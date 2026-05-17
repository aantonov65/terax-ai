import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type {
  ArtifactKind,
  ArtifactSummary,
  BatchStatus,
  BatchSummary,
  ProductSummary,
  RunStatus,
  WwxIndexState,
} from "./types";

type NativeArtifact = {
  id: string;
  batchId: string;
  productId: string;
  kind: string;
  label: string;
  filename: string;
  mimeType: string;
  size: number;
  source: string;
  public: boolean;
  createdAt: number;
  updatedAt: number;
  revision: number;
};

type NativeRun = {
  id: string;
  batchId: string;
  status: string;
  currentStage?: string | null;
  startedAt: number;
  finishedAt?: number | null;
  error?: string | null;
  updatedAt: number;
};

type NativeBatch = {
  id: string;
  productId: string;
  productCode: string;
  name: string;
  batchId: string;
  status: string;
  currentStage?: string | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
  artifacts: NativeArtifact[];
  runs: NativeRun[];
  decisionCounts?: { ship: number; review: number; fail: number };
  stageTimeline?: Array<{ stage: string; status: string; approved: boolean; artifactCount: number }>;
  finalScripts?: Array<{ taskId: string; script: string; decision: string; semanticReason?: string | null }>;
};

type NativeProduct = {
  id: string;
  productCode: string;
  name: string;
  configJson: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  batches: NativeBatch[];
};

type NativeIndex = {
  workspace: {
    id: string;
    name: string;
    rootPath: string;
    visibility: "account" | "private-local" | "shared";
    scopeLabel: string;
  };
  products: NativeProduct[];
};

type NativeArtifactContent = {
  artifact: NativeArtifact;
  contentText?: string | null;
  contentBlob?: number[] | null;
};

export type CreatedProduct = {
  productFolder: string;
  productPath: string;
  productCode: string;
  productId: string;
};

export type CreatedBatch = {
  batchId: string;
  batchPath: string;
  metaPath: string;
  productId: string;
};

const EMPTY_INDEX: WwxIndexState = {
  status: "idle",
  workspace: null,
  products: [],
  batches: [],
  refreshedAt: null,
};

export function useWwxIndex(_rootPath: string | null): WwxIndexState {
  const [state, setState] = useState<WwxIndexState>(EMPTY_INDEX);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setState((prev) => ({ ...prev, status: "loading" }));
      try {
        const native = await invoke<NativeIndex>("wwx_list_products");
        if (cancelled) return;
        const products = native.products.map(mapProduct);
        setState({
          status: "ready",
          workspace: native.workspace,
          products,
          batches: products.flatMap((product) => product.batches),
          refreshedAt: Date.now(),
        });
      } catch (error) {
        if (!cancelled) {
          setState((prev) => ({ ...prev, status: "error", error: String(error) }));
        }
      }
    };
    void load();
    const timer = window.setInterval(load, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return state;
}

export async function createProductInStore(input: {
  productFolder?: string;
  config: Record<string, unknown>;
}): Promise<CreatedProduct> {
  const product = await invoke<NativeProduct>("wwx_create_product", {
    input: { productFolder: input.productFolder, config: input.config },
  });
  return {
    productFolder: product.productCode,
    productPath: `app://wwx/products/${product.id}`,
    productCode: product.productCode,
    productId: product.id,
  };
}

export async function createBatchInStore(input: {
  productId: string;
  batchName: string;
}): Promise<CreatedBatch> {
  const batch = await invoke<NativeBatch>("wwx_create_batch", {
    input: { productId: input.productId, batchName: input.batchName },
  });
  return {
    batchId: batch.id,
    batchPath: `app://wwx/batches/${batch.id}`,
    metaPath: `app://wwx/batches/${batch.id}/wwx-batch.json`,
    productId: batch.productId,
  };
}

export async function readWwxArtifact(artifactId: string): Promise<{
  artifact: ArtifactSummary;
  contentText?: string | null;
  contentBlob?: number[] | null;
}> {
  const result = await invoke<NativeArtifactContent>("wwx_read_artifact", {
    artifactId,
  });
  return {
    artifact: mapArtifact(result.artifact),
    contentText: result.contentText,
    contentBlob: result.contentBlob,
  };
}

export async function writeWwxArtifact(input: {
  productId: string;
  batchId: string;
  kind: string;
  label: string;
  filename: string;
  mimeType?: string;
  contentText?: string;
  contentBlob?: number[];
  source?: string;
  public?: boolean;
}): Promise<ArtifactSummary> {
  const artifact = await invoke<NativeArtifact>("wwx_write_artifact", { input });
  return mapArtifact(artifact);
}

function mapProduct(product: NativeProduct): ProductSummary {
  const config = safeJson(product.configJson);
  const readiness = isRecord(config.wwx_readiness) ? config.wwx_readiness : null;
  const batches = product.batches.map((batch) => mapBatch(batch, product));
  return {
    id: product.id,
    code: product.productCode,
    name: product.name,
    path: `app://wwx/products/${product.id}`,
    configPath: `app://wwx/products/${product.id}/config.json`,
    config: {
      brand: stringValue(config.brand),
      productName: stringValue(config.product_name) ?? product.name,
      price: typeof config.price === "string" || typeof config.price === "number" ? config.price : undefined,
      guarantee: stringValue(config.guarantee),
      url: stringValue(config.url),
      targetDemographic: config.target_demographic,
      readiness: readiness
        ? {
            status: stringValue(readiness.status) as "draft" | "starter_only" | "needs_evidence" | "production_ready" | undefined,
            approved: Boolean(readiness.approved),
            gaps: Array.isArray(readiness.gaps)
              ? readiness.gaps.map((gap: unknown) => String(gap))
              : [],
          }
        : undefined,
    },
    batchCount: batches.length,
    statusCounts: statusCounts(batches),
    updatedAt: product.updatedAt,
    batches,
  };
}

function mapBatch(batch: NativeBatch, product: NativeProduct): BatchSummary {
  const decisions = batch.decisionCounts ?? decisionCounts(batch.artifacts);
  const hasConceptMatrix = batch.artifacts.some((artifact) => artifact.filename === "concept-matrix.json");
  const hasConceptApproval = batch.artifacts.some((artifact) => artifact.filename === "concept-matrix-approval.json");
  return {
    id: batch.id,
    name: batch.name,
    path: `app://wwx/batches/${batch.id}`,
    product: product.name,
    productCode: product.productCode,
    productPath: `app://wwx/products/${product.id}`,
    format: "lfs",
    status: toBatchStatus(batch.status),
    updatedAt: batch.updatedAt,
    decisionCounts: decisions,
    nextAction: nextAction(
      toBatchStatus(batch.status),
      batch.currentStage,
      hasConceptMatrix,
      hasConceptApproval,
    ),
    strategyPath: artifactPath(batch.artifacts, "strategy.json"),
    manifestPath: artifactPath(batch.artifacts, "lfs-v41-manifest.json"),
    reportPath: artifactPath(batch.artifacts, "lfs-v41-report.json"),
    artifacts: batch.artifacts.map(mapArtifact),
    runs: batch.runs.map(mapRun),
    stageTimeline: batch.stageTimeline ?? [],
    finalScripts: (batch.finalScripts ?? []).map((script) => ({
      ...script,
      semanticReason: script.semanticReason ?? undefined,
    })),
    alerts: alertsFor(batch),
  };
}

function mapArtifact(artifact: NativeArtifact): ArtifactSummary {
  return {
    id: artifact.id,
    batchId: artifact.batchId,
    label: artifact.label || artifact.filename,
    filename: artifact.filename,
    path: `app://wwx/artifacts/${artifact.id}`,
    kind: toArtifactKind(artifact.kind),
    size: artifact.size,
    mtime: artifact.updatedAt,
    source: "account",
  };
}

function isFinalLfsOutputArtifact(artifact: NativeArtifact): boolean {
  const filename = artifact.filename.replace(/^\/+/, "");
  return filename.startsWith("output-v41/") && filename.endsWith(".md");
}

function mapRun(run: NativeRun): { id: string; batchId: string; label: string; status: RunStatus; stage?: string; lastEvent?: string; updatedAt?: number } {
  return {
    id: run.id,
    batchId: run.batchId,
    label: "Guided Agent",
    status: toRunStatus(run.status),
    stage: run.currentStage ?? undefined,
    lastEvent: run.error ?? run.status,
    updatedAt: run.updatedAt,
  };
}

function safeJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toBatchStatus(status: string): BatchStatus {
  if (["draft", "ready", "running", "review", "complete", "blocked", "unknown"].includes(status)) {
    return status as BatchStatus;
  }
  return "ready";
}

function toRunStatus(status: string): RunStatus {
  if (status === "complete" || status === "ok") return "complete";
  if (status === "blocked" || status === "failed") return "blocked";
  if (status === "awaiting_review" || status === "held") return "idle";
  if (status === "running") return "running";
  return "unknown";
}

function toArtifactKind(kind: string): ArtifactKind {
  const known = new Set<ArtifactKind>([
    "angles",
    "strategy",
    "manifest",
    "report",
    "heartbeat",
    "image",
    "log",
    "markdown",
    "json",
    "csv",
    "upload",
    "directory",
    "other",
  ]);
  return known.has(kind as ArtifactKind) ? (kind as ArtifactKind) : "other";
}

function statusCounts(batches: BatchSummary[]): Record<BatchStatus, number> {
  const counts: Record<BatchStatus, number> = {
    draft: 0,
    ready: 0,
    running: 0,
    review: 0,
    complete: 0,
    blocked: 0,
    unknown: 0,
  };
  for (const batch of batches) counts[batch.status] += 1;
  return counts;
}

function artifactPath(artifacts: NativeArtifact[], filename: string): string | undefined {
  const artifact = artifacts.find((item) => item.filename === filename);
  return artifact ? `app://wwx/artifacts/${artifact.id}` : undefined;
}

function decisionCounts(artifacts: NativeArtifact[]) {
  const manifest = artifacts.find((item) => item.filename === "lfs-v41-manifest.json");
  if (!manifest) return { ship: 0, review: 0, fail: 0 };
  return { ship: 0, review: 0, fail: 0 };
}

function nextAction(
  status: BatchStatus,
  stage?: string | null,
  hasConceptMatrix = false,
  hasConceptApproval = false,
): string {
  if (status === "draft") {
    return hasConceptMatrix
      ? hasConceptApproval
        ? "Concept matrix approved. Start the batch when ready."
        : "Review the concept matrix, then approve generation."
      : "Start the guided workflow.";
  }
  if (status === "review") return `Review checkpoint${stage ? ` at ${stage}` : ""}.`;
  if (status === "running") return "Run is currently active.";
  if (status === "blocked") return "Open the agent to inspect the failure.";
  if (status === "complete") return "Batch is complete.";
  return "Start or continue the guided workflow.";
}

function alertsFor(batch: NativeBatch): string[] {
  const alerts: string[] = [];
  if (batch.status === "blocked") alerts.push("A recorded run ended with a failure event.");
  if (batch.artifacts.some((artifact) => artifact.filename === "repair-history.json")) {
    alerts.push("Repair history is available for this batch.");
  }
  if (batch.artifacts.length === 0) alerts.push("No public LFS artifacts are visible yet.");
  else if (!batch.artifacts.some(isFinalLfsOutputArtifact)) alerts.push("No final LFS output artifacts are visible yet.");
  return alerts;
}

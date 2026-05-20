import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { hostedRuntimeConfigured, wwxApiUrl, wwxAuthHeaders } from "./auth";
import type {
  ArtifactKind,
  ArtifactSummary,
  BatchStatus,
  BatchSummary,
  ProductSummary,
  RunStatus,
  WorkflowState,
  WwxIndexState,
} from "./types";
import { deriveWorkflowState, friendlyStageLabel } from "./workflow";

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
  visibilityClass: string;
  contentSha256: string;
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
  stageTimeline?: Array<{ stage: string; status: string; approved: boolean; artifactCount: number; label?: string; summary?: string }>;
  finalScripts?: Array<{ taskId: string; script: string; decision: string; semanticReason?: string | null }>;
  autonomous?: boolean;
  workflowState?: WorkflowState;
};

type NativeProduct = {
  id: string;
  productCode: string;
  name: string;
  configJson: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  researchArtifactCount?: number;
  researchArtifactUpdatedAt?: number | null;
  researchRuns?: NativeResearchRun[];
  batches: NativeBatch[];
};

type NativeResearchRun = {
  id: string;
  productId: string;
  topicSlug: string;
  topic: string;
  searchTermsJson: string;
  runFolder: string;
  status: string;
  qualityJson: string;
  createdAt: number;
  updatedAt: number;
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

type HostedIndex = {
  workspace: NativeIndex["workspace"];
  products: HostedProduct[];
};

type HostedProduct = {
  id: string;
  product_code: string;
  name: string;
  config: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  research_runs?: Array<{
    id: string;
    productId?: string;
    product_id?: string;
    topicSlug?: string;
    topic_slug?: string;
    topic: string;
    searchTerms?: string[];
    search_terms?: string[];
    status: string;
    quality?: Record<string, unknown>;
    createdAt?: number;
    created_at?: number;
    updatedAt?: number;
    updated_at?: number;
  }>;
  batches?: Array<{
    id: string;
    product_id: string;
    name: string;
    status: string;
    current_stage?: string | null;
    requested_ad_count?: number;
    created_at: number;
    updated_at: number;
    artifacts?: HostedArtifact[];
  }>;
};

type HostedArtifact = {
  id: string;
  batch_id: string;
  filename: string;
  label: string;
  mime_type: string;
  visibility_class: string;
  content_sha256: string;
  size: number;
  version?: number;
  created_at: number;
  updated_at: number;
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
        const native = hostedRuntimeConfigured()
          ? await loadHostedIndex()
          : await invoke<NativeIndex>("wwx_list_products");
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
  if (hostedRuntimeConfigured()) {
    const response = await hostedRequest<{ product: HostedProduct }>("/products", {
      method: "POST",
      body: { productFolder: input.productFolder, config: input.config },
    });
    return {
      productFolder: response.product.product_code,
      productPath: `hosted://wwx/products/${response.product.id}`,
      productCode: response.product.product_code,
      productId: response.product.id,
    };
  }
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

async function loadHostedIndex(): Promise<NativeIndex> {
  const hosted = await hostedRequest<HostedIndex>("/products");
  return {
    workspace: hosted.workspace,
    products: hosted.products.map(hostedProductToNative),
  };
}

async function hostedRequest<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const baseUrl = wwxApiUrl();
  if (!baseUrl) throw new Error("Hosted WWX API is not configured.");
  const response = await invoke<{ status: number; headers: Record<string, string>; body: number[] }>("ai_http_request", {
    url: `${baseUrl}${path}`,
    method: options.method ?? "GET",
    headers: {
      ...await wwxAuthHeaders(),
      "content-type": "application/json",
    },
    body: options.body ? Array.from(new TextEncoder().encode(JSON.stringify(options.body))) : undefined,
  });
  const text = new TextDecoder().decode(Uint8Array.from(response.body));
  if (response.status < 200 || response.status >= 300) {
    throw new Error(safeHostedError(text, response.status));
  }
  return text ? JSON.parse(text) as T : {} as T;
}

function hostedProductToNative(product: HostedProduct): NativeProduct {
  return {
    id: product.id,
    productCode: product.product_code,
    name: product.name,
    configJson: JSON.stringify(product.config ?? {}, null, 2),
    createdAt: product.created_at,
    updatedAt: product.updated_at,
    revision: 1,
    researchRuns: (product.research_runs ?? []).map((run) => ({
      id: run.id,
      productId: run.productId ?? run.product_id ?? product.id,
      topicSlug: run.topicSlug ?? run.topic_slug ?? "topic",
      topic: run.topic,
      searchTermsJson: JSON.stringify(run.searchTerms ?? run.search_terms ?? []),
      runFolder: `hosted://wwx/products/${product.id}/research-runs/${run.id}`,
      status: run.status,
      qualityJson: JSON.stringify(run.quality ?? {}),
      createdAt: run.createdAt ?? run.created_at ?? Date.now(),
      updatedAt: run.updatedAt ?? run.updated_at ?? Date.now(),
    })),
    batches: (product.batches ?? []).map((batch) => ({
      id: batch.id,
      productId: product.id,
      productCode: product.product_code,
      name: batch.name,
      batchId: batch.id,
      status: batch.status,
      currentStage: batch.current_stage,
      createdAt: batch.created_at,
      updatedAt: batch.updated_at,
      revision: 1,
      artifacts: (batch.artifacts ?? []).map((artifact) => ({
        id: artifact.id,
        batchId: artifact.batch_id,
        productId: product.id,
        kind: artifact.filename.endsWith(".json") ? "json" : "markdown",
        label: artifact.label,
        filename: artifact.filename,
        mimeType: artifact.mime_type,
        size: artifact.size,
        source: "hosted",
        public: artifact.visibility_class.startsWith("public_"),
        visibilityClass: artifact.visibility_class,
        contentSha256: artifact.content_sha256,
        createdAt: artifact.created_at,
        updatedAt: artifact.updated_at,
        revision: artifact.version ?? 1,
      })),
      runs: [],
    })),
  };
}

function safeHostedError(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: string };
    return parsed.error ?? `Hosted request failed with ${status}.`;
  } catch {
    return `Hosted request failed with ${status}.`;
  }
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

export async function listResearchRuns(productId: string): Promise<NativeResearchRun[]> {
  return invoke<NativeResearchRun[]>("wwx_list_research_runs", { productId });
}

export async function selectBatchResearchRuns(input: {
  productId: string;
  batchId: string;
  researchRunIds: string[];
}): Promise<NativeResearchRun[]> {
  return invoke<NativeResearchRun[]>("wwx_select_batch_research_runs", { input });
}

export async function analyzeAds(batchId: string): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("wwx_analyze_ads", { batchId });
}

export async function getBatchMetrics(batchId: string): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("wwx_get_batch_metrics", { batchId });
}

export async function answerBatchQuestion(input: {
  batchId: string;
  question: string;
}): Promise<{ refused: boolean; answer: string; citations: string[] }> {
  return invoke("wwx_answer_batch_question", { input });
}

export async function exportHandoffPackage(batchId: string): Promise<{
  artifact: ArtifactSummary;
  scriptCount: number;
}> {
  const result = await invoke<{ artifact: NativeArtifact; scriptCount: number }>("wwx_export_handoff_package", {
    batchId,
  });
  return {
    artifact: mapArtifact(result.artifact),
    scriptCount: result.scriptCount,
  };
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
    researchArtifactCount: product.researchArtifactCount ?? 0,
    researchArtifactUpdatedAt: product.researchArtifactUpdatedAt ?? null,
    researchRuns: product.researchRuns ?? [],
    batchCount: batches.length,
    statusCounts: statusCounts(batches),
    updatedAt: product.updatedAt,
    batches,
  };
}

function mapBatch(batch: NativeBatch, product: NativeProduct): BatchSummary {
  const decisions = batch.decisionCounts ?? decisionCounts(batch.artifacts);
  const hasStrategyPlan = batch.artifacts.some((artifact) => artifact.filename === "strategy-plan.json");
  const hasStrategy = batch.artifacts.some((artifact) => artifact.filename === "strategy.json");
  const artifacts = batch.artifacts.map(mapArtifact);
  const finalScripts = (batch.finalScripts ?? []).map((script) => ({
    ...script,
    semanticReason: script.semanticReason ?? undefined,
  }));
  const status = toBatchStatus(batch.status);
  const workflowState = deriveWorkflowState({
    status,
    currentStage: batch.currentStage,
    artifacts,
    finalScripts,
    autonomous: Boolean(batch.autonomous),
    nextAction: nextAction(status, batch.currentStage, hasStrategyPlan, hasStrategy),
    workflowState: batch.workflowState,
  });
  return {
    id: batch.id,
    productId: batch.productId,
    name: batch.name,
    path: `app://wwx/batches/${batch.id}`,
    product: product.name,
    productCode: product.productCode,
    productPath: `app://wwx/products/${product.id}`,
    format: "lfs",
    status,
    currentStage: batch.currentStage ?? undefined,
    updatedAt: batch.updatedAt,
    decisionCounts: decisions,
    nextAction: workflowState.summary,
    artifacts,
    runs: batch.runs.map(mapRun),
    stageTimeline: (batch.stageTimeline ?? []).map((stage) => ({
      ...stage,
      label: stage.label ?? friendlyStageLabel(stage.stage),
    })),
    finalScripts,
    alerts: alertsFor(batch),
    autonomous: Boolean(batch.autonomous),
    workflowState,
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
    visibilityClass: artifact.visibilityClass,
    contentSha256: artifact.contentSha256,
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
  if (status === "awaiting_review" || status === "held" || status === "review") return "review";
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

function decisionCounts(artifacts: NativeArtifact[]) {
  const manifest = artifacts.find((item) => item.filename === "lfs-v41-manifest.json");
  if (!manifest) return { ship: 0, review: 0, fail: 0 };
  return { ship: 0, review: 0, fail: 0 };
}

function nextAction(
  status: BatchStatus,
  stage?: string | null,
  hasStrategyPlan = false,
  hasStrategy = false,
): string {
  if (status === "draft") {
    if (hasStrategy) return "Batch inputs ready. Run autonomous LFS4.1 when ready.";
    if (hasStrategyPlan) return "Review the input bundle, then build internal batch inputs.";
    return "Add product truth, research topic, ad count, and optional constraints.";
  }
  if (status === "review") return `${friendlyStageLabel(stage)} is ready. Continue when approved.`;
  if (status === "running") return `${friendlyStageLabel(stage)} is running.`;
  if (status === "blocked") return "The batch needs operator attention.";
  if (status === "complete") return "Final ads are ready for review.";
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

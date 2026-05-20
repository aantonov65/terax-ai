import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { LOCAL_WORKSPACE } from "./data";
import type {
  ArtifactKind,
  ArtifactSummary,
  BatchDecisionCounts,
  BatchStatus,
  BatchSummary,
  ProductConfigSummary,
  ProductSummary,
  RunStatus,
  RunSummary,
  WorkspaceSummary,
  WwxIndexState,
} from "./types";

type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type BatchCandidate = {
  id: string;
  path: string;
  mtime?: number;
  productCode?: string;
  productName?: string;
  productPath?: string;
  legacy?: boolean;
};

type ProductCandidate = {
  id: string;
  code: string;
  name: string;
  path: string;
  configPath?: string;
  config?: ProductConfigSummary;
  updatedAt?: number;
};

type RawManifest = {
  batch_id?: string;
  generated_at?: string;
  output_subdir?: string;
  total_scripts?: number;
  decision_counts?: Partial<Record<keyof BatchDecisionCounts, number>>;
  scripts?: Array<{
    decision?: string;
    path?: string;
    task_id?: string;
    semantic_reason?: string;
    hard_violations?: string[];
    advisory_violations?: string[];
  }>;
};

type RawSpec = {
  product?: string;
  product_name?: string;
  product_code?: string;
  batch_id?: string;
  format?: string;
  formats?: string[];
};

type RawProductConfig = {
  brand?: string;
  name?: string;
  product?: string;
  product_code?: string;
  product_name?: string;
  price?: string | number;
  guarantee?: string;
  url?: string;
  target_demographic?: unknown;
};

type RawDraftBatch = {
  schema?: string;
  product_folder?: string;
  batch_id?: string;
  batch_name?: string;
  created_at?: string;
  status?: string;
};

type HeartbeatEvent = {
  event?: string;
  stage?: string;
  status?: string;
  message?: string;
  ts?: string | number;
  timestamp?: string | number;
};

type RawAgentRun = {
  status?: string;
  current_stage?: string;
  updated_at?: string;
};

const EMPTY_INDEX: WwxIndexState = {
  status: "idle",
  workspace: null,
  products: [],
  batches: [],
  refreshedAt: null,
};

const OUTPUT_DIRS = [
  "output-v41",
  "assets",
  "images",
  "landing-pages",
];
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const JSON_EXTENSIONS = new Set([".json", ".jsonl"]);
const CSV_EXTENSIONS = new Set([".csv", ".tsv"]);

const ROOT_ARTIFACT_FILES: Array<{
  name: string;
  label: string;
  kind: ArtifactKind;
}> = [
  { name: "ad-analysis-index.json", label: "Ad Analysis", kind: "report" },
  { name: "asset-inputs.json", label: "Asset Inputs", kind: "json" },
  { name: "batch-summary.json", label: "Batch Summary", kind: "report" },
  { name: "handoff-package.json", label: "Handoff Package", kind: "json" },
  { name: "research-selection.json", label: "Research Selection", kind: "report" },
];

export function useWwxIndex(rootPath: string | null): WwxIndexState {
  const [state, setState] = useState<WwxIndexState>(EMPTY_INDEX);

  useEffect(() => {
    let cancelled = false;

    if (!rootPath) {
      setState(EMPTY_INDEX);
      return;
    }

    setState((prev) => ({
      ...prev,
      status: "loading",
      error: undefined,
    }));

    const refresh = () => {
      void indexWwxWorkspace(rootPath)
        .then((next) => {
          if (!cancelled) setState(next);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            workspace: makeWorkspace(rootPath),
            products: [],
            batches: [],
            refreshedAt: Date.now(),
          });
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [rootPath]);

  return state;
}

async function indexWwxWorkspace(rootPath: string): Promise<WwxIndexState> {
  const { batches: candidates, products } = await discoverWorkspaceCandidates(rootPath);
  const batches = await Promise.all(candidates.map(indexBatch));
  const sortedBatches = batches
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return {
    status: "ready",
    workspace: makeWorkspace(rootPath),
    products: groupProducts(sortedBatches, rootPath, products),
    batches: sortedBatches,
    refreshedAt: Date.now(),
  };
}

async function discoverWorkspaceCandidates(rootPath: string): Promise<{
  batches: BatchCandidate[];
  products: ProductCandidate[];
}> {
  const rootEntries = await readDirSafe(rootPath);
  const candidates = new Map<string, BatchCandidate>();
  const products: ProductCandidate[] = [];

  const add = (path: string, next: Omit<BatchCandidate, "id" | "path"> = {}) => {
    const id = basename(path);
    candidates.set(path, { id, path, ...next });
  };

  if (looksLikeBatchDir(rootEntries)) add(rootPath, { mtime: maxMtime(rootEntries) });

  const productsPath = joinPath(rootPath, "products");
  const productRoots =
    rootEntries.some((entry) => entry.kind === "dir" && entry.name === "products")
      ? await readDirSafe(productsPath)
      : [];
  for (const productEntry of productRoots) {
    if (productEntry.kind !== "dir") continue;
    const productPath = joinPath(productsPath, productEntry.name);
    const configPath = joinPath(productPath, "config.json");
    const config = await readJsonSafe<RawProductConfig>(configPath);
    const productCode = config?.product_code ?? productEntry.name;
    const productName =
      config?.product_name ?? config?.name ?? config?.product ?? productEntry.name;
    products.push({
      id: productCode,
      code: productCode,
      name: productName,
      path: productPath,
      configPath: config ? configPath : undefined,
      config: config
        ? {
            brand: config.brand,
            productName: config.product_name ?? config.name ?? config.product,
            price: config.price,
            guarantee: config.guarantee,
            url: config.url,
            targetDemographic: config.target_demographic,
          }
        : undefined,
      updatedAt: productEntry.mtime,
    });
    const productBatchRoot = joinPath(productPath, "batches");
    const productBatches = await readDirSafe(productBatchRoot);
    for (const batchEntry of productBatches) {
      if (batchEntry.kind !== "dir") continue;
      add(joinPath(productBatchRoot, batchEntry.name), {
        mtime: batchEntry.mtime,
        productCode,
        productName,
        productPath,
      });
    }
  }

  const batchesPath = basename(rootPath) === "batches" ? rootPath : joinPath(rootPath, "batches");
  const batchRootEntries =
    basename(rootPath) === "batches"
      ? rootEntries
      : rootEntries.some((entry) => entry.kind === "dir" && entry.name === "batches")
        ? await readDirSafe(batchesPath)
        : [];

  for (const entry of batchRootEntries) {
    if (entry.kind !== "dir") continue;
    add(joinPath(batchesPath, entry.name), { mtime: entry.mtime, legacy: true });
  }

  return { batches: [...candidates.values()], products };
}

async function indexBatch(candidate: BatchCandidate): Promise<BatchSummary> {
  const entries = await readDirSafe(candidate.path);
  const files = new Map(entries.map((entry) => [entry.name, entry]));

  const anglesPath = filePathIfPresent(candidate.path, files, "angles.md");
  const strategyPath = filePathIfPresent(candidate.path, files, "strategy.json");
  const specPath = filePathIfPresent(candidate.path, files, "spec.json");
  const batchMetaPath = filePathIfPresent(candidate.path, files, "wwx-batch.json");
  const manifestPath = filePathIfPresent(candidate.path, files, "lfs-v41-manifest.json");
  const lfsReportPath = filePathIfPresent(candidate.path, files, "lfs-v41-report.json");
  const imageReportPath = filePathIfPresent(candidate.path, files, "image-report.json");
  const reportPath =
    lfsReportPath ?? imageReportPath ?? filePathIfPresent(candidate.path, files, "report.json");

  const [manifest, spec, strategy, batchMeta] = await Promise.all([
    manifestPath ? readJsonSafe<RawManifest>(manifestPath) : Promise.resolve(null),
    specPath ? readJsonSafe<RawSpec>(specPath) : Promise.resolve(null),
    strategyPath ? readJsonSafe<RawSpec>(strategyPath) : Promise.resolve(null),
    batchMetaPath ? readJsonSafe<RawDraftBatch>(batchMetaPath) : Promise.resolve(null),
  ]);

  const artifacts: ArtifactSummary[] = [];
  for (const artifact of ROOT_ARTIFACT_FILES) {
    addFileArtifact(
      artifacts,
      candidate.id,
      artifact.label,
      filePathIfPresent(candidate.path, files, artifact.name),
      artifact.kind,
      files.get(artifact.name),
    );
  }

  await addDirectoryArtifacts(candidate.path, candidate.id, artifacts);

  const runs = await readRuns(candidate.path, candidate.id, files);
  const decisions = normalizeDecisions(manifest);
  const alerts = collectAlerts({ entries, manifest, runs, anglesPath, strategyPath, reportPath });
  const status = inferBatchStatus({
    decisions,
    manifestPath,
    reportPath,
    runs,
    alerts,
    hasAngles: Boolean(anglesPath),
    hasStrategy: Boolean(strategyPath),
    hasDraftMeta: Boolean(batchMetaPath),
  });
  const batchId = manifest?.batch_id ?? spec?.batch_id ?? batchMeta?.batch_id ?? candidate.id;

  return {
    id: batchId,
    name: manifest?.batch_id ?? spec?.batch_id ?? batchMeta?.batch_name ?? batchId,
    path: candidate.path,
    product:
      spec?.product_name ??
      spec?.product ??
      strategy?.product_name ??
      strategy?.product ??
      candidate.productName ??
      candidate.productCode,
    productCode:
      spec?.product_code ??
      strategy?.product_code ??
      candidate.productCode,
    productPath: candidate.productPath,
    legacy: candidate.legacy,
    format: spec?.format ?? strategy?.format ?? firstFormat(spec?.formats ?? strategy?.formats),
    status,
    updatedAt: maxMtime(entries) ?? candidate.mtime,
    totalScripts: manifest?.total_scripts ?? manifest?.scripts?.length,
    decisionCounts: decisions,
    batchMetaPath,
    nextAction: nextActionForStatus(status, runs.length > 0, batchMeta?.batch_name),
    artifacts: artifacts.slice(0, 48),
    runs,
    alerts,
  };
}

async function addDirectoryArtifacts(
  batchPath: string,
  batchId: string,
  artifacts: ArtifactSummary[],
): Promise<void> {
  for (const dirName of OUTPUT_DIRS) {
    const dirPath = joinPath(batchPath, dirName);
    const entries = await readDirSafe(dirPath);
    if (!entries.length) continue;

    artifacts.push({
      id: dirPath,
      batchId,
      label: dirName,
      path: dirPath,
      kind: "directory",
      description: `${entries.length} item${entries.length === 1 ? "" : "s"}`,
      mtime: maxMtime(entries),
    });

    for (const entry of entries.slice(0, 16)) {
      const path = joinPath(dirPath, entry.name);
      if (entry.kind === "dir") {
        artifacts.push({
          id: path,
          batchId,
          label: `${dirName}/${entry.name}`,
          path,
          kind: "directory",
          mtime: entry.mtime,
        });
        if (dirName === "lfs-v41-parallel-runs") {
          const nested = await readDirSafe(path);
          for (const child of nested.slice(0, 10)) {
            if (child.kind !== "file") continue;
            const childPath = joinPath(path, child.name);
            artifacts.push({
              id: childPath,
              batchId,
              label: `${dirName}/${entry.name}/${child.name}`,
              path: childPath,
              kind: classifyPath(child.name),
              size: child.size,
              mtime: child.mtime,
            });
          }
        }
        continue;
      }
      if (entry.kind !== "file") continue;
      artifacts.push({
        id: path,
        batchId,
        label: `${dirName}/${entry.name}`,
        path,
        kind: classifyPath(entry.name),
        size: entry.size,
        mtime: entry.mtime,
      });
    }
  }
}

async function readRuns(
  batchPath: string,
  batchId: string,
  files: Map<string, DirEntry>,
): Promise<RunSummary[]> {
  const runs: RunSummary[] = [];
  const agentEntry = files.get("agent-run.json");
  if (agentEntry) {
    const path = joinPath(batchPath, "agent-run.json");
    const state = await readJsonSafe<RawAgentRun>(path);
    runs.push({
      id: path,
      batchId,
      label: "Guided Agent",
      status: inferAgentRunStatus(state?.status),
      stage: state?.current_stage,
      lastEvent: state?.status,
      updatedAt: agentEntry.mtime,
    });
  }
  const heartbeatPath = joinPath(batchPath, "generation-heartbeats");
  const heartbeats = await readDirSafe(heartbeatPath);

  for (const entry of heartbeats.slice(0, 12)) {
    if (entry.kind !== "file" || !entry.name.endsWith(".jsonl")) continue;
    const path = joinPath(heartbeatPath, entry.name);
    const event = await readLastJsonlEvent(path);
    runs.push({
      id: path,
      batchId,
      label: entry.name.replace(/\.jsonl$/, ""),
      status: inferRunStatus(event),
      stage: event?.stage ?? event?.status,
      lastEvent: event?.event ?? event?.message,
      heartbeatPath: path,
      updatedAt: entry.mtime,
    });
  }

  return runs;
}

function inferAgentRunStatus(status?: string): RunStatus {
  const text = (status ?? "").toLowerCase();
  if (text === "complete") return "complete";
  if (text === "failed" || text === "blocked") return "blocked";
  if (text === "held" || text === "awaiting_review" || text === "edit_requested") return "idle";
  if (text === "running" || text === "initialized") return "running";
  return "unknown";
}

function collectAlerts({
  entries,
  manifest,
  runs,
  anglesPath,
  strategyPath,
  reportPath,
}: {
  entries: DirEntry[];
  manifest: RawManifest | null;
  runs: RunSummary[];
  anglesPath?: string;
  strategyPath?: string;
  reportPath?: string;
}): string[] {
  const alerts: string[] = [];
  if (!strategyPath && !anglesPath) alerts.push("No batch input bundle is visible yet.");
  if (!manifest && !reportPath) alerts.push("No public final summary has been written yet.");
  if (runs.some((run) => run.status === "blocked")) alerts.push("A recorded run ended with a failure event.");
  if (entries.some((entry) => entry.name === "repair-history.json")) {
    alerts.push("Repair history is available for this batch.");
  }

  const decisions = normalizeDecisions(manifest);
  if (decisions.review > 0 || decisions.fail > 0) {
    alerts.push(`${decisions.review + decisions.fail} script${decisions.review + decisions.fail === 1 ? "" : "s"} need review or repair.`);
  }

  if (!entries.some((entry) => entry.name === "output-v41" || entry.name === "images")) {
    alerts.push("No generated script or image folder is visible yet.");
  }

  return alerts.slice(0, 4);
}

function inferBatchStatus({
  decisions,
  manifestPath,
  reportPath,
  runs,
  alerts,
  hasAngles,
  hasStrategy,
  hasDraftMeta,
}: {
  decisions: BatchDecisionCounts;
  manifestPath?: string;
  reportPath?: string;
  runs: RunSummary[];
  alerts: string[];
  hasAngles: boolean;
  hasStrategy: boolean;
  hasDraftMeta: boolean;
}): BatchStatus {
  if (runs.some((run) => run.status === "running")) return "running";
  if (hasDraftMeta && !hasStrategy && !manifestPath && !reportPath) return "draft";
  if (hasAngles && !hasStrategy) return "ready";
  if (!hasStrategy) return "blocked";
  if (decisions.review > 0 || decisions.fail > 0) return "review";
  if (manifestPath || reportPath) return "complete";
  if (alerts.length) return "ready";
  return "unknown";
}

function nextActionForStatus(
  status: BatchStatus,
  hasAgentRun: boolean,
  batchName?: string,
): string {
  if (status === "draft") return `Add batch inputs for ${batchName ?? "this batch"}.`;
  if (status === "running") return "The autonomous workflow is running.";
  if (status === "review") return "Continue repair or approval from the current checkpoint.";
  if (status === "blocked") return "Open the agent for a sanitized blocker summary.";
  if (status === "ready") return hasAgentRun ? "Continue the autonomous workflow." : "Start the autonomous workflow.";
  if (status === "complete") return "Batch is complete.";
  return "Open the agent to inspect the batch.";
}

function inferRunStatus(event: HeartbeatEvent | null): RunStatus {
  const text = `${event?.event ?? ""} ${event?.status ?? ""}`.toLowerCase();
  if (!text.trim()) return "unknown";
  if (text.includes("failed") || text.includes("error")) return "blocked";
  if (text.includes("finished") || text.includes("written") || text.includes("complete")) {
    return "complete";
  }
  return "running";
}

async function readLastJsonlEvent(path: string): Promise<HeartbeatEvent | null> {
  const content = await readTextSafe(path);
  if (!content) return null;
  const last = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  if (!last) return null;
  try {
    return JSON.parse(last) as HeartbeatEvent;
  } catch {
    return null;
  }
}

function normalizeDecisions(manifest: RawManifest | null): BatchDecisionCounts {
  const counts: BatchDecisionCounts = {
    ship: manifest?.decision_counts?.ship ?? 0,
    review: manifest?.decision_counts?.review ?? 0,
    fail: manifest?.decision_counts?.fail ?? 0,
  };

  if (!manifest?.decision_counts && manifest?.scripts?.length) {
    for (const script of manifest.scripts) {
      if (script.decision === "ship") counts.ship += 1;
      else if (script.decision === "fail") counts.fail += 1;
      else counts.review += 1;
    }
  }

  return counts;
}

function addFileArtifact(
  artifacts: ArtifactSummary[],
  batchId: string,
  label: string,
  path: string | undefined,
  kind: ArtifactKind,
  entry?: DirEntry,
) {
  if (!path) return;
  artifacts.push({
    id: path,
    batchId,
    label,
    path,
    kind,
    size: entry?.size,
    mtime: entry?.mtime,
  });
}

function classifyPath(name: string): ArtifactKind {
  const ext = extension(name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (JSON_EXTENSIONS.has(ext)) return ext === ".jsonl" ? "heartbeat" : "json";
  if (CSV_EXTENSIONS.has(ext)) return "csv";
  if (ext === ".log") return "log";
  return "other";
}

function looksLikeBatchDir(entries: DirEntry[]): boolean {
  return entries.some((entry) =>
    [
      "strategy.json",
      "wwx-batch.json",
      "spec.json",
      "lfs-v41-manifest.json",
      "lfs-v41-report.json",
      "report.json",
      "upload.json",
    ].includes(entry.name),
  );
}

const BATCH_STATUSES: BatchStatus[] = [
  "draft",
  "ready",
  "running",
  "review",
  "complete",
  "blocked",
  "unknown",
];

function groupProducts(
  batches: BatchSummary[],
  rootPath: string,
  productCandidates: ProductCandidate[] = [],
): ProductSummary[] {
  const groups = new Map<string, ProductSummary>();

  for (const product of productCandidates) {
    groups.set(product.id, {
      id: product.id,
      code: product.code,
      name: product.name,
      path: product.path,
      configPath: product.configPath,
      config: product.config,
      batchCount: 0,
      statusCounts: zeroStatusCounts(),
      updatedAt: product.updatedAt,
      batches: [],
    });
  }

  for (const batch of batches) {
    const displayName = batch.product ?? batch.productCode ?? "Legacy batches";
    const code = batch.productCode ?? slugify(displayName) ?? "legacy";
    const id = code;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        code,
        name: displayName,
        path: batch.productPath ?? joinPath(rootPath, "batches"),
        configPath: undefined,
        config: undefined,
        batchCount: 0,
        statusCounts: zeroStatusCounts(),
        updatedAt: batch.updatedAt,
        batches: [],
      };
      groups.set(id, group);
    }
    group.batches.push(batch);
    group.batchCount += 1;
    group.statusCounts[batch.status] += 1;
    group.updatedAt = Math.max(group.updatedAt ?? 0, batch.updatedAt ?? 0) || undefined;
  }

  return [...groups.values()]
    .map((product) => ({
      ...product,
      batches: [...product.batches].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function zeroStatusCounts(): Record<BatchStatus, number> {
  return BATCH_STATUSES.reduce(
    (acc, status) => {
      acc[status] = 0;
      return acc;
    },
    {} as Record<BatchStatus, number>,
  );
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function makeWorkspace(rootPath: string): WorkspaceSummary {
  return {
    ...LOCAL_WORKSPACE,
    rootPath,
    name: basename(rootPath) || LOCAL_WORKSPACE.name,
  };
}

function filePathIfPresent(
  root: string,
  files: Map<string, DirEntry>,
  name: string,
): string | undefined {
  return files.has(name) ? joinPath(root, name) : undefined;
}

async function readJsonSafe<T>(path: string): Promise<T | null> {
  const content = await readTextSafe(path);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function readTextSafe(path: string): Promise<string | null> {
  try {
    const result = await invoke<ReadResult>("fs_read_file", { path });
    return result.kind === "text" ? result.content : null;
  } catch {
    return null;
  }
}

async function readDirSafe(path: string): Promise<DirEntry[]> {
  try {
    return await invoke<DirEntry[]>("fs_read_dir", { path, showHidden: false });
  } catch {
    return [];
  }
}

function joinPath(base: string, child: string): string {
  return `${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function extension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx).toLowerCase();
}

function maxMtime(entries: DirEntry[]): number | undefined {
  const value = entries.reduce((max, entry) => Math.max(max, entry.mtime || 0), 0);
  return value > 0 ? value : undefined;
}

function firstFormat(formats?: string[]): string | undefined {
  return Array.isArray(formats) && formats.length ? formats[0] : undefined;
}

import { invoke } from "@tauri-apps/api/core";
import { hostedRuntimeConfigured, hostedRuntimeMode, wwxApiUrl, wwxAuthHeaders } from "./auth";
import { readWwxArtifact, writeWwxArtifact } from "./store";
import type { BatchSummary, ProductSummary } from "./types";

type HostedRun = {
  id: string;
  workflow_type: string;
  product_id: string | null;
  batch_id: string | null;
  status: string;
  current_stage?: string | null;
  failure_message_safe?: string | null;
};

type HostedArtifact = {
  id: string;
  batch_id: string;
  filename: string;
  label: string;
  mime_type: string;
  visibility_class: string;
  size: number;
  content_sha256: string;
};

type HostedCreateRunResponse = {
  run: HostedRun;
};

type HostedBatchStatus = {
  batch?: {
    id: string;
    status: string;
    current_stage?: string | null;
  };
  artifacts?: HostedArtifact[];
};

export type HostedResearchRun = {
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
};

export function shouldUseHostedRuntime(): boolean {
  const mode = hostedRuntimeMode();
  if (mode === "local") return false;
  return hostedRuntimeConfigured();
}

export async function startHostedLfsRun(input: {
  product: ProductSummary;
  batch: BatchSummary;
  workers?: number;
  generationWorkers?: number;
}): Promise<HostedRun> {
  return startHostedLfsRunForBatch({
    product: input.product,
    productId: input.product.id,
    batch: input.batch,
    workers: input.workers,
    generationWorkers: input.generationWorkers,
  });
}

export async function startHostedLfsRunForBatch(input: {
  product?: ProductSummary;
  productId: string;
  batch: BatchSummary;
  anglesMarkdown?: string;
  workers?: number;
  generationWorkers?: number;
}): Promise<HostedRun> {
  const strategyJson = await readBatchArtifactText(input.batch, "strategy.json");
  const anglesMarkdown = input.anglesMarkdown?.trim()
    || await readBatchArtifactText(input.batch, "angles.md")
    || await readBatchArtifactText(input.batch, "source-angle.md");
  const researchFiles = input.product ? await readProductResearchFiles(input.product) : undefined;
  const adCount = inferRequestedAdCount(input.batch, strategyJson);
  const response = await hostedRequest<HostedCreateRunResponse>("/runs", {
    method: "POST",
    body: {
      workflowType: "lfs_ads",
      productId: input.productId,
      batchId: input.batch.id,
      payload: {
        productId: input.productId,
        batchId: input.batch.id,
        batchName: input.batch.name,
        adCount,
        strategyJson: strategyJson ? safeJson(strategyJson) ?? strategyJson : undefined,
        anglesMarkdown: strategyJson ? undefined : anglesMarkdown ?? undefined,
        configJson: input.product?.rawConfig,
        researchFiles,
        runMode: "full",
        workers: input.workers,
        generationWorkers: input.generationWorkers,
      },
    },
  });
  await recordHostedRun(input.productId, input.batch.id, response.run);
  return response.run;
}

export async function startHostedResearchRun(input: {
  product: ProductSummary;
  topic: string;
  searchTerms?: string[];
}): Promise<HostedRun> {
  return startHostedResearchRunForProduct({
    productId: input.product.id,
    productCode: input.product.code,
    productName: input.product.name,
    configJson: input.product.rawConfig,
    topic: input.topic,
    searchTerms: input.searchTerms,
  });
}

export async function startHostedResearchRunForProduct(input: {
  productId: string;
  productCode?: string;
  productName?: string;
  configJson?: Record<string, unknown>;
  topic: string;
  searchTerms?: string[];
}): Promise<HostedRun> {
  const response = await hostedRequest<HostedCreateRunResponse>("/runs", {
    method: "POST",
    body: {
      workflowType: "research",
      productId: input.productId,
      payload: {
        productId: input.productId,
        productCode: input.productCode,
        productName: input.productName,
        configJson: input.configJson,
        topic: input.topic,
        searchTerms: input.searchTerms ?? [],
      },
    },
  });
  return response.run;
}

export async function listHostedResearchRuns(productId: string): Promise<HostedResearchRun[]> {
  const response = await hostedRequest<{ products: Array<{ id: string; research_runs?: HostedResearchRun[] }> }>("/products");
  return response.products.find((product) => product.id === productId)?.research_runs ?? [];
}

export async function startHostedStrategyRun(input: {
  product: ProductSummary;
  batch: BatchSummary;
  strategyPlanJson: Record<string, unknown> | string;
  adCount?: number;
}): Promise<HostedRun> {
  const researchFiles = await readProductResearchFiles(input.product);
  const response = await hostedRequest<HostedCreateRunResponse>("/runs", {
    method: "POST",
    body: {
      workflowType: "strategy",
      productId: input.product.id,
      batchId: input.batch.id,
      payload: {
        productId: input.product.id,
        batchId: input.batch.id,
        batchName: input.batch.name,
        productCode: input.product.code,
        productName: input.product.name,
        configJson: input.product.rawConfig,
        strategyPlanJson: input.strategyPlanJson,
        researchFiles,
        adCount: input.adCount ?? input.batch.totalScripts ?? 1,
      },
    },
  });
  await recordHostedRun(input.product.id, input.batch.id, response.run);
  return response.run;
}

export async function getHostedRunStatus(runId: string): Promise<HostedRun> {
  const status = await hostedRequest<{ run: HostedRun }>(`/runs/${encodeURIComponent(runId)}/status`);
  return status.run;
}

export async function waitForHostedRun(runId: string, options: { pollMs?: number; timeoutMs?: number } = {}): Promise<HostedRun> {
  const pollMs = options.pollMs ?? 2_000;
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  let last = await getHostedRunStatus(runId);
  while (last.status === "queued" || last.status === "running") {
    if (Date.now() > deadline) throw new Error("Hosted run is still running. Check the run status again shortly.");
    await new Promise((resolve) => window.setTimeout(resolve, pollMs));
    last = await getHostedRunStatus(runId);
  }
  if (last.status !== "succeeded") {
    throw new Error(last.failure_message_safe || `Hosted run ${last.status}.`);
  }
  return last;
}

export async function syncHostedRun(input: {
  product: ProductSummary;
  batch: BatchSummary;
  runId: string;
}): Promise<void> {
  return syncHostedRunForBatch({
    productId: input.product.id,
    batch: input.batch,
    runId: input.runId,
  });
}

export async function syncHostedRunForBatch(input: {
  productId: string;
  batch: BatchSummary;
  runId: string;
}): Promise<void> {
  const status = await hostedRequest<{ run: HostedRun }>(`/runs/${encodeURIComponent(input.runId)}/status`);
  await recordHostedRun(input.productId, input.batch.id, status.run);
  const batchStatus = await hostedRequest<HostedBatchStatus>(`/batches/${encodeURIComponent(input.batch.id)}/status`).catch(() => null);
  if (!batchStatus) return;
  if (batchStatus.batch?.status === "complete" || status.run.status === "succeeded") {
    await mirrorHostedOutputs(input.productId, input.batch.id);
  }
}

export async function hostedQuestion(runId: string, question: string): Promise<Record<string, unknown>> {
  return hostedRequest(`/runs/${encodeURIComponent(runId)}/question`, {
    method: "POST",
    body: { question },
  });
}

export async function stopHostedRunForBatch(input: {
  productId: string;
  batch: BatchSummary;
  runId: string;
}): Promise<HostedRun> {
  const response = await hostedRequest<{ run: HostedRun }>(`/runs/${encodeURIComponent(input.runId)}/stop`, {
    method: "POST",
  });
  await recordHostedRun(input.productId, input.batch.id, response.run);
  return response.run;
}

export async function continueHostedRunForBatch(input: {
  productId: string;
  batch: BatchSummary;
  runId: string;
}): Promise<HostedRun> {
  const response = await hostedRequest<{ run: HostedRun }>(`/runs/${encodeURIComponent(input.runId)}/continue`, {
    method: "POST",
  });
  await recordHostedRun(input.productId, input.batch.id, response.run);
  return response.run;
}

async function mirrorHostedOutputs(productId: string, batchId: string): Promise<void> {
  const finalAds = await hostedRequest<{ ads: HostedArtifact[] }>(`/batches/${encodeURIComponent(batchId)}/final-ads`).catch(() => ({ ads: [] }));
  for (const artifact of finalAds.ads ?? []) {
    const body = await hostedRequest<{ content?: string }>(`/batches/${encodeURIComponent(batchId)}/final-ads/${encodeURIComponent(artifact.id)}`).catch(() => null);
    if (!body?.content) continue;
    await writeWwxArtifact({
      productId,
      batchId,
      kind: "markdown",
      label: artifact.label || artifact.filename,
      filename: artifact.filename,
      mimeType: artifact.mime_type || "text/markdown",
      contentText: body.content,
      source: "hosted",
      public: true,
    });
  }
  const [assetInputs, metrics, analysis] = await Promise.all([
    hostedRequest<Record<string, unknown>>(`/batches/${encodeURIComponent(batchId)}/asset-inputs`).catch(() => null),
    hostedRequest<Record<string, unknown>>(`/batches/${encodeURIComponent(batchId)}/metrics`).catch(() => null),
    hostedRequest<Record<string, unknown>>(`/batches/${encodeURIComponent(batchId)}/analyze`, { method: "POST" }).catch(() => null),
  ]);
  if (assetInputs) {
    await writeJson(productId, batchId, "asset-inputs.json", "Asset Inputs", assetInputs);
  }
  if (analysis) {
    await writeJson(productId, batchId, "ad-analysis-index.json", "Ad Analysis Index", analysis);
  }
  if (metrics) {
    await writeJson(productId, batchId, "batch-summary.json", "Batch Summary", {
      schema: "wwx-public-batch-summary/v1",
      batch_id: batchId,
      metrics,
    });
  }
}

async function writeJson(productId: string, batchId: string, filename: string, label: string, value: Record<string, unknown>): Promise<void> {
  await writeWwxArtifact({
    productId,
    batchId,
    kind: "json",
    label,
    filename,
    mimeType: "application/json",
    contentText: JSON.stringify(value, null, 2),
    source: "hosted",
    public: true,
  });
}

async function recordHostedRun(productId: string, batchId: string, run: HostedRun): Promise<void> {
  await invoke("wwx_record_hosted_run", {
    input: {
      productId,
      batchId,
      runId: run.id,
      status: toLocalStatus(run.status),
      currentStage: run.current_stage ?? null,
      error: run.failure_message_safe ?? null,
    },
  });
}

async function readBatchArtifactText(batch: BatchSummary, filename: string): Promise<string | null> {
  const artifact = batch.artifacts.find((item) => item.filename === filename);
  if (!artifact) return null;
  const content = await readWwxArtifact(artifact.id).catch(() => null);
  return content?.contentText?.trim() || null;
}

async function readProductResearchFiles(product: ProductSummary): Promise<{ archetypes?: string; hotwords?: string; mechanisms?: string } | undefined> {
  const allArtifacts = [
    ...(product.researchArtifacts ?? []),
    ...(product.researchRuns ?? []).flatMap((run) => run.artifacts ?? []),
  ];
  const files: { archetypes?: string; hotwords?: string; mechanisms?: string } = {};
  for (const key of ["archetypes", "hotwords", "mechanisms"] as const) {
    const artifact = allArtifacts.find((item) => basename(item.filename ?? item.label) === `${key}.md`);
    if (!artifact) continue;
    const content = await readWwxArtifact(artifact.id).catch(() => null);
    const text = content?.contentText?.trim();
    if (text) files[key] = text;
  }
  return files.archetypes || files.hotwords || files.mechanisms ? files : undefined;
}

function basename(value: string | undefined): string {
  const parts = (value ?? "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function inferRequestedAdCount(batch: BatchSummary, strategyJson: string | null): number {
  const parsed = strategyJson ? safeJson(strategyJson) : null;
  const ads = parsed && Array.isArray(parsed.ads) ? parsed.ads.length : 0;
  const total = batch.totalScripts ?? batch.decisionCounts?.ship ?? 0;
  return Math.max(1, ads || total || 1);
}

async function hostedRequest<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const baseUrl = wwxApiUrl();
  if (!baseUrl) throw new Error("Hosted API is not configured.");
  const headers = {
    ...await wwxAuthHeaders(),
    "content-type": "application/json",
  };
  const response = await invoke<{ status: number; headers: Record<string, string>; body: number[] }>("ai_http_request", {
    url: `${baseUrl}${path}`,
    method: options.method ?? "GET",
    headers,
    body: options.body ? Array.from(new TextEncoder().encode(JSON.stringify(options.body))) : undefined,
  });
  const text = new TextDecoder().decode(Uint8Array.from(response.body));
  if (response.status === 426) throw new Error("wwworkbench must be updated before using the hosted runtime.");
  if (response.status < 200 || response.status >= 300) throw new Error(safeError(text, response.status));
  return text ? JSON.parse(text) as T : {} as T;
}

function safeError(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: string };
    return parsed.error ?? `Hosted request failed with ${status}.`;
  } catch {
    return `Hosted request failed with ${status}.`;
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function toLocalStatus(status: string): string {
  if (status === "succeeded" || status === "complete") return "complete";
  if (status === "failed" || status === "quarantined" || status === "cancelled") return "blocked";
  if (status === "queued" || status === "running") return "running";
  return "running";
}

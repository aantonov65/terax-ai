import type { CreateAdsInput } from "./model.js";

export function createAdsInputFromWorkflow(input: {
  productId?: string | null;
  batchId?: string | null;
  payload?: Record<string, unknown>;
}): CreateAdsInput {
  const payload = input.payload ?? {};
  const productId = stringValue(input.productId) ?? stringValue(payload.productId) ?? stringValue(payload.product_id);
  if (!productId) throw new Error("PRODUCT_ID_REQUIRED");
  const adCount = numberValue(payload.adCount) ?? numberValue(payload.ad_count) ?? 1;
  return {
    productId,
    batchId: stringValue(input.batchId) ?? stringValue(payload.batchId) ?? stringValue(payload.batch_id) ?? undefined,
    batchName: stringValue(payload.batchName) ?? stringValue(payload.batch_name) ?? undefined,
    adCount,
    selectedResearchRunIds: stringArray(payload.selectedResearchRunIds ?? payload.selected_research_run_ids),
    formats: stringArray(payload.formats),
    constraints: stringArray(payload.constraints),
    swipes: stringArray(payload.swipes),
    assetNeeds: stringArray(payload.assetNeeds ?? payload.asset_needs),
    launchNotes: stringValue(payload.launchNotes) ?? stringValue(payload.launch_notes) ?? undefined,
    strategyJson: objectOrString(payload.strategyJson ?? payload.strategy_json),
    strategyPath: stringValue(payload.strategyPath) ?? stringValue(payload.strategy_path) ?? undefined,
    anglesMarkdown: stringValue(payload.anglesMarkdown) ?? stringValue(payload.angles_markdown) ?? undefined,
    configJson: objectOrString(payload.configJson ?? payload.config_json),
    researchFiles: researchFiles(payload.researchFiles ?? payload.research_files),
    runMode: payload.runMode === "app_step" || payload.runMode === "full" ? payload.runMode : "full",
    workers: numberValue(payload.workers),
    generationWorkers: numberValue(payload.generationWorkers ?? payload.generation_workers),
    chunkSize: numberValue(payload.chunkSize ?? payload.chunk_size),
    chunkConcurrency: numberValue(payload.chunkConcurrency ?? payload.chunk_concurrency),
    fromStage: stringValue(payload.fromStage) ?? stringValue(payload.from_stage) ?? undefined,
    taskIds: stringArray(payload.taskIds ?? payload.task_ids),
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  return out.length ? out : undefined;
}

function objectOrString(value: unknown): Record<string, unknown> | string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function researchFiles(value: unknown): CreateAdsInput["researchFiles"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const files = {
    archetypes: stringValue(raw.archetypes) ?? undefined,
    hotwords: stringValue(raw.hotwords) ?? undefined,
    mechanisms: stringValue(raw.mechanisms) ?? undefined,
  };
  return files.archetypes || files.hotwords || files.mechanisms ? files : undefined;
}

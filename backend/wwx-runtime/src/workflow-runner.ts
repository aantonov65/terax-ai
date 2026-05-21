import type { WorkflowType } from "../../../packages/observability/src/index.js";
import { captureRuntimeException } from "./sentry.js";
import { LegacyLfs41Engine } from "./engine.js";
import { createRuntimeFromEnv, type RuntimeParts } from "./runtime.js";
import { RuntimeWorker } from "./worker.js";
import { createAdsInputFromWorkflow } from "./workflow-input.js";

export type WorkflowTaskPayload = {
  runId: string;
  workspaceId: string;
  createdByUserId: string;
  workflowType: WorkflowType;
  correlationId: string;
  input?: Record<string, unknown>;
  jobId?: string;
};

export type WorkflowTaskResult = {
  ok: boolean;
  runId: string;
  workflowType: WorkflowType;
  batchId?: string | null;
  status: string;
  publicArtifactCount?: number;
};

export async function executeWorkflowTask(
  payload: WorkflowTaskPayload,
  runtime: RuntimeParts = createRuntimeFromEnv(),
): Promise<WorkflowTaskResult> {
  if (payload.workflowType === "lfs_ads") {
    return executeLfsAdsTask(payload, runtime);
  }
  if (payload.workflowType === "research") {
    return executeResearchTask(payload, runtime);
  }
  if (payload.workflowType === "strategy") {
    return executeStrategyTask(payload, runtime);
  }
  await runtime.observability.markRunFailed(payload.runId, "workflow_not_implemented", "Workflow type is not implemented yet.");
  return {
    ok: false,
    runId: payload.runId,
    workflowType: payload.workflowType,
    status: "failed",
  };
}

async function executeResearchTask(
  payload: WorkflowTaskPayload,
  runtime: RuntimeParts,
): Promise<WorkflowTaskResult> {
  const productId = stringValue(payload.input?.productId) ?? stringValue(payload.input?.product_id);
  const topic = stringValue(payload.input?.topic);
  const researchRunId = stringValue(payload.input?.researchRunId) ?? stringValue(payload.input?.research_run_id);
  if (!productId || !topic) {
    await runtime.observability.markRunFailed(payload.runId, "invalid_input", "Research requires product and topic.");
    return { ok: false, runId: payload.runId, workflowType: "research", status: "failed" };
  }
  const storedProduct = await findStoredProduct(runtime, payload.workspaceId, productId);
  const stage = await runtime.observability.startStage({ runId: payload.runId, stageName: "research", provider: "ww-2" });
  const startedAt = Date.now();
  try {
    if (!(runtime.engine instanceof LegacyLfs41Engine)) {
      if (researchRunId) {
        await runtime.service.completeResearchRun(
          payload.workspaceId,
          researchRunId,
          stringArray(payload.input?.searchTerms ?? payload.input?.search_terms),
        );
      } else {
        await runtime.service.startResearchRun(payload.workspaceId, productId, topic, stringArray(payload.input?.searchTerms ?? payload.input?.search_terms));
      }
      await runtime.observability.completeStage({ stageId: stage.id, durationMs: Date.now() - startedAt });
      await runtime.observability.markRunCompleted(payload.runId);
      return { ok: true, runId: payload.runId, workflowType: "research", status: "succeeded" };
    }
    await runtime.service.store.ensureProduct(
      payload.workspaceId,
      productId,
      stringValue(payload.input?.productName) ?? storedProduct?.name ?? productId,
      objectValue(payload.input?.configJson ?? payload.input?.config_json) ?? storedProduct?.config,
    );
    const result = runtime.engine.runResearchPipeline({
      productId,
      productCode: stringValue(payload.input?.productCode) ?? stringValue(payload.input?.product_code) ?? undefined,
      productName: stringValue(payload.input?.productName) ?? stringValue(payload.input?.product_name) ?? storedProduct?.name ?? undefined,
      configJson: objectOrString(payload.input?.configJson ?? payload.input?.config_json) ?? storedProduct?.config,
      topic,
      searchTerms: stringArray(payload.input?.searchTerms ?? payload.input?.search_terms),
    });
    const researchRun = researchRunId
      ? await runtime.service.completeResearchRun(payload.workspaceId, researchRunId, result.searchTerms, result.quality)
      : await runtime.service.startResearchRun(payload.workspaceId, productId, topic, result.searchTerms, "complete", result.quality);
    await runtime.service.store.ensureBatch(payload.workspaceId, productId, { productId, batchId: productId, batchName: `Research: ${productId}`, adCount: 1 });
    for (const item of result.items) {
      const artifact = await runtime.service.publishArtifact(payload.workspaceId, productId, item);
      await runtime.observability.recordArtifact({
        runId: payload.runId,
        productId,
        batchId: productId,
        createdByUserId: payload.createdByUserId,
        workflowType: "research",
        artifactType: item.filename,
        status: "uploaded",
        sizeBytes: Buffer.byteLength(item.content),
        storageRefId: artifact.id,
        publicExportAllowed: artifact.visibilityClass.startsWith("public_"),
        textForLeakScan: artifact.visibilityClass.startsWith("public_") ? item.content : null,
      });
    }
    await runtime.observability.emitRunEvent({
      runId: payload.runId,
      stageId: stage.id,
      eventType: "research_completed",
      messageSafe: "Research completed",
      metadataSafe: { research_run_id: researchRun.id, artifact_count: result.items.length, quality: result.quality },
    });
    await runtime.observability.completeStage({ stageId: stage.id, durationMs: Date.now() - startedAt });
    await runtime.observability.markRunCompleted(payload.runId);
    return { ok: true, runId: payload.runId, workflowType: "research", status: "succeeded", publicArtifactCount: 0 };
  } catch (error) {
    if (researchRunId) await runtime.service.failResearchRun(payload.workspaceId, researchRunId).catch(() => undefined);
    await runtime.observability.failStage({
      stageId: stage.id,
      durationMs: Date.now() - startedAt,
      errorCategory: "research_failed",
      errorCode: error instanceof Error ? error.message.split(":")[0] : "RESEARCH_FAILED",
      errorMessageSafe: "Research workflow failed.",
    });
    await runtime.observability.markRunFailed(payload.runId, "research_failed", "Research workflow failed.");
    throw error;
  }
}

async function executeStrategyTask(
  payload: WorkflowTaskPayload,
  runtime: RuntimeParts,
): Promise<WorkflowTaskResult> {
  const productId = stringValue(payload.input?.productId) ?? stringValue(payload.input?.product_id);
  const batchId = stringValue(payload.input?.batchId) ?? stringValue(payload.input?.batch_id);
  const strategyPlanJson = payload.input?.strategyPlanJson ?? payload.input?.strategy_plan_json;
  if (!productId || !batchId || !strategyPlanJson) {
    await runtime.observability.markRunFailed(payload.runId, "invalid_input", "Strategy requires product, batch, and creative guidance.");
    return { ok: false, runId: payload.runId, workflowType: "strategy", status: "failed", batchId };
  }
  const storedProduct = await findStoredProduct(runtime, payload.workspaceId, productId);
  const stage = await runtime.observability.startStage({ runId: payload.runId, stageName: "strategy", provider: "ww-2" });
  const startedAt = Date.now();
  try {
    await runtime.service.store.ensureProduct(
      payload.workspaceId,
      productId,
      stringValue(payload.input?.productName) ?? storedProduct?.name ?? productId,
      objectValue(payload.input?.configJson ?? payload.input?.config_json) ?? storedProduct?.config,
    );
    await runtime.service.store.ensureBatch(payload.workspaceId, batchId, { productId, batchId, batchName: stringValue(payload.input?.batchName) ?? batchId, adCount: numberValue(payload.input?.adCount ?? payload.input?.ad_count) ?? 1 });
    if (!(runtime.engine instanceof LegacyLfs41Engine)) {
      await runtime.service.publishArtifact(payload.workspaceId, batchId, {
        stage: "strategy",
        itemKey: "strategy-json",
        filename: "strategy.json",
        label: "Strategy JSON",
        visibilityClass: "engine_secret",
        mimeType: "application/json",
        content: stringifyJson(strategyPlanJson),
      });
      await runtime.observability.completeStage({ stageId: stage.id, durationMs: Date.now() - startedAt });
      await runtime.observability.markRunCompleted(payload.runId);
      return { ok: true, runId: payload.runId, workflowType: "strategy", batchId, status: "succeeded" };
    }
    const result = runtime.engine.runStrategyBuild({
      productId,
      batchId,
      productCode: stringValue(payload.input?.productCode) ?? stringValue(payload.input?.product_code) ?? undefined,
      productName: stringValue(payload.input?.productName) ?? stringValue(payload.input?.product_name) ?? storedProduct?.name ?? undefined,
      configJson: objectOrString(payload.input?.configJson ?? payload.input?.config_json) ?? storedProduct?.config,
      strategyPlanJson: objectOrString(strategyPlanJson) ?? stringifyJson(strategyPlanJson),
      researchFiles: researchFiles(payload.input?.researchFiles ?? payload.input?.research_files),
      force: true,
    });
    for (const item of result.items) {
      const artifact = await runtime.service.publishArtifact(payload.workspaceId, batchId, item);
      await runtime.observability.recordArtifact({
        runId: payload.runId,
        productId,
        batchId,
        createdByUserId: payload.createdByUserId,
        workflowType: "strategy",
        artifactType: item.filename,
        status: "uploaded",
        sizeBytes: Buffer.byteLength(item.content),
        storageRefId: artifact.id,
        publicExportAllowed: artifact.visibilityClass.startsWith("public_"),
        textForLeakScan: artifact.visibilityClass.startsWith("public_") ? item.content : null,
      });
    }
    await runtime.observability.completeStage({ stageId: stage.id, durationMs: Date.now() - startedAt });
    await runtime.observability.markRunCompleted(payload.runId);
    return { ok: true, runId: payload.runId, workflowType: "strategy", batchId, status: "succeeded" };
  } catch (error) {
    await runtime.observability.failStage({
      stageId: stage.id,
      durationMs: Date.now() - startedAt,
      errorCategory: "strategy_failed",
      errorCode: error instanceof Error ? error.message.split(":")[0] : "STRATEGY_FAILED",
      errorMessageSafe: "Strategy workflow failed.",
    });
    await runtime.observability.markRunFailed(payload.runId, "strategy_failed", "Strategy workflow failed.");
    throw error;
  }
}

async function executeLfsAdsTask(
  payload: WorkflowTaskPayload,
  runtime: RuntimeParts,
): Promise<WorkflowTaskResult> {
  const jobIdFromPayload = payload.jobId ?? stringValue(payload.input?.jobId) ?? stringValue(payload.input?.job_id);
  const input = jobIdFromPayload ? null : createAdsInputFromWorkflow({ payload: payload.input });
  const batchId = stringValue(payload.input?.batchId) ?? stringValue(payload.input?.batch_id) ?? input?.batchId ?? payload.runId;
  try {
    const jobId = jobIdFromPayload ?? (await runtime.service.createAds(payload.workspaceId, batchId, input!)).job.id;
    const worker = new RuntimeWorker(
      `trigger-${payload.runId}`,
      runtime.store,
      runtime.service,
      runtime.engine,
      {},
      {
        observability: runtime.observability,
        workflowRunId: payload.runId,
        createdByUserId: payload.createdByUserId,
        workflowType: "lfs_ads",
      },
    );
    const ran = await worker.runJob(jobId);
    if (!ran) throw new Error("LFS_JOB_NOT_CLAIMED");
    const status = await runtime.service.getBatchStatus(payload.workspaceId, batchId);
    if (!status) throw new Error("BATCH_STATUS_MISSING");
    if (status.batch.status === "complete") {
      await runtime.observability.markRunCompleted(payload.runId);
    } else if (status.batch.status === "stopped") {
      await runtime.observability.markRunCancelled(payload.runId, "operator_stop_requested", "Run stopped.");
    } else if (status.batch.status === "failed") {
      await runtime.observability.markRunFailed(payload.runId, "workflow_failed", "Run failed.");
    }
    return {
      ok: status.batch.status === "complete",
      runId: payload.runId,
      workflowType: "lfs_ads",
      batchId,
      status: status.batch.status,
      publicArtifactCount: status.artifacts.length,
    };
  } catch (error) {
    captureRuntimeException(error, {
      run_id: payload.runId,
      workflow_type: payload.workflowType,
      stage_name: "lfs_ads",
      correlation_id: payload.correlationId,
    });
    await runtime.observability.markRunFailed(payload.runId, "workflow_failed", "Hosted LFS run failed.");
    throw error;
  }
}

async function findStoredProduct(runtime: RuntimeParts, workspaceId: string, productId: string) {
  return (await runtime.service.store.listProducts(workspaceId)).find((product) => product.id === productId) ?? null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function objectOrString(value: unknown): Record<string, unknown> | string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function stringifyJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function researchFiles(value: unknown): { archetypes?: string; hotwords?: string; mechanisms?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    archetypes: stringValue(record.archetypes) ?? undefined,
    hotwords: stringValue(record.hotwords) ?? undefined,
    mechanisms: stringValue(record.mechanisms) ?? undefined,
  };
}

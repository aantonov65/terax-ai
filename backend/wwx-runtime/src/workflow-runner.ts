import type { WorkflowType } from "../../../packages/observability/src/index.js";
import { captureRuntimeException } from "./sentry.js";
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
  await runtime.observability.markRunFailed(payload.runId, "workflow_not_implemented", "Workflow type is not implemented yet.");
  return {
    ok: false,
    runId: payload.runId,
    workflowType: payload.workflowType,
    status: "failed",
  };
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

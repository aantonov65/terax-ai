import { logger, task } from "@trigger.dev/sdk";
import { createRuntimeFromEnv } from "../backend/wwx-runtime/src/runtime.js";
import { executeWorkflowTask, type WorkflowTaskPayload } from "../backend/wwx-runtime/src/workflow-runner.js";

export const lfsAdsTask = task({
  id: "wwx.lfs_ads",
  queue: {
    name: "lfs_ads",
    concurrencyLimit: Number.parseInt(process.env.TRIGGER_LFS_CONCURRENCY ?? "1", 10),
  },
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: WorkflowTaskPayload) => {
    logger.info("Starting WWX LFS ads workflow", {
      runId: payload.runId,
      workflowType: payload.workflowType,
      correlationId: payload.correlationId,
    });
    return executeWorkflowTask({ ...payload, workflowType: "lfs_ads" }, createDurableRuntime());
  },
});

export const researchTask = task({
  id: "wwx.research",
  queue: {
    name: "research",
    concurrencyLimit: Number.parseInt(process.env.TRIGGER_RESEARCH_CONCURRENCY ?? "1", 10),
  },
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 10_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: WorkflowTaskPayload) => {
    logger.info("Starting WWX research workflow", {
      runId: payload.runId,
      workflowType: payload.workflowType,
      correlationId: payload.correlationId,
    });
    return executeWorkflowTask({ ...payload, workflowType: "research" }, createDurableRuntime());
  },
});

export const strategyTask = task({
  id: "wwx.strategy",
  queue: {
    name: "strategy",
    concurrencyLimit: Number.parseInt(process.env.TRIGGER_STRATEGY_CONCURRENCY ?? "1", 10),
  },
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: WorkflowTaskPayload) => {
    logger.info("Starting WWX strategy workflow", {
      runId: payload.runId,
      workflowType: payload.workflowType,
      correlationId: payload.correlationId,
    });
    return executeWorkflowTask({ ...payload, workflowType: "strategy" }, createDurableRuntime());
  },
});

export const imageBatchTask = placeholderTask("wwx.image_batch", "image_batch");
export const modularVideoTask = placeholderTask("wwx.modular_video", "modular_video");
export const avatarVideoTask = placeholderTask("wwx.avatar_video", "avatar_video");
export const lpRipTask = placeholderTask("wwx.lp_rip", "lp_rip");
export const metaUploadTask = placeholderTask("wwx.meta_upload", "meta_upload");
export const handoffExportTask = placeholderTask("wwx.handoff_export", "handoff_export");

function placeholderTask(id: string, queueName: string) {
  return task({
    id,
    queue: {
      name: queueName,
      concurrencyLimit: 1,
    },
    retry: {
      maxAttempts: 1,
    },
    run: async (payload: WorkflowTaskPayload) => {
      logger.warn("Workflow task is registered but not implemented yet", {
        runId: payload.runId,
        workflowType: payload.workflowType,
      });
      return executeWorkflowTask(payload, createDurableRuntime());
    },
  });
}

function createDurableRuntime() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL_REQUIRED_FOR_TRIGGER_RUNTIME");
  }
  return createRuntimeFromEnv();
}

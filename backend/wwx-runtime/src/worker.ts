import type { Engine } from "./engine.js";
import type { RuntimeService } from "./service.js";
import type { ClaimedJob, Store } from "./store.js";
import type { CreateAdsInput, EngineWorkItem, StageWorkItem } from "./model.js";
import type { ObservabilityClient, StageRecord, WorkflowType } from "../../../packages/observability/src/index.js";

const LEASE_MS = 30_000;

export type RuntimeWorkerHooks = {
  afterArtifactPublished?: (input: {
    workspaceId: string;
    batchId: string;
    stage: string;
    itemKey: string;
    artifactId: string;
  }) => Promise<void> | void;
};

export type RuntimeWorkerTelemetry = {
  observability: ObservabilityClient;
  workflowRunId: string;
  createdByUserId: string;
  workflowType: WorkflowType;
};

export class RuntimeWorker {
  constructor(
    private readonly workerId: string,
    private readonly store: Store,
    private readonly service: RuntimeService,
    private readonly engine: Engine,
    private readonly hooks: RuntimeWorkerHooks = {},
    private readonly telemetry: RuntimeWorkerTelemetry | null = null,
  ) {}

  async runOne(): Promise<boolean> {
    const claim = await this.store.claimNextJob(this.workerId, LEASE_MS);
    if (!claim) return false;
    try {
      await this.processClaim(claim);
      return true;
    } catch (error) {
      await this.store.failJob(claim.id, claim.run.id, String(error));
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type: "run_failed",
        stage: claim.run.currentStage,
        message: "Run failed",
        payload: { reason: String(error) },
      });
      return true;
    }
  }

  async runJob(jobId: string): Promise<boolean> {
    const claim = await this.store.claimJob(jobId, this.workerId, LEASE_MS);
    if (!claim) return false;
    try {
      await this.processClaim(claim);
      return true;
    } catch (error) {
      await this.store.failJob(claim.id, claim.run.id, String(error));
      await this.telemetry?.observability.markRunFailed(this.telemetry.workflowRunId, "workflow_failed", "Run failed.");
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type: "run_failed",
        stage: claim.run.currentStage,
        message: "Run failed",
        payload: { reason: String(error) },
      });
      return true;
    }
  }

  private async processClaim(claim: ClaimedJob): Promise<void> {
    const input = claim.payload as CreateAdsInput;
    await this.store.appendEvent({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      type: "run_started",
      stage: null,
      message: claim.type === "continue_batch" ? "Run resumed" : "Run started",
      payload: { jobId: claim.id },
    });
    if (this.telemetry) {
      await this.telemetry.observability.emitRunEvent({
        runId: this.telemetry.workflowRunId,
        eventType: claim.type === "continue_batch" ? "run_resumed" : "run_started",
        messageSafe: claim.type === "continue_batch" ? "Run resumed" : "Run started",
        metadataSafe: { batch_id: claim.batchId },
      });
    }
    await this.store.setStageState({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      stage: "lfs_generation",
      status: "running",
      expectedItems: expectedAdCount(input),
      completedItems: await this.completedCount(claim.workspaceId, claim.batchId, "lfs_generation"),
    });
    const heartbeat = this.startHeartbeat(claim);
    let items: EngineWorkItem[];
    try {
      items = await this.engine.planCreateAds(input);
    } finally {
      clearInterval(heartbeat);
    }
    await this.runStage(claim, "lfs_generation", items);
    if (await this.store.shouldStop(claim.workspaceId, claim.batchId)) {
      await this.stopClaim(claim, "Stopped after lfs_generation");
      return;
    }
    let publishStage: StageRecord | null = null;
    if (this.telemetry) {
      publishStage = await this.telemetry.observability.startStage({
        runId: this.telemetry.workflowRunId,
        stageName: "publish_indexes",
        provider: "wwx-runtime",
      });
    }
    await this.service.publishIndexes(claim.workspaceId, claim.batchId);
    if (this.telemetry) {
      const publicArtifacts = await this.store.listPublicArtifacts(claim.workspaceId, claim.batchId);
      for (const artifact of publicArtifacts.filter((item) =>
        item.filename === "ad-analysis-index.json" ||
        item.filename === "asset-inputs.json" ||
        item.filename === "batch-summary.json"
      )) {
        const text = await this.store.getArtifactContent(artifact.id);
        await this.telemetry.observability.recordArtifact({
          runId: this.telemetry.workflowRunId,
          productId: inputProductId(claim.payload),
          batchId: claim.batchId,
          createdByUserId: this.telemetry.createdByUserId,
          workflowType: this.telemetry.workflowType,
          artifactType: artifact.filename,
          status: "uploaded",
          sizeBytes: artifact.size,
          storageRefId: `artifact:${artifact.id}`,
          publicExportAllowed: true,
          textForLeakScan: text,
          metadataForLeakScan: {
            artifact_id: artifact.id,
            filename: artifact.filename,
            visibility_class: artifact.visibilityClass,
          },
        });
      }
      if (publishStage) {
        await this.telemetry.observability.completeStage({ stageId: publishStage.id });
      }
    }
    await this.store.setStageState({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      stage: "publish_indexes",
      status: "succeeded",
      expectedItems: 3,
      completedItems: 3,
    });
    await this.store.appendEvent({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      type: "run_completed",
      stage: "publish_indexes",
      message: "Run completed",
      payload: {},
    });
    if (this.telemetry) {
      await this.telemetry.observability.markRunCompleted(this.telemetry.workflowRunId);
    }
    await this.store.completeJob(claim.id, claim.run.id, "complete");
  }

  private async runStage(claim: ClaimedJob, stage: string, items: EngineWorkItem[]): Promise<void> {
    let telemetryStage: StageRecord | null = null;
    await this.store.setStageState({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      stage,
      status: "running",
      expectedItems: items.length,
      completedItems: await this.completedCount(claim.workspaceId, claim.batchId, stage),
    });
    await this.store.appendEvent({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      type: "stage_started",
      stage,
      message: "Stage started",
      payload: { expectedItems: items.length },
    });
    if (this.telemetry) {
      telemetryStage = await this.telemetry.observability.startStage({
        runId: this.telemetry.workflowRunId,
        stageName: stage,
        provider: "lfs4.1",
      });
    }
    for (const item of items) {
      const work = await this.ensureWorkItem(claim, item);
      if (work.status === "succeeded") continue;
      if (await this.store.shouldStop(claim.workspaceId, claim.batchId)) {
        await this.store.updateWorkItemStatus(claim.workspaceId, claim.batchId, stage, item.itemKey, "canceled");
        if (telemetryStage) {
          await this.telemetry?.observability.failStage({
            stageId: telemetryStage.id,
            errorCategory: "operator_stop_requested",
            errorMessageSafe: "Stop requested before work item.",
          });
        }
        await this.stopClaim(claim, `Stopped before ${item.itemKey}`);
        return;
      }
      await this.store.updateWorkItemStatus(claim.workspaceId, claim.batchId, stage, item.itemKey, "running");
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type: "work_item_started",
        stage,
        message: `Started ${item.itemKey}`,
        payload: { itemKey: item.itemKey },
      });
      if (this.telemetry) {
        await this.telemetry.observability.emitRunEvent({
          runId: this.telemetry.workflowRunId,
          stageId: telemetryStage?.id ?? null,
          eventType: "work_item_started",
          messageSafe: `Started ${item.itemKey}`,
          metadataSafe: { item_key: item.itemKey, stage_name: stage },
        });
      }
      const artifact = await this.service.publishArtifact(claim.workspaceId, claim.batchId, item);
      await this.store.updateWorkItemStatus(claim.workspaceId, claim.batchId, stage, item.itemKey, "succeeded", artifact.id);
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type: "artifact_published",
        stage,
        message: "Artifact published",
        payload: { artifactId: artifact.id, filename: artifact.filename, visibilityClass: artifact.visibilityClass },
      });
      if (this.telemetry) {
        await this.telemetry.observability.recordArtifact({
          runId: this.telemetry.workflowRunId,
          productId: inputProductId(claim.payload),
          batchId: claim.batchId,
          createdByUserId: this.telemetry.createdByUserId,
          workflowType: this.telemetry.workflowType,
          artifactType: artifact.filename,
          status: "uploaded",
          sizeBytes: artifact.size,
          storageRefId: `artifact:${artifact.id}`,
          publicExportAllowed: artifact.visibilityClass.startsWith("public_"),
          textForLeakScan: artifact.visibilityClass.startsWith("public_") ? item.content : null,
          metadataForLeakScan: {
            artifact_id: artifact.id,
            filename: artifact.filename,
            visibility_class: artifact.visibilityClass,
          },
        });
        await this.telemetry.observability.emitRunEvent({
          runId: this.telemetry.workflowRunId,
          stageId: telemetryStage?.id ?? null,
          eventType: "artifact_published",
          messageSafe: "Artifact published",
          metadataSafe: {
            artifact_id: artifact.id,
            filename: artifact.filename,
            visibility_class: artifact.visibilityClass,
          },
        });
      }
      await this.hooks.afterArtifactPublished?.({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        stage,
        itemKey: item.itemKey,
        artifactId: artifact.id,
      });
      await this.store.heartbeatJob(claim.id, claim.run.id, this.workerId, LEASE_MS);
    }
    const completedItems = await this.completedCount(claim.workspaceId, claim.batchId, stage);
    await this.store.setStageState({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      stage,
      status: completedItems === items.length ? "succeeded" : "canceled",
      expectedItems: items.length,
      completedItems,
    });
    await this.store.appendEvent({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      type: "stage_completed",
      stage,
      message: "Stage completed",
      payload: { expectedItems: items.length, completedItems },
    });
    if (telemetryStage) {
      await this.telemetry?.observability.completeStage({
        stageId: telemetryStage.id,
      });
    }
  }

  private async ensureWorkItem(claim: ClaimedJob, item: EngineWorkItem): Promise<StageWorkItem> {
    const existing = (await this.store.listWorkItems(claim.workspaceId, claim.batchId, item.stage))
      .find((work) => work.itemKey === item.itemKey);
    if (existing) return existing;
    return this.store.upsertWorkItem({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      stage: item.stage,
      itemKey: item.itemKey,
      status: "pending",
      artifactId: null,
      idempotencyKey: `${claim.workspaceId}:${claim.batchId}:${item.stage}:${item.itemKey}`,
    });
  }

  private async completedCount(workspaceId: string, batchId: string, stage: string): Promise<number> {
    return (await this.store.listWorkItems(workspaceId, batchId, stage))
      .filter((item) => item.status === "succeeded").length;
  }

  private async stopClaim(claim: ClaimedJob, reason: string): Promise<void> {
    await this.store.appendEvent({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      type: "run_stopped",
      stage: claim.run.currentStage,
      message: reason,
      payload: {},
    });
    if (this.telemetry) {
      await this.telemetry.observability.markRunCancelled(this.telemetry.workflowRunId, "operator_stop_requested", reason);
    }
    await this.store.completeJob(claim.id, claim.run.id, "stopped");
  }

  private startHeartbeat(claim: ClaimedJob): ReturnType<typeof setInterval> {
    const interval = setInterval(() => {
      void this.store.heartbeatJob(claim.id, claim.run.id, this.workerId, LEASE_MS).catch(() => {
        // Best-effort lease extension while a legacy engine subprocess is running.
      });
    }, Math.max(5_000, Math.floor(LEASE_MS / 3)));
    interval.unref?.();
    return interval;
  }
}

function inputProductId(payload: Record<string, unknown>): string | null {
  const value = payload.productId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function expectedAdCount(input: CreateAdsInput): number {
  const raw = typeof input.strategyJson === "string" ? safeJson(input.strategyJson) : input.strategyJson;
  const ads = raw?.ads;
  if (Array.isArray(ads) && ads.length > 0) return ads.length;
  return Math.max(1, Math.min(input.adCount || 1, 50));
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

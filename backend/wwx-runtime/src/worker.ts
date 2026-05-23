import { EngineRunError, type Engine, type EngineProgressEvent } from "./engine.js";
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
    const telemetryGenerationStage = this.telemetry
      ? await this.telemetry.observability.startStage({
          runId: this.telemetry.workflowRunId,
          stageName: "lfs_generation",
          provider: "lfs4.1",
        })
      : null;
    const heartbeat = this.startHeartbeat(claim);
    try {
      if (this.engine.streamCreateAds) {
        await this.runStreamingStage(claim, "lfs_generation", input, telemetryGenerationStage);
      } else {
        const items = await this.engine.planCreateAds(input, {
          onProgress: (event) => this.handleEngineProgress(claim, event, telemetryGenerationStage),
        });
        await this.runStage(claim, "lfs_generation", items, telemetryGenerationStage, expectedAdCount(input));
      }
    } catch (error) {
      await this.store.setStageState({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        stage: "lfs_generation",
        status: "failed",
        expectedItems: expectedAdCount(input),
        completedItems: await this.completedCount(claim.workspaceId, claim.batchId, "lfs_generation"),
      });
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type: "run_failed",
        stage: "lfs_generation",
        message: "LFS generation failed",
        payload: engineFailurePayload(error),
      });
      if (telemetryGenerationStage) {
        await this.telemetry?.observability.failStage({
          stageId: telemetryGenerationStage.id,
          errorCategory: "lfs_generation_failed",
          errorCode: error instanceof Error ? error.message.split(":")[0] : "LFS_GENERATION_FAILED",
          errorMessageSafe: "LFS generation failed.",
        });
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
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

  private async runStage(
    claim: ClaimedJob,
    stage: string,
    items: EngineWorkItem[],
    existingTelemetryStage: StageRecord | null = null,
    expectedItems = items.length,
  ): Promise<void> {
    let telemetryStage: StageRecord | null = existingTelemetryStage;
    await this.store.setStageState({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      stage,
      status: "running",
      expectedItems,
      completedItems: await this.completedCount(claim.workspaceId, claim.batchId, stage),
    });
    await this.store.appendEvent({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      type: "stage_started",
      stage,
      message: "Stage started",
      payload: { expectedItems },
    });
    if (this.telemetry && !telemetryStage) {
      telemetryStage = await this.telemetry.observability.startStage({
        runId: this.telemetry.workflowRunId,
        stageName: stage,
        provider: "lfs4.1",
      });
    }
    const stopped = await this.publishItems(claim, stage, items, telemetryStage, expectedItems);
    if (stopped) return;
    const completedItems = await this.completedCount(claim.workspaceId, claim.batchId, stage);
    await this.store.setStageState({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      stage,
      status: completedItems === expectedItems ? "succeeded" : "canceled",
      expectedItems,
      completedItems,
    });
    await this.store.appendEvent({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      type: "stage_completed",
      stage,
      message: "Stage completed",
      payload: { expectedItems, completedItems },
    });
    if (telemetryStage) {
      await this.telemetry?.observability.completeStage({
        stageId: telemetryStage.id,
      });
    }
  }

  private async runStreamingStage(
    claim: ClaimedJob,
    stage: string,
    input: CreateAdsInput,
    telemetryStage: StageRecord | null,
  ): Promise<void> {
    if (!this.engine.streamCreateAds) throw new Error("STREAMING_ENGINE_UNAVAILABLE");
    const expectedItems = expectedAdCount(input);
    const pendingInput = await this.inputWithPendingAdsOnly(claim, input, stage);
    if (!pendingInput) {
      await this.store.setStageState({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        stage,
        status: "succeeded",
        expectedItems,
        completedItems: expectedItems,
      });
      return;
    }
    await this.store.appendEvent({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      type: "stage_started",
      stage,
      message: "Stage started",
      payload: { expectedItems },
    });
    if (this.telemetry) {
      await this.telemetry.observability.emitRunEvent({
        runId: this.telemetry.workflowRunId,
        stageId: telemetryStage?.id ?? null,
        eventType: "stage_started",
        messageSafe: "Stage started",
        metadataSafe: { stage_name: stage, expected_items: expectedItems },
      });
    }

    for await (const chunk of this.engine.streamCreateAds(pendingInput, {
      onProgress: (event) => this.handleEngineProgress(claim, event, telemetryStage),
    })) {
      const stopped = await this.publishItems(claim, stage, chunk.items, telemetryStage, expectedItems, {
        preserveCompletedChunk: true,
      });
      if (stopped) return;
      const completedItems = await this.completedCount(claim.workspaceId, claim.batchId, stage);
      await this.store.setStageState({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        stage,
        status: "running",
        expectedItems,
        completedItems,
      });
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type: "chunk_completed",
        stage,
        message: `Published chunk ${chunk.index} of ${chunk.total}`,
        payload: {
          chunkIndex: chunk.index,
          chunkTotal: chunk.total,
          expectedItems,
          completedItems,
        },
      });
      if (await this.store.shouldStop(claim.workspaceId, claim.batchId)) {
        if (telemetryStage) {
          await this.telemetry?.observability.failStage({
            stageId: telemetryStage.id,
            errorCategory: "operator_stop_requested",
            errorMessageSafe: "Stop requested after completed chunk was preserved.",
          });
        }
        await this.stopClaim(claim, `Stopped after publishing chunk ${chunk.index}`);
        return;
      }
    }

    const completedItems = await this.completedCount(claim.workspaceId, claim.batchId, stage);
    await this.store.setStageState({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      stage,
      status: completedItems === expectedItems ? "succeeded" : "failed",
      expectedItems,
      completedItems,
    });
    await this.store.appendEvent({
      workspaceId: claim.workspaceId,
      batchId: claim.batchId,
      runId: claim.run.id,
      type: "stage_completed",
      stage,
      message: "Stage completed",
      payload: { expectedItems, completedItems },
    });
    if (completedItems !== expectedItems) {
      throw new Error(`LFS41_INCOMPLETE_OUTPUT:${completedItems}/${expectedItems}`);
    }
    if (telemetryStage) {
      await this.telemetry?.observability.completeStage({ stageId: telemetryStage.id });
    }
  }

  private async publishItems(
    claim: ClaimedJob,
    stage: string,
    items: EngineWorkItem[],
    telemetryStage: StageRecord | null,
    expectedItems: number,
    options: { preserveCompletedChunk?: boolean } = {},
  ): Promise<boolean> {
    for (const item of items) {
      const work = await this.ensureWorkItem(claim, item);
      if (work.status === "succeeded") continue;
      if (!options.preserveCompletedChunk && await this.store.shouldStop(claim.workspaceId, claim.batchId)) {
        await this.store.updateWorkItemStatus(claim.workspaceId, claim.batchId, stage, item.itemKey, "canceled");
        if (telemetryStage) {
          await this.telemetry?.observability.failStage({
            stageId: telemetryStage.id,
            errorCategory: "operator_stop_requested",
            errorMessageSafe: "Stop requested before work item.",
          });
        }
        await this.stopClaim(claim, `Stopped before ${item.itemKey}`);
        return true;
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
      const artifact = await this.service.publishArtifact(claim.workspaceId, claim.batchId, item, claim.run.id);
      await this.store.updateWorkItemStatus(claim.workspaceId, claim.batchId, stage, item.itemKey, "succeeded", artifact.id);
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type: "artifact_published",
        stage,
        message: "Artifact published",
        payload: {
          artifactId: artifact.id,
          filename: artifact.filename,
          visibilityClass: artifact.visibilityClass,
          expectedItems,
          completedItems: await this.completedCount(claim.workspaceId, claim.batchId, stage),
        },
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
    return false;
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

  private async handleEngineProgress(
    claim: ClaimedJob,
    event: EngineProgressEvent,
    telemetryStage: StageRecord | null,
  ): Promise<void> {
    if (event.event === "chunk_started" || event.event === "chunk_finished") {
      const type = event.event === "chunk_started" ? "chunk_started" : "chunk_completed";
      const verb = event.event === "chunk_started" ? "Started" : "Finished";
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type,
        stage: "lfs_generation",
        message: `${verb} chunk ${event.chunkIndex ?? "?"} of ${event.chunkTotal ?? "?"}`,
        payload: safeEngineProgressPayload(event),
      });
      if (this.telemetry) {
        await this.telemetry.observability.emitRunEvent({
          runId: this.telemetry.workflowRunId,
          stageId: telemetryStage?.id ?? null,
          eventType: type,
          messageSafe: `${verb} chunk ${event.chunkIndex ?? "?"} of ${event.chunkTotal ?? "?"}`,
          metadataSafe: safeEngineProgressPayload(event),
        });
      }
      return;
    }

    if (event.event === "ai_call_finished" || event.event === "ai_call_failed") {
      const payload = safeEngineProgressPayload(event);
      const status = event.event === "ai_call_failed" || event.status === "failed" ? "failed" : "succeeded";
      const model = event.model ?? "unknown";
      const costUsd = estimatedAiCostUsd(event);
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type: "engine_ai_call_completed",
        stage: event.stage ?? "lfs_generation",
        message: `${event.stage ?? "LFS"} model call ${status}`,
        payload: { ...payload, cost_usd: costUsd },
      });
      if (this.telemetry) {
        await this.telemetry.observability.recordAiCall({
          runId: this.telemetry.workflowRunId,
          stageId: telemetryStage?.id ?? null,
          provider: event.provider ?? "anthropic",
          model,
          promptTemplateId: event.stage ?? "lfs_generation",
          inputTokens: event.inputTokens ?? 0,
          outputTokens: event.outputTokens ?? 0,
          cachedTokens: event.cachedTokens ?? 0,
          latencyMs: event.latencyMs ?? null,
          costUsd,
          status,
          errorCategory: status === "failed" ? "provider_call_failed" : null,
        });
      }
      return;
    }

    if (event.event === "outline_task_started" || event.event === "outline_task_completed" || event.event === "outline_task_failed" || event.event === "outline_task_validation_failed") {
      const type = event.event === "outline_task_started"
        ? "engine_task_started"
        : event.event === "outline_task_completed"
          ? "engine_task_completed"
          : "engine_task_failed";
      const taskId = event.taskId ?? "outline_task";
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type,
        stage: "lfs_outline",
        message: event.event === "outline_task_validation_failed"
          ? `Outline validation failed for ${taskId}`
          : `Outline ${type.replace("engine_task_", "")} for ${taskId}`,
        payload: safeEngineProgressPayload(event),
      });
      if (this.telemetry) {
        await this.telemetry.observability.emitRunEvent({
          runId: this.telemetry.workflowRunId,
          stageId: telemetryStage?.id ?? null,
          eventType: type,
          messageSafe: event.event === "outline_task_validation_failed"
            ? "Outline validation failed"
            : `Outline ${type.replace("engine_task_", "")}`,
          metadataSafe: safeEngineProgressPayload(event),
        });
      }
      return;
    }

    if (!event.stage) return;
    const payload = safeEngineProgressPayload(event);
    if (event.event === "stage_started") {
      await this.store.setStageState({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        stage: event.stage,
        status: "running",
        expectedItems: event.artifactCount ?? 0,
        completedItems: 0,
      });
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type: "engine_stage_started",
        stage: event.stage,
        message: engineStageLabel(event.stage, "started"),
        payload,
      });
      if (this.telemetry) {
        await this.telemetry.observability.emitRunEvent({
          runId: this.telemetry.workflowRunId,
          stageId: telemetryStage?.id ?? null,
          eventType: "engine_stage_started",
          messageSafe: engineStageLabel(event.stage, "started"),
          metadataSafe: payload,
        });
      }
      return;
    }
    if (event.event === "stage_retrying") {
      const completed = event.completedTasks ?? 0;
      const failed = event.failed ?? 0;
      const pending = event.pendingTasks ?? 0;
      const expected = event.artifactCount ?? Math.max(0, completed + failed + pending);
      await this.store.setStageState({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        stage: event.stage,
        status: "retrying",
        expectedItems: expected,
        completedItems: completed,
      });
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type: "engine_stage_retrying",
        stage: event.stage,
        message: engineStageLabel(event.stage, "retrying"),
        payload,
      });
      if (this.telemetry) {
        await this.telemetry.observability.emitRunEvent({
          runId: this.telemetry.workflowRunId,
          stageId: telemetryStage?.id ?? null,
          eventType: "engine_stage_retrying",
          messageSafe: engineStageLabel(event.stage, "retrying"),
          metadataSafe: payload,
        });
      }
      return;
    }
    if (event.event === "stage_finished") {
      await this.store.setStageState({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        stage: event.stage,
        status: "succeeded",
        expectedItems: event.artifactCount ?? 0,
        completedItems: event.artifactCount ?? 0,
      });
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type: "engine_stage_completed",
        stage: event.stage,
        message: engineStageLabel(event.stage, "completed"),
        payload,
      });
      if (this.telemetry) {
        await this.telemetry.observability.emitRunEvent({
          runId: this.telemetry.workflowRunId,
          stageId: telemetryStage?.id ?? null,
          eventType: "engine_stage_completed",
          messageSafe: engineStageLabel(event.stage, "completed"),
          metadataSafe: payload,
        });
      }
      return;
    }
    if (event.event === "stage_failed") {
      await this.store.setStageState({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        stage: event.stage,
        status: "failed",
        expectedItems: event.artifactCount ?? 0,
        completedItems: 0,
      });
      await this.store.appendEvent({
        workspaceId: claim.workspaceId,
        batchId: claim.batchId,
        runId: claim.run.id,
        type: "engine_stage_failed",
        stage: event.stage,
        message: engineStageLabel(event.stage, "failed"),
        payload,
      });
      if (this.telemetry) {
        await this.telemetry.observability.emitRunEvent({
          runId: this.telemetry.workflowRunId,
          stageId: telemetryStage?.id ?? null,
          eventType: "engine_stage_failed",
          messageSafe: engineStageLabel(event.stage, "failed"),
          metadataSafe: payload,
        });
      }
    }
  }

  private async inputWithPendingAdsOnly(claim: ClaimedJob, input: CreateAdsInput, stage: string): Promise<CreateAdsInput | null> {
    const raw = typeof input.strategyJson === "string" ? safeJson(input.strategyJson) : input.strategyJson;
    const ads = raw?.ads;
    if (!raw || !Array.isArray(ads) || ads.length === 0) return input;
    const succeeded = new Set((await this.store.listWorkItems(claim.workspaceId, claim.batchId, stage))
      .filter((item) => item.status === "succeeded")
      .map((item) => item.itemKey));
    if (!succeeded.size) return input;
    const pendingAds = ads.filter((ad) => {
      const taskId = ad && typeof ad === "object" && !Array.isArray(ad)
        ? (ad as Record<string, unknown>).task_id
        : null;
      return !(typeof taskId === "string" && succeeded.has(taskId));
    });
    const strategyJson = { ...raw, ads: pendingAds, task_ids: pendingAds.map((ad) =>
      ad && typeof ad === "object" && !Array.isArray(ad) ? (ad as Record<string, unknown>).task_id : null
    ).filter((value): value is string => typeof value === "string" && value.trim().length > 0) };
    if (pendingAds.length === 0) return null;
    return { ...input, adCount: pendingAds.length, strategyJson };
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

function engineFailurePayload(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : "LFS_GENERATION_FAILED";
  const payload: Record<string, unknown> = {
    reason_code: message.split(":")[0],
  };
  if (error instanceof EngineRunError) {
    payload.details = {
      status: error.details.status,
      signal: error.details.signal,
    };
    const stderr = typeof error.details.stderr_tail === "string" ? error.details.stderr_tail : "";
    const stageMatch = stderr.match(/LFS agent failed:\s*([^\n]+)/i);
    if (stageMatch?.[1]) {
      payload.failure_stage_safe = stageMatch[1].slice(0, 120);
    }
  }
  return payload;
}

function safeEngineProgressPayload(event: EngineProgressEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    event: event.event,
  };
  if (event.stage) payload.engine_stage = event.stage;
  if (event.batchId) payload.engine_batch_id = event.batchId;
  if (event.chunkIndex) payload.chunk_index = event.chunkIndex;
  if (event.chunkTotal) payload.chunk_total = event.chunkTotal;
  if (event.artifactCount !== undefined) payload.artifact_count = event.artifactCount;
  if (event.itemCount !== undefined) payload.item_count = event.itemCount;
  if (event.durationMs !== undefined) payload.duration_ms = event.durationMs;
  if (event.attempt !== undefined) payload.attempt = event.attempt;
  if (event.failed !== undefined) payload.failed = event.failed;
  if (event.completedTasks !== undefined) payload.completed_tasks = event.completedTasks;
  if (event.pendingTasks !== undefined) payload.pending_tasks = event.pendingTasks;
  if (event.taskId) payload.task_id = event.taskId;
  if (event.provider) payload.provider = event.provider;
  if (event.model) payload.model = event.model;
  if (event.phase) payload.phase = event.phase;
  if (event.promptChars !== undefined) payload.prompt_chars = event.promptChars;
  if (event.promptHash) payload.prompt_hash = event.promptHash;
  if (event.inputTokens !== undefined) payload.input_tokens = event.inputTokens;
  if (event.outputTokens !== undefined) payload.output_tokens = event.outputTokens;
  if (event.cachedTokens !== undefined) payload.cached_tokens = event.cachedTokens;
  if (event.latencyMs !== undefined) payload.latency_ms = event.latencyMs;
  if (event.status) payload.status = event.status;
  if (event.validation && typeof event.validation === "object") payload.validation = event.validation;
  if (event.errors?.length) payload.errors = event.errors;
  if (event.error) payload.error_safe = event.error;
  if (event.reason) payload.reason_safe = event.reason;
  if (event.ts) payload.engine_ts = event.ts;
  return payload;
}

function estimatedAiCostUsd(event: EngineProgressEvent): number {
  const inputTokens = event.inputTokens ?? 0;
  const outputTokens = event.outputTokens ?? 0;
  const cachedTokens = event.cachedTokens ?? 0;
  const inputRate = Number(process.env.ANTHROPIC_INPUT_USD_PER_MTOK ?? "3");
  const outputRate = Number(process.env.ANTHROPIC_OUTPUT_USD_PER_MTOK ?? "15");
  const cachedRate = Number(process.env.ANTHROPIC_CACHE_READ_USD_PER_MTOK ?? String(inputRate * 0.1));
  const cost = ((inputTokens / 1_000_000) * inputRate) + ((outputTokens / 1_000_000) * outputRate) + ((cachedTokens / 1_000_000) * cachedRate);
  return Number.isFinite(cost) ? Number(cost.toFixed(8)) : 0;
}

function engineStageLabel(stage: string, status: "started" | "retrying" | "completed" | "failed"): string {
  const label = ENGINE_STAGE_LABELS[stage] ?? stage.replace(/_/g, " ");
  if (status === "started") return `${label} started`;
  if (status === "retrying") return `${label} retrying`;
  if (status === "completed") return `${label} completed`;
  return `${label} failed`;
}

const ENGINE_STAGE_LABELS: Record<string, string> = {
  compile_input: "Preparing batch",
  research_cards: "Checking research",
  lfs_brief: "Building briefs",
  lfs_outline: "Writing outlines",
  preflight_v41: "Checking readiness",
  batch_generation: "Generating scripts",
  materialize_v41_candidates: "Preparing candidates",
  objective_finish_pre_semantic: "Checking structure",
  semantic_launchable: "Checking launchability",
  objective_finish_final: "Final structure check",
  semantic_final_check: "Final quality check",
  manifest_overview: "Preparing final ads",
};

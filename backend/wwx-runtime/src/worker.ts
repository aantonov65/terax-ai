import type { Engine } from "./engine.js";
import type { RuntimeService } from "./service.js";
import type { ClaimedJob, Store } from "./store.js";
import type { CreateAdsInput, EngineWorkItem, StageWorkItem } from "./model.js";

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

export class RuntimeWorker {
  constructor(
    private readonly workerId: string,
    private readonly store: Store,
    private readonly service: RuntimeService,
    private readonly engine: Engine,
    private readonly hooks: RuntimeWorkerHooks = {},
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
    const items = this.engine.planCreateAds(input);
    await this.runStage(claim, "lfs_generation", items);
    if (await this.store.shouldStop(claim.workspaceId, claim.batchId)) {
      await this.stopClaim(claim, "Stopped after lfs_generation");
      return;
    }
    await this.service.publishIndexes(claim.workspaceId, claim.batchId);
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
    await this.store.completeJob(claim.id, claim.run.id, "complete");
  }

  private async runStage(claim: ClaimedJob, stage: string, items: EngineWorkItem[]): Promise<void> {
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
    for (const item of items) {
      const work = await this.ensureWorkItem(claim, item);
      if (work.status === "succeeded") continue;
      if (await this.store.shouldStop(claim.workspaceId, claim.batchId)) {
        await this.store.updateWorkItemStatus(claim.workspaceId, claim.batchId, stage, item.itemKey, "canceled");
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
    await this.store.completeJob(claim.id, claim.run.id, "stopped");
  }
}

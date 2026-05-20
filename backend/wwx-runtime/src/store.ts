import type {
  Artifact,
  Batch,
  BatchRun,
  BatchStatus,
  CreateAdsInput,
  QueueJob,
  ResearchRun,
  RunEvent,
  RunStatus,
  StageState,
  StageWorkItem,
  WorkItemStatus,
} from "./model.js";
import { id, nowMs } from "./ids.js";

export type ClaimedJob = QueueJob & { run: BatchRun };

export type Store = {
  ensureProduct(workspaceId: string, productId: string, name?: string, config?: Record<string, unknown>): Promise<void>;
  createResearchRun(workspaceId: string, productId: string, topic: string, searchTerms: string[]): Promise<ResearchRun>;
  listResearchRuns(workspaceId: string, productId: string): Promise<ResearchRun[]>;
  ensureBatch(workspaceId: string, batchId: string, input: CreateAdsInput): Promise<Batch>;
  enqueueJob(workspaceId: string, batchId: string, type: QueueJob["type"], payload: Record<string, unknown>): Promise<QueueJob>;
  claimNextJob(workerId: string, leaseMs: number): Promise<ClaimedJob | null>;
  heartbeatJob(jobId: string, runId: string, workerId: string, leaseMs: number): Promise<void>;
  completeJob(jobId: string, runId: string, status: RunStatus): Promise<void>;
  failJob(jobId: string, runId: string, reason: string): Promise<void>;
  requestStop(workspaceId: string, batchId: string, reason?: string): Promise<void>;
  clearStop(workspaceId: string, batchId: string): Promise<void>;
  shouldStop(workspaceId: string, batchId: string): Promise<boolean>;
  appendEvent(input: Omit<RunEvent, "id" | "createdAt">): Promise<RunEvent>;
  listEvents(workspaceId: string, batchId: string, afterEventId?: string): Promise<RunEvent[]>;
  setStageState(input: Omit<StageState, "id" | "updatedAt">): Promise<StageState>;
  getStageState(workspaceId: string, batchId: string, stage: string): Promise<StageState | null>;
  upsertWorkItem(input: Omit<StageWorkItem, "id" | "updatedAt">): Promise<StageWorkItem>;
  updateWorkItemStatus(workspaceId: string, batchId: string, stage: string, itemKey: string, status: WorkItemStatus, artifactId?: string | null): Promise<StageWorkItem>;
  listWorkItems(workspaceId: string, batchId: string, stage?: string): Promise<StageWorkItem[]>;
  publishArtifact(input: Omit<Artifact, "id" | "createdAt" | "updatedAt" | "version">): Promise<Artifact>;
  listPublicArtifacts(workspaceId: string, batchId: string): Promise<Artifact[]>;
  getPublicArtifact(workspaceId: string, artifactId: string): Promise<Artifact | null>;
  getArtifactContent(artifactId: string): Promise<string | null>;
  setArtifactContent(artifactId: string, content: string): Promise<void>;
  getBatchStatus(workspaceId: string, batchId: string): Promise<BatchStatus | null>;
};

export class MemoryStore implements Store {
  private readonly products = new Map<string, { workspaceId: string; id: string; name: string; config: Record<string, unknown> }>();
  private readonly researchRuns = new Map<string, ResearchRun>();
  private readonly batches = new Map<string, Batch>();
  private readonly runs = new Map<string, BatchRun>();
  private readonly jobs = new Map<string, QueueJob>();
  private readonly stopRequests = new Set<string>();
  private readonly events: RunEvent[] = [];
  private readonly stages = new Map<string, StageState>();
  private readonly workItems = new Map<string, StageWorkItem>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly artifactContent = new Map<string, string>();

  constructor(private readonly maxActiveJobs = 6) {}

  async ensureProduct(workspaceId: string, productId: string, name = productId, config: Record<string, unknown> = {}): Promise<void> {
    this.products.set(`${workspaceId}:${productId}`, { workspaceId, id: productId, name, config });
  }

  async createResearchRun(workspaceId: string, productId: string, topic: string, searchTerms: string[]): Promise<ResearchRun> {
    const now = nowMs();
    const run: ResearchRun = {
      id: id("research"),
      workspaceId,
      productId,
      topic,
      topicSlug: topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "topic",
      searchTerms,
      status: "complete",
      quality: { searchTermCount: searchTerms.length, corpusRefs: searchTerms.length },
      createdAt: now,
      updatedAt: now,
    };
    this.researchRuns.set(run.id, run);
    return run;
  }

  async listResearchRuns(workspaceId: string, productId: string): Promise<ResearchRun[]> {
    return [...this.researchRuns.values()]
      .filter((run) => run.workspaceId === workspaceId && run.productId === productId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async ensureBatch(workspaceId: string, batchId: string, input: CreateAdsInput): Promise<Batch> {
    const key = `${workspaceId}:${batchId}`;
    const now = nowMs();
    const existing = this.batches.get(key);
    if (existing) {
      existing.requestedAdCount = input.adCount;
      existing.updatedAt = now;
      return existing;
    }
    const batch: Batch = {
      id: batchId,
      workspaceId,
      productId: input.productId,
      name: input.batchName ?? batchId,
      status: "queued",
      currentStage: null,
      requestedAdCount: input.adCount,
      createdAt: now,
      updatedAt: now,
    };
    this.batches.set(key, batch);
    return batch;
  }

  async enqueueJob(workspaceId: string, batchId: string, type: QueueJob["type"], payload: Record<string, unknown>): Promise<QueueJob> {
    const now = nowMs();
    const job: QueueJob = {
      id: id("job"),
      workspaceId,
      batchId,
      type,
      payload,
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      leaseOwner: null,
      leaseExpiresAt: null,
      runId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async claimNextJob(workerId: string, leaseMs: number): Promise<ClaimedJob | null> {
    const now = nowMs();
    const running = [...this.jobs.values()].filter((job) => job.status === "running" && job.leaseExpiresAt && job.leaseExpiresAt > now);
    if (running.length >= this.maxActiveJobs) return null;
    const job = [...this.jobs.values()]
      .filter((item) =>
        item.attempts < item.maxAttempts &&
        (item.status === "queued" || (item.status === "running" && (item.leaseExpiresAt ?? 0) <= now)) &&
        ![...this.jobs.values()].some((active) =>
          active.id !== item.id &&
          active.workspaceId === item.workspaceId &&
          active.batchId === item.batchId &&
          active.status === "running" &&
          (active.leaseExpiresAt ?? 0) > now
        )
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!job) return null;
    const run = this.startRun(job.workspaceId, job.batchId);
    job.status = "running";
    job.attempts += 1;
    job.leaseOwner = workerId;
    job.leaseExpiresAt = now + leaseMs;
    job.runId = run.id;
    job.updatedAt = now;
    return { ...job, run };
  }

  private startRun(workspaceId: string, batchId: string): BatchRun {
    const now = nowMs();
    const run: BatchRun = {
      id: id("run"),
      workspaceId,
      batchId,
      status: "running",
      currentStage: null,
      startedAt: now,
      finishedAt: null,
      heartbeatAt: now,
    };
    this.runs.set(run.id, run);
    const batch = this.batches.get(`${workspaceId}:${batchId}`);
    if (batch) {
      batch.status = "running";
      batch.updatedAt = now;
    }
    return run;
  }

  async heartbeatJob(jobId: string, runId: string, workerId: string, leaseMs: number): Promise<void> {
    const job = this.jobs.get(jobId);
    const run = this.runs.get(runId);
    if (!job || job.leaseOwner !== workerId || !run) return;
    const now = nowMs();
    job.leaseExpiresAt = now + leaseMs;
    job.updatedAt = now;
    run.heartbeatAt = now;
  }

  async completeJob(jobId: string, runId: string, status: RunStatus): Promise<void> {
    const now = nowMs();
    const job = this.jobs.get(jobId);
    const run = this.runs.get(runId);
    if (job) {
      job.status = status === "complete" ? "complete" : status === "stopped" ? "stopped" : "failed";
      job.updatedAt = now;
      job.leaseExpiresAt = null;
    }
    if (run) {
      run.status = status;
      run.finishedAt = now;
      run.heartbeatAt = now;
      const batch = this.batches.get(`${run.workspaceId}:${run.batchId}`);
      if (batch) {
        batch.status = status;
        batch.updatedAt = now;
      }
    }
  }

  async failJob(jobId: string, runId: string, _reason: string): Promise<void> {
    const now = nowMs();
    const job = this.jobs.get(jobId);
    const run = this.runs.get(runId);
    if (run) {
      run.status = "failed";
      run.finishedAt = now;
      run.heartbeatAt = now;
    }
    if (!job) return;
    job.status = job.attempts >= job.maxAttempts ? "dead_letter" : "queued";
    job.leaseExpiresAt = null;
    job.leaseOwner = null;
    job.updatedAt = now;
    if (job.status === "dead_letter") {
      const batch = this.batches.get(`${job.workspaceId}:${job.batchId}`);
      if (batch) {
        batch.status = "failed";
        batch.updatedAt = now;
      }
    }
  }

  async requestStop(workspaceId: string, batchId: string, _reason?: string): Promise<void> {
    this.stopRequests.add(`${workspaceId}:${batchId}`);
  }

  async clearStop(workspaceId: string, batchId: string): Promise<void> {
    this.stopRequests.delete(`${workspaceId}:${batchId}`);
  }

  async shouldStop(workspaceId: string, batchId: string): Promise<boolean> {
    return this.stopRequests.has(`${workspaceId}:${batchId}`);
  }

  async appendEvent(input: Omit<RunEvent, "id" | "createdAt">): Promise<RunEvent> {
    const event = { ...input, id: id("evt"), createdAt: nowMs() };
    this.events.push(event);
    return event;
  }

  async listEvents(workspaceId: string, batchId: string, afterEventId?: string): Promise<RunEvent[]> {
    const events = this.events.filter((event) => event.workspaceId === workspaceId && event.batchId === batchId);
    if (!afterEventId) return events;
    const idx = events.findIndex((event) => event.id === afterEventId);
    return idx === -1 ? events : events.slice(idx + 1);
  }

  async setStageState(input: Omit<StageState, "id" | "updatedAt">): Promise<StageState> {
    const key = `${input.workspaceId}:${input.batchId}:${input.stage}`;
    const existing = this.stages.get(key);
    const stage = { ...input, id: existing?.id ?? id("stage"), updatedAt: nowMs() };
    this.stages.set(key, stage);
    const batch = this.batches.get(`${input.workspaceId}:${input.batchId}`);
    if (batch) {
      batch.currentStage = input.stage;
      batch.updatedAt = stage.updatedAt;
    }
    const run = this.runs.get(input.runId);
    if (run) {
      run.currentStage = input.stage;
      run.heartbeatAt = stage.updatedAt;
    }
    return stage;
  }

  async getStageState(workspaceId: string, batchId: string, stage: string): Promise<StageState | null> {
    return this.stages.get(`${workspaceId}:${batchId}:${stage}`) ?? null;
  }

  async upsertWorkItem(input: Omit<StageWorkItem, "id" | "updatedAt">): Promise<StageWorkItem> {
    const key = `${input.workspaceId}:${input.batchId}:${input.stage}:${input.itemKey}`;
    const existing = this.workItems.get(key);
    const item = { ...input, id: existing?.id ?? id("work"), updatedAt: nowMs() };
    this.workItems.set(key, item);
    return item;
  }

  async updateWorkItemStatus(workspaceId: string, batchId: string, stage: string, itemKey: string, status: WorkItemStatus, artifactId: string | null = null): Promise<StageWorkItem> {
    const key = `${workspaceId}:${batchId}:${stage}:${itemKey}`;
    const item = this.workItems.get(key);
    if (!item) throw new Error(`work item not found: ${stage}/${itemKey}`);
    item.status = status;
    item.artifactId = artifactId;
    item.updatedAt = nowMs();
    return item;
  }

  async listWorkItems(workspaceId: string, batchId: string, stage?: string): Promise<StageWorkItem[]> {
    return [...this.workItems.values()]
      .filter((item) => item.workspaceId === workspaceId && item.batchId === batchId && (!stage || item.stage === stage))
      .sort((a, b) => a.itemKey.localeCompare(b.itemKey));
  }

  async publishArtifact(input: Omit<Artifact, "id" | "createdAt" | "updatedAt" | "version">): Promise<Artifact> {
    const existing = [...this.artifacts.values()].find((artifact) =>
      artifact.workspaceId === input.workspaceId &&
      artifact.batchId === input.batchId &&
      artifact.filename === input.filename &&
      artifact.contentSha256 === input.contentSha256
    );
    if (existing) return existing;
    const now = nowMs();
    const version = [...this.artifacts.values()].filter((artifact) =>
      artifact.workspaceId === input.workspaceId &&
      artifact.batchId === input.batchId &&
      artifact.filename === input.filename
    ).length + 1;
    const artifact: Artifact = { ...input, id: id("art"), version, createdAt: now, updatedAt: now };
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  async listPublicArtifacts(workspaceId: string, batchId: string): Promise<Artifact[]> {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.workspaceId === workspaceId && artifact.batchId === batchId && artifact.visibilityClass.startsWith("public_"))
      .sort((a, b) => a.filename.localeCompare(b.filename));
  }

  async getPublicArtifact(workspaceId: string, artifactId: string): Promise<Artifact | null> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.workspaceId !== workspaceId || !artifact.visibilityClass.startsWith("public_")) return null;
    return artifact;
  }

  async getArtifactContent(artifactId: string): Promise<string | null> {
    return this.artifactContent.get(artifactId) ?? null;
  }

  async setArtifactContent(artifactId: string, content: string): Promise<void> {
    this.artifactContent.set(artifactId, content);
  }

  async getBatchStatus(workspaceId: string, batchId: string): Promise<BatchStatus | null> {
    const batch = this.batches.get(`${workspaceId}:${batchId}`);
    if (!batch) return null;
    const run = [...this.runs.values()]
      .filter((item) => item.workspaceId === workspaceId && item.batchId === batchId)
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
    return {
      batch,
      run,
      stages: [...this.stages.values()].filter((stage) => stage.workspaceId === workspaceId && stage.batchId === batchId),
      workItems: await this.listWorkItems(workspaceId, batchId),
      artifacts: await this.listPublicArtifacts(workspaceId, batchId),
    };
  }
}

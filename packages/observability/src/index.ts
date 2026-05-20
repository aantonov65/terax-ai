import { createHash, randomUUID } from "node:crypto";

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled", "quarantined"] as const;
export const STAGE_STATUSES = ["queued", "running", "succeeded", "failed", "skipped", "retrying"] as const;
export const ARTIFACT_STATUSES = ["created", "uploaded", "failed", "quarantined", "deleted"] as const;
export const ALERT_STATUSES = ["open", "acknowledged", "resolved", "ignored"] as const;

export const WORKFLOW_TYPES = [
  "lfs_ads",
  "research",
  "image_batch",
  "modular_video",
  "avatar_video",
  "lp_rip",
  "meta_upload",
  "handoff_export",
] as const;

export type RunStatus = typeof RUN_STATUSES[number];
export type StageStatus = typeof STAGE_STATUSES[number];
export type ArtifactStatus = typeof ARTIFACT_STATUSES[number];
export type AlertStatus = typeof ALERT_STATUSES[number];
export type WorkflowType = typeof WORKFLOW_TYPES[number];

export type UserRole = "owner" | "admin" | "operator" | "viewer";

export type UserRecord = {
  id: string;
  workspaceId: string;
  authProvider: string;
  authSubject: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: "active" | "suspended" | "deleted";
  desktopClientVersion: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RunRecord = {
  id: string;
  workspaceId: string;
  triggerRunId: string | null;
  correlationId: string;
  workflowType: WorkflowType;
  productId: string | null;
  batchId: string | null;
  createdByUserId: string;
  status: RunStatus;
  currentStage: string | null;
  totalCostUsd: number;
  desktopClientVersion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failureCategory: string | null;
  failureMessageSafe: string | null;
  canaryHash: string;
  createdAt: string;
  updatedAt: string;
};

export type StageRecord = {
  id: string;
  runId: string;
  stageName: string;
  provider: string | null;
  attempt: number;
  status: StageStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  costUsd: number;
  errorCategory: string | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  createdAt: string;
};

export type AiCallRecord = {
  id: string;
  runId: string;
  stageId: string | null;
  provider: string;
  model: string;
  promptTemplateId: string | null;
  promptVersion: string | null;
  promptHash: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number | null;
  status: "succeeded" | "failed";
  errorCode: string | null;
  errorCategory: string | null;
  createdAt: string;
};

export type MediaComputeRecord = {
  id: string;
  runId: string;
  stageId: string | null;
  tool: string;
  operation: string;
  inputCount: number;
  outputCount: number;
  durationMs: number | null;
  fileDurationSeconds: number | null;
  outputSizeBytes: number | null;
  status: "succeeded" | "failed";
  errorCode: string | null;
  errorCategory: string | null;
  createdAt: string;
};

export type ArtifactLedgerRecord = {
  id: string;
  runId: string;
  workspaceId: string;
  productId: string | null;
  batchId: string | null;
  createdByUserId: string;
  workflowType: WorkflowType;
  artifactType: string;
  status: ArtifactStatus;
  sizeBytes: number | null;
  storageRefId: string | null;
  publicExportAllowed: boolean;
  createdAt: string;
};

export type RunEventRecord = {
  id: string;
  runId: string;
  stageId: string | null;
  eventType: string;
  messageSafe: string;
  metadataSafe: Record<string, unknown>;
  createdAt: string;
};

export type ObservabilityAlertRecord = {
  id: string;
  runId: string | null;
  stageId: string | null;
  alertType: string;
  severity: "low" | "medium" | "high" | "critical";
  status: AlertStatus;
  messageSafe: string;
  metadataSafe: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
};

export type CreateRunInput = {
  workspaceId: string;
  workflowType: WorkflowType;
  productId?: string | null;
  batchId?: string | null;
  createdByUserId: string;
  desktopClientVersion?: string | null;
  correlationId?: string | null;
};

export type StartStageInput = {
  runId: string;
  stageName: string;
  provider?: string | null;
  attempt?: number;
};

export type CompleteStageInput = {
  stageId: string;
  durationMs?: number | null;
  costUsd?: number;
};

export type FailStageInput = {
  stageId: string;
  durationMs?: number | null;
  costUsd?: number;
  errorCategory?: string | null;
  errorCode?: string | null;
  errorMessageSafe?: string | null;
};

export type RecordAiCallInput = {
  runId: string;
  stageId?: string | null;
  provider: string;
  model: string;
  promptTemplateId?: string | null;
  promptVersion?: string | null;
  promptHash?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
  latencyMs?: number | null;
  status: "succeeded" | "failed";
  errorCode?: string | null;
  errorCategory?: string | null;
};

export type RecordMediaComputeInput = {
  runId: string;
  stageId?: string | null;
  tool: string;
  operation: string;
  inputCount?: number;
  outputCount?: number;
  durationMs?: number | null;
  fileDurationSeconds?: number | null;
  outputSizeBytes?: number | null;
  status: "succeeded" | "failed";
  errorCode?: string | null;
  errorCategory?: string | null;
};

export type RecordArtifactInput = {
  runId: string;
  productId?: string | null;
  batchId?: string | null;
  createdByUserId: string;
  workflowType: WorkflowType;
  artifactType: string;
  status?: ArtifactStatus;
  sizeBytes?: number | null;
  storageRefId?: string | null;
  publicExportAllowed?: boolean;
  textForLeakScan?: string | null;
  metadataForLeakScan?: Record<string, unknown> | null;
};

export type EmitRunEventInput = {
  runId: string;
  stageId?: string | null;
  eventType: string;
  messageSafe: string;
  metadataSafe?: Record<string, unknown>;
};

export type CreateAlertInput = {
  runId?: string | null;
  stageId?: string | null;
  alertType: string;
  severity: ObservabilityAlertRecord["severity"];
  messageSafe: string;
  metadataSafe?: Record<string, unknown>;
};

export type ObservabilityRepository = {
  upsertUser(input: {
    workspaceId: string;
    authProvider: string;
    authSubject: string;
    email: string;
    name?: string | null;
    role?: UserRole;
    status?: UserRecord["status"];
    desktopClientVersion?: string | null;
  }): Promise<UserRecord>;
  getUser(userId: string): Promise<UserRecord | null>;
  createRun(input: CreateRunInput & { canaryHash: string }): Promise<RunRecord>;
  attachTriggerRunId(runId: string, triggerRunId: string): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  listRuns(filter?: { workspaceId?: string; createdByUserId?: string; limit?: number }): Promise<RunRecord[]>;
  updateRunStatus(input: {
    runId: string;
    status: RunStatus;
    currentStage?: string | null;
    failureCategory?: string | null;
    failureMessageSafe?: string | null;
  }): Promise<RunRecord>;
  startStage(input: StartStageInput): Promise<StageRecord>;
  completeStage(input: CompleteStageInput): Promise<StageRecord>;
  failStage(input: FailStageInput): Promise<StageRecord>;
  listStages(runId: string): Promise<StageRecord[]>;
  recordAiCall(input: RecordAiCallInput): Promise<AiCallRecord>;
  listAiCalls(runId: string): Promise<AiCallRecord[]>;
  recordMediaCompute(input: RecordMediaComputeInput): Promise<MediaComputeRecord>;
  listMediaCompute(runId: string): Promise<MediaComputeRecord[]>;
  recordArtifact(input: Omit<RecordArtifactInput, "textForLeakScan" | "metadataForLeakScan"> & { status: ArtifactStatus }): Promise<ArtifactLedgerRecord>;
  getArtifact(artifactId: string): Promise<ArtifactLedgerRecord | null>;
  listArtifacts(runId: string): Promise<ArtifactLedgerRecord[]>;
  emitRunEvent(input: EmitRunEventInput): Promise<RunEventRecord>;
  listRunEvents(runId: string, afterEventId?: string): Promise<RunEventRecord[]>;
  createAlert(input: CreateAlertInput & { status?: AlertStatus }): Promise<ObservabilityAlertRecord>;
  listAlerts(filter?: { status?: AlertStatus; limit?: number }): Promise<ObservabilityAlertRecord[]>;
  summarizeCosts(filter?: { workspaceId?: string }): Promise<Array<Record<string, unknown>>>;
  summarizeStages(filter?: { workspaceId?: string }): Promise<Array<Record<string, unknown>>>;
  summarizeUsers(filter?: { workspaceId?: string }): Promise<Array<Record<string, unknown>>>;
};

export class ObservabilityClient {
  constructor(private readonly repository: ObservabilityRepository) {}

  upsertUser(input: Parameters<ObservabilityRepository["upsertUser"]>[0]) {
    return this.repository.upsertUser(input);
  }

  async createRun(input: CreateRunInput): Promise<RunRecord & { canary: string }> {
    const canary = generateRunCanary();
    const run = await this.repository.createRun({
      ...input,
      correlationId: input.correlationId ?? randomUUID(),
      canaryHash: hashValue(canary),
    });
    await this.emitRunEvent({
      runId: run.id,
      eventType: "run_created",
      messageSafe: "Run created",
      metadataSafe: {
        workflow_type: run.workflowType,
        product_id: run.productId,
        batch_id: run.batchId,
      },
    });
    return { ...run, canary };
  }

  async attachTriggerRunId(runId: string, triggerRunId: string): Promise<RunRecord> {
    const run = await this.repository.attachTriggerRunId(runId, triggerRunId);
    await this.emitRunEvent({
      runId,
      eventType: "trigger_attached",
      messageSafe: "Workflow scheduled",
      metadataSafe: { scheduler: "trigger.dev" },
    });
    return run;
  }

  async startStage(input: StartStageInput): Promise<StageRecord> {
    const stage = await this.repository.startStage(input);
    await this.repository.updateRunStatus({ runId: stage.runId, status: "running", currentStage: stage.stageName });
    await this.emitRunEvent({
      runId: stage.runId,
      stageId: stage.id,
      eventType: "stage_started",
      messageSafe: `Stage started: ${stage.stageName}`,
      metadataSafe: { stage_name: stage.stageName, attempt: stage.attempt },
    });
    return stage;
  }

  async completeStage(input: CompleteStageInput): Promise<StageRecord> {
    const stage = await this.repository.completeStage(input);
    await this.emitRunEvent({
      runId: stage.runId,
      stageId: stage.id,
      eventType: "stage_completed",
      messageSafe: `Stage completed: ${stage.stageName}`,
      metadataSafe: { stage_name: stage.stageName, duration_ms: stage.durationMs },
    });
    return stage;
  }

  async failStage(input: FailStageInput): Promise<StageRecord> {
    const stage = await this.repository.failStage({
      ...input,
      errorMessageSafe: safeMessage(input.errorMessageSafe ?? input.errorCategory ?? "Stage failed"),
    });
    await this.emitRunEvent({
      runId: stage.runId,
      stageId: stage.id,
      eventType: "stage_failed",
      messageSafe: `Stage failed: ${stage.stageName}`,
      metadataSafe: {
        stage_name: stage.stageName,
        error_category: stage.errorCategory,
        error_code: stage.errorCode,
      },
    });
    return stage;
  }

  recordAiCall(input: RecordAiCallInput): Promise<AiCallRecord> {
    return this.repository.recordAiCall({
      ...input,
      promptHash: input.promptHash ? hashValue(input.promptHash) : null,
    });
  }

  recordMediaCompute(input: RecordMediaComputeInput): Promise<MediaComputeRecord> {
    return this.repository.recordMediaCompute(input);
  }

  async recordArtifact(input: RecordArtifactInput): Promise<ArtifactLedgerRecord> {
    const leak = detectCanaryLeak({
      text: input.textForLeakScan ?? "",
      metadata: input.metadataForLeakScan ?? {},
    });
    const status: ArtifactStatus = leak ? "quarantined" : input.status ?? "created";
    const artifact = await this.repository.recordArtifact({
      ...input,
      storageRefId: sanitizeStorageRef(input.storageRefId ?? null),
      publicExportAllowed: leak ? false : input.publicExportAllowed ?? false,
      status,
    });
    await this.emitRunEvent({
      runId: input.runId,
      eventType: leak ? "artifact_quarantined" : "artifact_recorded",
      messageSafe: leak ? "Artifact quarantined" : "Artifact recorded",
      metadataSafe: {
        artifact_id: artifact.id,
        artifact_type: artifact.artifactType,
        status: artifact.status,
      },
    });
    if (leak) {
      await this.markRunQuarantined(input.runId, "canary_leak_detected", "A public surface matched a hidden canary.");
      await this.createAlert({
        runId: input.runId,
        alertType: "canary_leak_detected",
        severity: "critical",
        messageSafe: "Hidden canary detected on an output surface.",
        metadataSafe: leak,
      });
    }
    return artifact;
  }

  emitRunEvent(input: EmitRunEventInput): Promise<RunEventRecord> {
    return this.repository.emitRunEvent({
      ...input,
      messageSafe: safeMessage(input.messageSafe),
      metadataSafe: sanitizeTelemetryPayload(input.metadataSafe ?? {}),
    });
  }

  async markRunCompleted(runId: string): Promise<RunRecord> {
    const run = await this.repository.updateRunStatus({ runId, status: "succeeded", currentStage: null });
    await this.emitRunEvent({ runId, eventType: "run_completed", messageSafe: "Run completed" });
    return run;
  }

  async markRunQueued(runId: string): Promise<RunRecord> {
    const run = await this.repository.updateRunStatus({ runId, status: "queued", currentStage: null });
    await this.emitRunEvent({ runId, eventType: "run_queued", messageSafe: "Run queued" });
    return run;
  }

  async markRunFailed(runId: string, failureCategory: string, failureMessageSafe: string): Promise<RunRecord> {
    const run = await this.repository.updateRunStatus({
      runId,
      status: "failed",
      failureCategory,
      failureMessageSafe: safeMessage(failureMessageSafe),
    });
    await this.emitRunEvent({
      runId,
      eventType: "run_failed",
      messageSafe: "Run failed",
      metadataSafe: { failure_category: failureCategory },
    });
    return run;
  }

  async markRunCancelled(runId: string, failureCategory = "operator_stop_requested", failureMessageSafe = "Run cancelled"): Promise<RunRecord> {
    const run = await this.repository.updateRunStatus({
      runId,
      status: "cancelled",
      currentStage: null,
      failureCategory,
      failureMessageSafe: safeMessage(failureMessageSafe),
    });
    await this.emitRunEvent({
      runId,
      eventType: "run_cancelled",
      messageSafe: "Run cancelled",
      metadataSafe: { failure_category: failureCategory },
    });
    return run;
  }

  async markRunQuarantined(runId: string, failureCategory = "security_quarantine", failureMessageSafe = "Run quarantined"): Promise<RunRecord> {
    const run = await this.repository.updateRunStatus({
      runId,
      status: "quarantined",
      failureCategory,
      failureMessageSafe: safeMessage(failureMessageSafe),
    });
    await this.emitRunEvent({
      runId,
      eventType: "run_quarantined",
      messageSafe: "Run quarantined",
      metadataSafe: { failure_category: failureCategory },
    });
    return run;
  }

  createAlert(input: CreateAlertInput): Promise<ObservabilityAlertRecord> {
    return this.repository.createAlert({
      ...input,
      messageSafe: safeMessage(input.messageSafe),
      metadataSafe: sanitizeTelemetryPayload(input.metadataSafe ?? {}),
      status: "open",
    });
  }

  getRun(runId: string) {
    return this.repository.getRun(runId);
  }

  listRuns(filter?: Parameters<ObservabilityRepository["listRuns"]>[0]) {
    return this.repository.listRuns(filter);
  }

  listStages(runId: string) {
    return this.repository.listStages(runId);
  }

  listAiCalls(runId: string) {
    return this.repository.listAiCalls(runId);
  }

  listMediaCompute(runId: string) {
    return this.repository.listMediaCompute(runId);
  }

  listArtifacts(runId: string) {
    return this.repository.listArtifacts(runId);
  }

  getArtifact(artifactId: string) {
    return this.repository.getArtifact(artifactId);
  }

  listRunEvents(runId: string, afterEventId?: string) {
    return this.repository.listRunEvents(runId, afterEventId);
  }

  listAlerts(filter?: Parameters<ObservabilityRepository["listAlerts"]>[0]) {
    return this.repository.listAlerts(filter);
  }

  summarizeCosts(filter?: Parameters<ObservabilityRepository["summarizeCosts"]>[0]) {
    return this.repository.summarizeCosts(filter);
  }

  summarizeStages(filter?: Parameters<ObservabilityRepository["summarizeStages"]>[0]) {
    return this.repository.summarizeStages(filter);
  }

  summarizeUsers(filter?: Parameters<ObservabilityRepository["summarizeUsers"]>[0]) {
    return this.repository.summarizeUsers(filter);
  }
}

export function sanitizeTelemetryPayload(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeValue(value, "root");
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return { value: sanitized };
}

export function generateRunCanary(): string {
  return `canary_run_${randomUUID().replace(/-/g, "")}`;
}

export function detectCanaryLeak(value: unknown): { surface: string; match_hash: string } | null {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const match = text.match(/canary_run_[a-zA-Z0-9_-]+/);
  return match ? { surface: "payload", match_hash: hashValue(match[0]) } : null;
}

export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeMessage(value: string): string {
  return redactString(value).replace(/[^\x20-\x7E]/g, "").slice(0, 500);
}

function sanitizeValue(value: unknown, key: string): unknown {
  if (shouldRedactKey(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = sanitizeValue(childValue, childKey);
    }
    return out;
  }
  return null;
}

function shouldRedactKey(key: string): boolean {
  if (/^(input|output|cached)_?tokens?$|^token_?count$/i.test(key)) return false;
  if (/^(prompt_)?template_?id$|^prompt_?version$|^prompt_?hash$/i.test(key)) return false;
  return /prompt|completion|raw|secret|token|api[_-]?key|password|signed[_-]?url|object[_-]?key|r2|canary|instruction|template/i.test(key);
}

function redactString(value: string): string {
  let out = value;
  out = out.replace(/canary_run_[a-zA-Z0-9_-]+/g, (match) => `[REDACTED_CANARY:${hashValue(match).slice(0, 12)}]`);
  out = out.replace(/(sk|tr|pk|rk)_[a-zA-Z0-9_-]{16,}/g, "[REDACTED_SECRET]");
  out = out.replace(/Bearer\s+[a-zA-Z0-9._-]+/g, "Bearer [REDACTED]");
  out = out.replace(/https:\/\/[^"\s]+X-Amz-Signature=[^"\s]+/g, "[REDACTED_SIGNED_URL]");
  return out;
}

function sanitizeStorageRef(value: string | null): string | null {
  if (!value) return null;
  return hashValue(value).slice(0, 32);
}

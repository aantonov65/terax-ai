import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type {
  AiCallRecord,
  AlertStatus,
  ArtifactLedgerRecord,
  ArtifactStatus,
  CompleteStageInput,
  CreateAlertInput,
  CreateRunInput,
  EmitRunEventInput,
  FailStageInput,
  MediaComputeRecord,
  ObservabilityAlertRecord,
  ObservabilityRepository,
  RecordAiCallInput,
  RecordArtifactInput,
  RecordMediaComputeInput,
  RunEventRecord,
  RunRecord,
  RunStatus,
  StageRecord,
  StartStageInput,
  UserRecord,
  UserRole,
} from "../../../packages/observability/src/index.js";

export class MemoryObservabilityRepository implements ObservabilityRepository {
  private readonly users = new Map<string, UserRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly stages = new Map<string, StageRecord>();
  private readonly aiCalls = new Map<string, AiCallRecord>();
  private readonly mediaEvents = new Map<string, MediaComputeRecord>();
  private readonly artifacts = new Map<string, ArtifactLedgerRecord>();
  private readonly runEvents: RunEventRecordInternal[] = [];
  private readonly alerts = new Map<string, ObservabilityAlertRecord>();

  async upsertUser(input: Parameters<ObservabilityRepository["upsertUser"]>[0]): Promise<UserRecord> {
    const existing = [...this.users.values()].find((user) =>
      user.authProvider === input.authProvider && user.authSubject === input.authSubject
    );
    const now = isoNow();
    const user: UserRecord = {
      id: existing?.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      authProvider: input.authProvider,
      authSubject: input.authSubject,
      email: input.email,
      name: input.name ?? existing?.name ?? null,
      role: input.role ?? existing?.role ?? "operator",
      status: input.status ?? existing?.status ?? "active",
      desktopClientVersion: input.desktopClientVersion ?? existing?.desktopClientVersion ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    return user;
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    return this.users.get(userId) ?? null;
  }

  async createRun(input: CreateRunInput & { canaryHash: string }): Promise<RunRecord> {
    const now = isoNow();
    const run: RunRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      triggerRunId: null,
      correlationId: input.correlationId ?? randomUUID(),
      workflowType: input.workflowType,
      productId: input.productId ?? null,
      batchId: input.batchId ?? null,
      createdByUserId: input.createdByUserId,
      status: "queued",
      currentStage: null,
      totalCostUsd: 0,
      desktopClientVersion: input.desktopClientVersion ?? null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      failureCategory: null,
      failureMessageSafe: null,
      canaryHash: input.canaryHash,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return run;
  }

  async attachTriggerRunId(runId: string, triggerRunId: string): Promise<RunRecord> {
    return this.patchRun(runId, { triggerRunId });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async listRuns(filter: { workspaceId?: string; createdByUserId?: string; limit?: number } = {}): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => !filter.workspaceId || run.workspaceId === filter.workspaceId)
      .filter((run) => !filter.createdByUserId || run.createdByUserId === filter.createdByUserId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 100);
  }

  async updateRunStatus(input: {
    runId: string;
    status: RunStatus;
    currentStage?: string | null;
    failureCategory?: string | null;
    failureMessageSafe?: string | null;
  }): Promise<RunRecord> {
    const now = isoNow();
    return this.patchRun(input.runId, {
      status: input.status,
      currentStage: input.currentStage ?? (input.status === "succeeded" || input.status === "failed" ? null : undefined),
      completedAt: input.status === "succeeded" ? now : undefined,
      failedAt: input.status === "failed" || input.status === "quarantined" ? now : undefined,
      failureCategory: input.failureCategory ?? undefined,
      failureMessageSafe: input.failureMessageSafe ?? undefined,
      startedAt: input.status === "running" ? this.runs.get(input.runId)?.startedAt ?? now : undefined,
    });
  }

  async startStage(input: StartStageInput): Promise<StageRecord> {
    const now = isoNow();
    const stage: StageRecord = {
      id: randomUUID(),
      runId: input.runId,
      stageName: input.stageName,
      provider: input.provider ?? null,
      attempt: input.attempt ?? this.nextAttempt(input.runId, input.stageName),
      status: "running",
      startedAt: now,
      completedAt: null,
      durationMs: null,
      costUsd: 0,
      errorCategory: null,
      errorCode: null,
      errorMessageSafe: null,
      createdAt: now,
    };
    this.stages.set(stage.id, stage);
    return stage;
  }

  async completeStage(input: CompleteStageInput): Promise<StageRecord> {
    const stage = this.requireStage(input.stageId);
    const updated: StageRecord = {
      ...stage,
      status: "succeeded",
      completedAt: isoNow(),
      durationMs: input.durationMs ?? elapsedMs(stage.startedAt),
      costUsd: input.costUsd ?? stage.costUsd,
    };
    this.stages.set(updated.id, updated);
    this.recomputeRunCost(updated.runId);
    return updated;
  }

  async failStage(input: FailStageInput): Promise<StageRecord> {
    const stage = this.requireStage(input.stageId);
    const updated: StageRecord = {
      ...stage,
      status: "failed",
      completedAt: isoNow(),
      durationMs: input.durationMs ?? elapsedMs(stage.startedAt),
      costUsd: input.costUsd ?? stage.costUsd,
      errorCategory: input.errorCategory ?? null,
      errorCode: input.errorCode ?? null,
      errorMessageSafe: input.errorMessageSafe ?? null,
    };
    this.stages.set(updated.id, updated);
    this.recomputeRunCost(updated.runId);
    return updated;
  }

  async listStages(runId: string): Promise<StageRecord[]> {
    return [...this.stages.values()].filter((stage) => stage.runId === runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async recordAiCall(input: RecordAiCallInput): Promise<AiCallRecord> {
    const record: AiCallRecord = {
      id: randomUUID(),
      runId: input.runId,
      stageId: input.stageId ?? null,
      provider: input.provider,
      model: input.model,
      promptTemplateId: input.promptTemplateId ?? null,
      promptVersion: input.promptVersion ?? null,
      promptHash: input.promptHash ?? null,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cachedTokens: input.cachedTokens ?? 0,
      costUsd: input.costUsd ?? 0,
      latencyMs: input.latencyMs ?? null,
      status: input.status,
      errorCode: input.errorCode ?? null,
      errorCategory: input.errorCategory ?? null,
      createdAt: isoNow(),
    };
    this.aiCalls.set(record.id, record);
    return record;
  }

  async listAiCalls(runId: string): Promise<AiCallRecord[]> {
    return [...this.aiCalls.values()].filter((call) => call.runId === runId);
  }

  async recordMediaCompute(input: RecordMediaComputeInput): Promise<MediaComputeRecord> {
    const record: MediaComputeRecord = {
      id: randomUUID(),
      runId: input.runId,
      stageId: input.stageId ?? null,
      tool: input.tool,
      operation: input.operation,
      inputCount: input.inputCount ?? 0,
      outputCount: input.outputCount ?? 0,
      durationMs: input.durationMs ?? null,
      fileDurationSeconds: input.fileDurationSeconds ?? null,
      outputSizeBytes: input.outputSizeBytes ?? null,
      status: input.status,
      errorCode: input.errorCode ?? null,
      errorCategory: input.errorCategory ?? null,
      createdAt: isoNow(),
    };
    this.mediaEvents.set(record.id, record);
    return record;
  }

  async listMediaCompute(runId: string): Promise<MediaComputeRecord[]> {
    return [...this.mediaEvents.values()].filter((event) => event.runId === runId);
  }

  async recordArtifact(input: Omit<RecordArtifactInput, "textForLeakScan" | "metadataForLeakScan"> & { status: ArtifactStatus }): Promise<ArtifactLedgerRecord> {
    const run = this.runs.get(input.runId);
    if (!run) throw new Error("run not found");
    const artifact: ArtifactLedgerRecord = {
      id: randomUUID(),
      runId: input.runId,
      workspaceId: run.workspaceId,
      productId: input.productId ?? run.productId,
      batchId: input.batchId ?? run.batchId,
      createdByUserId: input.createdByUserId,
      workflowType: input.workflowType,
      artifactType: input.artifactType,
      status: input.status,
      sizeBytes: input.sizeBytes ?? null,
      storageRefId: input.storageRefId ?? null,
      publicExportAllowed: input.publicExportAllowed ?? false,
      createdAt: isoNow(),
    };
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  async listArtifacts(runId: string): Promise<ArtifactLedgerRecord[]> {
    return [...this.artifacts.values()].filter((artifact) => artifact.runId === runId);
  }

  async getArtifact(artifactId: string): Promise<ArtifactLedgerRecord | null> {
    return this.artifacts.get(artifactId) ?? null;
  }

  async emitRunEvent(input: EmitRunEventInput): Promise<RunEventRecordInternal> {
    const event: RunEventRecordInternal = {
      id: randomUUID(),
      runId: input.runId,
      stageId: input.stageId ?? null,
      eventType: input.eventType,
      messageSafe: input.messageSafe,
      metadataSafe: input.metadataSafe ?? {},
      createdAt: isoNow(),
      sequence: this.runEvents.length + 1,
    };
    this.runEvents.push(event);
    return event;
  }

  async listRunEvents(runId: string, afterEventId?: string): Promise<RunEventRecordInternal[]> {
    const events = this.runEvents.filter((event) => event.runId === runId);
    if (!afterEventId) return events;
    const idx = events.findIndex((event) => event.id === afterEventId);
    return idx === -1 ? events : events.slice(idx + 1);
  }

  async createAlert(input: CreateAlertInput & { status?: AlertStatus }): Promise<ObservabilityAlertRecord> {
    const alert: ObservabilityAlertRecord = {
      id: randomUUID(),
      runId: input.runId ?? null,
      stageId: input.stageId ?? null,
      alertType: input.alertType,
      severity: input.severity,
      status: input.status ?? "open",
      messageSafe: input.messageSafe,
      metadataSafe: input.metadataSafe ?? {},
      createdAt: isoNow(),
      resolvedAt: null,
    };
    this.alerts.set(alert.id, alert);
    return alert;
  }

  async listAlerts(filter: { status?: AlertStatus; limit?: number } = {}): Promise<ObservabilityAlertRecord[]> {
    return [...this.alerts.values()]
      .filter((alert) => !filter.status || alert.status === filter.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 100);
  }

  async summarizeCosts(): Promise<Array<Record<string, unknown>>> {
    const rows = new Map<string, { userId: string; workflowType: string; totalCostUsd: number; runs: number }>();
    for (const run of this.runs.values()) {
      const key = `${run.createdByUserId}:${run.workflowType}`;
      const row = rows.get(key) ?? { userId: run.createdByUserId, workflowType: run.workflowType, totalCostUsd: 0, runs: 0 };
      row.totalCostUsd += run.totalCostUsd;
      row.runs += 1;
      rows.set(key, row);
    }
    return [...rows.values()];
  }

  async summarizeStages(): Promise<Array<Record<string, unknown>>> {
    const byStage = new Map<string, StageRecord[]>();
    for (const stage of this.stages.values()) {
      byStage.set(stage.stageName, [...(byStage.get(stage.stageName) ?? []), stage]);
    }
    return [...byStage.entries()].map(([stageName, stages]) => ({
      stageName,
      attempts: stages.length,
      failures: stages.filter((stage) => stage.status === "failed").length,
      averageDurationMs: average(stages.map((stage) => stage.durationMs ?? 0)),
      totalCostUsd: sum(stages.map((stage) => stage.costUsd)),
    }));
  }

  async summarizeUsers(): Promise<Array<Record<string, unknown>>> {
    return [...this.users.values()].map((user) => {
      const runs = [...this.runs.values()].filter((run) => run.createdByUserId === user.id);
      const artifacts = [...this.artifacts.values()].filter((artifact) => artifact.createdByUserId === user.id);
      return {
        userId: user.id,
        email: user.email,
        role: user.role,
        runsStarted: runs.length,
        runsCompleted: runs.filter((run) => run.status === "succeeded").length,
        artifactsGenerated: artifacts.length,
        totalCostUsd: sum(runs.map((run) => run.totalCostUsd)),
        desktopClientVersion: user.desktopClientVersion,
      };
    });
  }

  private patchRun(runId: string, patch: Partial<RunRecord>): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new Error("run not found");
    const next = { ...run, ...dropUndefined(patch), updatedAt: isoNow() };
    this.runs.set(runId, next);
    return next;
  }

  private nextAttempt(runId: string, stageName: string): number {
    return [...this.stages.values()].filter((stage) => stage.runId === runId && stage.stageName === stageName).length + 1;
  }

  private requireStage(stageId: string): StageRecord {
    const stage = this.stages.get(stageId);
    if (!stage) throw new Error("stage not found");
    return stage;
  }

  private recomputeRunCost(runId: string): void {
    const totalCostUsd = sum([...this.stages.values()].filter((stage) => stage.runId === runId).map((stage) => stage.costUsd));
    this.patchRun(runId, { totalCostUsd });
  }
}

export class PostgresObservabilityRepository implements ObservabilityRepository {
  constructor(private readonly pool: Pool) {}

  async upsertUser(input: Parameters<ObservabilityRepository["upsertUser"]>[0]): Promise<UserRecord> {
    await this.ensureWorkspace(input.workspaceId);
    const result = await this.pool.query(
      `
      INSERT INTO users
        (workspace_id, auth_provider, auth_subject, email, name, role, status, desktop_client_version, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, EXTRACT(EPOCH FROM now())::bigint * 1000, EXTRACT(EPOCH FROM now())::bigint * 1000)
      ON CONFLICT (auth_provider, auth_subject) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        desktop_client_version = EXCLUDED.desktop_client_version,
        updated_at = EXTRACT(EPOCH FROM now())::bigint * 1000
      RETURNING *
      `,
      [
        input.workspaceId,
        input.authProvider,
        input.authSubject,
        input.email,
        input.name ?? null,
        input.role ?? "operator",
        input.status ?? "active",
        input.desktopClientVersion ?? null,
      ],
    );
    await this.pool.query(
      `
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at)
      VALUES ($1, $2, $3, 'active', EXTRACT(EPOCH FROM now())::bigint * 1000, EXTRACT(EPOCH FROM now())::bigint * 1000)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = EXTRACT(EPOCH FROM now())::bigint * 1000
      `,
      [input.workspaceId, result.rows[0].id, input.role ?? "operator"],
    );
    return mapUser(result.rows[0]);
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    const result = await this.pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async createRun(input: CreateRunInput & { canaryHash: string }): Promise<RunRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO runs
        (workspace_id, correlation_id, workflow_type, product_id, batch_id, created_by_user_id, status, desktop_client_version, canary_hash)
      VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8)
      RETURNING *
      `,
      [
        input.workspaceId,
        input.correlationId,
        input.workflowType,
        input.productId ?? null,
        input.batchId ?? null,
        input.createdByUserId,
        input.desktopClientVersion ?? null,
        input.canaryHash,
      ],
    );
    return mapRun(result.rows[0]);
  }

  async attachTriggerRunId(runId: string, triggerRunId: string): Promise<RunRecord> {
    return this.updateRun(runId, "trigger_run_id = $2", [triggerRunId]);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query("SELECT * FROM runs WHERE id = $1", [runId]);
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async listRuns(filter: { workspaceId?: string; createdByUserId?: string; limit?: number } = {}): Promise<RunRecord[]> {
    const result = await this.pool.query(
      `
      SELECT *
      FROM runs
      WHERE ($1::text IS NULL OR workspace_id = $1)
        AND ($2::text IS NULL OR created_by_user_id = $2)
      ORDER BY created_at DESC
      LIMIT $3
      `,
      [filter.workspaceId ?? null, filter.createdByUserId ?? null, filter.limit ?? 100],
    );
    return result.rows.map(mapRun);
  }

  async updateRunStatus(input: {
    runId: string;
    status: RunStatus;
    currentStage?: string | null;
    failureCategory?: string | null;
    failureMessageSafe?: string | null;
  }): Promise<RunRecord> {
    const result = await this.pool.query(
      `
      UPDATE runs
      SET status = $2,
          current_stage = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled', 'quarantined') THEN NULL ELSE COALESCE($3, current_stage) END,
          started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
          completed_at = CASE WHEN $2 = 'succeeded' THEN now() WHEN $2 IN ('queued', 'running') THEN NULL ELSE completed_at END,
          failed_at = CASE WHEN $2 IN ('failed', 'quarantined') THEN now() WHEN $2 IN ('queued', 'running', 'succeeded') THEN NULL ELSE failed_at END,
          failure_category = CASE WHEN $2 IN ('queued', 'running', 'succeeded') THEN NULL ELSE COALESCE($4, failure_category) END,
          failure_message_safe = CASE WHEN $2 IN ('queued', 'running', 'succeeded') THEN NULL ELSE COALESCE($5, failure_message_safe) END,
          updated_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [input.runId, input.status, input.currentStage ?? null, input.failureCategory ?? null, input.failureMessageSafe ?? null],
    );
    return mapRun(result.rows[0]);
  }

  async startStage(input: StartStageInput): Promise<StageRecord> {
    const attempt = input.attempt ?? await this.nextAttempt(input.runId, input.stageName);
    const result = await this.pool.query(
      `
      INSERT INTO run_stages (run_id, stage_name, provider, attempt, status, started_at)
      VALUES ($1, $2, $3, $4, 'running', now())
      RETURNING *
      `,
      [input.runId, input.stageName, input.provider ?? null, attempt],
    );
    return mapStage(result.rows[0]);
  }

  async completeStage(input: CompleteStageInput): Promise<StageRecord> {
    const result = await this.pool.query(
      `
      UPDATE run_stages
      SET status = 'succeeded',
          completed_at = now(),
          duration_ms = COALESCE($2, EXTRACT(EPOCH FROM (now() - started_at))::int * 1000),
          cost_usd = COALESCE($3, cost_usd)
      WHERE id = $1
      RETURNING *
      `,
      [input.stageId, input.durationMs ?? null, input.costUsd ?? null],
    );
    await this.recomputeRunCost(result.rows[0].run_id);
    return mapStage(result.rows[0]);
  }

  async failStage(input: FailStageInput): Promise<StageRecord> {
    const result = await this.pool.query(
      `
      UPDATE run_stages
      SET status = 'failed',
          completed_at = now(),
          duration_ms = COALESCE($2, EXTRACT(EPOCH FROM (now() - started_at))::int * 1000),
          cost_usd = COALESCE($3, cost_usd),
          error_category = $4,
          error_code = $5,
          error_message_safe = $6
      WHERE id = $1
      RETURNING *
      `,
      [input.stageId, input.durationMs ?? null, input.costUsd ?? null, input.errorCategory ?? null, input.errorCode ?? null, input.errorMessageSafe ?? null],
    );
    await this.recomputeRunCost(result.rows[0].run_id);
    return mapStage(result.rows[0]);
  }

  async listStages(runId: string): Promise<StageRecord[]> {
    const result = await this.pool.query("SELECT * FROM run_stages WHERE run_id = $1 ORDER BY created_at ASC", [runId]);
    return result.rows.map(mapStage);
  }

  async recordAiCall(input: RecordAiCallInput): Promise<AiCallRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO ai_calls
        (run_id, stage_id, provider, model, prompt_template_id, prompt_version, prompt_hash,
         input_tokens, output_tokens, cached_tokens, cost_usd, latency_ms, status, error_code, error_category)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
      `,
      [
        input.runId,
        input.stageId ?? null,
        input.provider,
        input.model,
        input.promptTemplateId ?? null,
        input.promptVersion ?? null,
        input.promptHash ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.cachedTokens ?? 0,
        input.costUsd ?? 0,
        input.latencyMs ?? null,
        input.status,
        input.errorCode ?? null,
        input.errorCategory ?? null,
      ],
    );
    return mapAiCall(result.rows[0]);
  }

  async listAiCalls(runId: string): Promise<AiCallRecord[]> {
    const result = await this.pool.query("SELECT * FROM ai_calls WHERE run_id = $1 ORDER BY created_at ASC", [runId]);
    return result.rows.map(mapAiCall);
  }

  async recordMediaCompute(input: RecordMediaComputeInput): Promise<MediaComputeRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO media_compute_events
        (run_id, stage_id, tool, operation, input_count, output_count, duration_ms,
         file_duration_seconds, output_size_bytes, status, error_code, error_category)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
      `,
      [
        input.runId,
        input.stageId ?? null,
        input.tool,
        input.operation,
        input.inputCount ?? 0,
        input.outputCount ?? 0,
        input.durationMs ?? null,
        input.fileDurationSeconds ?? null,
        input.outputSizeBytes ?? null,
        input.status,
        input.errorCode ?? null,
        input.errorCategory ?? null,
      ],
    );
    return mapMedia(result.rows[0]);
  }

  async listMediaCompute(runId: string): Promise<MediaComputeRecord[]> {
    const result = await this.pool.query("SELECT * FROM media_compute_events WHERE run_id = $1 ORDER BY created_at ASC", [runId]);
    return result.rows.map(mapMedia);
  }

  async recordArtifact(input: Omit<RecordArtifactInput, "textForLeakScan" | "metadataForLeakScan"> & { status: ArtifactStatus }): Promise<ArtifactLedgerRecord> {
    const run = await this.getRun(input.runId);
    if (!run) throw new Error("run not found");
    const result = await this.pool.query(
      `
      INSERT INTO run_artifacts
        (run_id, workspace_id, product_id, batch_id, created_by_user_id, workflow_type,
         artifact_type, status, size_bytes, storage_ref_id, public_export_allowed)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
      `,
      [
        input.runId,
        run.workspaceId,
        input.productId ?? run.productId,
        input.batchId ?? run.batchId,
        input.createdByUserId,
        input.workflowType,
        input.artifactType,
        input.status,
        input.sizeBytes ?? null,
        input.storageRefId ?? null,
        input.publicExportAllowed ?? false,
      ],
    );
    return mapArtifactLedger(result.rows[0]);
  }

  async listArtifacts(runId: string): Promise<ArtifactLedgerRecord[]> {
    const result = await this.pool.query("SELECT * FROM run_artifacts WHERE run_id = $1 ORDER BY created_at ASC", [runId]);
    return result.rows.map(mapArtifactLedger);
  }

  async getArtifact(artifactId: string): Promise<ArtifactLedgerRecord | null> {
    const result = await this.pool.query("SELECT * FROM run_artifacts WHERE id = $1", [artifactId]);
    return result.rows[0] ? mapArtifactLedger(result.rows[0]) : null;
  }

  async emitRunEvent(input: EmitRunEventInput): Promise<RunEventRecordInternal> {
    const result = await this.pool.query(
      `
      INSERT INTO workflow_run_events (run_id, stage_id, event_type, message_safe, metadata_safe)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [input.runId, input.stageId ?? null, input.eventType, input.messageSafe, input.metadataSafe ?? {}],
    );
    return mapRunEvent(result.rows[0]);
  }

  async listRunEvents(runId: string, afterEventId?: string): Promise<RunEventRecordInternal[]> {
    const cursor = afterEventId
      ? await this.pool.query("SELECT sequence FROM workflow_run_events WHERE id = $1 AND run_id = $2", [afterEventId, runId])
      : null;
    const afterSequence = cursor?.rows[0]?.sequence ? Number(cursor.rows[0].sequence) : null;
    const result = await this.pool.query(
      `
      SELECT *
      FROM workflow_run_events
      WHERE run_id = $1 AND ($2::bigint IS NULL OR sequence > $2)
      ORDER BY sequence ASC
      `,
      [runId, afterSequence],
    );
    return result.rows.map(mapRunEvent);
  }

  async createAlert(input: CreateAlertInput & { status?: AlertStatus }): Promise<ObservabilityAlertRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO observability_alerts (run_id, stage_id, alert_type, severity, status, message_safe, metadata_safe)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [input.runId ?? null, input.stageId ?? null, input.alertType, input.severity, input.status ?? "open", input.messageSafe, input.metadataSafe ?? {}],
    );
    return mapAlert(result.rows[0]);
  }

  async listAlerts(filter: { status?: AlertStatus; limit?: number } = {}): Promise<ObservabilityAlertRecord[]> {
    const result = await this.pool.query(
      `
      SELECT *
      FROM observability_alerts
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [filter.status ?? null, filter.limit ?? 100],
    );
    return result.rows.map(mapAlert);
  }

  async summarizeCosts(filter: { workspaceId?: string } = {}): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `
      SELECT u.email, r.workflow_type, SUM(r.total_cost_usd)::float AS total_cost_usd, COUNT(*)::int AS runs
      FROM runs r
      JOIN users u ON u.id = r.created_by_user_id
      WHERE ($1::text IS NULL OR r.workspace_id = $1)
      GROUP BY u.email, r.workflow_type
      ORDER BY total_cost_usd DESC
      `,
      [filter.workspaceId ?? null],
    );
    return result.rows;
  }

  async summarizeStages(filter: { workspaceId?: string } = {}): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `
      SELECT s.stage_name,
             COUNT(*)::int AS attempts,
             COUNT(*) FILTER (WHERE s.status = 'failed')::int AS failures,
             AVG(s.duration_ms)::float AS average_duration_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms) AS p95_duration_ms,
             SUM(s.cost_usd)::float AS total_cost_usd
      FROM run_stages s
      JOIN runs r ON r.id = s.run_id
      WHERE ($1::text IS NULL OR r.workspace_id = $1)
      GROUP BY s.stage_name
      ORDER BY failures DESC, p95_duration_ms DESC NULLS LAST
      `,
      [filter.workspaceId ?? null],
    );
    return result.rows;
  }

  async summarizeUsers(filter: { workspaceId?: string } = {}): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `
      SELECT u.id AS user_id,
             u.email,
             u.role,
             u.desktop_client_version,
             COUNT(r.id)::int AS runs_started,
             COUNT(r.id) FILTER (WHERE r.status = 'succeeded')::int AS runs_completed,
             COALESCE(SUM(r.total_cost_usd), 0)::float AS total_cost_usd,
             COUNT(a.id)::int AS artifacts_generated
      FROM users u
      LEFT JOIN runs r ON r.created_by_user_id = u.id
      LEFT JOIN run_artifacts a ON a.created_by_user_id = u.id
      WHERE ($1::text IS NULL OR u.workspace_id = $1)
      GROUP BY u.id
      ORDER BY runs_started DESC
      `,
      [filter.workspaceId ?? null],
    );
    return result.rows;
  }

  private async ensureWorkspace(workspaceId: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO workspaces (id, name, created_at, updated_at)
      VALUES ($1, $1, EXTRACT(EPOCH FROM now())::bigint * 1000, EXTRACT(EPOCH FROM now())::bigint * 1000)
      ON CONFLICT (id) DO NOTHING
      `,
      [workspaceId],
    );
  }

  private async nextAttempt(runId: string, stageName: string): Promise<number> {
    const result = await this.pool.query(
      "SELECT COUNT(*)::int + 1 AS attempt FROM run_stages WHERE run_id = $1 AND stage_name = $2",
      [runId, stageName],
    );
    return Number(result.rows[0]?.attempt ?? 1);
  }

  private async recomputeRunCost(runId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE runs
      SET total_cost_usd = COALESCE((SELECT SUM(cost_usd) FROM run_stages WHERE run_id = $1), 0),
          updated_at = now()
      WHERE id = $1
      `,
      [runId],
    );
  }

  private async updateRun(runId: string, setSql: string, values: unknown[]): Promise<RunRecord> {
    const result = await this.pool.query(
      `UPDATE runs SET ${setSql}, updated_at = now() WHERE id = $1 RETURNING *`,
      [runId, ...values],
    );
    return mapRun(result.rows[0]);
  }
}

type RunEventRecordInternal = RunEventRecord & { sequence?: number };

function isoNow(): string {
  return new Date().toISOString();
}

function elapsedMs(startedAt: string | null): number | null {
  return startedAt ? Math.max(0, Date.now() - new Date(startedAt).getTime()) : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function average(values: number[]): number {
  const present = values.filter((value) => Number.isFinite(value) && value > 0);
  return present.length ? Math.round(sum(present) / present.length) : 0;
}

function dropUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function mapUser(row: QueryResultRow): UserRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    authProvider: String(row.auth_provider),
    authSubject: String(row.auth_subject),
    email: String(row.email),
    name: row.name ?? null,
    role: row.role as UserRole,
    status: row.status,
    desktopClientVersion: row.desktop_client_version ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapRun(row: QueryResultRow): RunRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    triggerRunId: row.trigger_run_id ?? null,
    correlationId: String(row.correlation_id),
    workflowType: row.workflow_type,
    productId: row.product_id ?? null,
    batchId: row.batch_id ?? null,
    createdByUserId: String(row.created_by_user_id),
    status: row.status,
    currentStage: row.current_stage ?? null,
    totalCostUsd: Number(row.total_cost_usd ?? 0),
    desktopClientVersion: row.desktop_client_version ?? null,
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    failedAt: nullableIso(row.failed_at),
    failureCategory: row.failure_category ?? null,
    failureMessageSafe: row.failure_message_safe ?? null,
    canaryHash: String(row.canary_hash ?? ""),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapStage(row: QueryResultRow): StageRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageName: String(row.stage_name),
    provider: row.provider ?? null,
    attempt: Number(row.attempt),
    status: row.status,
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    costUsd: Number(row.cost_usd ?? 0),
    errorCategory: row.error_category ?? null,
    errorCode: row.error_code ?? null,
    errorMessageSafe: row.error_message_safe ?? null,
    createdAt: toIso(row.created_at),
  };
}

function mapAiCall(row: QueryResultRow): AiCallRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageId: row.stage_id ?? null,
    provider: String(row.provider),
    model: String(row.model),
    promptTemplateId: row.prompt_template_id ?? null,
    promptVersion: row.prompt_version ?? null,
    promptHash: row.prompt_hash ?? null,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cachedTokens: Number(row.cached_tokens ?? 0),
    costUsd: Number(row.cost_usd ?? 0),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    status: row.status,
    errorCode: row.error_code ?? null,
    errorCategory: row.error_category ?? null,
    createdAt: toIso(row.created_at),
  };
}

function mapMedia(row: QueryResultRow): MediaComputeRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageId: row.stage_id ?? null,
    tool: String(row.tool),
    operation: String(row.operation),
    inputCount: Number(row.input_count ?? 0),
    outputCount: Number(row.output_count ?? 0),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    fileDurationSeconds: row.file_duration_seconds === null ? null : Number(row.file_duration_seconds),
    outputSizeBytes: row.output_size_bytes === null ? null : Number(row.output_size_bytes),
    status: row.status,
    errorCode: row.error_code ?? null,
    errorCategory: row.error_category ?? null,
    createdAt: toIso(row.created_at),
  };
}

function mapArtifactLedger(row: QueryResultRow): ArtifactLedgerRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    workspaceId: String(row.workspace_id),
    productId: row.product_id ?? null,
    batchId: row.batch_id ?? null,
    createdByUserId: String(row.created_by_user_id),
    workflowType: row.workflow_type,
    artifactType: String(row.artifact_type),
    status: row.status,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    storageRefId: row.storage_ref_id ?? null,
    publicExportAllowed: Boolean(row.public_export_allowed),
    createdAt: toIso(row.created_at),
  };
}

function mapRunEvent(row: QueryResultRow): RunEventRecordInternal {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageId: row.stage_id ?? null,
    eventType: String(row.event_type),
    messageSafe: String(row.message_safe ?? ""),
    metadataSafe: isObject(row.metadata_safe) ? row.metadata_safe as Record<string, unknown> : {},
    createdAt: toIso(row.created_at),
    sequence: Number(row.sequence ?? 0),
  };
}

function mapAlert(row: QueryResultRow): ObservabilityAlertRecord {
  return {
    id: String(row.id),
    runId: row.run_id ?? null,
    stageId: row.stage_id ?? null,
    alertType: String(row.alert_type),
    severity: row.severity,
    status: row.status,
    messageSafe: String(row.message_safe ?? ""),
    metadataSafe: isObject(row.metadata_safe) ? row.metadata_safe as Record<string, unknown> : {},
    createdAt: toIso(row.created_at),
    resolvedAt: nullableIso(row.resolved_at),
  };
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "bigint") return new Date(Number(value)).toISOString();
  if (typeof value === "string" && /^\d+$/.test(value)) return new Date(Number(value)).toISOString();
  if (typeof value === "string") return value;
  return new Date(value as string | number).toISOString();
}

function isObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

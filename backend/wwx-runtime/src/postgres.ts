import { Pool, type PoolClient, type QueryResultRow } from "pg";
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
import type { ClaimedJob, Store } from "./store.js";
import { id, nowMs, slugify } from "./ids.js";

export class PostgresStore implements Store {
  constructor(
    private readonly pool: Pool,
    private readonly maxActiveJobs = 6,
  ) {}

  static fromDatabaseUrl(databaseUrl: string, maxActiveJobs = 6): PostgresStore {
    return new PostgresStore(new Pool({ connectionString: databaseUrl }), maxActiveJobs);
  }

  async ensureProduct(workspaceId: string, productId: string, name = productId, config: Record<string, unknown> = {}): Promise<void> {
    const now = nowMs();
    await this.pool.query(
      `
      INSERT INTO workspaces (id, name, created_at, updated_at)
      VALUES ($1, $1, $2, $2)
      ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at
      `,
      [workspaceId, now],
    );
    await this.pool.query(
      `
      INSERT INTO products (workspace_id, id, name, config, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $5)
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        name = COALESCE(NULLIF(EXCLUDED.name, ''), products.name),
        config = products.config || EXCLUDED.config,
        updated_at = EXCLUDED.updated_at
      `,
      [workspaceId, productId, name, config, now],
    );
  }

  async createResearchRun(workspaceId: string, productId: string, topic: string, searchTerms: string[]): Promise<ResearchRun> {
    const now = nowMs();
    const run: ResearchRun = {
      id: id("research"),
      workspaceId,
      productId,
      topic,
      topicSlug: slugify(topic),
      searchTerms,
      status: "complete",
      quality: { searchTermCount: searchTerms.length, corpusRefs: searchTerms.length },
      createdAt: now,
      updatedAt: now,
    };
    await this.pool.query(
      `
      INSERT INTO research_runs
        (id, workspace_id, product_id, topic, topic_slug, search_terms, status, quality, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [run.id, workspaceId, productId, topic, run.topicSlug, JSON.stringify(searchTerms), run.status, run.quality, now, now],
    );
    return run;
  }

  async listResearchRuns(workspaceId: string, productId: string): Promise<ResearchRun[]> {
    const result = await this.pool.query(
      "SELECT * FROM research_runs WHERE workspace_id = $1 AND product_id = $2 ORDER BY updated_at DESC",
      [workspaceId, productId],
    );
    return result.rows.map(mapResearchRun);
  }

  async ensureBatch(workspaceId: string, batchId: string, input: CreateAdsInput): Promise<Batch> {
    const now = nowMs();
    const result = await this.pool.query(
      `
      INSERT INTO batches
        (workspace_id, id, product_id, name, status, current_stage, requested_ad_count, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'queued', NULL, $5, $6, $6)
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        product_id = EXCLUDED.product_id,
        name = EXCLUDED.name,
        requested_ad_count = EXCLUDED.requested_ad_count,
        updated_at = EXCLUDED.updated_at
      RETURNING *
      `,
      [workspaceId, batchId, input.productId, input.batchName ?? batchId, input.adCount, now],
    );
    await this.linkBatchResearchRuns(workspaceId, batchId, input.selectedResearchRunIds ?? []);
    return mapBatch(result.rows[0]);
  }

  async enqueueJob(workspaceId: string, batchId: string, type: QueueJob["type"], payload: Record<string, unknown>): Promise<QueueJob> {
    const now = nowMs();
    const result = await this.pool.query(
      `
      INSERT INTO job_queue
        (id, workspace_id, batch_id, type, payload, status, attempts, max_attempts, lease_owner, lease_expires_at, run_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 'queued', 0, 3, NULL, NULL, NULL, $6, $6)
      RETURNING *
      `,
      [id("job"), workspaceId, batchId, type, payload, now],
    );
    return mapQueueJob(result.rows[0]);
  }

  async claimNextJob(workerId: string, leaseMs: number): Promise<ClaimedJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = nowMs();
      const active = await client.query(
        "SELECT COUNT(*)::int AS count FROM job_queue WHERE status = 'running' AND lease_expires_at > $1",
        [now],
      );
      if (Number(active.rows[0]?.count ?? 0) >= this.maxActiveJobs) {
        await client.query("COMMIT");
        return null;
      }
      const selected = await client.query(
        `
        SELECT *
        FROM job_queue candidate
        WHERE candidate.attempts < candidate.max_attempts
          AND (
            candidate.status = 'queued'
            OR (candidate.status = 'running' AND COALESCE(candidate.lease_expires_at, 0) <= $1)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM job_queue active
            WHERE active.id <> candidate.id
              AND active.workspace_id = candidate.workspace_id
              AND active.batch_id = candidate.batch_id
              AND active.status = 'running'
              AND COALESCE(active.lease_expires_at, 0) > $1
          )
        ORDER BY candidate.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
        `,
        [now],
      );
      const jobRow = selected.rows[0];
      if (!jobRow) {
        await client.query("COMMIT");
        return null;
      }
      const run = await this.startRun(client, jobRow.workspace_id, jobRow.batch_id, now);
      const updated = await client.query(
        `
        UPDATE job_queue
        SET status = 'running',
            attempts = attempts + 1,
            lease_owner = $2,
            lease_expires_at = $3,
            run_id = $4,
            updated_at = $5
        WHERE id = $1
        RETURNING *
        `,
        [jobRow.id, workerId, now + leaseMs, run.id, now],
      );
      await client.query("COMMIT");
      return { ...mapQueueJob(updated.rows[0]), run };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeatJob(jobId: string, runId: string, workerId: string, leaseMs: number): Promise<void> {
    const now = nowMs();
    await this.pool.query(
      `
      UPDATE job_queue
      SET lease_expires_at = $4, updated_at = $5
      WHERE id = $1 AND run_id = $2 AND lease_owner = $3
      `,
      [jobId, runId, workerId, now + leaseMs, now],
    );
    await this.pool.query(
      "UPDATE batch_runs SET heartbeat_at = $2 WHERE id = $1",
      [runId, now],
    );
  }

  async completeJob(jobId: string, runId: string, status: RunStatus): Promise<void> {
    const client = await this.pool.connect();
    const now = nowMs();
    const jobStatus = status === "complete" ? "complete" : status === "stopped" ? "stopped" : "failed";
    try {
      await client.query("BEGIN");
      const job = await client.query("SELECT * FROM job_queue WHERE id = $1", [jobId]);
      await client.query(
        "UPDATE job_queue SET status = $2, lease_expires_at = NULL, updated_at = $3 WHERE id = $1",
        [jobId, jobStatus, now],
      );
      await client.query(
        "UPDATE batch_runs SET status = $2, finished_at = $3, heartbeat_at = $3 WHERE id = $1",
        [runId, status, now],
      );
      const row = job.rows[0];
      if (row) {
        await client.query(
          "UPDATE batches SET status = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2",
          [row.workspace_id, row.batch_id, status, now],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failJob(jobId: string, runId: string, reason: string): Promise<void> {
    const now = nowMs();
    await this.pool.query(
      "UPDATE batch_runs SET status = 'failed', finished_at = $2, heartbeat_at = $2, error_reason = $3 WHERE id = $1",
      [runId, now, sanitizeReason(reason)],
    );
    const updated = await this.pool.query(
      `
      UPDATE job_queue
      SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = $2,
          last_error = $3
      WHERE id = $1
      RETURNING *
      `,
      [jobId, now, sanitizeReason(reason)],
    );
    const row = updated.rows[0];
    if (row?.status === "dead_letter") {
      await this.pool.query(
        "UPDATE batches SET status = 'failed', updated_at = $3 WHERE workspace_id = $1 AND id = $2",
        [row.workspace_id, row.batch_id, now],
      );
    }
  }

  async requestStop(workspaceId: string, batchId: string, reason?: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO run_control_commands (id, workspace_id, batch_id, command, reason, created_at, resolved_at)
      VALUES ($1, $2, $3, 'stop_requested', $4, $5, NULL)
      `,
      [id("ctrl"), workspaceId, batchId, reason ?? null, nowMs()],
    );
  }

  async clearStop(workspaceId: string, batchId: string): Promise<void> {
    const now = nowMs();
    await this.pool.query(
      `
      UPDATE run_control_commands
      SET resolved_at = $3
      WHERE workspace_id = $1 AND batch_id = $2 AND command = 'stop_requested' AND resolved_at IS NULL
      `,
      [workspaceId, batchId, now],
    );
    await this.pool.query(
      `
      INSERT INTO run_control_commands (id, workspace_id, batch_id, command, reason, created_at, resolved_at)
      VALUES ($1, $2, $3, 'continue_requested', NULL, $4, $4)
      `,
      [id("ctrl"), workspaceId, batchId, now],
    );
  }

  async shouldStop(workspaceId: string, batchId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
      SELECT 1
      FROM run_control_commands
      WHERE workspace_id = $1 AND batch_id = $2 AND command = 'stop_requested' AND resolved_at IS NULL
      LIMIT 1
      `,
      [workspaceId, batchId],
    );
    return Boolean(result.rows[0]);
  }

  async appendEvent(input: Omit<RunEvent, "id" | "createdAt">): Promise<RunEvent> {
    const event: RunEvent = { ...input, id: id("evt"), createdAt: nowMs() };
    await this.pool.query(
      `
      INSERT INTO run_events (id, workspace_id, batch_id, run_id, type, stage, message, payload, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [event.id, event.workspaceId, event.batchId, event.runId, event.type, event.stage, event.message, event.payload, event.createdAt],
    );
    return event;
  }

  async listEvents(workspaceId: string, batchId: string, afterEventId?: string): Promise<RunEvent[]> {
    let afterSequence: number | null = null;
    if (afterEventId) {
      const cursor = await this.pool.query(
        "SELECT sequence FROM run_events WHERE workspace_id = $1 AND batch_id = $2 AND id = $3",
        [workspaceId, batchId, afterEventId],
      );
      afterSequence = cursor.rows[0]?.sequence ? Number(cursor.rows[0].sequence) : null;
    }
    const result = await this.pool.query(
      `
      SELECT *
      FROM run_events
      WHERE workspace_id = $1 AND batch_id = $2 AND ($3::bigint IS NULL OR sequence > $3)
      ORDER BY sequence ASC
      `,
      [workspaceId, batchId, afterSequence],
    );
    return result.rows.map(mapRunEvent);
  }

  async setStageState(input: Omit<StageState, "id" | "updatedAt">): Promise<StageState> {
    const now = nowMs();
    const result = await this.pool.query(
      `
      INSERT INTO stage_states
        (id, workspace_id, batch_id, run_id, stage, status, expected_items, completed_items, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (workspace_id, batch_id, stage) DO UPDATE SET
        run_id = EXCLUDED.run_id,
        status = EXCLUDED.status,
        expected_items = EXCLUDED.expected_items,
        completed_items = EXCLUDED.completed_items,
        updated_at = EXCLUDED.updated_at
      RETURNING *
      `,
      [id("stage"), input.workspaceId, input.batchId, input.runId, input.stage, input.status, input.expectedItems, input.completedItems, now],
    );
    await this.pool.query(
      "UPDATE batches SET current_stage = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2",
      [input.workspaceId, input.batchId, input.stage, now],
    );
    await this.pool.query(
      "UPDATE batch_runs SET current_stage = $2, heartbeat_at = $3 WHERE id = $1",
      [input.runId, input.stage, now],
    );
    return mapStageState(result.rows[0]);
  }

  async getStageState(workspaceId: string, batchId: string, stage: string): Promise<StageState | null> {
    const result = await this.pool.query(
      "SELECT * FROM stage_states WHERE workspace_id = $1 AND batch_id = $2 AND stage = $3",
      [workspaceId, batchId, stage],
    );
    return result.rows[0] ? mapStageState(result.rows[0]) : null;
  }

  async upsertWorkItem(input: Omit<StageWorkItem, "id" | "updatedAt">): Promise<StageWorkItem> {
    const now = nowMs();
    const result = await this.pool.query(
      `
      INSERT INTO stage_work_items
        (id, workspace_id, batch_id, run_id, stage, item_key, status, artifact_id, idempotency_key, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (workspace_id, batch_id, stage, item_key) DO UPDATE SET
        run_id = stage_work_items.run_id,
        status = stage_work_items.status,
        artifact_id = stage_work_items.artifact_id,
        updated_at = stage_work_items.updated_at
      RETURNING *
      `,
      [id("work"), input.workspaceId, input.batchId, input.runId, input.stage, input.itemKey, input.status, input.artifactId, input.idempotencyKey, now],
    );
    return mapWorkItem(result.rows[0]);
  }

  async updateWorkItemStatus(workspaceId: string, batchId: string, stage: string, itemKey: string, status: WorkItemStatus, artifactId: string | null = null): Promise<StageWorkItem> {
    const result = await this.pool.query(
      `
      UPDATE stage_work_items
      SET status = $5, artifact_id = COALESCE($6, artifact_id), updated_at = $7
      WHERE workspace_id = $1 AND batch_id = $2 AND stage = $3 AND item_key = $4
      RETURNING *
      `,
      [workspaceId, batchId, stage, itemKey, status, artifactId, nowMs()],
    );
    if (!result.rows[0]) throw new Error(`work item not found: ${stage}/${itemKey}`);
    return mapWorkItem(result.rows[0]);
  }

  async listWorkItems(workspaceId: string, batchId: string, stage?: string): Promise<StageWorkItem[]> {
    const result = await this.pool.query(
      `
      SELECT *
      FROM stage_work_items
      WHERE workspace_id = $1 AND batch_id = $2 AND ($3::text IS NULL OR stage = $3)
      ORDER BY item_key ASC
      `,
      [workspaceId, batchId, stage ?? null],
    );
    return result.rows.map(mapWorkItem);
  }

  async publishArtifact(input: Omit<Artifact, "id" | "createdAt" | "updatedAt" | "version">): Promise<Artifact> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `
        SELECT *
        FROM artifacts
        WHERE workspace_id = $1 AND batch_id = $2 AND filename = $3 AND content_sha256 = $4
        LIMIT 1
        `,
        [input.workspaceId, input.batchId, input.filename, input.contentSha256],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return mapArtifact(existing.rows[0]);
      }
      const versionResult = await client.query(
        "SELECT COUNT(*)::int + 1 AS version FROM artifacts WHERE workspace_id = $1 AND batch_id = $2 AND filename = $3",
        [input.workspaceId, input.batchId, input.filename],
      );
      const now = nowMs();
      const artifactId = id("art");
      const version = Number(versionResult.rows[0]?.version ?? 1);
      const inserted = await client.query(
        `
        INSERT INTO artifacts
          (id, workspace_id, batch_id, filename, label, mime_type, visibility_class, object_key, content_sha256, size, version, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
        RETURNING *
        `,
        [
          artifactId,
          input.workspaceId,
          input.batchId,
          input.filename,
          input.label,
          input.mimeType,
          input.visibilityClass,
          input.objectKey,
          input.contentSha256,
          input.size,
          version,
          now,
        ],
      );
      await client.query(
        `
        INSERT INTO artifact_versions
          (artifact_id, workspace_id, batch_id, version, content_sha256, object_key, visibility_class, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [artifactId, input.workspaceId, input.batchId, version, input.contentSha256, input.objectKey, input.visibilityClass, now],
      );
      await client.query("COMMIT");
      return mapArtifact(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listPublicArtifacts(workspaceId: string, batchId: string): Promise<Artifact[]> {
    const result = await this.pool.query(
      `
      SELECT *
      FROM artifacts
      WHERE workspace_id = $1 AND batch_id = $2 AND visibility_class LIKE 'public_%'
      ORDER BY filename ASC
      `,
      [workspaceId, batchId],
    );
    return result.rows.map(mapArtifact);
  }

  async getPublicArtifact(workspaceId: string, artifactId: string): Promise<Artifact | null> {
    const result = await this.pool.query(
      "SELECT * FROM artifacts WHERE workspace_id = $1 AND id = $2 AND visibility_class LIKE 'public_%'",
      [workspaceId, artifactId],
    );
    return result.rows[0] ? mapArtifact(result.rows[0]) : null;
  }

  async getArtifactContent(artifactId: string): Promise<string | null> {
    const result = await this.pool.query(
      "SELECT content_text FROM artifact_bodies WHERE artifact_id = $1",
      [artifactId],
    );
    return result.rows[0]?.content_text ?? null;
  }

  async setArtifactContent(artifactId: string, content: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO artifact_bodies (artifact_id, content_text, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (artifact_id) DO UPDATE SET
        content_text = EXCLUDED.content_text,
        updated_at = EXCLUDED.updated_at
      `,
      [artifactId, content, nowMs()],
    );
  }

  async getBatchStatus(workspaceId: string, batchId: string): Promise<BatchStatus | null> {
    const batch = await this.pool.query(
      "SELECT * FROM batches WHERE workspace_id = $1 AND id = $2",
      [workspaceId, batchId],
    );
    if (!batch.rows[0]) return null;
    const run = await this.pool.query(
      "SELECT * FROM batch_runs WHERE workspace_id = $1 AND batch_id = $2 ORDER BY started_at DESC LIMIT 1",
      [workspaceId, batchId],
    );
    const stages = await this.pool.query(
      "SELECT * FROM stage_states WHERE workspace_id = $1 AND batch_id = $2 ORDER BY updated_at ASC",
      [workspaceId, batchId],
    );
    return {
      batch: mapBatch(batch.rows[0]),
      run: run.rows[0] ? mapBatchRun(run.rows[0]) : null,
      stages: stages.rows.map(mapStageState),
      workItems: await this.listWorkItems(workspaceId, batchId),
      artifacts: await this.listPublicArtifacts(workspaceId, batchId),
    };
  }

  private async linkBatchResearchRuns(workspaceId: string, batchId: string, researchRunIds: string[]): Promise<void> {
    if (!researchRunIds.length) return;
    const now = nowMs();
    for (const researchRunId of researchRunIds) {
      await this.pool.query(
        `
        INSERT INTO batch_research_runs (workspace_id, batch_id, research_run_id, created_at)
        SELECT $1, $2, id, $4
        FROM research_runs
        WHERE workspace_id = $1 AND id = $3
        ON CONFLICT DO NOTHING
        `,
        [workspaceId, batchId, researchRunId, now],
      );
    }
  }

  private async startRun(client: PoolClient, workspaceId: string, batchId: string, now: number): Promise<BatchRun> {
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
    await client.query(
      `
      INSERT INTO batch_runs
        (id, workspace_id, batch_id, status, current_stage, started_at, finished_at, heartbeat_at)
      VALUES ($1, $2, $3, 'running', NULL, $4, NULL, $4)
      `,
      [run.id, workspaceId, batchId, now],
    );
    await client.query(
      "UPDATE batches SET status = 'running', updated_at = $3 WHERE workspace_id = $1 AND id = $2",
      [workspaceId, batchId, now],
    );
    return run;
  }
}

function sanitizeReason(reason: string): string {
  return reason.replace(/[^\x20-\x7E]/g, "").slice(0, 240) || "RUNTIME_FAILURE";
}

function mapResearchRun(row: QueryResultRow): ResearchRun {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    productId: String(row.product_id),
    topic: String(row.topic),
    topicSlug: String(row.topic_slug),
    searchTerms: asArray(row.search_terms),
    status: row.status,
    quality: asRecord(row.quality),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapBatch(row: QueryResultRow): Batch {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    productId: String(row.product_id),
    name: String(row.name),
    status: row.status,
    currentStage: row.current_stage ?? null,
    requestedAdCount: Number(row.requested_ad_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapBatchRun(row: QueryResultRow): BatchRun {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    batchId: String(row.batch_id),
    status: row.status,
    currentStage: row.current_stage ?? null,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    heartbeatAt: Number(row.heartbeat_at),
  };
}

function mapQueueJob(row: QueryResultRow): QueueJob {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    batchId: String(row.batch_id),
    type: row.type,
    payload: asRecord(row.payload),
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: row.lease_owner ?? null,
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    runId: row.run_id ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapRunEvent(row: QueryResultRow): RunEvent {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    batchId: String(row.batch_id),
    runId: row.run_id ?? null,
    type: row.type,
    stage: row.stage ?? null,
    message: String(row.message),
    payload: asRecord(row.payload),
    createdAt: Number(row.created_at),
  };
}

function mapStageState(row: QueryResultRow): StageState {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    batchId: String(row.batch_id),
    runId: String(row.run_id),
    stage: String(row.stage),
    status: row.status,
    expectedItems: Number(row.expected_items),
    completedItems: Number(row.completed_items),
    updatedAt: Number(row.updated_at),
  };
}

function mapWorkItem(row: QueryResultRow): StageWorkItem {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    batchId: String(row.batch_id),
    runId: String(row.run_id),
    stage: String(row.stage),
    itemKey: String(row.item_key),
    status: row.status,
    artifactId: row.artifact_id ?? null,
    idempotencyKey: String(row.idempotency_key),
    updatedAt: Number(row.updated_at),
  };
}

function mapArtifact(row: QueryResultRow): Artifact {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    batchId: String(row.batch_id),
    filename: String(row.filename),
    label: String(row.label),
    mimeType: String(row.mime_type),
    visibilityClass: row.visibility_class,
    objectKey: String(row.object_key),
    contentSha256: String(row.content_sha256),
    size: Number(row.size),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

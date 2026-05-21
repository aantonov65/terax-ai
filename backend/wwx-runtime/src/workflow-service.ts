import {
  ObservabilityClient,
  WORKFLOW_TYPES,
  type ArtifactLedgerRecord,
  type RunEventRecord,
  type RunRecord,
  type WorkflowType,
} from "../../../packages/observability/src/index.js";
import type { AuthContext } from "./auth.js";
import { publicError } from "./auth.js";
import type { RuntimeService } from "./service.js";
import type { WorkflowTrigger } from "./trigger.js";
import { createAdsInputFromWorkflow } from "./workflow-input.js";

export type WorkflowRunInput = {
  workflowType?: string;
  productId?: string | null;
  batchId?: string | null;
  payload?: Record<string, unknown>;
};

export class WorkflowRuntimeService {
  constructor(
    private readonly observability: ObservabilityClient,
    private readonly trigger: WorkflowTrigger,
    private readonly runtimeService: RuntimeService | null = null,
    private readonly minimumClientVersion = process.env.WWX_MINIMUM_DESKTOP_VERSION ?? null,
  ) {}

  capabilities() {
    return {
      workflows: WORKFLOW_TYPES,
      features: {
        trigger_orchestration: true,
        replayable_events: true,
        admin_observability: true,
        canary_quarantine: true,
        operator_cost_visibility: false,
      },
      minimum_client_version: this.minimumClientVersion,
    };
  }

  async createRun(auth: AuthContext, input: WorkflowRunInput): Promise<{ run: Record<string, unknown> }> {
    this.requireSupportedClient(auth.clientVersion);
    const workflowType = parseWorkflowType(input.workflowType);
    const run = await this.observability.createRun({
      workspaceId: auth.workspaceId,
      workflowType,
      productId: input.productId ?? null,
      batchId: input.batchId ?? null,
      createdByUserId: auth.user.id,
      desktopClientVersion: auth.clientVersion,
      correlationId: auth.correlationId,
    });
    const triggerPayload = await this.prepareTriggerPayload(auth, run, input);
    let triggerRun: Awaited<ReturnType<WorkflowTrigger["trigger"]>>;
    try {
      triggerRun = await this.trigger.trigger({
        runId: run.id,
        workflowType,
        workspaceId: auth.workspaceId,
        createdByUserId: auth.user.id,
        correlationId: run.correlationId,
        payload: triggerPayload,
      });
    } catch (error) {
      await this.observability.markRunFailed(run.id, "orchestrator_unavailable", "Workflow could not be started.");
      await this.observability.emitRunEvent({
        runId: run.id,
        eventType: "run_failed",
        messageSafe: "Workflow could not be started.",
        metadataSafe: { workflow_type: workflowType, failure_category: "orchestrator_unavailable" },
      });
      throw publicError("WORKFLOW_START_FAILED", 503);
    }
    await this.observability.attachTriggerRunId(run.id, triggerRun.triggerRunId);
    await this.observability.emitRunEvent({
      runId: run.id,
      eventType: "run_queued",
      messageSafe: "Run queued",
      metadataSafe: { workflow_type: workflowType, trigger_provider: triggerRun.provider },
    });
    return { run: operatorRun({ ...run, triggerRunId: triggerRun.triggerRunId }) };
  }

  async stopRun(auth: AuthContext, runId: string): Promise<Record<string, unknown>> {
    const run = await this.requireRun(auth, runId);
    if (this.runtimeService && run.batchId) {
      await this.runtimeService.stopBatch(auth.workspaceId, run.batchId, "operator stop requested");
    }
    await this.observability.emitRunEvent({
      runId: run.id,
      eventType: "stop_requested",
      messageSafe: "Stop requested",
      metadataSafe: { requested_by_user_id: auth.user.id },
    });
    const stopped = await this.observability.markRunCancelled(run.id, "operator_stop_requested", "Stop requested by operator.");
    return operatorRun(stopped);
  }

  async continueRun(auth: AuthContext, runId: string): Promise<Record<string, unknown>> {
    const run = await this.requireRun(auth, runId);
    if (run.status !== "cancelled" && run.status !== "failed") {
      throw publicError("RUN_NOT_CONTINUABLE", 409);
    }
    const triggerPayload = await this.prepareResumePayload(auth, run);
    const triggerRun = await this.trigger.trigger({
      runId: run.id,
      workflowType: run.workflowType,
      workspaceId: auth.workspaceId,
      createdByUserId: auth.user.id,
      correlationId: run.correlationId,
      payload: triggerPayload,
    });
    const resumed = await this.observability.attachTriggerRunId(run.id, triggerRun.triggerRunId);
    await this.observability.markRunQueued(run.id);
    await this.observability.emitRunEvent({ runId: run.id, eventType: "run_resumed", messageSafe: "Run resumed" });
    return operatorRun({ ...resumed, status: "queued" });
  }

  async retryRun(auth: AuthContext, runId: string): Promise<Record<string, unknown>> {
    const run = await this.requireRun(auth, runId);
    if (run.status !== "failed" && run.status !== "quarantined") {
      throw publicError("RUN_NOT_RETRYABLE", 409);
    }
    const triggerPayload = await this.prepareResumePayload(auth, run);
    const triggerRun = await this.trigger.trigger({
      runId: run.id,
      workflowType: run.workflowType,
      workspaceId: auth.workspaceId,
      createdByUserId: auth.user.id,
      correlationId: run.correlationId,
      payload: { ...triggerPayload, retry: true },
    });
    const retried = await this.observability.attachTriggerRunId(run.id, triggerRun.triggerRunId);
    await this.observability.markRunQueued(run.id);
    await this.observability.emitRunEvent({ runId: run.id, eventType: "run_retry_requested", messageSafe: "Retry requested" });
    return operatorRun({ ...retried, status: "queued" });
  }

  async getStatus(auth: AuthContext, runId: string): Promise<Record<string, unknown>> {
    const run = await this.requireRun(auth, runId);
    const stages = await this.observability.listStages(runId);
    const artifacts = await this.observability.listArtifacts(runId);
    return {
      run: operatorRun(run),
      stages: stages.map((stage) => ({
        id: stage.id,
        stage_name: stage.stageName,
        attempt: stage.attempt,
        status: stage.status,
        started_at: stage.startedAt,
        completed_at: stage.completedAt,
        duration_ms: stage.durationMs,
      })),
      artifacts: artifacts.filter((artifact) => artifact.publicExportAllowed).map(operatorArtifact),
    };
  }

  async listEvents(auth: AuthContext, runId: string, afterEventId?: string): Promise<RunEventRecord[]> {
    await this.requireRun(auth, runId);
    return this.observability.listRunEvents(runId, afterEventId);
  }

  async listArtifacts(auth: AuthContext, runId: string): Promise<Record<string, unknown>[]> {
    await this.requireRun(auth, runId);
    const artifacts = await this.observability.listArtifacts(runId);
    return artifacts.filter((artifact) => artifact.publicExportAllowed && artifact.status !== "quarantined").map(operatorArtifact);
  }

  async getArtifact(auth: AuthContext, artifactId: string): Promise<Record<string, unknown>> {
    const artifact = await this.observability.getArtifact(artifactId);
    if (artifact?.workspaceId === auth.workspaceId && artifact.publicExportAllowed && artifact.status !== "quarantined") return operatorArtifact(artifact);
    throw publicError("ARTIFACT_NOT_FOUND", 404);
  }

  async answerQuestion(auth: AuthContext, runId: string, question: string): Promise<Record<string, unknown>> {
    await this.requireRun(auth, runId);
    if (isCostQuestion(question)) {
      return {
        refused: true,
        answer: "Cost attribution is admin-only. I can summarize safe run status, public artifacts, and what is left.",
        citations: [],
      };
    }
    if (isSecretQuestion(question)) {
      return {
        refused: true,
        answer: "I can summarize public artifacts and safe run status, but I cannot expose prompts, raw logs, provider errors, object keys, hidden templates, or internal workflow instructions.",
        citations: [],
      };
    }
    const status = await this.getStatus(auth, runId);
    const artifacts = status.artifacts as Array<Record<string, unknown>>;
    return {
      refused: false,
      answer: `This run is ${String((status.run as Record<string, unknown>).status)} with ${artifacts.length} public artifact(s).`,
      citations: ["run_events", "artifacts"],
    };
  }

  async exportRun(auth: AuthContext, runId: string): Promise<Record<string, unknown>> {
    await this.requireRun(auth, runId);
    const artifact = await this.observability.recordArtifact({
      runId,
      createdByUserId: auth.user.id,
      workflowType: "handoff_export",
      artifactType: "handoff_export",
      status: "created",
      publicExportAllowed: true,
      metadataForLeakScan: { source_run_id: runId },
    });
    return operatorArtifact(artifact);
  }

  async adminRuns(auth: AuthContext): Promise<Record<string, unknown>[]> {
    const runs = await this.observability.listRuns({ workspaceId: auth.workspaceId, limit: 200 });
    return runs.map(adminRun);
  }

  async adminRunDetail(auth: AuthContext, runId: string): Promise<Record<string, unknown>> {
    const run = await this.requireRun(auth, runId);
    return {
      run: adminRun(run),
      stages: await this.observability.listStages(runId),
      ai_calls: await this.observability.listAiCalls(runId),
      media_compute_events: await this.observability.listMediaCompute(runId),
      artifacts: await this.observability.listArtifacts(runId),
      events: await this.observability.listRunEvents(runId),
    };
  }

  adminCosts(auth: AuthContext): Promise<Array<Record<string, unknown>>> {
    return this.observability.summarizeCosts({ workspaceId: auth.workspaceId });
  }

  adminStages(auth: AuthContext): Promise<Array<Record<string, unknown>>> {
    return this.observability.summarizeStages({ workspaceId: auth.workspaceId });
  }

  adminUsers(auth: AuthContext): Promise<Array<Record<string, unknown>>> {
    return this.observability.summarizeUsers({ workspaceId: auth.workspaceId });
  }

  async adminArtifacts(auth: AuthContext): Promise<Record<string, unknown>[]> {
    const runs = await this.observability.listRuns({ workspaceId: auth.workspaceId, limit: 200 });
    const artifacts = [];
    for (const run of runs) {
      artifacts.push(...await this.observability.listArtifacts(run.id));
    }
    return artifacts;
  }

  adminAlerts() {
    return this.observability.listAlerts({ limit: 200 });
  }

  private async requireRun(auth: AuthContext, runId: string): Promise<RunRecord> {
    const run = await this.observability.getRun(runId);
    if (!run || run.workspaceId !== auth.workspaceId) throw publicError("RUN_NOT_FOUND", 404);
    return run;
  }

  private requireSupportedClient(version: string | null): void {
    if (!this.minimumClientVersion || !version) return;
    if (compareVersions(version, this.minimumClientVersion) < 0) throw publicError("UPGRADE_REQUIRED", 426);
  }

  private async prepareTriggerPayload(auth: AuthContext, run: RunRecord, input: WorkflowRunInput): Promise<Record<string, unknown>> {
    if (run.workflowType === "research" && this.runtimeService) {
      const payload = sanitizeOperatorInput(input.payload ?? {});
      const productId = stringValue(input.productId) ?? stringValue(payload.productId) ?? stringValue(payload.product_id);
      const topic = stringValue(payload.topic);
      if (productId && topic) {
        const researchRun = await this.runtimeService.startResearchRun(
          auth.workspaceId,
          productId,
          topic,
          stringArray(payload.searchTerms ?? payload.search_terms),
          "running",
          { workflow_run_id: run.id },
        );
        return { ...payload, productId, topic, researchRunId: researchRun.id };
      }
      return payload;
    }
    if (run.workflowType !== "lfs_ads" || !this.runtimeService) return sanitizeOperatorInput(input.payload ?? {});
    const createAdsInput = createAdsInputFromWorkflow({
      productId: input.productId,
      batchId: input.batchId,
      payload: input.payload,
    });
    const batchId = createAdsInput.batchId ?? run.batchId ?? run.id;
    const { job } = await this.runtimeService.createAds(auth.workspaceId, batchId, createAdsInput);
    return { jobId: job.id, batchId, productId: createAdsInput.productId };
  }

  private async prepareResumePayload(auth: AuthContext, run: RunRecord): Promise<Record<string, unknown>> {
    if (run.workflowType !== "lfs_ads" || !this.runtimeService || !run.batchId) {
      return { resume: true };
    }
    const { job } = await this.runtimeService.continueBatch(auth.workspaceId, run.batchId);
    return { resume: true, jobId: job.id, batchId: run.batchId, productId: run.productId };
  }
}

function parseWorkflowType(value: string | undefined): WorkflowType {
  if (!value) throw publicError("WORKFLOW_TYPE_REQUIRED", 400);
  if ((WORKFLOW_TYPES as readonly string[]).includes(value)) return value as WorkflowType;
  throw publicError("UNKNOWN_WORKFLOW_TYPE", 400);
}

function operatorRun(run: RunRecord): Record<string, unknown> {
  return {
    id: run.id,
    correlation_id: run.correlationId,
    workflow_type: run.workflowType,
    product_id: run.productId,
    batch_id: run.batchId,
    status: run.status,
    current_stage: run.currentStage,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    failed_at: run.failedAt,
    failure_category: run.failureCategory,
    failure_message_safe: run.failureMessageSafe,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

function adminRun(run: RunRecord): Record<string, unknown> {
  return {
    ...operatorRun(run),
    workspace_id: run.workspaceId,
    trigger_run_id: run.triggerRunId,
    created_by_user_id: run.createdByUserId,
    total_cost_usd: run.totalCostUsd,
    desktop_client_version: run.desktopClientVersion,
    canary_hash: run.canaryHash,
  };
}

function operatorArtifact(artifact: ArtifactLedgerRecord): Record<string, unknown> {
  return {
    id: artifact.id,
    run_id: artifact.runId,
    product_id: artifact.productId,
    batch_id: artifact.batchId,
    workflow_type: artifact.workflowType,
    artifact_type: artifact.artifactType,
    status: artifact.status,
    size_bytes: artifact.sizeBytes,
    created_at: artifact.createdAt,
  };
}

function sanitizeOperatorInput(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (/prompt|secret|token|api[_-]?key|signed[_-]?url|object[_-]?key|canary/i.test(key)) continue;
    output[key] = value;
  }
  return output;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}

function isCostQuestion(question: string): boolean {
  return /\b(cost|spent|spend|price|billing|bill|usd|dollar|token cost|infra)\b/i.test(question);
}

function isSecretQuestion(question: string): boolean {
  return /\b(prompt|system prompt|developer message|raw log|provider error|trigger link|sentry|object key|r2|canary|template|internal instruction)\b/i.test(question);
}

function compareVersions(left: string, right: string): number {
  const a = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

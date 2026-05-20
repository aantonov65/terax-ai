import type { WorkflowType } from "../../../packages/observability/src/index.js";

export type TriggerRunInput = {
  runId: string;
  workflowType: WorkflowType;
  workspaceId: string;
  createdByUserId: string;
  correlationId: string;
  payload: Record<string, unknown>;
};

export type WorkflowTrigger = {
  trigger(input: TriggerRunInput): Promise<{ triggerRunId: string; provider: "trigger.dev" | "noop" }>;
};

export class NoopWorkflowTrigger implements WorkflowTrigger {
  async trigger(input: TriggerRunInput): Promise<{ triggerRunId: string; provider: "noop" }> {
    return { triggerRunId: `noop_${input.runId}`, provider: "noop" };
  }
}

export class TriggerDevWorkflowTrigger implements WorkflowTrigger {
  constructor(
    private readonly secretKey: string,
    private readonly apiUrl = process.env.TRIGGER_API_URL ?? "https://api.trigger.dev",
  ) {}

  async trigger(input: TriggerRunInput): Promise<{ triggerRunId: string; provider: "trigger.dev" }> {
    const taskIdentifier = taskIdentifierFor(input.workflowType);
    const response = await fetch(`${this.apiUrl.replace(/\/$/, "")}/api/v1/tasks/${encodeURIComponent(taskIdentifier)}/trigger`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        payload: {
          runId: input.runId,
          workspaceId: input.workspaceId,
          createdByUserId: input.createdByUserId,
          workflowType: input.workflowType,
          correlationId: input.correlationId,
          input: input.payload,
        },
        context: {
          correlationId: input.correlationId,
          workflowType: input.workflowType,
        },
        options: {
          idempotencyKey: input.runId,
          concurrencyKey: `${input.workspaceId}:${input.workflowType}`,
          queue: queueFor(input.workflowType),
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`TRIGGER_REQUEST_FAILED_${response.status}`);
    }
    const body = await response.json() as { id?: string };
    return { triggerRunId: body.id ?? `trigger_unknown_${input.runId}`, provider: "trigger.dev" };
  }
}

export function createWorkflowTriggerFromEnv(): WorkflowTrigger {
  const secretKey = process.env.TRIGGER_SECRET_KEY;
  if (!secretKey) return new NoopWorkflowTrigger();
  return new TriggerDevWorkflowTrigger(secretKey);
}

function taskIdentifierFor(workflowType: WorkflowType): string {
  const envName = `TRIGGER_TASK_${workflowType.toUpperCase()}`;
  return process.env[envName] ?? `wwx.${workflowType}`;
}

function queueFor(workflowType: WorkflowType): { name: string; concurrencyLimit: number } {
  switch (workflowType) {
    case "lfs_ads":
      return { name: "lfs_ads", concurrencyLimit: parseIntEnv("TRIGGER_LFS_CONCURRENCY", 6) };
    case "research":
      return { name: "research", concurrencyLimit: parseIntEnv("TRIGGER_RESEARCH_CONCURRENCY", 2) };
    case "image_batch":
      return { name: "image_batch", concurrencyLimit: parseIntEnv("TRIGGER_IMAGE_CONCURRENCY", 3) };
    case "modular_video":
    case "avatar_video":
      return { name: "video", concurrencyLimit: parseIntEnv("TRIGGER_VIDEO_CONCURRENCY", 1) };
    case "lp_rip":
      return { name: "lp_rip", concurrencyLimit: parseIntEnv("TRIGGER_LP_RIP_CONCURRENCY", 1) };
    default:
      return { name: workflowType, concurrencyLimit: parseIntEnv("TRIGGER_DEFAULT_CONCURRENCY", 2) };
  }
}

function parseIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

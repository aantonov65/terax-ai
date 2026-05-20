import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { createWwxProduct } from "@/modules/wwx/mutations";
import { artifactAudience, friendlyStageLabel } from "@/modules/wwx/workflow";
import { getKey } from "../lib/keyring";
import { native } from "../lib/native";
import { resolvePath, type ToolContext } from "./context";

const DIAGNOSTIC_LIMIT = 2_000;
const ARTIFACT_LIMIT = 50;

type WwxBinding = NonNullable<ReturnType<NonNullable<ToolContext["getWwxBinding"]>>>;

type NativeArtifact = {
  id: string;
  batchId: string;
  productId: string;
  kind: string;
  label: string;
  filename: string;
  mimeType: string;
  size: number;
  source: string;
  public: boolean;
};

type NativeArtifactContent = {
  artifact: NativeArtifact;
  contentText?: string | null;
  contentBlob?: number[] | null;
};

type NativeProductRecord = {
  id: string;
  productCode?: string;
  name?: string;
  configJson: string;
};

type NativeQueuedJob = {
  id: string;
  productId: string;
  batchId: string;
  status: string;
  attempts: number;
  requestedAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  updatedAt: number;
  lastError?: string | null;
};

type NativeIndexRecord = {
  products: NativeProductRecord[];
};

type NativeJobResult = {
  ok: boolean;
  workflow: string;
  batchId: string;
  productId: string;
  runId: string;
  status: string;
  currentStage?: string | null;
  awaitingReview: boolean;
  retryable: boolean;
  reason?: string | null;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  artifacts: NativeArtifact[];
};

type Manifest = {
  scripts?: Array<{ task_id?: string; decision?: "ship" | "review" | "fail" }>;
  task_decisions?: Record<string, "ship" | "review" | "fail">;
};

type BatchPlan = {
  strategyPlan?: Record<string, unknown> | null;
  strategy?: Record<string, unknown> | null;
  autonomy?: Record<string, unknown> | null;
};

function requireBinding(ctx: ToolContext): WwxBinding {
  const binding = ctx.getWwxBinding?.() ?? null;
  if (!binding) {
    throw new Error("No bound WWX batch is active. Open this batch in an agent window first.");
  }
  return binding;
}

function shortOutput(value: string): string | undefined {
  if (!value) return undefined;
  return value.length > DIAGNOSTIC_LIMIT
    ? `${value.slice(0, DIAGNOSTIC_LIMIT)}\n...[truncated]`
    : value;
}

function canonicalTaskSuffix(): string {
  return "V001";
}

function frontmatterValue(markdown: string, key: string): string | undefined {
  const front = markdown.startsWith("---\n")
    ? markdown.slice(4, markdown.indexOf("\n---", 4))
    : "";
  if (!front) return undefined;
  const match = front.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "mi"));
  return match?.[1]?.replace(/^["']|["']$/g, "").trim() || undefined;
}

function parseAds(markdown: string): Array<{ title: string; body: string; fields: Record<string, string> }> {
  const matches = [...markdown.matchAll(/^###\s+(.+?)\s*$/gm)];
  if (!matches.length) return [];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    const body = markdown.slice(start, end).trim();
    return { title: match[1].trim(), body, fields: parseFields(body) };
  });
}

function parseFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (raw.trim() === "|") {
      const block: string[] = [];
      i += 1;
      while (i < lines.length && !/^[A-Za-z][A-Za-z0-9_-]*:\s*/.test(lines[i])) {
        block.push(lines[i].startsWith("  ") ? lines[i].slice(2) : lines[i]);
        i += 1;
      }
      i -= 1;
      fields[key] = block.join("\n").trim();
    } else {
      fields[key] = raw.trim().replace(/^["']|["']$/g, "");
    }
  }
  return fields;
}

function canonicalizeAngles(markdown: string, binding: WwxBinding): string {
  const product = binding.productCode || binding.productId.replace(/^prod_/, "");
  const batch = binding.batchId.replace(/^batch_[^_]+_/, "");
  const existingAds = parseAds(markdown);
  const ads = existingAds.length
    ? existingAds
    : [{ title: `${product}_LFS_ARC1_A1B1_M1_${canonicalTaskSuffix()}`, body: markdown.trim(), fields: {} }];
  const defaultFormat = frontmatterValue(markdown, "lfs_format_template") || "expose";
  const cta = frontmatterValue(markdown, "cta_text") || "Click \"LEARN MORE\" below to read the article.";
  const lines = [
    "---",
    `product: ${product}`,
    `batch_id: ${batch}`,
    "format: lfs",
    "variant: native",
    `lfs_format_template: ${defaultFormat}`,
    "cta_text: |",
    ...cta.split("\n").map((line) => `  ${line}`),
    "---",
    "",
    "## Ads",
    "",
  ];
  const suffix = canonicalTaskSuffix();
  const blocks = ads.map((ad, index) => {
    const mechanism = (ad.fields.mechanism || "M1").toUpperCase();
    const format = ad.fields.format || defaultFormat;
    const taskId = ad.title.includes("_LFS_")
      ? ad.title
      : `${product}_LFS_ARC${index + 1}_A${index + 1}B1_${mechanism}_${suffix}`;
    const angle = ad.fields.angle || ad.body || markdown.trim();
    return [
      `### ${taskId}`,
      "angle: |",
      ...angle.split("\n").map((line) => `  ${line}`),
      `format: ${format}`,
      `mechanism: ${mechanism}`,
      "",
    ].join("\n");
  });
  return `${lines.join("\n")}${blocks.join("\n")}`.trimEnd() + "\n";
}

async function hydrateArtifactReferences(markdown: string): Promise<string> {
  const refs = [...markdown.matchAll(/app:\/\/wwx\/artifacts\/([A-Za-z0-9_-]+)/g)];
  if (!refs.length) return markdown;
  let hydrated = markdown;
  for (const match of refs) {
    const full = match[0];
    const artifactId = match[1];
    const artifact = await invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId });
    hydrated = hydrated.split(full).join(artifact.contentText?.trim() || "");
  }
  return hydrated;
}

function publicArtifacts(artifacts: NativeArtifact[]) {
  return artifacts
    .filter((artifact) => artifact.public)
    .slice(0, ARTIFACT_LIMIT)
    .map((artifact) => ({
      id: artifact.id,
      path: `app://wwx/artifacts/${artifact.id}`,
      label: artifact.label || artifact.filename,
      filename: artifact.filename,
      kind: artifact.kind,
      audience: artifactAudience(artifact),
      size: artifact.size,
    }));
}

function artifactByFilename(artifacts: NativeArtifact[], filename: string): NativeArtifact | undefined {
  return artifacts.find((artifact) => artifact.filename === filename);
}

function isFinalLfsArtifact(artifact: NativeArtifact): boolean {
  const filename = artifact.filename.replace(/^\/+/, "");
  return filename.startsWith("output-v41/") && filename.endsWith(".md");
}

function isResearchMissing(result: NativeJobResult): boolean {
  const text = `${result.reason ?? ""}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /research folder not found|missing research|research_cards failed/i.test(text);
}

function classifyFailure(result: NativeJobResult): {
  kind:
    | "missing_truth"
    | "malformed_artifact"
    | "weak_creative_artifact"
    | "deterministic_compliance_issue"
    | "transient_runtime_issue"
    | "infrastructure_config_issue"
    | "unknown";
  operatorNeeded: boolean;
  resumeFrom?: string;
} | null {
  if (result.ok) return null;
  const text = `${result.reason ?? ""}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`.toLowerCase();
  if (/preflight|non-canonical prices|forbidden phrases in prompt|forbidden|cta|native lfs|format contract|objective/.test(text)) {
    return { kind: "deterministic_compliance_issue", operatorNeeded: false, resumeFrom: "lfs_brief" };
  }
  if (/not production-ready|missing research|pricing_rules|guarantee|product_name|target_demographic|mechanism/.test(text)) {
    return { kind: "missing_truth", operatorNeeded: true, resumeFrom: "research_cards" };
  }
  if (/invalid json|expected exactly|prompt source|outline contract|manifest/.test(text)) {
    return { kind: "malformed_artifact", operatorNeeded: false, resumeFrom: "lfs_brief" };
  }
  if (/semantic/.test(text)) {
    return { kind: "weak_creative_artifact", operatorNeeded: false, resumeFrom: "semantic_launchable" };
  }
  if (/timeout|rate limit|temporar|network|connection reset|fetch failed/.test(text)) {
    return { kind: "transient_runtime_issue", operatorNeeded: false };
  }
  if (/credential|api key|anthropic|permission denied|no such file|not found/.test(text)) {
    return { kind: "infrastructure_config_issue", operatorNeeded: true };
  }
  return { kind: "unknown", operatorNeeded: true };
}

function jobResult(workflow: string, result: NativeJobResult) {
  const visibleArtifacts = result.artifacts.filter((artifact) => artifact.public);
  const finalArtifacts = visibleArtifacts.filter(isFinalLfsArtifact);
  const artifacts = publicArtifacts(result.artifacts);
  const artifactCount = visibleArtifacts.length;
  const finalArtifactCount = finalArtifacts.length;
  const stage = result.currentStage ?? result.status;
  const reason = shortOutput(result.reason ?? "") ?? undefined;
  const missingResearch = isResearchMissing(result);
  const retryable = missingResearch ? false : result.retryable;
  const failure = classifyFailure(result);
  const stageLabel = friendlyStageLabel(result.currentStage ?? result.status);
  const primaryAction = result.ok
    ? result.awaitingReview
      ? { kind: "continue", label: "Continue to next stage", prompt: "Continue to the next LFS stage for this batch." }
      : finalArtifactCount > 0 || result.status === "complete"
        ? { kind: "review_final", label: "Review final ads", prompt: "Show me the final ads and call out what is ship-ready versus needs review." }
        : { kind: "wait", label: "Running" }
    : missingResearch || failure?.operatorNeeded
      ? { kind: "provide_input", label: "Provide missing input", prompt: "Tell me exactly what input is missing for this batch." }
      : { kind: "repair", label: "Repair and continue", prompt: "Repair the current batch issue and continue from the earliest safe stage." };
  const secondaryAction = result.ok && result.awaitingReview
    ? { kind: "open_agent", label: "Ask / Hold", prompt: "I want to ask a question before continuing this batch." }
    : result.ok && (finalArtifactCount > 0 || result.status === "complete")
      ? { kind: "export", label: "Export ship-ready ads", prompt: "Export the ship-ready scripts for handoff." }
      : undefined;
  const diagnostics = result.ok
    ? undefined
    : {
        stdout: shortOutput(result.stdout),
        stderr: shortOutput(result.stderr),
      };

  return {
    ok: result.ok,
    workflow,
    batch_id: result.batchId,
    product: result.productId,
    run_id: result.runId,
    status: result.status,
    current_stage: result.currentStage ?? undefined,
    awaiting_review: result.awaitingReview,
    retryable,
    failure_kind: failure?.kind,
    operator_needed: failure?.operatorNeeded,
    suggested_resume_from: failure?.resumeFrom,
    reason,
    summary: result.ok
      ? finalArtifactCount > 0
        ? `${stage} finished; ${finalArtifactCount} final LFS artifact${finalArtifactCount === 1 ? "" : "s"} available.`
        : `${stage} finished; ${artifactCount} public artifact${artifactCount === 1 ? "" : "s"} available while final LFS output is still pending.`
      : missingResearch
        ? `${stage} blocked: product research is missing or incomplete.`
        : `${stage} failed${reason ? `: ${reason}` : "."}`,
    next_actions: result.ok
      ? finalArtifactCount > 0
        ? result.status === "complete"
          ? ["Review the final manifest and shipped scripts.", "Use export_lfs with ship_only for handoff."]
          : ["Review final LFS outputs.", "Run advance_lfs_job only for an explicitly guided run."]
        : ["Review the available checkpoint artifacts.", "Run advance_lfs_job to continue toward final LFS outputs."]
      : missingResearch
        ? ["Add or import product research before advancing this batch."]
        : ["Read the job status for the failed checkpoint."],
    artifacts,
    artifact_count: artifactCount,
    artifacts_truncated: artifactCount > ARTIFACT_LIMIT,
    diagnostics,
    exit_code: result.exitCode,
    ui: {
      headline: result.ok
        ? finalArtifactCount > 0 || result.status === "complete"
          ? "Final ads are ready"
          : result.awaitingReview
            ? `${stageLabel} is ready. Continue to next stage?`
            : `${stageLabel} finished`
        : missingResearch || failure?.operatorNeeded
          ? "Batch needs operator input"
          : "Repair is available",
      stage_label: stageLabel,
      summary: result.ok
        ? finalArtifactCount > 0 || result.status === "complete"
          ? "Review the ship, review, and fail decisions before upload."
          : result.awaitingReview
            ? "Skim the checkpoint, then continue when it looks right."
            : "The workflow is continuing."
        : missingResearch
          ? "Product research is missing or incomplete."
          : reason ?? "The batch hit a repairable issue.",
      tone: result.ok
        ? finalArtifactCount > 0 || result.status === "complete"
          ? "success"
          : result.awaitingReview
            ? "warning"
            : "running"
        : missingResearch || failure?.operatorNeeded
          ? "danger"
          : "warning",
      operator_needed: missingResearch || failure?.operatorNeeded === true,
      retryable,
      primary_action: primaryAction,
      secondary_action: secondaryAction,
      important_artifacts: artifacts.filter((artifact) => artifact.audience !== "technical").slice(0, 8),
      diagnostic_count: artifacts.filter((artifact) => artifact.audience === "technical").length,
    },
  };
}

function simpleUi(
  headline: string,
  summary: string,
  tone: "neutral" | "running" | "success" | "warning" | "danger" = "neutral",
  primaryAction?: { kind: string; label: string; prompt?: string },
) {
  return {
    headline,
    summary,
    tone,
    operator_needed: tone === "danger",
    retryable: false,
    primary_action: primaryAction,
  };
}

type RepairAttemptInput = {
  resumedFrom?: string;
  operatorGuidance?: string;
};

async function readRepairHistory(binding: WwxBinding): Promise<Record<string, unknown>> {
  const artifacts = await invoke<NativeArtifact[]>("wwx_list_artifacts", { batchId: binding.batchId });
  const existing = artifactByFilename(artifacts, "repair-history.json");
  if (!existing) {
    return {
      schema: "lfs-repair-history/v1",
      failures: [],
      repair_attempts: [],
    };
  }
  const content = await invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId: existing.id });
  return {
    schema: "lfs-repair-history/v1",
    failures: [],
    repair_attempts: [],
    ...safeJson(content.contentText ?? ""),
  };
}

async function recordRunHistory(
  binding: WwxBinding,
  workflow: string,
  result: NativeJobResult,
  attempt?: RepairAttemptInput,
): Promise<NativeArtifact | null> {
  if (result.ok && !attempt) return null;
  const history = await readRepairHistory(binding);
  const failures = Array.isArray(history.failures) ? [...history.failures] : [];
  const repairAttempts = Array.isArray(history.repair_attempts) ? [...history.repair_attempts] : [];
  const failure = classifyFailure(result);
  const now = new Date().toISOString();
  if (attempt) {
    repairAttempts.push({
      id: `repair_${Date.now().toString(36)}`,
      workflow,
      run_id: result.runId,
      resumed_from: attempt.resumedFrom ?? result.currentStage ?? null,
      operator_guidance: attempt.operatorGuidance ?? null,
      result_ok: result.ok,
      result_status: result.status,
      result_stage: result.currentStage ?? null,
      failure_kind: failure?.kind ?? null,
      recorded_at: now,
    });
  }
  if (failure) {
    failures.push({
      id: `failure_${Date.now().toString(36)}`,
      workflow,
      run_id: result.runId,
      stage: result.currentStage ?? result.status,
      kind: failure.kind,
      operator_needed: failure.operatorNeeded,
      earliest_resume_from: failure.resumeFrom ?? result.currentStage ?? null,
      reason: shortOutput(result.reason ?? result.stderr ?? "") ?? "",
      exit_code: result.exitCode ?? null,
      recorded_at: now,
    });
  }
  const payload = {
    ...history,
    schema: "lfs-repair-history/v1",
    updated_at: now,
    failures,
    repair_attempts: repairAttempts,
  };
  return invoke<NativeArtifact>("wwx_write_artifact", {
    input: {
      productId: binding.productId,
      batchId: binding.batchId,
      kind: "json",
      label: "repair-history.json",
      filename: "repair-history.json",
      mimeType: "application/json",
      contentText: JSON.stringify(payload, null, 2),
      source: "repair-history",
      public: true,
    },
  });
}

async function recordedJobResult(
  binding: WwxBinding,
  workflow: string,
  result: NativeJobResult,
  attempt?: RepairAttemptInput,
) {
  const artifact = await recordRunHistory(binding, workflow, result, attempt);
  if (artifact && !result.artifacts.some((item) => item.id === artifact.id)) {
    result.artifacts = [artifact, ...result.artifacts];
  }
  return jobResult(workflow, result);
}

async function runNativeJob(
  command: "wwx_start_lfs_job" | "wwx_advance_lfs_job" | "wwx_resume_lfs_job",
  binding: WwxBinding,
  input: {
    anglesMarkdown?: string;
    runMode?: "review" | "full";
    workers?: number;
    generationWorkers?: number;
    fromStage?: string;
  } = {},
): Promise<NativeJobResult> {
  const anthropicApiKey = await getKey("anthropic");
  return invoke<NativeJobResult>(command, {
    input: {
      productId: binding.productId,
      batchId: binding.batchId,
      anglesMarkdown: input.anglesMarkdown,
      runMode: input.runMode,
      workers: input.workers,
      generationWorkers: input.generationWorkers,
      fromStage: input.fromStage,
      anthropicApiKey,
    },
  });
}

export function buildWwxTools(ctx: ToolContext) {
  return {
    create_product_from_config: tool({
      description:
        "Create a new product from a drive-aligned config.json object after the operator has provided enough brand-brief truth.",
      inputSchema: z.object({
        product_folder: z.string().optional(),
        config: z.record(z.string(), z.unknown()),
      }),
      needsApproval: true,
      execute: async ({ product_folder, config }) => {
        try {
          if (ctx.getWwxBinding?.()) {
            throw new Error("Create products only from an unbound intake agent.");
          }
          const created = await createWwxProduct({
            workspaceRoot: ctx.getWorkspaceRoot() ?? "",
            productFolder: product_folder,
            config,
          });
          return {
            ok: true,
            workflow: "create_product_from_config",
            product: created.productId,
            product_code: created.productCode,
            ui: simpleUi(
              "Product setup is saved",
              "Run research before creating production batches.",
              "success",
              { kind: "provide_input", label: "Run product research" },
            ),
            next_actions: [
              "Run product research from the product row before creating production batches.",
              "After research exists, create a batch and provide owner-authored creative direction.",
            ],
          };
        } catch (error) {
          return { ok: false, workflow: "create_product_from_config", error: String(error), retryable: false };
        }
      },
    }),

    run_product_research: tool({
      description:
        "Run the proven Reddit research pipeline for an existing product: raw scrape, canonical synthesis, and research-card verification.",
      inputSchema: z.object({
        product_id: z.string().optional(),
        topic: z.string().min(1),
      }),
      needsApproval: true,
      execute: async ({ product_id, topic }) => {
        try {
          const binding = ctx.getWwxBinding?.() ?? null;
          const productId = product_id?.trim() || binding?.productId;
          if (!productId) throw new Error("Provide product_id or run from a bound product batch.");
          const result = await invoke<Record<string, unknown>>("wwx_run_research_pipeline", {
            input: {
              productId,
              topic,
              anthropicApiKey: await getKey("anthropic"),
            },
          });
          return {
            ...result,
            workflow: "run_product_research",
            ui: simpleUi(
              "Research is ready",
              "The product can now support production LFS batches.",
              "success",
              { kind: "add_direction", label: "Create batch", prompt: "Create a new LFS batch from this research." },
            ),
          };
        } catch (error) {
          return { ok: false, workflow: "run_product_research", error: String(error), retryable: true };
        }
      },
    }),

    save_strategy_plan: tool({
      description:
        "Save owner-authored creative direction for the bound batch as strategy-plan.json. Use this after structuring the strategist's input; do not invent the ad set.",
      inputSchema: z.object({
        date: z.string().optional(),
        description: z.string().optional(),
        ads: z.array(z.object({
          archetype: z.string(),
          a_point: z.string(),
          b_point: z.string(),
          mechanism: z.string(),
          format: z.string(),
          angle: z.string(),
          tag: z.string().optional(),
          source_swipe: z.string().optional(),
          edge_to_preserve: z.string().optional(),
          failed_solutions: z.array(z.string()).optional(),
          proof_focus: z.string().optional(),
          must_not_say: z.array(z.string()).optional(),
          notes: z.string().optional(),
        })).min(1),
      }),
      needsApproval: true,
      execute: async (plan) => {
        try {
          const binding = requireBinding(ctx);
          const artifact = await invoke<NativeArtifact>("wwx_write_artifact", {
            input: {
              productId: binding.productId,
              batchId: binding.batchId,
              kind: "json",
              label: "strategy-plan.json",
              filename: "strategy-plan.json",
              mimeType: "application/json",
              contentText: JSON.stringify(plan, null, 2),
              source: "strategy-plan",
              public: true,
            },
          });
          const validation = await invoke("wwx_validate_strategy_plan", {
            input: {
              productId: binding.productId,
              batchId: binding.batchId,
              strategyPlanJson: JSON.stringify(plan, null, 2),
            },
          });
          return {
            ok: true,
            workflow: "save_strategy_plan",
            batch_id: binding.batchId,
            artifact_path: `app://wwx/artifacts/${artifact.id}`,
            strategy_plan: plan,
            validation,
            ui: simpleUi(
              "Creative direction is saved",
              "Build the strategy before running the LFS batch.",
              "success",
              { kind: "build_strategy", label: "Build Strategy", prompt: "Build the strategy for this batch." },
            ),
          };
        } catch (error) {
          return { ok: false, workflow: "save_strategy_plan", error: String(error), retryable: false };
        }
      },
    }),

    build_strategy_json: tool({
      description:
        "Validate the bound batch strategy-plan.json against research cards and format templates, then deterministically build strategy.json.",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const artifacts = await invoke<NativeArtifact[]>("wwx_list_artifacts", { batchId: binding.batchId });
          const planArtifact = artifactByFilename(artifacts, "strategy-plan.json");
          if (!planArtifact) throw new Error("Save a strategy plan before building strategy.json.");
          const plan = await invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId: planArtifact.id });
          const result = await invoke<Record<string, unknown>>("wwx_build_strategy", {
            input: {
              productId: binding.productId,
              batchId: binding.batchId,
              strategyPlanJson: plan.contentText ?? "",
            },
          });
          return {
            ...result,
            workflow: "build_strategy_json",
            ui: simpleUi(
              "Strategy is ready",
              "Run the LFS batch when you are ready for generation.",
              "success",
              { kind: "run_batch", label: "Run Batch", prompt: "Run this LFS batch now." },
            ),
          };
        } catch (error) {
          return { ok: false, workflow: "build_strategy_json", error: String(error), retryable: false };
        }
      },
    }),

    set_autonomous_mode: tool({
      description: "Enable or disable autonomous execution for the bound batch.",
      inputSchema: z.object({ enabled: z.boolean() }),
      needsApproval: true,
      execute: async ({ enabled }) => {
        try {
          const binding = requireBinding(ctx);
          const artifact = await invoke<NativeArtifact>("wwx_write_artifact", {
            input: {
              productId: binding.productId,
              batchId: binding.batchId,
              kind: "json",
              label: "Batch Control",
              filename: "batch-control.json",
              mimeType: "application/json",
              contentText: JSON.stringify({ autonomous: enabled }, null, 2),
              source: "desktop",
              public: true,
            },
          });
          return {
            ok: true,
            workflow: "set_autonomous_mode",
            batch_id: binding.batchId,
            autonomous: enabled,
            artifact_path: `app://wwx/artifacts/${artifact.id}`,
            ui: simpleUi(
              enabled ? "Autonomous mode is on" : "Autonomous mode is off",
              enabled
                ? "The batch can continue through repairable steps without checkpoint prompts."
                : "The batch will pause at review checkpoints.",
              "success",
            ),
          };
        } catch (error) {
          return { ok: false, workflow: "set_autonomous_mode", error: String(error), retryable: false };
        }
      },
    }),


    submit_lfs_job: tool({
      description:
        "Run the bound LFS batch from built strategy.json, or from legacy angle.md input when explicitly provided.",
      inputSchema: z.object({
        angles_markdown: z.string().optional().describe("Full attached angle.md text."),
        angles_path: z.string().optional().describe("Path to angle.md if already on disk."),
        run_mode: z.enum(["review", "full"]).optional(),
        workers: z.number().int().min(1).max(20).optional(),
        generation_workers: z.number().int().min(1).max(50).optional(),
        expected_cost_risk: z.string().optional(),
      }),
      needsApproval: true,
      execute: async ({ angles_markdown, angles_path, run_mode, workers, generation_workers }) => {
        try {
          const binding = requireBinding(ctx);
          const batchArtifacts = await invoke<NativeArtifact[]>("wwx_list_artifacts", { batchId: binding.batchId });
          let markdown = angles_markdown?.trim() || "";
          if (!markdown && angles_path) {
            if (angles_path.startsWith("app://wwx/artifacts/")) {
              const artifactId = angles_path.slice("app://wwx/artifacts/".length);
              const file = await invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId });
              markdown = file.contentText?.trim() || "";
            } else {
              const resolved = resolvePath(angles_path, ctx.getCwd());
              const file = await native.readFile(resolved);
              if (file.kind !== "text") throw new Error("The supplied angle file is not readable text.");
              markdown = file.content;
            }
          }
          if (!markdown && !angles_path) {
            const angles = artifactByFilename(batchArtifacts, "angles.md");
            if (angles) {
              const file = await invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId: angles.id });
              markdown = file.contentText?.trim() || "";
            }
          }
          const strategy = artifactByFilename(batchArtifacts, "strategy.json");
          if (!markdown && !strategy) {
            throw new Error("Build strategy.json or attach angle.md before generation.");
          }
          const hydrated = markdown ? await hydrateArtifactReferences(markdown) : "";
          const result = await runNativeJob("wwx_start_lfs_job", binding, {
            anglesMarkdown: hydrated ? canonicalizeAngles(hydrated, binding) : undefined,
            runMode: run_mode ?? "full",
            workers,
            generationWorkers: generation_workers,
          });
          return recordedJobResult(binding, "submit_lfs_job", result);
        } catch (error) {
          return { ok: false, workflow: "submit_lfs_job", error: String(error), retryable: false };
        }
      },
    }),

    advance_lfs_job: tool({
      description: "Advance an explicitly guided checkpoint for the bound batch.",
      inputSchema: z.object({
        batch_id: z.string().optional(),
        workers: z.number().int().min(1).max(20).optional(),
        generation_workers: z.number().int().min(1).max(50).optional(),
        expected_cost_risk: z.string().optional(),
      }),
      needsApproval: true,
      execute: async ({ workers, generation_workers }) => {
        try {
          const binding = requireBinding(ctx);
          const result = await runNativeJob("wwx_advance_lfs_job", binding, {
            workers,
            generationWorkers: generation_workers,
          });
          return recordedJobResult(binding, "advance_lfs_job", result);
        } catch (error) {
          return { ok: false, workflow: "advance_lfs_job", error: String(error), retryable: true };
        }
      },
    }),

    resume_lfs_job: tool({
      description: "Resume the bound LFS job from its durable app-store state.",
      inputSchema: z.object({
        batch_id: z.string().optional(),
        expected_cost_risk: z.string().optional(),
      }),
      needsApproval: true,
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const result = await runNativeJob("wwx_resume_lfs_job", binding);
          return recordedJobResult(binding, "resume_lfs_job", result);
        } catch (error) {
          return { ok: false, workflow: "resume_lfs_job", error: String(error), retryable: true };
        }
      },
    }),

    get_lfs_job: tool({
      description: "Read sanitized status and public artifact summary for the bound LFS job.",
      inputSchema: z.object({ batch_id: z.string().optional() }),
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const artifacts = await invoke<NativeArtifact[]>("wwx_list_artifacts", { batchId: binding.batchId });
          return {
            ok: true,
            workflow: "get_lfs_job",
            batch_id: binding.batchId,
            product: binding.productId,
            artifacts: publicArtifacts(artifacts),
            ui: simpleUi(
              "Batch progress checked",
              "Important outputs are shown first. Technical files stay in details.",
              "neutral",
            ),
          };
        } catch (error) {
          return { ok: false, workflow: "get_lfs_job", error: String(error) };
        }
      },
    }),

    get_lfs_plan: tool({
      description: "Read the public strategy-plan preview, built strategy, and autonomous-mode state for the bound batch.",
      inputSchema: z.object({ batch_id: z.string().optional() }),
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const artifacts = await invoke<NativeArtifact[]>("wwx_list_artifacts", { batchId: binding.batchId });
          const result: BatchPlan = {};
          for (const [filename, key] of [
            ["strategy-plan.json", "strategyPlan"],
            ["strategy.json", "strategy"],
            ["batch-control.json", "autonomy"],
          ] as const) {
            const artifact = artifactByFilename(artifacts, filename);
            if (!artifact) {
              result[key] = null;
              continue;
            }
            const content = await invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId: artifact.id });
            result[key] = safeJson(content.contentText ?? "");
          }
          return {
            ok: true,
            workflow: "get_lfs_plan",
            batch_id: binding.batchId,
            product: binding.productId,
            ...result,
            ui: simpleUi(
              result.strategy
                ? "Strategy is ready"
                : result.strategyPlan
                  ? "Creative direction is saved"
                  : "Creative direction needed",
              result.strategy
                ? "Run the LFS batch when you are ready for generation."
                : result.strategyPlan
                  ? "Build the strategy before running the LFS batch."
                  : "Add the ARC, A/B, mechanism, format, count, and any swipes or notes.",
              "neutral",
              result.strategy
                ? { kind: "run_batch", label: "Run Batch", prompt: "Run this LFS batch now." }
                : result.strategyPlan
                  ? { kind: "build_strategy", label: "Build Strategy", prompt: "Build the strategy for this batch." }
                  : { kind: "add_direction", label: "Add creative direction", prompt: "Help me structure creative direction for this batch." },
            ),
          };
        } catch (error) {
          return { ok: false, workflow: "get_lfs_plan", error: String(error) };
        }
      },
    }),

    list_lfs_artifacts: tool({
      description: "List public artifacts for the bound batch.",
      inputSchema: z.object({ scope: z.enum(["public"]).optional(), batch_id: z.string().optional() }),
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const artifacts = await invoke<NativeArtifact[]>("wwx_list_artifacts", { batchId: binding.batchId });
          return {
            ok: true,
            workflow: "list_lfs_artifacts",
            batch_id: binding.batchId,
            artifacts: publicArtifacts(artifacts),
            ui: simpleUi(
              "Outputs are available",
              "Final ads, strategy, and run summary are prioritized above technical details.",
              "neutral",
            ),
          };
        } catch (error) {
          return { ok: false, workflow: "list_lfs_artifacts", error: String(error) };
        }
      },
    }),

    read_lfs_artifact: tool({
      description: "Read one public artifact by artifact id from the bound batch.",
      inputSchema: z.object({ artifact_id: z.string(), batch_id: z.string().optional() }),
      execute: async ({ artifact_id }) => {
        try {
          const result = await invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId: artifact_id });
          return {
            ok: true,
            workflow: "read_lfs_artifact",
            batch_id: result.artifact.batchId,
            artifact_path: `app://wwx/artifacts/${result.artifact.id}`,
            content: shortOutput(result.contentText ?? "") ?? "",
            ui: simpleUi(
              "Output opened",
              result.artifact.filename,
              "neutral",
            ),
          };
        } catch (error) {
          return { ok: false, workflow: "read_lfs_artifact", error: String(error) };
        }
      },
    }),

    edit_lfs_artifact: tool({
      description: "Edit a public text artifact stored in the app database.",
      inputSchema: z.object({
        artifact_id: z.string(),
        replacement: z.string().min(1),
        batch_id: z.string().optional(),
        expected_cost_risk: z.string().optional(),
      }),
      needsApproval: true,
      execute: async ({ artifact_id, replacement }) => {
        try {
          const current = await invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId: artifact_id });
          const artifact = await invoke<NativeArtifact>("wwx_write_artifact", {
            input: {
              productId: current.artifact.productId,
              batchId: current.artifact.batchId,
              kind: current.artifact.kind,
              label: current.artifact.label,
              filename: current.artifact.filename,
              mimeType: current.artifact.mimeType,
              contentText: replacement.trimEnd(),
              source: "user-edit",
              public: current.artifact.public,
            },
          });
          return {
            ok: true,
            workflow: "edit_lfs_artifact",
            batch_id: artifact.batchId,
            artifact_path: `app://wwx/artifacts/${artifact.id}`,
            ui: simpleUi(
              "Output updated",
              "Rerun checks if downstream outputs need to refresh.",
              "success",
              { kind: "repair", label: "Rerun checks", prompt: "Rerun the relevant checks for this batch." },
            ),
            next_actions: ["Run rerun_lfs_checks or resume_lfs_job if downstream artifacts need refresh."],
          };
        } catch (error) {
          return { ok: false, workflow: "edit_lfs_artifact", error: String(error) };
        }
      },
    }),

    rerun_lfs_checks: tool({
      description: "Resume the bound batch through the app-owned runner.",
      inputSchema: z.object({
        mode: z.enum(["objective", "semantic", "final"]),
        focus_note: z.string().optional(),
        batch_id: z.string().optional(),
        expected_cost_risk: z.string().optional(),
      }),
      needsApproval: true,
      execute: async ({ mode, focus_note }) => {
        try {
          const fromStage = mode === "objective"
            ? "objective_finish_pre_semantic"
            : mode === "semantic"
              ? "semantic_launchable"
              : "objective_finish_final";
          const binding = requireBinding(ctx);
          const result = await runNativeJob("wwx_resume_lfs_job", binding, { fromStage, runMode: "full" });
          return recordedJobResult(binding, "rerun_lfs_checks", result, {
            resumedFrom: fromStage,
            operatorGuidance: focus_note,
          });
        } catch (error) {
          return { ok: false, workflow: "rerun_lfs_checks", error: String(error), retryable: true };
        }
      },
    }),

    retry_lfs_failures: tool({
      description: "Retry the failed or requested LFS stage for the bound batch.",
      inputSchema: z.object({
        stage: z.string().optional(),
        batch_id: z.string().optional(),
        expected_cost_risk: z.string().optional(),
      }),
      needsApproval: true,
      execute: async ({ stage }) => {
        try {
          const binding = requireBinding(ctx);
          const result = await runNativeJob("wwx_resume_lfs_job", binding, {
            fromStage: stage,
            runMode: "full",
          });
          return recordedJobResult(binding, "retry_lfs_failures", result, { resumedFrom: stage });
        } catch (error) {
          return { ok: false, workflow: "retry_lfs_failures", error: String(error), retryable: true };
        }
      },
    }),

    export_lfs: tool({
      description: "Return public final scripts for handoff.",
      inputSchema: z.object({ filter: z.enum(["ship_only", "all"]).optional(), batch_id: z.string().optional() }),
      execute: async ({ filter = "ship_only" }) => {
        try {
          const binding = requireBinding(ctx);
          const artifacts = await invoke<NativeArtifact[]>("wwx_list_artifacts", { batchId: binding.batchId });
          const manifestArtifact = artifacts.find((artifact) => artifact.filename === "lfs-v41-manifest.json");
          let manifest: Manifest | null = null;
          if (manifestArtifact) {
            const content = await invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId: manifestArtifact.id });
            manifest = safeJson(content.contentText ?? "") as Manifest;
          }
          const decisions = manifestDecisions(manifest);
          const scripts = [];
          for (const artifact of artifacts.filter((item) => item.filename.startsWith("output-v41/") && item.filename.endsWith(".md"))) {
            const taskId = artifact.filename.split("/").pop()?.replace(/\.md$/, "") ?? "";
            const decision = decisions[taskId];
            if (filter === "ship_only" && decision !== "ship") continue;
            const content = await invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId: artifact.id });
            scripts.push({ name: artifact.filename, task_id: taskId, decision, content: shortOutput(content.contentText ?? "") ?? "" });
          }
          return {
            ok: true,
            workflow: "export_lfs",
            batch_id: binding.batchId,
            filter,
            scripts,
            ui: simpleUi(
              "Export is ready",
              `${scripts.length} script${scripts.length === 1 ? "" : "s"} matched ${filter === "ship_only" ? "ship-ready" : "all"} output.`,
              "success",
            ),
          };
        } catch (error) {
          return { ok: false, workflow: "export_lfs", error: String(error) };
        }
      },
    }),

    cancel_lfs_job: tool({
      description: "Mark the bound job as canceled in app storage.",
      inputSchema: z.object({ reason: z.string().optional(), batch_id: z.string().optional() }),
      needsApproval: true,
      execute: async ({ reason }) => {
        try {
          const binding = requireBinding(ctx);
          const run = await invoke("wwx_cancel_lfs_job", { batchId: binding.batchId, reason });
          return {
            ok: true,
            workflow: "cancel_lfs_job",
            batch_id: binding.batchId,
            run,
            ui: simpleUi("Batch canceled", "The run is marked blocked in app storage.", "warning"),
          };
        } catch (error) {
          return { ok: false, workflow: "cancel_lfs_job", error: String(error) };
        }
      },
    }),

    get_product_readiness: tool({
      description: "Read the current production-readiness record for the bound product.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const index = await invoke<NativeIndexRecord>("wwx_list_products");
          const product = index.products.find((item) => item.id === binding.productId);
          const config = safeJson(product?.configJson ?? "");
          return {
            ok: true,
            workflow: "get_product_readiness",
            product: binding.productId,
            readiness: config.wwx_readiness ?? null,
          };
        } catch (error) {
          return { ok: false, workflow: "get_product_readiness", error: String(error) };
        }
      },
    }),


    enqueue_lfs_job: tool({
      description: "Queue a production LFS run for the bound batch so the desktop scheduler can execute multiple batches concurrently.",
      inputSchema: z.object({
        angles_markdown: z.string().optional(),
        angles_path: z.string().optional(),
        workers: z.number().int().min(1).max(20).optional(),
        generation_workers: z.number().int().min(1).max(50).optional(),
      }),
      needsApproval: true,
      execute: async ({ angles_markdown, angles_path, workers, generation_workers }) => {
        try {
          const binding = requireBinding(ctx);
          let markdown = angles_markdown?.trim() || "";
          if (!markdown && angles_path) {
            if (angles_path.startsWith("app://wwx/artifacts/")) {
              const artifactId = angles_path.slice("app://wwx/artifacts/".length);
              const file = await invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId });
              markdown = file.contentText?.trim() || "";
            } else {
              const resolved = resolvePath(angles_path, ctx.getCwd());
              const file = await native.readFile(resolved);
              if (file.kind !== "text") throw new Error("The supplied angle file is not readable text.");
              markdown = file.content;
            }
          }
          if (!markdown) throw new Error("Attach angle.md or provide angles_markdown.");
          const anthropicApiKey = await getKey("anthropic");
          const queued = await invoke<NativeQueuedJob>("wwx_enqueue_lfs_job", {
            input: {
              productId: binding.productId,
              batchId: binding.batchId,
              anglesMarkdown: canonicalizeAngles(await hydrateArtifactReferences(markdown), binding),
              runMode: "full",
              workers,
              generationWorkers: generation_workers,
              anthropicApiKey,
            },
          });
          return { ok: true, workflow: "enqueue_lfs_job", queued };
        } catch (error) {
          return { ok: false, workflow: "enqueue_lfs_job", error: String(error) };
        }
      },
    }),

    list_lfs_queue: tool({
      description: "List queued, running, blocked, and completed desktop LFS jobs.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const jobs = await invoke<NativeQueuedJob[]>("wwx_list_lfs_queue");
          return { ok: true, workflow: "list_lfs_queue", jobs };
        } catch (error) {
          return { ok: false, workflow: "list_lfs_queue", error: String(error) };
        }
      },
    }),
  } as const;
}

function safeJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}



function manifestDecisions(manifest: Manifest | null): Record<string, "ship" | "review" | "fail"> {
  if (!manifest) return {};
  if (manifest.task_decisions) return manifest.task_decisions;
  const result: Record<string, "ship" | "review" | "fail"> = {};
  for (const entry of manifest.scripts ?? []) {
    if (entry.task_id && entry.decision) result[entry.task_id] = entry.decision;
  }
  return result;
}

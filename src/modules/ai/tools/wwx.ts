import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { artifactAudience, friendlyStageLabel } from "@/modules/wwx/workflow";
import { getKey } from "../lib/keyring";
import type { ToolContext } from "./context";

const ARTIFACT_LIMIT = 50;
const SCRIPT_LIMIT = 12_000;

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
  visibilityClass?: string;
  contentSha256?: string;
};

type NativeArtifactContent = {
  artifact: NativeArtifact;
  contentText?: string | null;
  contentBlob?: number[] | null;
};

type NativeResearchRun = {
  id: string;
  productId: string;
  topicSlug: string;
  topic: string;
  searchTermsJson: string;
  runFolder: string;
  status: string;
  qualityJson: string;
  createdAt: number;
  updatedAt: number;
};

type NativeBatch = {
  id: string;
  productId: string;
  name: string;
  status: string;
  currentStage?: string | null;
  updatedAt: number;
  decisionCounts?: { ship: number; review: number; fail: number };
  workflowState?: Record<string, unknown>;
  artifacts: NativeArtifact[];
  finalScripts?: Array<{ taskId: string; script: string; decision: string }>;
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

function requireBinding(ctx: ToolContext): WwxBinding {
  const binding = ctx.getWwxBinding?.() ?? null;
  if (!binding) {
    throw new Error("No bound WWX batch is active. Open a product batch in the strategist agent first.");
  }
  return binding;
}

function shortOutput(value: string, limit = SCRIPT_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated]`;
}

function publicArtifacts(artifacts: NativeArtifact[]) {
  return artifacts
    .filter((artifact) => artifact.public && artifact.visibilityClass?.startsWith("public_"))
    .slice(0, ARTIFACT_LIMIT)
    .map((artifact) => ({
      id: artifact.id,
      path: `app://wwx/artifacts/${artifact.id}`,
      label: artifact.label || artifact.filename,
      filename: artifact.filename,
      kind: artifact.kind,
      audience: artifactAudience(artifact),
      visibility_class: artifact.visibilityClass,
      content_sha256: artifact.contentSha256,
      size: artifact.size,
    }));
}

function isFinalAd(artifact: NativeArtifact): boolean {
  const filename = artifact.filename.replace(/^\/+/, "");
  return artifact.visibilityClass === "public_final" && filename.startsWith("output-v41/") && filename.endsWith(".md");
}

function artifactByFilename(artifacts: NativeArtifact[], filename: string): NativeArtifact | undefined {
  return artifacts.find((artifact) => artifact.filename === filename);
}

async function readPublicArtifact(artifactId: string): Promise<NativeArtifactContent> {
  return invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId });
}

async function listPublicArtifacts(batchId: string): Promise<NativeArtifact[]> {
  return invoke<NativeArtifact[]>("wwx_list_artifacts", { batchId });
}

async function getBoundBatch(binding: WwxBinding): Promise<NativeBatch | null> {
  const batches = await invoke<NativeBatch[]>("wwx_list_batches", { productId: binding.productId });
  return batches.find((batch) => batch.id === binding.batchId) ?? null;
}

function jobResult(result: NativeJobResult) {
  const artifacts = publicArtifacts(result.artifacts);
  const finalCount = artifacts.filter((artifact) => artifact.audience === "final_ads").length;
  const stageLabel = friendlyStageLabel(result.currentStage ?? result.status);
  return {
    ok: result.ok,
    workflow: "create_ads",
    batch_id: result.batchId,
    product: result.productId,
    run_id: result.runId,
    status: result.status,
    current_stage: result.currentStage ?? undefined,
    awaiting_review: result.awaitingReview,
    retryable: result.retryable,
    reason: result.ok ? undefined : shortOutput(result.reason ?? result.stderr ?? "", 2_000),
    artifacts,
    ui: {
      headline: result.ok && (finalCount > 0 || result.status === "complete") ? "Final ads are ready" : `${stageLabel} is running`,
      stage_label: stageLabel,
      summary: result.ok
        ? `${finalCount} final ad artifact${finalCount === 1 ? "" : "s"} available.`
        : "The batch returned a sanitized blocker summary.",
      tone: result.ok ? (finalCount > 0 || result.status === "complete" ? "success" : "running") : "danger",
      operator_needed: !result.ok,
      retryable: result.retryable,
    },
  };
}

async function startNativeJob(
  binding: WwxBinding,
  input: {
    anglesMarkdown?: string;
    runMode?: "review" | "full";
    workers?: number;
    generationWorkers?: number;
  },
): Promise<NativeJobResult> {
  return invoke<NativeJobResult>("wwx_start_lfs_job", {
    input: {
      productId: binding.productId,
      batchId: binding.batchId,
      anglesMarkdown: input.anglesMarkdown,
      runMode: input.runMode ?? "full",
      workers: input.workers,
      generationWorkers: input.generationWorkers,
      anthropicApiKey: await getKey("anthropic"),
    },
  });
}

export function buildWwxTools(ctx: ToolContext) {
  return {
    create_ads: tool({
      description:
        "Start the autonomous blackbox LFS4.1 workflow for the bound batch. The backend keeps prompts, strategy, outlines, reports, and runner folders hidden.",
      inputSchema: z.object({
        angles_markdown: z.string().optional().describe("Optional owner-provided ad input text if the batch does not already have hidden inputs."),
        run_mode: z.enum(["review", "full"]).optional(),
        workers: z.number().int().min(1).max(20).optional(),
        generation_workers: z.number().int().min(1).max(50).optional(),
      }),
      needsApproval: true,
      execute: async ({ angles_markdown, run_mode, workers, generation_workers }) => {
        try {
          const binding = requireBinding(ctx);
          const result = await startNativeJob(binding, {
            anglesMarkdown: angles_markdown?.trim() || undefined,
            runMode: run_mode,
            workers,
            generationWorkers: generation_workers,
          });
          return jobResult(result);
        } catch (error) {
          return { ok: false, workflow: "create_ads", error: String(error), retryable: false };
        }
      },
    }),

    start_research_run: tool({
      description: "Run a new product research topic/search-term folder and store reusable research-run metadata.",
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
          return { ...result, workflow: "start_research_run" };
        } catch (error) {
          return { ok: false, workflow: "start_research_run", error: String(error), retryable: true };
        }
      },
    }),

    list_research_runs: tool({
      description: "List reusable research topics for the bound product, including dates, coverage, and quality stats.",
      inputSchema: z.object({ product_id: z.string().optional() }),
      execute: async ({ product_id }) => {
        try {
          const binding = ctx.getWwxBinding?.() ?? null;
          const productId = product_id?.trim() || binding?.productId;
          if (!productId) throw new Error("Provide product_id or run from a bound product batch.");
          const runs = await invoke<NativeResearchRun[]>("wwx_list_research_runs", { productId });
          return { ok: true, workflow: "list_research_runs", product_id: productId, research_runs: runs };
        } catch (error) {
          return { ok: false, workflow: "list_research_runs", error: String(error) };
        }
      },
    }),

    get_batch_status: tool({
      description: "Return sanitized current stage, blockers, retry state, counts, and public artifact metadata for the bound batch.",
      inputSchema: z.object({ batch_id: z.string().optional() }),
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const batch = await getBoundBatch(binding);
          if (!batch) throw new Error("Bound batch was not found.");
          return {
            ok: true,
            workflow: "get_batch_status",
            batch_id: binding.batchId,
            status: batch.status,
            current_stage: batch.currentStage,
            stage_label: friendlyStageLabel(batch.currentStage ?? batch.status),
            decision_counts: batch.decisionCounts,
            workflow_state: batch.workflowState,
            final_script_count: batch.finalScripts?.length ?? 0,
            artifacts: publicArtifacts(batch.artifacts),
          };
        } catch (error) {
          return { ok: false, workflow: "get_batch_status", error: String(error) };
        }
      },
    }),

    list_final_ads: tool({
      description: "List final public LFS scripts only.",
      inputSchema: z.object({ batch_id: z.string().optional() }),
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const artifacts = await listPublicArtifacts(binding.batchId);
          return {
            ok: true,
            workflow: "list_final_ads",
            batch_id: binding.batchId,
            ads: publicArtifacts(artifacts.filter(isFinalAd)),
          };
        } catch (error) {
          return { ok: false, workflow: "list_final_ads", error: String(error) };
        }
      },
    }),

    get_final_ad: tool({
      description: "Read one final public LFS script by artifact id or task id.",
      inputSchema: z.object({
        artifact_id: z.string().optional(),
        task_id: z.string().optional(),
        batch_id: z.string().optional(),
      }),
      execute: async ({ artifact_id, task_id }) => {
        try {
          const binding = requireBinding(ctx);
          const artifacts = await listPublicArtifacts(binding.batchId);
          const artifact = artifact_id
            ? artifacts.find((item) => item.id === artifact_id)
            : artifacts.find((item) => isFinalAd(item) && item.filename.endsWith(`${task_id ?? ""}.md`));
          if (!artifact || !isFinalAd(artifact)) throw new Error("Final ad not found in public batch outputs.");
          const content = await readPublicArtifact(artifact.id);
          return {
            ok: true,
            workflow: "get_final_ad",
            batch_id: binding.batchId,
            artifact: publicArtifacts([artifact])[0],
            content: shortOutput(content.contentText ?? ""),
          };
        } catch (error) {
          return { ok: false, workflow: "get_final_ad", error: String(error) };
        }
      },
    }),

    get_asset_inputs: tool({
      description: "Return approved scripts plus public fields needed for image/video asset generation.",
      inputSchema: z.object({ batch_id: z.string().optional() }),
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const artifacts = await listPublicArtifacts(binding.batchId);
          const artifact = artifactByFilename(artifacts, "asset-inputs.json");
          if (!artifact) throw new Error("Asset inputs are not available yet.");
          const content = await readPublicArtifact(artifact.id);
          return {
            ok: true,
            workflow: "get_asset_inputs",
            batch_id: binding.batchId,
            artifact: publicArtifacts([artifact])[0],
            asset_inputs: safeJson(content.contentText ?? "{}"),
          };
        } catch (error) {
          return { ok: false, workflow: "get_asset_inputs", error: String(error) };
        }
      },
    }),

    get_batch_metrics: tool({
      description: "Return ad count, ship/review/fail counts, formats, mechanisms, research topics, duplicate clusters, and word-count stats.",
      inputSchema: z.object({ batch_id: z.string().optional() }),
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const metrics = await invoke<Record<string, unknown>>("wwx_get_batch_metrics", { batchId: binding.batchId });
          return { ok: true, workflow: "get_batch_metrics", metrics };
        } catch (error) {
          return { ok: false, workflow: "get_batch_metrics", error: String(error) };
        }
      },
    }),

    analyze_ads: tool({
      description: "Cluster duplicates, list tested angles, repeated hooks/mechanisms, weak diversity, and missing coverage using public final ads and metadata only.",
      inputSchema: z.object({ batch_id: z.string().optional() }),
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const analysis = await invoke<Record<string, unknown>>("wwx_analyze_ads", { batchId: binding.batchId });
          return { ok: true, workflow: "analyze_ads", analysis };
        } catch (error) {
          return { ok: false, workflow: "analyze_ads", error: String(error) };
        }
      },
    }),

    compare_batches: tool({
      description: "Compare formats, angles, research topics, duplicate rate, and output quality across batches.",
      inputSchema: z.object({ batch_ids: z.array(z.string()).min(1) }),
      execute: async ({ batch_ids }) => {
        try {
          const comparison = await invoke<Record<string, unknown>>("wwx_compare_batches", { batchIds: batch_ids });
          return { ok: true, workflow: "compare_batches", comparison };
        } catch (error) {
          return { ok: false, workflow: "compare_batches", error: String(error) };
        }
      },
    }),

    answer_batch_question: tool({
      description: "Answer a strategist question using RAG over public final ads, public summaries, and structured metadata only.",
      inputSchema: z.object({
        question: z.string().min(1),
        batch_id: z.string().optional(),
      }),
      execute: async ({ question }) => {
        try {
          const binding = requireBinding(ctx);
          const answer = await invoke<Record<string, unknown>>("wwx_answer_batch_question", {
            input: { batchId: binding.batchId, question },
          });
          return { ok: true, workflow: "answer_batch_question", ...answer };
        } catch (error) {
          return { ok: false, workflow: "answer_batch_question", error: String(error) };
        }
      },
    }),

    export_handoff_package: tool({
      description: "Export final scripts and asset inputs for creative strategist handoff.",
      inputSchema: z.object({ batch_id: z.string().optional() }),
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const result = await invoke<Record<string, unknown>>("wwx_export_handoff_package", { batchId: binding.batchId });
          return { ok: true, workflow: "export_handoff_package", ...result };
        } catch (error) {
          return { ok: false, workflow: "export_handoff_package", error: String(error) };
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

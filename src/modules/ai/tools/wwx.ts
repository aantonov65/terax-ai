import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import {
  createWwxBatch,
  createWwxProduct,
  seedWwxBatchFromPackage,
} from "@/modules/wwx/mutations";
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

type GeneratedProductPackage = {
  productCode: string;
  batchId: string;
  configJson: string;
  archetypes: string;
  hotwords: string;
  mechanisms: string;
  sourceAngle: string;
  angles: string;
  strategyJson: string;
  operatorInputJson: string;
  readinessAssessmentJson: string;
  conceptMatrixJson: string;
  reportJson: string;
  sourceBundleJson: string;
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
  readiness?: Record<string, unknown> | null;
  conceptMatrix?: Record<string, unknown> | null;
  approval?: Record<string, unknown> | null;
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
      size: artifact.size,
    }));
}

function safeSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "PRODUCT"
  );
}

function inferProductCode(input: {
  productCode?: string;
  documents: Array<{ label: string; content: string }>;
  batchGoal?: string;
}): string {
  if (input.productCode?.trim()) return input.productCode;
  const text = [
    input.batchGoal ?? "",
    ...input.documents.flatMap((doc) => [doc.label, doc.content.slice(0, 240)]),
  ].join("\n");
  const match =
    text.match(/\b(?:product|brand|name)\s*[:=-]\s*([A-Za-z][A-Za-z0-9 -]{1,40})/i) ??
    text.match(/\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,2})\b/);
  return match?.[1] ?? "PRODUCT";
}

function packageArtifacts(generated: GeneratedProductPackage) {
  return {
    batchId: generated.batchId,
    sourceAngle: generated.sourceAngle,
    angles: generated.angles,
    strategyJson: generated.strategyJson,
    operatorInputJson: generated.operatorInputJson,
    readinessAssessmentJson: generated.readinessAssessmentJson,
    conceptMatrixJson: generated.conceptMatrixJson,
    reportJson: generated.reportJson,
  };
}

function packageCanProceed(readiness: Record<string, unknown>): boolean {
  if (readiness.can_proceed === false) return false;
  return String(readiness.status ?? "").toLowerCase() !== "red";
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
  if (/not production-ready|missing research|pricing_rules|guarantee|product_name|target_demographic|mechanism/.test(text)) {
    return { kind: "missing_truth", operatorNeeded: true, resumeFrom: "research_cards" };
  }
  if (/invalid json|expected exactly|prompt source|outline contract|manifest/.test(text)) {
    return { kind: "malformed_artifact", operatorNeeded: false, resumeFrom: "lfs_brief" };
  }
  if (/semantic/.test(text)) {
    return { kind: "weak_creative_artifact", operatorNeeded: false, resumeFrom: "semantic_launchable" };
  }
  if (/preflight|forbidden|cta|native lfs|format contract|objective/.test(text)) {
    return { kind: "deterministic_compliance_issue", operatorNeeded: false, resumeFrom: "preflight_v41" };
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
  };
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
    create_product_from_intake: tool({
      description:
        "Chat-first WWX intake: generate a production package from messy product evidence, readiness-check it, create the Product and first Batch only if it can proceed, then seed strategy artifacts for approval.",
      inputSchema: z.object({
        product_code: z.string().optional().describe("Short uppercase-safe product code, if the operator supplied one."),
        documents: z.array(z.object({
          label: z.string().min(1),
          content: z.string().min(1),
        })).min(1).describe("Raw product evidence, research notes, swipes, URLs copied as text, offer facts, or operator notes."),
        batch_goal: z.string().optional().describe("What this ad batch should accomplish."),
        target_ad_count: z.number().int().min(1).max(100).optional().describe("Requested number of ads."),
        preferred_formats: z.array(z.string()).optional().describe("Optional LFS formats, e.g. confession, expose, listicle, warning."),
        approval_note: z.string().optional().describe("Human approval note for creating the product/batch if the package is ready."),
      }),
      needsApproval: true,
      execute: async ({ product_code, documents, batch_goal, target_ad_count, preferred_formats, approval_note }) => {
        try {
          if (ctx.getWwxBinding?.()) {
            throw new Error("This intake tool creates a new Product and Batch. Open a New intake agent first.");
          }
          const anthropicApiKey = await getKey("anthropic");
          const productCode = safeSegment(inferProductCode({
            productCode: product_code,
            documents,
            batchGoal: batch_goal,
          })).toUpperCase();
          const generated = await invoke<GeneratedProductPackage>("wwx_generate_product_package", {
            input: {
              productCode,
              documents,
              batchRequest: {
                goal: batch_goal?.trim() ?? "",
                target_ad_count: target_ad_count ?? 10,
                preferred_formats: preferred_formats ?? [],
              },
              anthropicApiKey,
            },
          });
          const readiness = safeJson(generated.readinessAssessmentJson);
          const conceptMatrix = safeJson(generated.conceptMatrixJson);
          const operatorInput = safeJson(generated.operatorInputJson);
          if (!packageCanProceed(readiness)) {
            return {
              ok: true,
              workflow: "create_product_from_intake",
              created: false,
              blocked: true,
              product_code: generated.productCode,
              batch_id: generated.batchId,
              readiness,
              concept_matrix: conceptMatrix,
              operator_input: operatorInput,
              next_actions: [
                "Ask the operator for the missing truth or stronger research named in readiness.missing_truth and readiness.weak_research.",
                "Run create_product_from_intake again with the added evidence.",
              ],
            };
          }

          const config = safeJson(generated.configJson);
          const sourceBundle = safeJson(generated.sourceBundleJson);
          const artifacts = packageArtifacts(generated);
          const createdProduct = await createWwxProduct({
            workspaceRoot: ctx.getWorkspaceRoot() ?? "",
            productFolder: generated.productCode,
            config,
            research: {
              archetypes: generated.archetypes,
              hotwords: generated.hotwords,
              mechanisms: generated.mechanisms,
            },
            sourceBundle,
            packageArtifacts: artifacts,
            approveForProduction: true,
          });
          const createdBatch = await createWwxBatch({
            workspaceRoot: ctx.getWorkspaceRoot() ?? "",
            productFolder: createdProduct.productId,
            batchName: generated.batchId,
          });
          await seedWwxBatchFromPackage({
            productId: createdProduct.productId,
            batchId: createdBatch.batchId,
            packageArtifacts: artifacts,
          });
          ctx.onWwxBatchCreated?.({
            productId: createdProduct.productId,
            productCode: createdProduct.productCode,
            batchId: createdBatch.batchId,
            batchPath: createdBatch.batchPath,
            seedPrompt: [
              "A new product and batch were created from chat intake.",
              "Read the readiness and concept matrix, then explain the proposed strategy in plain language.",
              "Do not start generation until the operator approves the concept matrix.",
            ].join(" "),
          });
          return {
            ok: true,
            workflow: "create_product_from_intake",
            created: true,
            product: createdProduct.productId,
            product_code: createdProduct.productCode,
            batch_id: createdBatch.batchId,
            batch_path: createdBatch.batchPath,
            readiness,
            concept_matrix: conceptMatrix,
            operator_input: operatorInput,
            approval_note: approval_note ?? null,
            next_actions: [
              "Present the concept matrix for approval.",
              "After approval, call approve_concept_matrix, then submit_lfs_job with run_mode full.",
            ],
          };
        } catch (error) {
          return { ok: false, workflow: "create_product_from_intake", error: String(error), retryable: false };
        }
      },
    }),

    submit_lfs_job: tool({
      description:
        "Submit angle.md content to the bound batch, canonicalize product/task IDs deterministically, and run the first guided LFS checkpoint.",
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
          if (
            artifactByFilename(batchArtifacts, "concept-matrix.json") &&
            !artifactByFilename(batchArtifacts, "concept-matrix-approval.json")
          ) {
            throw new Error("Concept matrix approval is required before generation.");
          }
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
          if (!markdown) throw new Error("Attach angle.md or provide angles_markdown.");
          const hydrated = await hydrateArtifactReferences(markdown);
          const result = await runNativeJob("wwx_start_lfs_job", binding, {
            anglesMarkdown: canonicalizeAngles(hydrated, binding),
            runMode: run_mode ?? "full",
            workers,
            generationWorkers: generation_workers,
          });
          return jobResult("submit_lfs_job", result);
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
          const result = await runNativeJob("wwx_advance_lfs_job", requireBinding(ctx), {
            workers,
            generationWorkers: generation_workers,
          });
          return jobResult("advance_lfs_job", result);
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
          const result = await runNativeJob("wwx_resume_lfs_job", requireBinding(ctx));
          return jobResult("resume_lfs_job", result);
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
          };
        } catch (error) {
          return { ok: false, workflow: "get_lfs_job", error: String(error) };
        }
      },
    }),

    get_lfs_plan: tool({
      description: "Read the public readiness, concept-matrix, and approval state for the bound batch.",
      inputSchema: z.object({ batch_id: z.string().optional() }),
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const artifacts = await invoke<NativeArtifact[]>("wwx_list_artifacts", { batchId: binding.batchId });
          const result: BatchPlan = {};
          for (const [filename, key] of [
            ["readiness-assessment.json", "readiness"],
            ["concept-matrix.json", "conceptMatrix"],
            ["concept-matrix-approval.json", "approval"],
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
      execute: async ({ mode }) => {
        try {
          const fromStage = mode === "objective"
            ? "objective_finish_pre_semantic"
            : mode === "semantic"
              ? "semantic_launchable"
              : "objective_finish_final";
          const result = await runNativeJob("wwx_resume_lfs_job", requireBinding(ctx), { fromStage, runMode: "full" });
          return jobResult("rerun_lfs_checks", result);
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
          const result = await runNativeJob("wwx_resume_lfs_job", requireBinding(ctx), {
            fromStage: stage,
            runMode: "full",
          });
          return jobResult("retry_lfs_failures", result);
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
          return { ok: true, workflow: "export_lfs", batch_id: binding.batchId, filter, scripts };
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
          return { ok: true, workflow: "cancel_lfs_job", batch_id: binding.batchId, run };
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

    approve_product_package: tool({
      description: "Explicitly approve the current bound product package for production LFS use after human review.",
      inputSchema: z.object({
        approval_note: z.string().min(1),
      }),
      needsApproval: true,
      execute: async ({ approval_note }) => {
        try {
          const binding = requireBinding(ctx);
          const index = await invoke<NativeIndexRecord>("wwx_list_products");
          const product = index.products.find((item) => item.id === binding.productId);
          if (!product) throw new Error("Bound product was not found.");
          const config = safeJson(product.configJson);
          const current = isRecord(config.wwx_readiness) ? config.wwx_readiness : {};
          config.wwx_readiness = {
            ...current,
            status: "production_ready",
            approved: true,
            gaps: [],
            approval_note,
            approved_at: new Date().toISOString(),
          };
          await invoke("wwx_update_product", { productId: binding.productId, config });
          return {
            ok: true,
            workflow: "approve_product_package",
            product: binding.productId,
            readiness: config.wwx_readiness,
          };
        } catch (error) {
          return { ok: false, workflow: "approve_product_package", error: String(error) };
        }
      },
    }),

    approve_concept_matrix: tool({
      description: "Record explicit human approval for the bound batch concept matrix before generation.",
      inputSchema: z.object({
        approval_note: z.string().min(1),
      }),
      needsApproval: true,
      execute: async ({ approval_note }) => {
        try {
          const binding = requireBinding(ctx);
          const payload = {
            schema: "concept-matrix-approval/v1",
            approved: true,
            approval_note,
            approved_at: new Date().toISOString(),
          };
          const artifact = await invoke<NativeArtifact>("wwx_write_artifact", {
            input: {
              productId: binding.productId,
              batchId: binding.batchId,
              kind: "json",
              label: "concept-matrix-approval.json",
              filename: "concept-matrix-approval.json",
              mimeType: "application/json",
              contentText: JSON.stringify(payload, null, 2),
              source: "concept-matrix-approval",
              public: true,
            },
          });
          return {
            ok: true,
            workflow: "approve_concept_matrix",
            batch_id: binding.batchId,
            artifact_path: `app://wwx/artifacts/${artifact.id}`,
            approval: payload,
          };
        } catch (error) {
          return { ok: false, workflow: "approve_concept_matrix", error: String(error) };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

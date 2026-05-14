import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { getKey } from "../lib/keyring";
import { native } from "../lib/native";
import { resolvePath, type ToolContext } from "./context";

const OUTPUT_LIMIT = 8_000;

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
    throw new Error("No bound WWX batch is active. Open this batch in an agent window first.");
  }
  return binding;
}

function shortOutput(value: string): string | undefined {
  if (!value) return undefined;
  return value.length > OUTPUT_LIMIT
    ? `${value.slice(0, OUTPUT_LIMIT)}\n...[truncated]`
    : value;
}

function canonicalDateSuffix(): string {
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${month}${now.getUTCDate()}`;
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
    : [{ title: `${product}_LFS_ARC1_A1B1_M1_${canonicalDateSuffix()}`, body: markdown.trim(), fields: {} }];
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
  const suffix = canonicalDateSuffix();
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

function publicArtifacts(artifacts: NativeArtifact[]) {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    path: `app://wwx/artifacts/${artifact.id}`,
    label: artifact.label || artifact.filename,
    kind: artifact.kind,
    size: artifact.size,
  }));
}

function jobResult(workflow: string, result: NativeJobResult) {
  return {
    ok: result.ok,
    workflow,
    batch_id: result.batchId,
    product: result.productId,
    run_id: result.runId,
    status: result.status,
    current_stage: result.currentStage ?? undefined,
    awaiting_review: result.awaitingReview,
    retryable: result.retryable,
    reason: result.reason ?? undefined,
    next_actions: result.ok
      ? ["Review public artifacts.", "Run advance_lfs_job to approve and continue."]
      : ["Read the job status and public artifacts for the failed checkpoint."],
    artifacts: publicArtifacts(result.artifacts),
    stdout: shortOutput(result.stdout),
    stderr: shortOutput(result.stderr),
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
      anthropicApiKey,
    },
  });
}

export function buildWwxTools(ctx: ToolContext) {
  return {
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
          let markdown = angles_markdown?.trim() || "";
          if (!markdown && angles_path) {
            const resolved = resolvePath(angles_path, ctx.getCwd());
            const file = await native.readFile(resolved);
            if (file.kind !== "text") throw new Error("The supplied angle file is not readable text.");
            markdown = file.content;
          }
          if (!markdown) throw new Error("Attach angle.md or provide angles_markdown.");
          const result = await runNativeJob("wwx_start_lfs_job", binding, {
            anglesMarkdown: canonicalizeAngles(markdown, binding),
            runMode: run_mode,
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
      description: "Approve the current held checkpoint for the bound batch and run exactly one next LFS stage.",
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
      execute: async () => {
        try {
          const result = await runNativeJob("wwx_resume_lfs_job", requireBinding(ctx));
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
      execute: async () => {
        try {
          const result = await runNativeJob("wwx_resume_lfs_job", requireBinding(ctx));
          return jobResult("retry_lfs_failures", result);
        } catch (error) {
          return { ok: false, workflow: "retry_lfs_failures", error: String(error), retryable: true };
        }
      },
    }),

    export_lfs: tool({
      description: "Return public final scripts for handoff.",
      inputSchema: z.object({ filter: z.enum(["ship_only", "all"]).optional(), batch_id: z.string().optional() }),
      execute: async () => {
        try {
          const binding = requireBinding(ctx);
          const artifacts = await invoke<NativeArtifact[]>("wwx_list_artifacts", { batchId: binding.batchId });
          const scripts = [];
          for (const artifact of artifacts.filter((item) => item.filename.startsWith("output-v41/") && item.filename.endsWith(".md"))) {
            const content = await invoke<NativeArtifactContent>("wwx_read_artifact", { artifactId: artifact.id });
            scripts.push({ name: artifact.filename, content: shortOutput(content.contentText ?? "") ?? "" });
          }
          return { ok: true, workflow: "export_lfs", batch_id: binding.batchId, filter: "ship_only", scripts };
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
  } as const;
}

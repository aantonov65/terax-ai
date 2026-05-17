import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AiMagicIcon,
  Cancel01Icon,
  Edit02Icon,
  FileEditIcon,
  FilePlusIcon,
  FileSearchIcon,
  FolderAddIcon,
  Image01Icon,
  TerminalIcon,
  Tick02Icon,
  ToolsIcon,
  WorkflowSquare06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ToolUIPart } from "ai";
import { memo } from "react";

type Props = {
  part: Extract<ToolUIPart, { state: "approval-requested" }>;
  toolName: string;
  onRespond: (approved: boolean) => void;
};

const TOOL_META: Record<string, { label: string; icon: typeof FilePlusIcon }> =
  {
    write_file: { label: "Write file", icon: FilePlusIcon },
    edit: { label: "Edit file", icon: FileEditIcon },
    multi_edit: { label: "Edit file (batch)", icon: Edit02Icon },
    create_directory: { label: "Create directory", icon: FolderAddIcon },
    bash_run: { label: "Run shell command", icon: TerminalIcon },
    bash_background: { label: "Spawn background process", icon: TerminalIcon },
    create_product_from_intake: { label: "Create product from intake", icon: AiMagicIcon },
    approve_concept_matrix: { label: "Approve concept matrix", icon: WorkflowSquare06Icon },
    submit_lfs_job: { label: "Submit LFS job", icon: WorkflowSquare06Icon },
    advance_lfs_job: { label: "Advance LFS job", icon: WorkflowSquare06Icon },
    resume_lfs_job: { label: "Resume LFS job", icon: WorkflowSquare06Icon },
    rerun_lfs_checks: { label: "Rerun LFS checks", icon: WorkflowSquare06Icon },
    retry_lfs_failures: { label: "Retry LFS failures", icon: WorkflowSquare06Icon },
    cancel_lfs_job: { label: "Cancel LFS job", icon: Cancel01Icon },
    export_lfs: { label: "Export LFS scripts", icon: FileSearchIcon },
    edit_lfs_artifact: { label: "Edit LFS artifact", icon: FileEditIcon },
    create_batch_from_angles: { label: "Create WWX batch", icon: AiMagicIcon },
    run_guided_lfs_agent: { label: "Create LFS", icon: WorkflowSquare06Icon },
    run_lfs_v41: { label: "Run LFS V4.1", icon: WorkflowSquare06Icon },
    generate_images: { label: "Generate images", icon: Image01Icon },
    run_lfs_and_images: { label: "Run LFS + images", icon: WorkflowSquare06Icon },
    get_batch_status: { label: "Inspect batch status", icon: FileSearchIcon },
    open_artifact: { label: "Open artifact", icon: FileSearchIcon },
  };

function AiToolApprovalImpl({ part, toolName, onRespond }: Props) {
  const meta = TOOL_META[toolName];
  const label = meta?.label ?? toolName;
  const Icon = meta?.icon ?? ToolsIcon;
  const input = part.input as Record<string, unknown>;

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500 animate-pulse" />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="text-[12px] font-medium text-foreground">
          {label}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          needs approval
        </span>
      </div>

      <div className="px-3 py-2.5">
        <PreviewBlock toolName={toolName} input={input} />
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onRespond(false)}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          Deny
        </Button>
        <Button
          size="sm"
          variant="default"
          onClick={() => onRespond(true)}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
          Approve
        </Button>
      </div>
    </div>
  );
}

export const AiToolApproval = memo(AiToolApprovalImpl, (a, b) => {
  // The approval card never changes content for a given approvalId — once
  // the model has emitted the approval-requested part with its input, we
  // don't want to re-render on every downstream token.
  return (
    a.toolName === b.toolName &&
    a.part.approval.id === b.part.approval.id &&
    a.onRespond === b.onRespond
  );
});

function PreviewBlock({
  toolName,
  input,
}: {
  toolName: string;
  input: Record<string, unknown>;
}) {
  if (isWwxWorkflowTool(toolName)) {
    const product = stringInput(input.product);
    const batch = stringInput(input.batch_id);
    const risk = stringInput(input.expected_cost_risk);
    const productPrefix = product ? `products/${product}` : "products/{product}";
    const touched = [
      stringInput(input.angles_path),
      stringInput(input.strategy_path),
      input.angles_markdown ? "uploaded angle.md" : null,
      batch ? `${productPrefix}/batches/${batch}/wwx-artifacts.json` : null,
      toolName.includes("image") ? "images/ and image-report.json" : null,
    ].filter((item): item is string => Boolean(item));
    return (
      <div className="space-y-2 text-[11px]">
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
          <span className="text-muted-foreground">Intent</span>
          <span>{workflowIntent(toolName)}</span>
          {product ? (
            <>
              <span className="text-muted-foreground">Product</span>
              <span className="font-mono">{product}</span>
            </>
          ) : null}
          {batch ? (
            <>
              <span className="text-muted-foreground">Batch</span>
              <span className="font-mono">{batch}</span>
            </>
          ) : null}
          <span className="text-muted-foreground">Risk</span>
          <span>{risk || defaultWorkflowRisk(toolName)}</span>
        </div>
        {touched.length ? (
          <div className="rounded-md bg-muted/60 p-2">
            <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Files touched
            </div>
            <div className="space-y-0.5 font-mono text-[10.5px] text-muted-foreground">
              {touched.map((item) => (
                <div key={item} className="truncate" title={item}>
                  {item}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (toolName === "bash_run" || toolName === "bash_background") {
    const cwd = typeof input.cwd === "string" ? input.cwd : null;
    return (
      <div className="space-y-1.5">
        {cwd && (
          <div className="font-mono text-[10.5px] text-muted-foreground">
            {cwd}
          </div>
        )}
        <pre
          className={cn(
            "max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed",
          )}
        >
          {String(input.command ?? "")}
        </pre>
      </div>
    );
  }
  // For file mutations we deliberately do NOT preview content here —
  // streamed write/edit content thrashes the UI and the AI diff tab is the
  // authoritative place to review the change. Show just the path + a
  // one-line size hint so the user knows what's being touched.
  if (toolName === "write_file") {
    const content = typeof input.content === "string" ? input.content : "";
    const lines = content ? content.split("\n").length : 0;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground">{String(input.path ?? "")}</div>
        <div className="text-[10.5px] text-muted-foreground/80">
          {lines} line{lines === 1 ? "" : "s"} · review in the diff tab
        </div>
      </div>
    );
  }
  if (toolName === "edit") {
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    const removed = oldStr ? oldStr.split("\n").length : 0;
    const added = newStr ? newStr.split("\n").length : 0;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground">
          {String(input.path ?? "")}
          {input.replace_all ? " · replace all" : ""}
        </div>
        <div className="text-[10.5px] text-muted-foreground/80">
          −{removed} / +{added} line{added === 1 && removed === 1 ? "" : "s"} ·
          review in the diff tab
        </div>
      </div>
    );
  }
  if (toolName === "multi_edit") {
    const edits = Array.isArray(input.edits)
      ? (input.edits as Array<{ old_string?: string; new_string?: string }>)
      : [];
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground">{String(input.path ?? "")}</div>
        <div className="text-[10.5px] text-muted-foreground/80">
          {edits.length} edit{edits.length === 1 ? "" : "s"} · review in the
          diff tab
        </div>
      </div>
    );
  }
  if (toolName === "create_directory") {
    return (
      <div className="font-mono text-[11px] text-muted-foreground">
        {String(input.path ?? "")}
      </div>
    );
  }
  return (
    <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

function isWwxWorkflowTool(toolName: string): boolean {
  return [
    "submit_lfs_job",
    "create_product_from_intake",
    "get_lfs_plan",
    "approve_concept_matrix",
    "advance_lfs_job",
    "resume_lfs_job",
    "rerun_lfs_checks",
    "retry_lfs_failures",
    "cancel_lfs_job",
    "export_lfs",
    "get_lfs_job",
    "list_lfs_artifacts",
    "read_lfs_artifact",
    "edit_lfs_artifact",
    "create_batch_from_angles",
    "run_guided_lfs_agent",
    "run_lfs_v41",
    "generate_images",
    "run_lfs_and_images",
    "get_batch_status",
    "open_artifact",
  ].includes(toolName);
}

function stringInput(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function workflowIntent(toolName: string): string {
  if (toolName === "create_product_from_intake") return "Generate a product package from chat evidence and create the first batch only if readiness passes.";
  if (toolName === "get_lfs_plan") return "Read the prepared readiness and concept matrix.";
  if (toolName === "approve_concept_matrix") return "Record explicit strategy approval for this batch.";
  if (toolName === "submit_lfs_job") return "Canonicalize angle input and start a bound LFS job.";
  if (toolName === "advance_lfs_job") return "Approve the current checkpoint and run one next stage.";
  if (toolName === "resume_lfs_job") return "Resume the bound LFS job from saved state.";
  if (toolName === "rerun_lfs_checks") return "Rerun high-level QA/check stages.";
  if (toolName === "retry_lfs_failures") return "Retry a failed LFS stage.";
  if (toolName === "cancel_lfs_job") return "Mark the LFS job canceled.";
  if (toolName === "export_lfs") return "Export public generated scripts.";
  if (toolName === "get_lfs_job") return "Read sanitized job status.";
  if (toolName === "list_lfs_artifacts") return "List public LFS artifacts.";
  if (toolName === "read_lfs_artifact") return "Read one public LFS artifact.";
  if (toolName === "edit_lfs_artifact") return "Edit only whitelisted public LFS artifacts.";
  if (toolName === "create_batch_from_angles") return "Compile angles.md into a guarded WWX batch.";
  if (toolName === "run_guided_lfs_agent") return "Run the guided LFS agent workflow.";
  if (toolName === "run_lfs_v41") return "Run the LFS V4.1 script workflow.";
  if (toolName === "generate_images") return "Generate image assets for the batch.";
  if (toolName === "run_lfs_and_images") return "Run scripts first, then images.";
  if (toolName === "get_batch_status") return "Read public status and artifact metadata.";
  return "Open a public artifact preview.";
}

function defaultWorkflowRisk(toolName: string): string {
  if (toolName === "create_product_from_intake") return "May call model providers and writes a new Product, Batch, and public planning artifacts if readiness passes.";
  if (toolName === "get_lfs_plan") return "Read-only.";
  if (toolName === "approve_concept_matrix") return "Writes the strategy approval record for this batch.";
  if (toolName === "submit_lfs_job") return "Writes canonical input and may call model providers.";
  if (toolName === "advance_lfs_job" || toolName === "resume_lfs_job") return "May call model providers and write batch artifacts.";
  if (toolName === "rerun_lfs_checks" || toolName === "retry_lfs_failures") return "May call model providers for QA/repair stages.";
  if (toolName === "cancel_lfs_job") return "Updates local job state only.";
  if (toolName === "edit_lfs_artifact") return "Writes only whitelisted batch artifacts.";
  if (toolName === "export_lfs" || toolName === "get_lfs_job" || toolName === "list_lfs_artifacts" || toolName === "read_lfs_artifact") return "Read-only.";
  if (toolName === "create_batch_from_angles") return "Writes strategy/spec/manifest files only.";
  if (toolName === "get_batch_status" || toolName === "open_artifact") return "Read-only.";
  if (toolName === "generate_images") return "May call image providers and consume credits.";
  if (toolName === "run_guided_lfs_agent") return "May call model providers and write LFS artifacts.";
  return "May call model providers and write generated artifacts.";
}

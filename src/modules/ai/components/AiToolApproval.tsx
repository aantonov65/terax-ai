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
    create_product_from_config: { label: "Saving Product Setup", icon: AiMagicIcon },
    create_ads: { label: "Creating Ads", icon: WorkflowSquare06Icon },
    start_research_run: { label: "Running Research", icon: FileSearchIcon },
    list_research_runs: { label: "Listing Research", icon: FileSearchIcon },
    list_final_ads: { label: "Listing Final Ads", icon: FileSearchIcon },
    get_final_ad: { label: "Opening Final Ad", icon: FileSearchIcon },
    get_asset_inputs: { label: "Opening Asset Inputs", icon: Image01Icon },
    get_batch_metrics: { label: "Reading Metrics", icon: FileSearchIcon },
    analyze_ads: { label: "Analyzing Ads", icon: WorkflowSquare06Icon },
    compare_batches: { label: "Comparing Batches", icon: WorkflowSquare06Icon },
    answer_batch_question: { label: "Answering Batch Question", icon: FileSearchIcon },
    export_handoff_package: { label: "Exporting Handoff", icon: FileSearchIcon },
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
    const product = stringInput(input.product_id) ?? stringInput(input.product);
    const batch = stringInput(input.batch_id);
    const risk = stringInput(input.expected_cost_risk);
    const touched = [
      stringInput(input.topic),
      stringInput(input.artifact_id),
      stringInput(input.task_id),
      input.angles_markdown ? "owner-provided batch input text" : null,
      toolName === "get_asset_inputs" ? "public asset-inputs.json" : null,
      toolName === "export_handoff_package" ? "public handoff-package.json" : null,
    ].filter((item): item is string => Boolean(item));
    return (
      <div className="space-y-2 text-[11px]">
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
          <span className="text-muted-foreground">Action</span>
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
          <span className="text-muted-foreground">Impact</span>
          <span>{risk || defaultWorkflowRisk(toolName)}</span>
        </div>
        {touched.length ? (
          <div className="rounded-md bg-muted/60 p-2">
            <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Details
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
    "create_ads",
    "start_research_run",
    "list_research_runs",
    "get_batch_status",
    "list_final_ads",
    "get_final_ad",
    "get_asset_inputs",
    "get_batch_metrics",
    "analyze_ads",
    "compare_batches",
    "answer_batch_question",
    "export_handoff_package",
  ].includes(toolName);
}

function stringInput(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function workflowIntent(toolName: string): string {
  if (toolName === "create_ads") return "Start the autonomous blackbox LFS4.1 workflow.";
  if (toolName === "start_research_run") return "Build a reusable research topic for this product.";
  if (toolName === "list_research_runs") return "List available research topics and quality stats.";
  if (toolName === "get_batch_status") return "Read public status and artifact metadata.";
  if (toolName === "list_final_ads") return "List final public scripts.";
  if (toolName === "get_final_ad") return "Open one final public script.";
  if (toolName === "get_asset_inputs") return "Open public asset-generation inputs.";
  if (toolName === "get_batch_metrics") return "Read public batch metrics.";
  if (toolName === "analyze_ads") return "Analyze duplicates, angles, and coverage.";
  if (toolName === "compare_batches") return "Compare public metrics across batches.";
  if (toolName === "answer_batch_question") return "Answer from public batch data only.";
  if (toolName === "export_handoff_package") return "Prepare final scripts and asset inputs for handoff.";
  if (toolName === "create_batch_from_angles") return "Compile angles.md into a guarded WWX batch.";
  if (toolName === "run_guided_lfs_agent") return "Run the guided LFS agent workflow.";
  if (toolName === "run_lfs_v41") return "Run the LFS V4.1 script workflow.";
  if (toolName === "generate_images") return "Generate image assets for the batch.";
  if (toolName === "run_lfs_and_images") return "Run scripts first, then images.";
  if (toolName === "get_batch_status") return "Read public status and artifact metadata.";
  return "Open a public artifact preview.";
}

function defaultWorkflowRisk(toolName: string): string {
  if (toolName === "create_ads" || toolName === "start_research_run") return "May use model/research providers and save public outputs plus hidden backend state.";
  if (toolName === "export_handoff_package") return "Writes one public handoff artifact.";
  return "May call model providers and write generated artifacts.";
}

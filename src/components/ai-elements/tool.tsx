"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tool as PromptKitTool,
  type ToolPart as PromptKitToolPart,
  type ToolStateVariant,
} from "@/components/ui/tool";
import { cn } from "@/lib/utils";
import {
  ArrowRight01Icon,
  CheckListIcon,
  Edit02Icon,
  EyeIcon,
  File01Icon,
  FileEditIcon,
  FilePlusIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  GlobalSearchIcon,
  RobotIcon,
  SparklesIcon,
  TerminalIcon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, memo, useState } from "react";

import type { BundledLanguage } from "shiki";
import { CodeBlockContent } from "./code-block";
import { sendMessage } from "@/modules/ai/store/chatStore";

export type ToolPart = ToolUIPart | DynamicToolUIPart;

const TOOL_META: Record<string, { label: string; icon: typeof File01Icon }> = {
  read_file: { label: "Read", icon: File01Icon },
  list_directory: { label: "List", icon: FolderOpenIcon },
  write_file: { label: "Write", icon: FilePlusIcon },
  create_directory: { label: "Create dir", icon: FolderAddIcon },
  edit: { label: "Edit", icon: FileEditIcon },
  multi_edit: { label: "Edit", icon: Edit02Icon },
  bash_run: { label: "Run", icon: TerminalIcon },
  bash_background: { label: "Spawn", icon: TerminalIcon },
  bash_logs: { label: "Logs", icon: TerminalIcon },
  bash_list: { label: "Jobs", icon: TerminalIcon },
  bash_kill: { label: "Kill", icon: TerminalIcon },
  grep: { label: "Search", icon: GlobalSearchIcon },
  glob: { label: "Glob", icon: Folder01Icon },
  suggest_command: { label: "Suggest", icon: SparklesIcon },
  open_preview: { label: "Preview", icon: EyeIcon },
  run_subagent: { label: "Subagent", icon: RobotIcon },
  todo_write: { label: "Todos", icon: CheckListIcon },
  create_product_from_config: { label: "Saving Product Setup", icon: SparklesIcon },
  run_product_research: { label: "Running Product Research", icon: GlobalSearchIcon },
  save_strategy_plan: { label: "Saving Creative Direction", icon: FileEditIcon },
  build_strategy_json: { label: "Building Strategy", icon: ToolsIcon },
  set_autonomous_mode: { label: "Updating Autonomy", icon: ToolsIcon },
  get_lfs_plan: { label: "Checking Strategy Plan", icon: File01Icon },
  submit_lfs_job: { label: "Running LFS Batch", icon: ToolsIcon },
  advance_lfs_job: { label: "Continuing Batch", icon: ToolsIcon },
  resume_lfs_job: { label: "Continuing Batch", icon: ToolsIcon },
  get_lfs_job: { label: "Checking Progress", icon: ToolsIcon },
  list_lfs_artifacts: { label: "Opening Outputs", icon: File01Icon },
  read_lfs_artifact: { label: "Opening Output", icon: File01Icon },
  edit_lfs_artifact: { label: "Editing Output", icon: FileEditIcon },
  rerun_lfs_checks: { label: "Checking Output", icon: CheckListIcon },
  retry_lfs_failures: { label: "Repairing Batch", icon: ToolsIcon },
  export_lfs: { label: "Exporting Scripts", icon: File01Icon },
  cancel_lfs_job: { label: "Canceling Batch", icon: ToolsIcon },
};

function deriveSummary(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" ? (i[k] as string) : null;

  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit":
    case "multi_edit":
    case "create_directory":
    case "list_directory":
      return str("path");
    case "bash_run":
    case "bash_background":
      return str("command");
    case "bash_logs":
    case "bash_kill":
      return str("id");
    case "grep":
      return str("pattern") ?? str("query");
    case "glob":
      return str("pattern");
    case "suggest_command":
      return str("intent") ?? str("description");
    case "open_preview":
      return str("path") ?? str("url");
    case "run_subagent":
      return str("agent") ?? str("task");
    case "create_product_from_config":
      return str("product_folder") ?? "product setup";
    case "run_product_research":
      return str("topic") ?? "research";
    case "save_strategy_plan":
      return Array.isArray(i.ads) ? `${i.ads.length} ad${i.ads.length === 1 ? "" : "s"}` : "creative direction";
    case "build_strategy_json":
    case "set_autonomous_mode":
    case "get_lfs_plan":
    case "submit_lfs_job":
      return str("batch_id") ?? "bound batch";
    case "advance_lfs_job":
    case "resume_lfs_job":
    case "get_lfs_job":
    case "list_lfs_artifacts":
    case "rerun_lfs_checks":
    case "retry_lfs_failures":
    case "export_lfs":
    case "cancel_lfs_job":
      return str("batch_id") ?? "bound batch";
    case "read_lfs_artifact":
    case "edit_lfs_artifact":
      return str("artifact_id") ?? str("batch_id");
    case "todo_write": {
      const items = Array.isArray(i.todos) ? i.todos : null;
      return items
        ? `${items.length} item${items.length === 1 ? "" : "s"}`
        : null;
    }
    default:
      return null;
  }
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  toolName: string;
  state: ToolPart["state"];
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

// Tools whose `input` carries large/streaming content (file bodies, sub-
// agent prompts, todo lists). The AI diff tab is the canonical place to
// view file changes; for the rest, the header summary + final output is
// enough. Re-rendering streamed input on every token both stalls the UI
// and duplicates information.
const HEAVY_CONTENT_TOOLS = new Set([
  "write_file",
  "edit",
  "multi_edit",
  "run_subagent",
  "todo_write",
]);

const HEAVY_INPUT_TOOLS = new Set([
  ...HEAVY_CONTENT_TOOLS,
  "submit_lfs_job",
  "edit_lfs_artifact",
]);

const ToolImpl = ({
  className,
  toolName,
  state,
  input,
  output,
  errorText,
  defaultOpen,
  ...props
}: ToolProps) => {
  const meta = TOOL_META[toolName];
  const label = meta?.label ?? toolName;
  const inputSummary = deriveSummary(toolName, input);
  const isError = state === "output-error";
  const isWwx = isWwxTool(toolName);
  const toolState = getPromptKitToolState(toolName, state, output, errorText);
  const summary = isWwx ? null : (toolState.summary ?? inputSummary);
  const open = defaultOpen ?? (isError || (isWwx && output !== undefined));
  const hidesInput = HEAVY_INPUT_TOOLS.has(toolName) || isWwx;
  const hidesOutput = HEAVY_CONTENT_TOOLS.has(toolName);
  // Some tools carry large file bodies in input; the header plus compact output
  // is enough and avoids re-rendering streamed content on every token.
  const showInputBody = !hidesInput && Boolean(input);
  const showOutputBody = !hidesOutput && output !== undefined;
  const hasDetails =
    showInputBody || showOutputBody || Boolean(errorText);

  return (
    <PromptKitTool
      toolPart={{
        type: label,
        displayName: label,
        state: state as PromptKitToolPart["state"],
        input: isRecord(input) ? input : undefined,
        output: isRecord(output) ? output : undefined,
        errorText,
        summary,
        stateLabel: toolState.label,
        stateVariant: toolState.variant,
      }}
      defaultOpen={open}
      className={cn("group/tool not-prose w-full", className)}
      hasDetails={hasDetails}
      {...props}
    >
      {showInputBody ? <ToolInput toolName={toolName} input={input} /> : null}
      {showOutputBody || errorText ? (
        <ToolOutput
          toolName={toolName}
          output={showOutputBody ? output : undefined}
          errorText={errorText}
        />
      ) : null}
    </PromptKitTool>
  );
};

// For heavy tools, the only thing that should trigger a re-render is a
// state transition or the path summary changing — NOT every input-content
// token. We compare the cheap derived summary instead of the input ref.
export const Tool = memo(ToolImpl, (a, b) => {
  if (a.toolName !== b.toolName || a.state !== b.state) return false;
  if (a.errorText !== b.errorText) return false;
  if (a.output !== b.output) return false;
  if (a.className !== b.className) return false;
  if (HEAVY_INPUT_TOOLS.has(a.toolName)) {
    return deriveSummary(a.toolName, a.input) ===
      deriveSummary(b.toolName, b.input);
  }
  return a.input === b.input;
});

function getPromptKitToolState(
  toolName: string,
  state: ToolPart["state"],
  output: unknown,
  errorText?: string,
): { variant?: ToolStateVariant; label?: string; summary?: string | null } {
  if (errorText || state === "output-error") {
    return { variant: "error", label: "Error" };
  }

  if (isWwxTool(toolName) && output && typeof output === "object") {
    const data = output as Record<string, unknown>;
    const ui = readToolUi(data);
    const status = typeof data.status === "string" ? data.status : null;
    const awaitingReview =
      data.awaiting_review === true ||
      status === "awaiting_review" ||
      status === "held" ||
      status === "review";
    const retryable = data.retryable === true || ui?.retryable === true;
    const operatorNeeded =
      data.operator_needed === true || ui?.operator_needed === true;

    if (awaitingReview || ui?.tone === "warning") {
      return {
        variant: "review",
        label: retryable && !awaitingReview ? "Needs repair" : "Needs review",
      };
    }
    if (ui?.tone === "danger" || operatorNeeded || data.ok === false) {
      return { variant: "blocked", label: "Blocked" };
    }
    if (ui?.tone === "running") {
      return { variant: "running", label: "Processing" };
    }
    if (state === "output-available") {
      return { variant: "completed", label: "Completed" };
    }
  }

  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ToolInput({ toolName, input }: { toolName: string; input: unknown }) {
  if (input == null) return null;
  const preview = renderInputPreview(toolName, input);
  if (preview) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-muted-foreground">
          Input
        </div>
        {preview}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">Input</div>
      <CodeBlockMini
        code={
          typeof input === "string" ? input : JSON.stringify(input, null, 2)
        }
        language="json"
      />
    </div>
  );
}

function renderInputPreview(
  toolName: string,
  input: unknown,
): ReactNode | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" ? (i[k] as string) : null;

  if (toolName === "bash_run" || toolName === "bash_background") {
    const cmd = str("command");
    const cwd = str("cwd");
    if (!cmd) return null;
    return (
      <div className="space-y-1">
        {cwd ? (
          <div className="font-mono text-[10px] text-muted-foreground">
            {cwd}
          </div>
        ) : null}
        <pre className="overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
          {cmd}
        </pre>
      </div>
    );
  }
  if (
    toolName === "read_file" ||
    toolName === "list_directory" ||
    toolName === "create_directory" ||
    toolName === "open_preview"
  ) {
    const path = str("path") ?? str("url");
    if (!path) return null;
    return (
      <div className="font-mono text-[11px] text-muted-foreground">{path}</div>
    );
  }
  if (toolName === "grep") {
    const pat = str("pattern") ?? str("query");
    const path = str("path") ?? str("root");
    if (!pat) return null;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-foreground">{pat}</div>
        {path ? <div className="text-muted-foreground">{path}</div> : null}
      </div>
    );
  }
  return null;
}

function ToolOutput({
  toolName,
  output,
  errorText,
}: {
  toolName: string;
  output: unknown;
  errorText?: string;
}) {
  if (errorText) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-destructive">Error</div>
        <div className="rounded bg-destructive/10 px-2 py-1.5 font-mono text-[11px] text-destructive whitespace-pre-wrap">
          {errorText}
        </div>
      </div>
    );
  }
  if (output === undefined || output === null) return null;

  const custom = renderToolOutput(toolName, output);
  if (custom) return custom;

  let body: ReactNode;
  if (typeof output === "string") {
    body = <CodeBlockMini code={output} language="text" />;
  } else if (typeof output === "object" && !isValidElement(output)) {
    body = (
      <CodeBlockMini code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else {
    body = <div className="text-[12px]">{output as ReactNode}</div>;
  }

  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">
        Output
      </div>
      {body}
    </div>
  );
}

function renderToolOutput(toolName: string, output: unknown): ReactNode | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;

  if (toolName === "read_file") {
    const path = typeof o.path === "string" ? o.path : "";
    const size = typeof o.size === "number" ? o.size : null;
    const content = typeof o.content === "string" ? o.content : "";
    const lines = content ? content.split("\n").length : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">read</span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {lines != null ? (
          <span className="text-muted-foreground">
            ({lines} line{lines === 1 ? "" : "s"}
            {size != null ? `, ${formatBytes(size)}` : ""})
          </span>
        ) : null}
      </div>
    );
  }

  if (toolName === "list_directory") {
    const entries = Array.isArray(o.entries)
      ? (o.entries as Array<{ name: string; kind: string }>)
      : [];
    if (entries.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">empty</div>
      );
    }
    const dirs = entries.filter(
      (e) => e.kind === "directory" || e.kind === "dir",
    );
    const files = entries.filter(
      (e) => !(e.kind === "directory" || e.kind === "dir"),
    );
    return (
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {dirs.map((e) => (
          <div
            key={`d-${e.name}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={FolderOpenIcon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-foreground">{e.name}/</span>
          </div>
        ))}
        {files.map((e) => (
          <div
            key={`f-${e.name}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={File01Icon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-muted-foreground">{e.name}</span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "bash_run") {
    return <BashRunOutput data={o} />;
  }

  if (isWwxTool(toolName)) {
    return <WwxToolOutput data={o} />;
  }

  if (toolName === "suggest_command") {
    const cmd = typeof o.command === "string" ? o.command : null;
    const explanation =
      typeof o.explanation === "string" ? o.explanation : null;
    if (!cmd) return null;
    return <SuggestCommandCard command={cmd} explanation={explanation} />;
  }

  if (toolName === "grep") {
    const hits = Array.isArray(o.hits)
      ? (o.hits as Array<{
          rel?: string;
          path?: string;
          line: number;
          text: string;
        }>)
      : [];
    const pattern = typeof o.pattern === "string" ? o.pattern : null;
    const truncated = Boolean(o.truncated);
    const filesScanned =
      typeof o.files_scanned === "number" ? o.files_scanned : null;

    if (hits.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
          {filesScanned != null ? ` · ${filesScanned} files scanned` : ""}
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <div className="max-h-72 overflow-auto rounded bg-muted/30 font-mono text-[11px]">
          {hits.slice(0, 200).map((h, idx) => (
            <div
              key={`${h.rel ?? h.path}-${h.line}-${idx}`}
              className="flex gap-2 border-b border-border/30 px-2 py-1 last:border-b-0 hover:bg-muted/60"
            >
              <span className="shrink-0 text-muted-foreground">
                {h.rel ?? h.path}:{h.line}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {pattern ? highlightMatch(h.text, pattern) : h.text}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {hits.length} hit{hits.length === 1 ? "" : "s"}
            {filesScanned != null ? ` · ${filesScanned} files` : ""}
          </span>
          {truncated ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
              truncated
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (toolName === "glob") {
    const matches = Array.isArray(o.matches)
      ? (o.matches as string[])
      : Array.isArray(o.paths)
        ? (o.paths as string[])
        : [];
    if (matches.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
        </div>
      );
    }
    return (
      <div className="max-h-60 overflow-auto rounded bg-muted/30 px-2 py-1 font-mono text-[11px]">
        {matches.slice(0, 300).map((p) => (
          <div key={p} className="truncate text-muted-foreground">
            {p}
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "edit" || toolName === "multi_edit") {
    const ok = o.ok === true || typeof o.replacements === "number";
    if (ok) {
      const reps = typeof o.replacements === "number" ? o.replacements : null;
      const path = typeof o.path === "string" ? o.path : "";
      return (
        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          {reps != null ? (
            <span className="text-foreground">
              {reps} replacement{reps === 1 ? "" : "s"}
            </span>
          ) : null}
          {path ? (
            <span className="text-muted-foreground">· {path}</span>
          ) : null}
        </div>
      );
    }
  }

  if (toolName === "write_file" || toolName === "create_directory") {
    const path = typeof o.path === "string" ? o.path : "";
    const bytes = typeof o.bytesWritten === "number" ? o.bytesWritten : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">
          {toolName === "create_directory" ? "created" : "wrote"}
        </span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {bytes != null ? (
          <span className="text-muted-foreground">({formatBytes(bytes)})</span>
        ) : null}
      </div>
    );
  }

  if (toolName === "bash_background") {
    const handle = typeof o.handle === "string" ? o.handle : null;
    const cmd = typeof o.command === "string" ? o.command : "";
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {handle ? <span className="text-foreground">{handle}</span> : null}
          <span className="text-muted-foreground">running</span>
        </div>
        {cmd ? (
          <div className="truncate text-muted-foreground">{cmd}</div>
        ) : null}
      </div>
    );
  }

  return null;
}

function isWwxTool(toolName: string): boolean {
  return WWX_TOOL_NAMES.has(toolName);
}

const WWX_TOOL_NAMES = new Set([
  "create_product_from_config",
  "run_product_research",
  "save_strategy_plan",
  "build_strategy_json",
  "set_autonomous_mode",
  "get_lfs_plan",
  "submit_lfs_job",
  "advance_lfs_job",
  "resume_lfs_job",
  "get_lfs_job",
  "list_lfs_artifacts",
  "read_lfs_artifact",
  "edit_lfs_artifact",
  "rerun_lfs_checks",
  "retry_lfs_failures",
  "export_lfs",
  "cancel_lfs_job",
  "get_product_readiness",
  "enqueue_lfs_job",
  "list_lfs_queue",
]);

function WwxToolOutput({ data }: { data: Record<string, unknown> }) {
  const openPreview = useChatStore((s) => s.live.openPreview);
  const focusInput = useChatStore((s) => s.focusInput);
  const ui = readToolUi(data);
  const retryable = data.retryable === true;
  const action = ui?.primary_action?.kind === "wait" ? null : ui?.primary_action ?? null;
  const secondaryAction = ui?.secondary_action ?? null;
  const artifacts = Array.isArray(ui?.important_artifacts)
    ? ui.important_artifacts
    : Array.isArray(data.artifacts)
      ? (data.artifacts as Array<Record<string, unknown>>).filter(
          (artifact) => artifact.audience !== "technical",
        )
      : [];
  const diagnosticCount =
    typeof ui?.diagnostic_count === "number"
      ? ui.diagnostic_count
      : Array.isArray(data.artifacts)
        ? (data.artifacts as Array<Record<string, unknown>>).filter(
            (artifact) => artifact.audience === "technical",
          ).length
        : 0;
  const diagnosticArtifacts = Array.isArray(data.artifacts)
    ? (data.artifacts as Array<Record<string, unknown>>).filter(
        (artifact) => artifact.audience === "technical",
      )
    : [];

  return (
    <div className="space-y-2.5">
      {action ? (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className="rounded-md bg-foreground px-2.5 py-1.5 text-[11px] font-semibold text-background hover:opacity-90 active:scale-[0.98]"
            onClick={() => {
              if (action.prompt) void sendMessage(action.prompt);
              else focusInput(action.label);
            }}
          >
            {action.label}
          </button>
          {secondaryAction ? (
            <button
              type="button"
              className="rounded-md border border-border/70 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground active:scale-[0.98]"
              onClick={() => focusInput(secondaryAction.prompt ?? "")}
            >
              {secondaryAction.label}
            </button>
          ) : null}
        </div>
      ) : null}

      {artifacts.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[10px] font-medium text-muted-foreground">
            Important outputs
          </div>
          <div className="max-h-44 overflow-y-auto overflow-x-hidden rounded bg-muted/30 font-mono text-[11px]">
            {artifacts.slice(0, 8).map((artifact, idx) => {
              const label =
                typeof artifact.label === "string"
                  ? artifact.label
                  : typeof artifact.path === "string"
                    ? artifact.path
                    : `artifact ${idx + 1}`;
              const kind =
                typeof artifact.kind === "string" ? artifact.kind : null;
              const path =
                typeof artifact.path === "string" ? artifact.path : null;
              const size =
                typeof artifact.size === "number"
                  ? formatBytes(artifact.size)
                  : null;
              return (
                <div
                  key={`${label}-${idx}`}
                  className="flex gap-2 border-b border-border/30 px-2 py-1 last:border-b-0"
                >
                  {path ? (
                    <button
                      type="button"
                      onClick={() => openPreview(path)}
                      className="min-w-0 flex-1 truncate text-left text-foreground underline decoration-border underline-offset-2 hover:text-primary"
                      title={`Open ${label}`}
                    >
                      {label}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {label}
                    </span>
                  )}
                  {kind ? (
                    <span className="shrink-0 text-muted-foreground">
                      {kind}
                    </span>
                  ) : null}
                  {size ? (
                    <span className="shrink-0 text-muted-foreground">
                      {size}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {diagnosticCount > 0 ? (
        <Collapsible className="rounded-md border border-border/40 bg-background/20">
          <CollapsibleTrigger className="flex w-full items-center justify-between px-2 py-1.5 text-left text-[10px] font-medium text-muted-foreground hover:text-foreground">
            <span>Technical details hidden</span>
            <span>{diagnosticCount}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="max-h-40 overflow-y-auto border-t border-border/40 font-mono text-[10.5px]">
              {diagnosticArtifacts.map((artifact, index) => {
                const label =
                  typeof artifact.label === "string"
                    ? artifact.label
                    : typeof artifact.filename === "string"
                      ? artifact.filename
                      : `detail ${index + 1}`;
                const path =
                  typeof artifact.path === "string" ? artifact.path : null;
                return (
                  <div
                    key={`${label}-${index}`}
                    className="flex gap-2 border-b border-border/30 px-2 py-1 last:border-b-0"
                  >
                    {path ? (
                      <button
                        type="button"
                        onClick={() => openPreview(path)}
                        className="min-w-0 flex-1 truncate text-left text-muted-foreground underline decoration-border underline-offset-2 hover:text-primary"
                        title={`Open ${label}`}
                      >
                        {label}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {label}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {data.ok === false && retryable ? (
        <div className="text-[10px] text-muted-foreground">
          Repairable by the workflow. Operator input is only needed if the next step asks for missing truth.
        </div>
      ) : null}
    </div>
  );
}

type WwxToolUi = {
  headline?: string;
  summary?: string;
  tone?: "neutral" | "running" | "success" | "warning" | "danger";
  operator_needed?: boolean;
  retryable?: boolean;
  stage_label?: string;
  primary_action?: { kind?: string; label: string; prompt?: string };
  secondary_action?: { kind?: string; label: string; prompt?: string };
  important_artifacts?: Array<Record<string, unknown>>;
  diagnostic_count?: number;
};

function readToolUi(data: Record<string, unknown>): WwxToolUi | null {
  if (!data.ui || typeof data.ui !== "object") return null;
  return data.ui as WwxToolUi;
}

function BashRunOutput({ data }: { data: Record<string, unknown> }) {
  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const exit = typeof data.exit_code === "number" ? data.exit_code : null;
  const cwdAfter = typeof data.cwd_after === "string" ? data.cwd_after : null;
  const truncated = Boolean(data.truncated);
  const timedOut = Boolean(data.timed_out);

  const hasStdout = stdout.length > 0;
  const hasStderr = stderr.length > 0;
  const initial = hasStdout ? "stdout" : hasStderr ? "stderr" : "stdout";
  const [tab, setTab] = useState<"stdout" | "stderr">(initial);

  const tabs: Array<{
    key: "stdout" | "stderr";
    label: string;
    count: number;
  }> = [
    { key: "stdout", label: "stdout", count: stdout.length },
    { key: "stderr", label: "stderr", count: stderr.length },
  ];

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
              tab === t.key
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:text-foreground",
              t.count === 0 && "opacity-40",
            )}
            disabled={t.count === 0}
          >
            {t.label}
            {t.count > 0 ? (
              <span className="ml-1 text-muted-foreground">{t.count}</span>
            ) : null}
          </button>
        ))}
        <span className="flex-1" />
        {exit != null ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              exit === 0
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/15 text-destructive",
            )}
          >
            exit {exit}
          </span>
        ) : null}
        {timedOut ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            timed out
          </span>
        ) : null}
        {truncated ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            truncated
          </span>
        ) : null}
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {tab === "stdout" ? stdout || " " : stderr || " "}
      </pre>
      {cwdAfter ? (
        <div className="font-mono text-[10px] text-muted-foreground">
          cwd → {cwdAfter}
        </div>
      ) : null}
    </div>
  );
}

function highlightMatch(text: string, pattern: string): ReactNode {
  if (!pattern) return text;
  let re: RegExp;
  try {
    re = new RegExp(
      `(${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
  } catch {
    return text;
  }
  const parts = text.split(re);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-amber-500/30 px-0.5 text-foreground">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function CodeBlockMini({ code, language }: { code: string; language: string }) {
  return (
    <div className="overflow-hidden rounded bg-muted/40 [&_pre]:!bg-transparent [&_pre]:!p-2 [&_pre]:text-[11px] [&>div]:max-h-60">
      <CodeBlockContent code={code} language={language as BundledLanguage} />
    </div>
  );
}

function SuggestCommandCard({
  command,
  explanation,
}: {
  command: string;
  explanation: string | null;
}) {
  const [inserted, setInserted] = useState(false);
  const onInsert = () => {
    const ok = useChatStore
      .getState()
      .live.injectIntoActivePty(command);
    if (ok) setInserted(true);
  };
  return (
    <div className="space-y-1.5">
      {explanation ? (
        <div className="text-[11px] text-muted-foreground">{explanation}</div>
      ) : null}
      <div className="flex items-stretch gap-1.5 rounded bg-muted/40 overflow-hidden">
        <pre className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
          {command}
        </pre>
        <button
          type="button"
          onClick={onInsert}
          disabled={inserted}
          className={cn(
            "shrink-0 flex items-center gap-1 px-2.5 text-[11px] font-medium",
            "border-l border-border/60",
            "hover:bg-muted/80 active:bg-muted",
            "disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          aria-label="Insert into active terminal"
        >
          <HugeiconsIcon
            icon={inserted ? TerminalIcon : ArrowRight01Icon}
            size={12}
            strokeWidth={1.75}
          />
          <span>{inserted ? "Inserted" : "Insert"}</span>
        </button>
      </div>
    </div>
  );
}

// Compatibility re-exports — the previous API exposed these subcomponents,
// but the new compact <Tool /> takes everything via props. Kept as no-ops
// to avoid breaking accidental imports.
export const ToolHeader = () => null;
export const ToolContent = ({ children }: { children?: ReactNode }) => (
  <>{children}</>
);
export { ToolInput, ToolOutput };

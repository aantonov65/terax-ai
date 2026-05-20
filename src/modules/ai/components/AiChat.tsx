import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { Tool as RichTool } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
  ChainOfThoughtTrigger,
} from "@/components/ui/chain-of-thought";
import { HugeiconsIcon } from "@hugeicons/react";
import { SLASH_COMMANDS, TERAX_CMD_RE } from "../lib/slashCommands";
import {
  hasSuccessfulWwxToolResult,
  isRecoverableWwxFollowupError,
} from "../lib/wwxToolResult";
import { sendMessage } from "../store/chatStore";
import { DotMatrixLoader } from "@/components/ui/dot-matrix-loader";
import { ThinkingBar } from "@/components/ui/thinking-bar";
import { Tool as PromptKitTool } from "@/components/ui/tool";
import type {
  ChatStatus,
  DynamicToolUIPart,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from "ai";
import { memo, useCallback } from "react";
import { AiToolApproval } from "./AiToolApproval";

function CommandSnippet({ name }: { name: string }) {
  const meta = SLASH_COMMANDS[name];
  if (!meta) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1 font-mono text-[11px]">
        /{name}
      </div>
    );
  }
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/50 bg-muted/40 px-2 py-1">
      <HugeiconsIcon
        icon={meta.icon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0 text-foreground"
      />
      <span className="font-mono text-[11px] text-foreground">
        {meta.invocation}
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {meta.label}
      </span>
    </div>
  );
}

type AnyToolPart = ToolUIPart | DynamicToolUIPart;
type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;
const WWX_TOOL_NAMES = new Set([
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
]);

type ApprovalArg = {
  id: string;
  approved: boolean;
  reason?: string;
};

type Props = {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  clearError: () => void;
  addToolApprovalResponse: (arg: ApprovalArg) => void | PromiseLike<void>;
  stop: () => void | PromiseLike<void>;
};

export function AiChatView({
  messages,
  status,
  error,
  clearError,
  addToolApprovalResponse,
  stop,
}: Props) {
  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages[messages.length - 1];
  const showSpinner = isBusy && lastMessage?.role === "user";
  const hasWwxToolSuccess = hasSuccessfulWwxToolResult(messages);
  const recoverableWwxError =
    hasWwxToolSuccess && isRecoverableWwxFollowupError(error);

  const onApproval = useCallback(
    (id: string, approved: boolean) => addToolApprovalResponse({ id, approved }),
    [addToolApprovalResponse],
  );

  if (messages.length === 0) {
    return (
      <Conversation>
        <ConversationContent>
          <ConversationEmptyState
            title="Ask Terax anything"
            description="Explain command output, fix errors, generate snippets, or run a task."
          />
        </ConversationContent>
      </Conversation>
    );
  }

  return (
    <Conversation>
      <ConversationContent className="gap-5 p-3">
        {isBusy ? (
          <ThinkingBar
            text="Working"
            onStop={() => void stop()}
            stopLabel="Stop"
            className="sticky top-0 z-10 rounded-full border border-white/10 bg-[#17181b]/90 px-3 py-1.5 text-[11px] backdrop-blur"
          />
        ) : null}
        {messages.map((m) => (
          <RenderedMessage key={m.id} message={m} onApproval={onApproval} />
        ))}
        {showSpinner && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <DotMatrixLoader label="Thinking" />
          </div>
        )}
        {error && !recoverableWwxError && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <div className="font-medium">Something went wrong.</div>
            <div className="mt-0.5 leading-relaxed opacity-90">
              {error.message}
            </div>
            <button
              type="button"
              onClick={clearError}
              className="mt-1 underline opacity-80 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

const RenderedMessage = memo(function RenderedMessage({
  message,
  onApproval,
}: {
  message: UIMessage;
  onApproval: (id: string, approved: boolean) => void;
}) {
  if (message.role === "user") {
    const rawText = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");

    const cmdMatch = rawText.match(TERAX_CMD_RE);
    const commandName = cmdMatch?.[1] ?? null;
    const text = cmdMatch ? rawText.slice(cmdMatch[0].length) : rawText;

    return (
      <Message from="user">
        <MessageContent>
          {commandName ? <CommandSnippet name={commandName} /> : null}
          {text ? (
            <p className="whitespace-pre-wrap wrap-break-word">{text}</p>
          ) : null}
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message from={message.role}>
      <MessageContent>
        <div className="flex flex-col gap-3">
          {message.parts.map((part, i) => (
            <RenderedPart
              key={`${message.id}-${i}`}
              part={part as AnyPart}
              onApproval={onApproval}
            />
          ))}
        </div>
      </MessageContent>
    </Message>
  );
});

const RenderedPart = memo(function RenderedPart({
  part,
  onApproval,
}: {
  part: AnyPart;
  onApproval: (id: string, approved: boolean) => void;
}) {
  if (part.type === "text") {
    return (
      <MessageResponse>
        {(part as unknown as { text: string }).text}
      </MessageResponse>
    );
  }

  if (part.type === "reasoning") {
    return (
      <ChainOfThought>
        <ChainOfThoughtStep defaultOpen>
          <ChainOfThoughtTrigger className="text-[11px]">
            Reasoning
          </ChainOfThoughtTrigger>
          <ChainOfThoughtContent className="pl-1 text-[11.5px] leading-relaxed text-slate-400">
            <MessageResponse>{(part as unknown as { text: string }).text}</MessageResponse>
          </ChainOfThoughtContent>
        </ChainOfThoughtStep>
      </ChainOfThought>
    );
  }

  if (
    part.type === "dynamic-tool" ||
    (typeof part.type === "string" && part.type.startsWith("tool-"))
  ) {
    return (
      <RenderedTool
        part={part as unknown as AnyToolPart}
        onApproval={onApproval}
      />
    );
  }

  return null;
});

const RenderedTool = memo(function RenderedTool({
  part,
  onApproval,
}: {
  part: AnyToolPart;
  onApproval: (id: string, approved: boolean) => void;
}) {
  const toolName =
    part.type === "dynamic-tool"
      ? part.toolName
      : part.type.replace(/^tool-/, "");

  if (part.state === "approval-requested") {
    return (
      <AiToolApproval
        part={part as Extract<ToolUIPart, { state: "approval-requested" }>}
        toolName={toolName}
        onRespond={(approved) => onApproval(part.approval.id, approved)}
      />
    );
  }

  if (
    !WWX_TOOL_NAMES.has(toolName) &&
    (
      part.state === "input-streaming" ||
      part.state === "input-available" ||
      part.state === "output-available" ||
      part.state === "output-error"
    )
  ) {
    return (
      <PromptKitTool
        className="border-white/10 bg-[#17181b]/70"
        defaultOpen={part.state === "output-error"}
        toolPart={{
          type: toolName,
          state: part.state,
          input: part.input as Record<string, unknown> | undefined,
          output: "output" in part ? (part.output as Record<string, unknown> | undefined) : undefined,
          errorText: "errorText" in part ? part.errorText : undefined,
        }}
      />
    );
  }

  const output = "output" in part ? part.output : undefined;

  return (
    <div className="flex flex-col gap-2">
      <RichTool
        toolName={toolName}
        state={part.state}
        input={part.input}
        output={output}
        errorText={"errorText" in part ? part.errorText : undefined}
      />
      {WWX_TOOL_NAMES.has(toolName) ? (
        <WwxTerminalAction output={output} />
      ) : null}
    </div>
  );
});

function WwxTerminalAction({ output }: { output: unknown }) {
  if (!output || typeof output !== "object") return null;
  const data = output as Record<string, unknown>;
  const ui = data.ui && typeof data.ui === "object"
    ? (data.ui as {
        stage_label?: string;
        status_label?: string;
        primary_action?: WwxAction;
        secondary_action?: WwxAction;
      })
    : null;
  const primary = ui?.primary_action;
  const secondary = ui?.secondary_action;
  const status = typeof data.status === "string" ? data.status : null;
  const awaitingReview =
    data.awaiting_review === true ||
    status === "awaiting_review" ||
    status === "held";
  if (!awaitingReview || primary?.kind !== "continue") return null;

  const question = terminalActionQuestion(ui?.stage_label, primary);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-muted/50 px-3 py-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[12px] font-semibold text-foreground">
          {question}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          className="h-7 rounded-md bg-white px-2.5 text-[10.5px] font-medium text-slate-950 hover:bg-white/90"
          onClick={() => void sendAction(primary)}
        >
          {terminalActionLabel(primary)}
        </Button>
        {secondary ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 rounded-md px-2.5 text-[10.5px]"
            onClick={() => void sendAction(secondary)}
          >
            {terminalActionLabel(secondary)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

type WwxAction = {
  kind?: string;
  label?: string;
  prompt?: string;
};

async function sendAction(action: WwxAction) {
  if (!action.prompt) return;
  await sendMessage(action.prompt);
}

function terminalActionQuestion(stageLabel: string | undefined, action: WwxAction): string {
  const stage = stageLabel || "Stage";
  if (action.kind === "continue") return `${stage} completed. Continue to next stage?`;
  if (action.kind === "repair") return "Repair needed. Repair and continue?";
  if (action.kind === "provide_input") return "Input needed. Open agent?";
  if (action.kind === "review_final") return "Final ads completed. Review now?";
  if (action.kind === "export") return "Final ads completed. Export now?";
  if (action.kind === "build_strategy") return "Batch input plan saved. Prepare hidden inputs?";
  if (action.kind === "run_batch") return "Batch inputs ready. Create ads?";
  return action.label || "Continue?";
}

function terminalActionLabel(action: WwxAction): string {
  if (action.kind === "continue") return "Continue";
  if (action.kind === "open_agent") return "Wait";
  if (action.kind === "repair") return "Repair";
  if (action.kind === "provide_input") return "Open agent";
  if (action.kind === "review_final") return "Review";
  if (action.kind === "export") return "Export";
  if (action.kind === "build_strategy") return "Prepare";
  if (action.kind === "run_batch") return "Run";
  return action.label || "Continue";
}

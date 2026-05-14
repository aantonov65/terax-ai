import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import type { AgentTerminalTab } from "@/modules/tabs";
import { leafIds, type PaneNode } from "@/modules/terminal";
import { useChat, type UIMessage } from "@ai-sdk/react";
import {
  Cancel01Icon,
  File01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { getOrCreateChat, useChatStore } from "../store/chatStore";
import { AiChatView } from "./AiChat";
import { AiInputBarConnect } from "./AiInputBar";

type Props = {
  sessionId?: string;
  active: boolean;
  hasComposer: boolean;
  onAddApiKey: () => void;
  onSessionReady?: (sessionId: string) => void;
  createSessionWhenMissing?: boolean;
  initialPrompt?: string;
  batchPath?: string | null;
};

type StackProps = {
  tab: AgentTerminalTab;
  active: boolean;
  hasComposer: boolean;
  onFocusLeaf: (leafId: number) => void;
  onLeafSession: (leafId: number, sessionId: string) => void;
  onAddApiKey: () => void;
};

const CREATIVE_STRATEGIST_ID = "builtin:creative-strategist";

type UploadedTextFile = {
  id: string;
  name: string;
  mediaType: string;
  text: string;
  size: number;
  path?: string;
};

type MessagePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; url: string; filename?: string };

export function AgentTerminalStack({
  tab,
  active,
  hasComposer,
  onFocusLeaf,
  onLeafSession,
  onAddApiKey,
}: StackProps) {
  return (
    <AgentPaneTree
      node={tab.paneTree}
      tab={tab}
      active={active}
      hasComposer={hasComposer}
      onFocusLeaf={onFocusLeaf}
      onLeafSession={onLeafSession}
      onAddApiKey={onAddApiKey}
    />
  );
}

function AgentPaneTree({
  node,
  tab,
  active,
  hasComposer,
  onFocusLeaf,
  onLeafSession,
  onAddApiKey,
}: StackProps & { node: PaneNode }) {
  if (node.kind === "leaf") {
    const focused = tab.activeLeafId === node.id;
    return (
      <div
            className="relative h-full w-full border border-white/15 bg-[#1f2024]"
        onMouseDownCapture={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        onFocus={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
      >
        <AgentTerminal
          sessionId={tab.sessionsByLeaf[node.id]}
          active={active && focused}
          hasComposer={hasComposer}
          onAddApiKey={onAddApiKey}
          onSessionReady={(sessionId) => onLeafSession(node.id, sessionId)}
          createSessionWhenMissing={Object.keys(tab.sessionsByLeaf).length > 0}
        />
      </div>
    );
  }

  const childCount = leafIds(node).length;
  const balancedThreePane = childCount === 3 && node.dir === "row";

  return (
    <ResizablePanelGroup
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
    >
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 && <ResizableHandle className="bg-white/15" />}
          <ResizablePanel
            id={`agent-pane-${child.id}`}
            minSize={balancedThreePane ? "28%" : "18%"}
            defaultSize={balancedThreePane && index === 0 ? 50 : undefined}
          >
            <AgentPaneTree
              node={child}
              tab={tab}
              active={active}
              hasComposer={hasComposer}
              onFocusLeaf={onFocusLeaf}
              onLeafSession={onLeafSession}
              onAddApiKey={onAddApiKey}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}

export function AgentTerminal({
  sessionId: tabSessionId,
  active,
  hasComposer,
  onAddApiKey,
  onSessionReady,
  createSessionWhenMissing,
  initialPrompt,
  batchPath,
}: Props) {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const sessionId = tabSessionId ?? activeSessionId;
  const setActiveAgentId = useAgentsStore((s) => s.setActiveId);

  useEffect(() => {
    if (!active) return;
    setActiveAgentId(CREATIVE_STRATEGIST_ID);
    if (tabSessionId) {
      switchSession(tabSessionId);
      return;
    }
    if (createSessionWhenMissing) {
      const nextSessionId = newSession();
      onSessionReady?.(nextSessionId);
      switchSession(nextSessionId);
    }
  }, [
    active,
    createSessionWhenMissing,
    newSession,
    onSessionReady,
    setActiveAgentId,
    switchSession,
    tabSessionId,
  ]);

  useEffect(() => {
    if (!tabSessionId && activeSessionId) onSessionReady?.(activeSessionId);
  }, [activeSessionId, onSessionReady, tabSessionId]);

  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading Creative Strategist session...
      </div>
    );
  }

  if (!hasComposer) {
    return (
      <div className="flex h-full min-h-0 flex-col justify-end">
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Add an AI provider key to chat with the Creative Strategist agent.
        </div>
        <AiInputBarConnect onAdd={onAddApiKey} />
      </div>
    );
  }

  return (
    <AgentTerminalSession
      sessionId={sessionId}
      initialPrompt={initialPrompt}
      batchPath={batchPath}
    />
  );
}

function AgentTerminalSession({
  sessionId,
  initialPrompt,
  batchPath,
}: {
  sessionId: string;
  initialPrompt?: string;
  batchPath?: string | null;
}) {
  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({ chat });
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<UploadedTextFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isBusy =
    helpers.status === "submitted" || helpers.status === "streaming";

  const submit = () => {
    const text = value.trim();
    if ((!text && files.length === 0) || isBusy) return;
    const fileBlocks = files.map(
      (file) =>
        `<file name="${escapeAttr(file.name)}" mediaType="${escapeAttr(file.mediaType)}"${file.path ? ` path="${escapeAttr(file.path)}"` : ""}>\n${file.text}\n</file>`,
    );
    const composed = [...fileBlocks, text].filter(Boolean).join("\n\n");
    const parts: MessagePart[] = composed
      ? [{ type: "text", text: composed }]
      : [];
    setValue("");
    setFiles([]);
    void chat.sendMessage({ role: "user", parts } as Parameters<
      typeof chat.sendMessage
    >[0]);
  };

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const next: UploadedTextFile[] = [];
    for (const file of Array.from(list)) {
      if (!isTextUpload(file)) continue;
      const text = await file.text();
      const path = await materializeUploadedFile(file.name, text, batchPath);
      next.push({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        name: file.name,
        mediaType: file.type || guessMediaType(file.name),
        text,
        size: file.size,
        path,
      });
    }
    if (next.length) {
      setFiles((prev) => {
        const seen = new Set(prev.map((file) => file.id));
        return [...prev, ...next.filter((file) => !seen.has(file.id))];
      });
    }
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, [sessionId]);

  const appliedInitialPrompt = useRef<string | null>(null);
  useEffect(() => {
    if (!initialPrompt || appliedInitialPrompt.current === initialPrompt) return;
    appliedInitialPrompt.current = initialPrompt;
    setValue((current) => current || initialPrompt);
    inputRef.current?.focus();
  }, [initialPrompt]);

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-[#1f2024] text-slate-100",
        dragging && "ring-2 ring-emerald-300/70",
      )}
      onMouseDownCapture={(event) => {
        const target = event.target as HTMLElement | null;
        if (
          target?.closest("button, input, textarea, a, [role='button']")
        ) {
          return;
        }
        requestAnimationFrame(() => inputRef.current?.focus());
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return;
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void addFiles(event.dataTransfer.files);
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#1f2024] text-foreground [&_.text-sm]:text-[12px]">
        {helpers.messages.length > 0 ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <AiChatView
              messages={helpers.messages}
              status={helpers.status}
              error={helpers.error}
              clearError={helpers.clearError}
              addToolApprovalResponse={helpers.addToolApprovalResponse}
              stop={helpers.stop}
            />
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-white/15 bg-[#191a1e] px-3 py-2">
        <div className="px-0 py-0.5">
          {files.length ? (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {files.map((file) => (
                <div
                  key={file.id}
                  className="group flex items-center gap-1 border border-white/15 bg-[#202126] px-1.5 py-0.5 text-[11px]"
                  title={`${file.name} · ${file.path ?? `${file.size} bytes`}`}
                >
                  <HugeiconsIcon
                    icon={File01Icon}
                    size={11}
                    strokeWidth={1.8}
                    className="text-slate-400"
                  />
                  <span className="max-w-40 truncate">{file.name}</span>
                  <button
                    type="button"
                    className="text-slate-500 opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() =>
                      setFiles((prev) => prev.filter((f) => f.id !== file.id))
                    }
                    aria-label={`Remove ${file.name}`}
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      size={10}
                      strokeWidth={2}
                    />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.txt,.json,text/*,application/json"
            className="hidden"
            onChange={(event) => {
              void addFiles(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          <Button
            size="icon-xs"
            variant="ghost"
            className="rounded-none text-slate-300 hover:bg-white/10 hover:text-slate-50"
            disabled={isBusy}
            onClick={() => fileInputRef.current?.click()}
            title="Attach angle.md"
          >
            <HugeiconsIcon icon={File01Icon} size={16} strokeWidth={1.8} />
          </Button>
          <textarea
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            disabled={isBusy}
            placeholder="Create"
            className="max-h-28 min-h-8 flex-1 resize-none bg-transparent py-1 text-[13px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-500"
          />
          </div>
        </div>
      </div>
    </div>
  );
}

function isTextUpload(file: File): boolean {
  if (file.size > 200_000) return false;
  if (file.type.startsWith("text/")) return true;
  return /\.(md|txt|json|ya?ml|toml)$/i.test(file.name);
}

function guessMediaType(name: string): string {
  if (/\.json$/i.test(name)) return "application/json";
  if (/\.md$/i.test(name)) return "text/markdown";
  return "text/plain";
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

async function materializeUploadedFile(
  filename: string,
  text: string,
  boundBatchPath?: string | null,
): Promise<string | undefined> {
  void filename;
  void text;
  void boundBatchPath;
  return undefined;
}

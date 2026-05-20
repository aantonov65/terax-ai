import {
  FileUpload,
  FileUploadContent,
  FileUploadTrigger,
} from "@/components/ui/file-upload";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
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
import { invoke } from "@tauri-apps/api/core";
import {
  Cancel01Icon,
  File01Icon,
  Link02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ensureChatSeeded,
  flushPersist,
  getOrCreateChat,
  useChatStore,
} from "../store/chatStore";
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

type StoredArtifact = {
  id: string;
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
  const [seedReady, setSeedReady] = useState(false);

  useEffect(() => {
    let alive = true;
    setSeedReady(false);
    void ensureChatSeeded(sessionId).finally(() => {
      if (alive) setSeedReady(true);
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  if (!seedReady) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading chat history...
      </div>
    );
  }

  return (
    <AgentTerminalChat
      sessionId={sessionId}
      initialPrompt={initialPrompt}
      batchPath={batchPath}
    />
  );
}

function AgentTerminalChat({
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
  const persistMessages = useChatStore((s) => s.persistMessages);
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<UploadedTextFile[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const isBusy =
    helpers.status === "submitted" || helpers.status === "streaming";

  const resizeInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const shellHeight = shellRef.current?.clientHeight ?? window.innerHeight;
    const maxHeight = Math.max(72, Math.min(260, Math.floor(shellHeight * 0.38)));
    input.style.height = "0px";
    const nextHeight = Math.min(input.scrollHeight, maxHeight);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  const submit = () => {
    const text = value.trim();
    if ((!text && files.length === 0) || isBusy) return;
    const fileBlocks = files.map((file) =>
      file.path
        ? `<file name="${escapeAttr(file.name)}" mediaType="${escapeAttr(file.mediaType)}" path="${escapeAttr(file.path)}" />`
        : `<file name="${escapeAttr(file.name)}" mediaType="${escapeAttr(file.mediaType)}">\n${file.text}\n</file>`,
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

  const addFiles = async (list: FileList | File[] | null) => {
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

  useLayoutEffect(() => {
    resizeInput();
  }, [files.length, resizeInput, value]);

  useEffect(() => {
    window.addEventListener("resize", resizeInput);
    return () => window.removeEventListener("resize", resizeInput);
  }, [resizeInput]);

  useEffect(() => {
    persistMessages(sessionId, helpers.messages);
  }, [sessionId, helpers.messages, persistMessages]);

  useEffect(() => {
    if (helpers.status !== "submitted" && helpers.status !== "streaming") {
      flushPersist(sessionId);
    }
  }, [sessionId, helpers.status]);

  useEffect(() => {
    return () => flushPersist(sessionId);
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
      ref={shellRef}
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-[#1f2024] text-slate-100",
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

      <div className="shrink-0 border-t border-white/15 bg-[#17181b] px-3 py-2 focus-within:border-white/25">
        {files.length ? (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {files.map((file) => (
              <div
                key={file.id}
                className="group flex items-center gap-1 rounded-md border border-white/15 bg-[#202126] px-1.5 py-0.5 text-[11px]"
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
        <FileUpload
          onFilesAdded={(nextFiles) => void addFiles(nextFiles)}
          accept=".md,.txt,.json,text/*,application/json"
          disabled={isBusy}
        >
          <FileUploadContent className="bg-[#101114]/75">
            <div className="rounded-xl border border-white/15 bg-[#17181b] px-5 py-4 text-sm text-slate-200">
              Drop files to attach
            </div>
          </FileUploadContent>
          <InputGroup className="min-h-10 rounded-none border-0 bg-transparent">
            <InputGroupAddon align="inline-start" className="py-1 pl-0">
              <FileUploadTrigger asChild>
                <InputGroupButton
                  size="icon-sm"
                  variant="ghost"
                  className="rounded-none text-slate-300 hover:bg-transparent hover:text-slate-50 focus-visible:ring-0"
                  disabled={isBusy}
                  title="Attach file"
                >
                  <HugeiconsIcon icon={Link02Icon} size={20} strokeWidth={1.8} />
                </InputGroupButton>
              </FileUploadTrigger>
            </InputGroupAddon>
            <InputGroupTextarea
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
              className="min-h-9 py-1.5 text-[13px] leading-6 text-slate-100 placeholder:text-slate-500"
            />
          </InputGroup>
        </FileUpload>
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
  if (!boundBatchPath || !/\.md$/i.test(filename)) return undefined;
  const binding = useChatStore.getState().live.getWwxBinding?.() ?? null;
  if (!binding) return undefined;

  const artifact = await invoke<StoredArtifact>("wwx_write_artifact", {
    input: {
      productId: binding.productId,
      batchId: binding.batchId,
      kind: "angles",
      label: "Uploaded angle",
      filename: `uploads/${safeUploadName(filename)}`,
      mimeType: "text/markdown",
      contentText: text,
      source: "upload",
      public: false,
    },
  });
  return `app://wwx/artifacts/${artifact.id}`;
}

function safeUploadName(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop() || "angle.md";
  const safe = leaf.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "angle.md";
}

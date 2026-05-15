import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AgentTerminal,
  getAllKeys,
  hasAnyKey,
  useChatStore,
} from "@/modules/ai";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import { native } from "@/modules/ai/lib/native";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { useSnippetsStore } from "@/modules/ai/store/snippetsStore";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import { ThemeProvider } from "@/modules/theme";
import {
  CreateBatchDialog,
  CreateProductDialog,
  type ProductDraft,
} from "@/modules/wwx/WwxCreateDialogs";
import { createWwxBatch, createWwxProduct } from "@/modules/wwx/mutations";
import {
  useWwxIndex,
  WwxInspector,
  WwxSidebar,
  type AgentWindow,
  type BatchSummary,
  type ProductSummary,
} from "@/modules/wwx";
import {
  Cancel01Icon,
  Copy01Icon,
  LayoutLeftIcon,
  Settings01Icon,
  SidebarLeftIcon,
  SquareIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { homeDir } from "@tauri-apps/api/path";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

const WWX_WORKSPACE_STORAGE_KEY = "wwx.workspaceRoot";
const DEFAULT_WWX_WORKSPACE_ROOT = "/Users/aantonov1/boris/ww-2";
const CREATIVE_STRATEGIST_ID = "builtin:creative-strategist";

export default function App() {
  const [home, setHome] = useState<string | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(() => {
    if (typeof window === "undefined") return DEFAULT_WWX_WORKSPACE_ROOT;
    return (
      window.localStorage.getItem(WWX_WORKSPACE_STORAGE_KEY) ||
      DEFAULT_WWX_WORKSPACE_ROOT
    );
  });
  const effectiveWorkspaceRoot = workspaceRoot || home || DEFAULT_WWX_WORKSPACE_ROOT;
  const wwxIndex = useWwxIndex(effectiveWorkspaceRoot);

  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  const inspectorRef = useRef<PanelImperativeHandle | null>(null);
  const togglePanel = useCallback((ref: RefObject<PanelImperativeHandle | null>) => {
    const panel = ref.current;
    if (!panel) return;
    if (panel.getSize().asPercentage <= 0) panel.expand();
    else panel.collapse();
  }, []);

  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [selectedArtifactPath, setSelectedArtifactPath] = useState<string | null>(null);
  const [agentWindows, setAgentWindows] = useState<AgentWindow[]>([]);
  const [createProductOpen, setCreateProductOpen] = useState(false);
  const [batchDialogProduct, setBatchDialogProduct] =
    useState<ProductSummary | null>(null);
  const [batchDialogTitle, setBatchDialogTitle] = useState("Create Batch");
  const firstBatchProductRef = useRef<ProductSummary | null>(null);

  const apiKeys = useChatStore((s) => s.apiKeys);
  const setApiKeys = useChatStore((s) => s.setApiKeys);
  const setSelectedModelId = useChatStore((s) => s.setSelectedModelId);
  const setLive = useChatStore((s) => s.setLive);
  const hydrateSessions = useChatStore((s) => s.hydrateSessions);
  const hasComposer = hasAnyKey(apiKeys);

  useEffect(() => {
    homeDir()
      .then((path) => setHome(path.replace(/\\/g, "/")))
      .catch(() => setHome(null));
  }, []);

  useEffect(() => {
    let alive = true;
    const assertWwRoot = async () => {
      const root = (workspaceRoot || DEFAULT_WWX_WORKSPACE_ROOT).replace(/\/+$/, "");
      try {
        await native.readFile(`${root}/tools/ww`);
        return;
      } catch {
        if (root === DEFAULT_WWX_WORKSPACE_ROOT) return;
      }

      try {
        await native.readFile(`${DEFAULT_WWX_WORKSPACE_ROOT}/tools/ww`);
        if (alive) setWorkspaceRoot(DEFAULT_WWX_WORKSPACE_ROOT);
      } catch {
        // Keep the user's configured root if the bundled default is not available.
      }
    };
    void assertWwRoot();
    return () => {
      alive = false;
    };
  }, [workspaceRoot]);

  useEffect(() => {
    if (!effectiveWorkspaceRoot || typeof window === "undefined") return;
    window.localStorage.setItem(WWX_WORKSPACE_STORAGE_KEY, effectiveWorkspaceRoot);
  }, [effectiveWorkspaceRoot]);

  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getAllKeys().then((keys) => {
        if (alive) setApiKeys(keys);
      });
    };
    reload();
    const unlistenP = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, [setApiKeys]);

  const initPrefs = usePreferencesStore((s) => s.init);
  const prefDefaultModel = usePreferencesStore((s) => s.defaultModelId);
  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);
  useEffect(() => {
    if (prefsHydrated) setSelectedModelId(prefDefaultModel);
  }, [prefsHydrated, prefDefaultModel, setSelectedModelId]);

  useEffect(() => {
    void hydrateSessions();
    void useAgentsStore.getState().hydrate();
    void useSnippetsStore.getState().hydrate();
    useAgentsStore.getState().setActiveId(CREATIVE_STRATEGIST_ID);
  }, [hydrateSessions]);

  useEffect(() => {
    if (
      selectedBatchId &&
      wwxIndex.batches.some((batch) => batch.id === selectedBatchId)
    ) {
      return;
    }
    setSelectedBatchId(wwxIndex.batches[0]?.id ?? null);
  }, [selectedBatchId, wwxIndex.batches]);

  const activeWindow = agentWindows.find((window) => window.active) ?? null;
  const selectedBatch = useMemo(
    () => wwxIndex.batches.find((batch) => batch.id === selectedBatchId) ?? null,
    [selectedBatchId, wwxIndex.batches],
  );

  const productForBatch = useCallback(
    (batch: BatchSummary): ProductSummary | null =>
      wwxIndex.products.find((product) =>
        product.batches.some((item) => item.id === batch.id),
      ) ?? null,
    [wwxIndex.products],
  );

  const selectBatch = useCallback((batchId: string) => {
    setSelectedBatchId(batchId);
    setSelectedArtifactPath(null);
  }, []);

  const focusAgentWindow = useCallback((windowId: string) => {
    setAgentWindows((current) =>
      current.map((window) => ({ ...window, active: window.id === windowId })),
    );
    const window = agentWindows.find((item) => item.id === windowId);
    if (window) {
      setSelectedBatchId(window.batchId);
      useChatStore.getState().switchSession(window.sessionId);
      useAgentsStore.getState().setActiveId(CREATIVE_STRATEGIST_ID);
    }
  }, [agentWindows]);

  const ensureAgentWindowForBatch = useCallback(
    (batch: BatchSummary, seedPrompt?: string) => {
      const existing = agentWindows.find((window) => window.batchId === batch.id);
      if (existing) {
        setAgentWindows((current) =>
          current.map((window) => ({
            ...window,
            active: window.id === existing.id,
            seedPrompt: window.id === existing.id ? seedPrompt ?? window.seedPrompt : window.seedPrompt,
          })),
        );
        setSelectedBatchId(batch.id);
        useChatStore.getState().switchSession(existing.sessionId);
        useAgentsStore.getState().setActiveId(CREATIVE_STRATEGIST_ID);
        return existing.id;
      }

      const product = productForBatch(batch);
      const sessionId = useChatStore.getState().newSession();
      const next: AgentWindow = {
        id: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        productId: product?.id ?? batch.productCode ?? "legacy",
        productCode: product?.code ?? batch.productCode,
        batchId: batch.id,
        batchPath: batch.path,
        sessionId,
        active: true,
        createdAt: Date.now(),
        seedPrompt,
      };
      setAgentWindows((current) => [
        ...current.map((window) => ({ ...window, active: false })),
        next,
      ]);
      setSelectedBatchId(batch.id);
      useAgentsStore.getState().setActiveId(CREATIVE_STRATEGIST_ID);
      return next.id;
    },
    [agentWindows, productForBatch],
  );

  const closeAgentWindow = useCallback((windowId: string) => {
    setAgentWindows((current) => {
      const filtered = current.filter((window) => window.id !== windowId);
      if (filtered.some((window) => window.active) || filtered.length === 0) {
        return filtered;
      }
      const last = filtered[filtered.length - 1];
      setSelectedBatchId(last.batchId);
      useChatStore.getState().switchSession(last.sessionId);
      return filtered.map((window) => ({ ...window, active: window.id === last.id }));
    });
  }, []);

  const continueBatchInAgent = useCallback(
    (batch: BatchSummary) => {
      ensureAgentWindowForBatch(
        batch,
        `Continue this workflow for ${batch.id} from the current checkpoint.`,
      );
    },
    [ensureAgentWindowForBatch],
  );

  const handleCreateProduct = useCallback(
    async (draft: ProductDraft) => {
      const created = await createWwxProduct({
        workspaceRoot: effectiveWorkspaceRoot,
        productFolder: draft.productFolder,
        config: draft.config,
      });
      const product: ProductSummary = {
        id: created.productId,
        code: created.productCode,
        name: String(draft.config.product_name ?? created.productFolder),
        path: created.productPath,
        configPath: `${created.productPath}/config.json`,
        batchCount: 0,
        statusCounts: {
          draft: 0,
          ready: 0,
          running: 0,
          review: 0,
          complete: 0,
          blocked: 0,
          unknown: 0,
        },
        batches: [],
      };
      firstBatchProductRef.current = product;
      setBatchDialogProduct(product);
      setBatchDialogTitle("Create Your First Batch");
    },
    [effectiveWorkspaceRoot],
  );

  const handleCreateBatch = useCallback(
    async (batchName: string) => {
      const product = batchDialogProduct;
      if (!product) return;
      const created = await createWwxBatch({
        workspaceRoot: effectiveWorkspaceRoot,
        productFolder: product.id,
        batchName,
      });
      const batch: BatchSummary = {
        id: created.batchId,
        name: batchName,
        path: created.batchPath,
        product: product.name,
        productCode: product.code,
        productPath: product.path,
        status: "draft",
        batchMetaPath: created.metaPath,
        nextAction: "Start guided workflow for this batch.",
        artifacts: [
          {
            id: created.metaPath,
            batchId: created.batchId,
            label: "Batch Metadata",
            path: created.metaPath,
            kind: "json",
          },
        ],
        runs: [],
        alerts: [],
      };
      setSelectedBatchId(created.batchId);
      ensureAgentWindowForBatch(
        batch,
        `Start the guided workflow for ${created.batchId}. This agent window is tied to that batch.`,
      );
      firstBatchProductRef.current = null;
    },
    [batchDialogProduct, effectiveWorkspaceRoot, ensureAgentWindowForBatch],
  );

  const openBatchDialog = useCallback((product: ProductSummary) => {
    setBatchDialogProduct(product);
    setBatchDialogTitle("Create Batch");
  }, []);

  useEffect(() => {
    setLive({
      getCwd: () => effectiveWorkspaceRoot,
      getTerminalContext: () => null,
      isActiveTerminalPrivate: () => false,
      injectIntoActivePty: () => false,
      getWorkspaceRoot: () => effectiveWorkspaceRoot,
      getWwxBinding: () =>
        activeWindow
          ? {
              productId: activeWindow.productId,
              productCode: activeWindow.productCode,
              batchId: activeWindow.batchId,
              batchPath: activeWindow.batchPath,
            }
          : null,
      getActiveFile: () => null,
      openPreview: (path) => {
        const artifactBatch = wwxIndex.batches.find((batch) =>
          batch.artifacts.some((artifact) => artifact.path === path || artifact.id === path),
        );
        if (artifactBatch) setSelectedBatchId(artifactBatch.id);
        setSelectedArtifactPath(path);
        return true;
      },
    });
  }, [activeWindow, effectiveWorkspaceRoot, setLive, wwxIndex.batches]);

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        <div className="flex h-[100dvh] flex-col overflow-hidden bg-[#17181b] text-slate-100">
          <WwxHeader
            selectedBatch={selectedBatch}
            activeWindows={agentWindows.length}
            onToggleSidebar={() => togglePanel(sidebarRef)}
            onToggleInspector={() => togglePanel(inspectorRef)}
            onOpenSettings={() => void openSettingsWindow()}
          />

          <main className="min-h-0 flex-1">
            <ResizablePanelGroup
              orientation="horizontal"
              className="h-full min-h-0 bg-[#17181b]"
            >
              <ResizablePanel
                id="wwx-sidebar"
                panelRef={sidebarRef}
                defaultSize="252px"
                minSize="210px"
                maxSize="360px"
                collapsible
                collapsedSize={0}
                className="min-w-0 overflow-hidden border-r border-white/15 bg-[#101114]"
              >
                <WwxSidebar
                  index={wwxIndex}
                  selectedBatchId={selectedBatchId}
                  onSelectBatch={selectBatch}
                  onCreateProduct={() => setCreateProductOpen(true)}
                  onCreateBatch={openBatchDialog}
                  onOpenBatchAgent={ensureAgentWindowForBatch}
                />
              </ResizablePanel>
              <ResizableHandle withHandle className="bg-white/15" />
              <ResizablePanel
                id="agent-canvas"
                defaultSize="70%"
                minSize="42%"
                className="min-w-0 overflow-hidden bg-[#1a1b1f]"
              >
                <AgentCanvas
                  windows={agentWindows}
                  batches={wwxIndex.batches}
                  hasComposer={hasComposer}
                  onFocus={focusAgentWindow}
                  onClose={closeAgentWindow}
                  onAddApiKey={() => void openSettingsWindow("models")}
                />
              </ResizablePanel>
              <ResizableHandle withHandle className="bg-white/15" />
              <ResizablePanel
                id="wwx-inspector"
                panelRef={inspectorRef}
                defaultSize="290px"
                minSize="250px"
                maxSize="390px"
                collapsible
                collapsedSize={0}
                className="min-w-0 overflow-hidden border-l border-white/15 bg-[#101114]"
              >
                <WwxInspector
                  cwd={null}
                  index={wwxIndex}
                  selectedBatch={selectedBatch}
                  selectedArtifactPath={selectedArtifactPath}
                  onContinueInAgent={continueBatchInAgent}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

          <CreateProductDialog
            open={createProductOpen}
            onOpenChange={setCreateProductOpen}
            onCreate={handleCreateProduct}
          />
          <CreateBatchDialog
            open={Boolean(batchDialogProduct)}
            product={batchDialogProduct}
            title={batchDialogTitle}
            onOpenChange={(open) => {
              if (!open) {
                setBatchDialogProduct(null);
                firstBatchProductRef.current = null;
              }
            }}
            onCreate={handleCreateBatch}
          />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}

function WwxHeader({
  selectedBatch,
  activeWindows,
  onToggleSidebar,
  onToggleInspector,
  onOpenSettings,
}: {
  selectedBatch: BatchSummary | null;
  activeWindows: number;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-center gap-2 border-b border-white/15 bg-[#121316] px-2 select-none"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-none text-slate-400 hover:bg-white/10 hover:text-slate-100"
        onClick={onToggleSidebar}
        title="Toggle products"
      >
        <HugeiconsIcon icon={SidebarLeftIcon} size={17} strokeWidth={1.8} />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-2" data-tauri-drag-region>
        {selectedBatch ? (
          <span className="truncate text-[10.5px] text-slate-300">
            {selectedBatch.name}
          </span>
        ) : null}
        <span className="text-[10.5px] text-slate-500">
          {activeWindows} agent{activeWindows === 1 ? "" : "s"}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-none text-slate-400 hover:bg-white/10 hover:text-slate-100"
        onClick={onOpenSettings}
        title="Settings"
      >
        <HugeiconsIcon icon={Settings01Icon} size={15} strokeWidth={1.8} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-none text-slate-400 hover:bg-white/10 hover:text-slate-100"
        onClick={onToggleInspector}
        title="Toggle details"
      >
        <HugeiconsIcon
          icon={LayoutLeftIcon}
          size={15}
          strokeWidth={1.9}
          className="rotate-180"
        />
      </Button>
    </header>
  );
}

function AgentCanvas({
  windows,
  batches,
  hasComposer,
  onFocus,
  onClose,
  onAddApiKey,
}: {
  windows: AgentWindow[];
  batches: BatchSummary[];
  hasComposer: boolean;
  onFocus: (windowId: string) => void;
  onClose: (windowId: string) => void;
  onAddApiKey: () => void;
}) {
  const [maximizedWindowId, setMaximizedWindowId] = useState<string | null>(null);

  useEffect(() => {
    if (
      maximizedWindowId &&
      !windows.some((window) => window.id === maximizedWindowId)
    ) {
      setMaximizedWindowId(null);
    }
  }, [maximizedWindowId, windows]);

  if (windows.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-8">
        <div className="max-w-md border border-dashed border-white/20 bg-[#202126] p-6 text-center">
          <div className="text-sm font-medium">No batch agent is open</div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Create a product, create a batch, or right-click an existing batch
            and open it in an agent.
          </p>
        </div>
      </div>
    );
  }

  const visibleWindows = maximizedWindowId
    ? windows.filter((window) => window.id === maximizedWindowId)
    : windows;

  return (
    <div
      className={cn(
        "h-full min-h-0 overflow-hidden bg-[#17181b]",
        maximizedWindowId
          ? "grid grid-cols-1"
          : agentCanvasGridClass(visibleWindows.length),
      )}
    >
      {visibleWindows.map((window, index) => {
        const batch = batches.find((item) => item.path === window.batchPath);
        return (
          <section
            key={window.id}
            onMouseDownCapture={() => onFocus(window.id)}
            className={cn(
              "relative flex min-h-0 min-w-0 flex-col overflow-hidden border border-white/15 bg-[#1f2024] shadow-[0_0_0_1px_rgba(0,0,0,0.32)]",
              maximizedWindowId && "h-full min-h-0",
              visibleWindows.length !== 1 && !maximizedWindowId && "min-h-[300px]",
              visibleWindows.length === 3 && !maximizedWindowId && index === 0 && "xl:row-span-2",
              window.active && !maximizedWindowId && "border-white/20 bg-[#222328]",
            )}
          >
            {window.active ? (
              <div className="absolute left-0 top-0 h-0 w-0 border-r-[12px] border-t-[12px] border-r-transparent border-t-[#9ca3af]" />
            ) : null}
            <div className="relative flex h-8 shrink-0 items-center justify-end gap-1 border-b border-white/15 bg-[#111216] px-2">
              <div className="pointer-events-none absolute inset-x-12 text-center text-[11px] text-slate-400">
                <span className="block truncate leading-none">
                  {batch?.name ?? window.batchId}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                className="rounded-none text-slate-500 hover:bg-white/10 hover:text-slate-200"
                onClick={(event) => {
                  event.stopPropagation();
                  setMaximizedWindowId((current) =>
                    current === window.id ? null : window.id,
                  );
                }}
                title={maximizedWindowId === window.id ? "Restore terminal" : "Maximize terminal"}
              >
                <HugeiconsIcon
                  icon={maximizedWindowId === window.id ? Copy01Icon : SquareIcon}
                  size={12}
                  strokeWidth={2}
                />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="rounded-none text-slate-500 hover:bg-white/10 hover:text-slate-200"
                onClick={(event) => {
                  event.stopPropagation();
                  if (maximizedWindowId === window.id) setMaximizedWindowId(null);
                  onClose(window.id);
                }}
                title="Close agent"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <AgentTerminal
                sessionId={window.sessionId}
                active={window.active}
                hasComposer={hasComposer}
                onAddApiKey={onAddApiKey}
                initialPrompt={window.seedPrompt}
                batchPath={window.batchPath}
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}

function agentCanvasGridClass(count: number): string {
  if (count <= 1) return "grid grid-cols-1 grid-rows-1 gap-px";
  if (count === 2) return "grid grid-cols-1 grid-rows-2 gap-px xl:grid-cols-2 xl:grid-rows-1";
  if (count === 3) {
    return "grid grid-cols-1 auto-rows-fr gap-px xl:grid-cols-2 xl:grid-rows-2";
  }
  return "grid grid-cols-1 auto-rows-fr gap-px xl:grid-cols-2";
}

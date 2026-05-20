import { Button } from "@/components/ui/button";
import { DotmCircular3 } from "@/components/ui/dotm-circular-3";
import { MatrixRainIntro } from "@/components/ui/matrix-rain-intro";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { UploadArrowOutlineIcon } from "@/components/ui/upload-arrow-outline-icon";
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
import { getKey } from "@/modules/ai/lib/keyring";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { useSnippetsStore } from "@/modules/ai/store/snippetsStore";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import { ThemeProvider } from "@/modules/theme";
import {
  CreateBatchDialog,
  CreateProductDialog,
  ResearchPreviewDialog,
  RunResearchDialog,
  type ProductDraft,
  type ResearchDraft,
} from "@/modules/wwx/WwxCreateDialogs";
import {
  createWwxBatch,
  createWwxProduct,
} from "@/modules/wwx/mutations";
import {
  getWwxMe,
  hostedRuntimeConfigured,
  signInWithClerkPkce,
  type WwxMe,
} from "@/modules/wwx/auth";
import {
  shouldUseHostedRuntime,
  startHostedLfsRun,
  startHostedResearchRun,
  startHostedStrategyRun,
  syncHostedRun,
  waitForHostedRun,
} from "@/modules/wwx/hosted";
import {
  useWwxIndex,
  WwxInspector,
  WwxSidebar,
  readWwxArtifact,
  type AgentWindow,
  type BatchSummary,
  type ProductResearchJob,
  type ProductSummary,
} from "@/modules/wwx";
import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  LayoutLeftIcon,
  PlayIcon,
  Settings01Icon,
  SidebarLeftIcon,
  SquareIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { writeWwxArtifact } from "@/modules/wwx";
import { useGlobalShortcuts } from "@/modules/shortcuts";

const WWX_WORKSPACE_STORAGE_KEY = "wwx.workspaceRoot";
const DEFAULT_WWX_WORKSPACE_ROOT = "/Users/aantonov1/boris/ww-2";
const CREATIVE_STRATEGIST_ID = "builtin:creative-strategist";

type AppNotification = {
  id: string;
  productId: string;
  batchId?: string;
  title: string;
  body: string;
  tone: "success" | "error" | "warning";
  createdAt: number;
};

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
  const [researchDialogProduct, setResearchDialogProduct] =
    useState<ProductSummary | null>(null);
  const [researchPreviewProduct, setResearchPreviewProduct] =
    useState<ProductSummary | null>(null);
  const [researchJobs, setResearchJobs] = useState<Record<string, ProductResearchJob>>({});
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [hostedAuthState, setHostedAuthState] = useState<"checking" | "signed_out" | "signed_in">(
    hostedRuntimeConfigured() ? "checking" : "signed_out",
  );
  const [hostedUser, setHostedUser] = useState<WwxMe["user"] | null>(null);
  const [hostedAuthError, setHostedAuthError] = useState<string | null>(null);
  const [hostedAuthBusy, setHostedAuthBusy] = useState(false);
  const batchStatusRef = useRef<Record<string, BatchSummary["status"]>>({});
  const batchStatusBootedRef = useRef(false);
  const hostedSyncInFlightRef = useRef<Set<string>>(new Set());
  const [batchDialogTitle, setBatchDialogTitle] = useState("Create Batch");
  const hostedEnabled = hostedRuntimeConfigured();
  const hostedSignedIn = !hostedEnabled || hostedAuthState === "signed_in";

  const pushNotification = useCallback(
    (notification: Omit<AppNotification, "id" | "createdAt">) => {
      const key = `${notification.productId}:${notification.batchId ?? "product"}:${notification.title}`;
      const next: AppNotification = {
        ...notification,
        id: `${key}:${Date.now().toString(36)}`,
        createdAt: Date.now(),
      };
      setNotifications((current) => [
        next,
        ...current.filter(
          (item) =>
            `${item.productId}:${item.batchId ?? "product"}:${item.title}` !== key,
        ),
      ].slice(0, 8));
    },
    [],
  );

  const currentResearchDialogProduct = useMemo(
    () =>
      researchDialogProduct
        ? wwxIndex.products.find((product) => product.id === researchDialogProduct.id) ??
          researchDialogProduct
        : null,
    [researchDialogProduct, wwxIndex.products],
  );
  const currentResearchPreviewProduct = useMemo(
    () =>
      researchPreviewProduct
        ? wwxIndex.products.find((product) => product.id === researchPreviewProduct.id) ??
          researchPreviewProduct
        : null,
    [researchPreviewProduct, wwxIndex.products],
  );

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
    if (!hostedEnabled) {
      setHostedAuthState("signed_out");
      setHostedUser(null);
      return;
    }
    let alive = true;
    setHostedAuthState("checking");
    setHostedAuthError(null);
    void getWwxMe()
      .then((me) => {
        if (!alive) return;
        setHostedUser(me.user);
        setHostedAuthState("signed_in");
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setHostedUser(null);
        setHostedAuthState("signed_out");
        setHostedAuthError(error instanceof Error ? error.message : "Sign-in is required.");
      });
    return () => {
      alive = false;
    };
  }, [hostedEnabled]);

  useEffect(() => {
    if (selectedBatchId && !wwxIndex.batches.some((batch) => batch.id === selectedBatchId)) {
      setSelectedBatchId(null);
    }
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

  const handleHostedSignIn = useCallback(async () => {
    if (!hostedEnabled || hostedAuthBusy) return;
    setHostedAuthBusy(true);
    setHostedAuthError(null);
    try {
      await signInWithClerkPkce();
      const me = await getWwxMe();
      setHostedUser(me.user);
      setHostedAuthState("signed_in");
    } catch (error) {
      setHostedUser(null);
      setHostedAuthState("signed_out");
      setHostedAuthError(error instanceof Error ? error.message : "Sign-in failed.");
    } finally {
      setHostedAuthBusy(false);
    }
  }, [hostedAuthBusy, hostedEnabled]);

  useEffect(() => {
    const next: Record<string, BatchSummary["status"]> = {};
    for (const batch of wwxIndex.batches) {
      next[batch.id] = batch.status;
    }

    if (!batchStatusBootedRef.current) {
      batchStatusRef.current = next;
      batchStatusBootedRef.current = true;
      return;
    }

    for (const batch of wwxIndex.batches) {
      const previous = batchStatusRef.current[batch.id];
      if (!previous || previous === batch.status) continue;
      if (!["complete", "review", "blocked", "running"].includes(batch.status)) continue;
      const product = productForBatch(batch);
      const tone =
        batch.status === "blocked"
          ? "error"
          : batch.status === "review"
            ? "warning"
            : "success";
      const label =
        batch.status === "complete"
          ? "Batch complete"
          : batch.status === "running"
            ? "Batch running"
            : batch.status === "review"
              ? "Batch needs review"
              : "Batch blocked";
      pushNotification({
        productId: product?.id ?? batch.productId ?? "",
        batchId: batch.id,
        tone,
        title: label,
        body: batch.workflowState?.headline ?? batch.name,
      });
    }

    batchStatusRef.current = next;
  }, [productForBatch, pushNotification, wwxIndex.batches]);

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
      if (window.batchId) setSelectedBatchId(window.batchId);
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
      const fallbackProductId = batch.productPath?.startsWith("app://wwx/products/")
        ? batch.productPath.slice("app://wwx/products/".length)
        : batch.productCode ?? "legacy";
      const sessionId = stableBatchSessionId(batch.id);
      useChatStore.getState().ensureSession(sessionId, batch.name);
      const next: AgentWindow = {
        id: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        productId: product?.id ?? fallbackProductId,
        productCode: product?.code ?? batch.productCode,
        batchId: batch.id,
        batchPath: batch.path,
        sessionId,
        active: true,
        autonomous: batch.autonomous,
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
      if (last.batchId) setSelectedBatchId(last.batchId);
      useChatStore.getState().switchSession(last.sessionId);
      return filtered.map((window) => ({ ...window, active: window.id === last.id }));
    });
  }, []);

  const handleWwxBatchCreated = useCallback(
    (batch: {
      productId: string;
      productCode?: string;
      batchId: string;
      batchPath?: string;
      seedPrompt?: string;
    }) => {
      setAgentWindows((current) => {
        const active = current.find((window) => window.active);
        if (!active) return current;
        return current.map((window) =>
          window.id === active.id
            ? {
                ...window,
                productId: batch.productId,
                productCode: batch.productCode,
                batchId: batch.batchId,
                batchPath: batch.batchPath,
                seedPrompt: batch.seedPrompt ?? window.seedPrompt,
              }
            : window,
        );
      });
      setSelectedBatchId(batch.batchId);
    },
    [],
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
        rawConfig: draft.config,
        config: {
          brand: typeof draft.config.brand === "string" ? draft.config.brand : undefined,
          productName: typeof draft.config.product_name === "string" ? draft.config.product_name : undefined,
          price: typeof draft.config.price === "string" || typeof draft.config.price === "number" ? draft.config.price : undefined,
          guarantee: typeof draft.config.guarantee === "string" ? draft.config.guarantee : undefined,
          url: typeof draft.config.url === "string" ? draft.config.url : undefined,
          targetDemographic: draft.config.target_demographic,
        },
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
      setResearchDialogProduct(product);
    },
    [effectiveWorkspaceRoot],
  );

  const handleCreateBatch = useCallback(
    async ({ batchName, autonomous }: { batchName: string; autonomous: boolean }) => {
      const product = batchDialogProduct;
      if (!product) return;
      const created = await createWwxBatch({
        workspaceRoot: effectiveWorkspaceRoot,
        productFolder: product.id,
        batchName,
      });
      const batch: BatchSummary = {
        id: created.batchId,
        productId: product.id,
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
        autonomous,
      };
      await writeWwxArtifact({
        productId: product.id,
        batchId: created.batchId,
        kind: "json",
        label: "Batch Control",
        filename: "batch-control.json",
        mimeType: "application/json",
        contentText: JSON.stringify({ autonomous }, null, 2),
        source: "desktop",
        public: true,
      });
      setSelectedBatchId(created.batchId);
      ensureAgentWindowForBatch(
        batch,
        [
          `Start the drive-aligned workflow for ${created.batchId}.`,
          "This batch already inherits product truth; ask only for owner-authored creative direction:",
          "which ARCs, which A/B combinations, which mechanisms, which LFS formats, how many ads, and optional source swipes/notes.",
          autonomous
            ? "Autonomous mode is on: once the strategy plan validates, continue through strategy build and LFS execution until blocked."
            : "Autonomous mode is off: preview the creative direction and wait for me to run it.",
        ].join(" "),
      );
    },
    [batchDialogProduct, effectiveWorkspaceRoot, ensureAgentWindowForBatch],
  );

  const openBatchDialog = useCallback((product: ProductSummary) => {
    setBatchDialogProduct(product);
    setBatchDialogTitle("Create Batch");
  }, []);

  const openResearchDialog = useCallback((product: ProductSummary) => {
    setResearchDialogProduct(product);
  }, []);

  const openResearchPreview = useCallback((product: ProductSummary) => {
    setResearchPreviewProduct(product);
    setNotifications((current) =>
      current.filter((item) => item.productId !== product.id || item.batchId),
    );
  }, []);

  const handleRunResearch = useCallback(
    async ({ topic }: ResearchDraft) => {
      const product = researchDialogProduct;
      if (!product) return;
      if (researchJobs[product.id]?.status === "running") return;

      const startedAt = Date.now();
      setResearchJobs((current) => ({
        ...current,
        [product.id]: {
          productId: product.id,
          topic,
          status: "running",
          startedAt,
        },
      }));
      pushNotification({
        productId: product.id,
        tone: "success",
        title: "Research started",
        body: `${product.name} is running in the background.`,
      });

      void (async () => {
        try {
          if (shouldUseHostedRuntime()) {
            const run = await startHostedResearchRun({ product, topic });
            setHostedAuthState("signed_in");
            await waitForHostedRun(run.id);
          } else {
          const result = await invoke<{
            ok: boolean;
            productId: string;
            productCode: string;
            runFolder: string;
            artifacts: unknown[];
          }>("wwx_run_research_pipeline", {
            input: {
              productId: product.id,
              topic,
              anthropicApiKey: await getKey("anthropic"),
            },
          });
          if (!result.ok) throw new Error("Research pipeline failed.");
          }
          setResearchJobs((current) => ({
            ...current,
            [product.id]: {
              productId: product.id,
              topic,
              status: "complete",
              startedAt,
              finishedAt: Date.now(),
            },
          }));
          pushNotification({
            productId: product.id,
            tone: "success",
            title: "Research complete",
            body: `${product.name} research is ready. Click to preview.`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setResearchJobs((current) => ({
            ...current,
            [product.id]: {
              productId: product.id,
              topic,
              status: "blocked",
              startedAt,
              finishedAt: Date.now(),
              error: message,
            },
          }));
          pushNotification({
            productId: product.id,
            tone: "error",
            title: "Research blocked",
            body: message,
          });
        }
      })();
    },
    [pushNotification, researchDialogProduct, researchJobs],
  );

  useEffect(() => {
    if (!shouldUseHostedRuntime()) return;
    const syncRunning = () => {
      for (const batch of wwxIndex.batches) {
        if (batch.status !== "running") continue;
        const runId = batch.runs[0]?.id;
        if (!runId || runId.startsWith("run-")) continue;
        const product = productForBatch(batch);
        if (!product || hostedSyncInFlightRef.current.has(runId)) continue;
        hostedSyncInFlightRef.current.add(runId);
        void syncHostedRun({ product, batch, runId })
          .catch(() => undefined)
          .finally(() => {
            hostedSyncInFlightRef.current.delete(runId);
          });
      }
    };
    syncRunning();
    const interval = window.setInterval(syncRunning, 4_000);
    return () => window.clearInterval(interval);
  }, [productForBatch, wwxIndex.batches]);

  const handleRunBatch = useCallback(async (batch: BatchSummary) => {
    const product = productForBatch(batch);
    if (!product) return;
    if (shouldUseHostedRuntime()) {
      try {
        const run = await startHostedLfsRun({ product, batch });
        setHostedAuthState("signed_in");
        pushNotification({
          productId: product.id,
          batchId: batch.id,
          tone: "success",
          title: "Batch running",
          body: `${batch.name} started on the hosted runtime.`,
        });
        void syncHostedRun({ product, batch, runId: run.id }).catch(() => undefined);
      } catch (error) {
        pushNotification({
          productId: product.id,
          batchId: batch.id,
          tone: "error",
          title: "Batch blocked",
          body: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    await invoke("wwx_start_lfs_job", {
      input: {
        productId: product.id,
        batchId: batch.id,
        runMode: "full",
        anthropicApiKey: await getKey("anthropic"),
      },
    });
  }, [productForBatch, pushNotification]);

  const handleBuildStrategy = useCallback(async (batch: BatchSummary) => {
    const product = productForBatch(batch);
    if (!product) return;
    const planArtifact = batch.artifacts.find(
      (artifact) => artifact.filename === "strategy-plan.json",
    );
    if (!planArtifact) {
      throw new Error("Upload or save strategy-plan.json before building strategy.json.");
    }
    const plan = await readWwxArtifact(planArtifact.id);
    if (shouldUseHostedRuntime()) {
      const run = await startHostedStrategyRun({
        product,
        batch,
        strategyPlanJson: plan.contentText ?? "",
      });
      setHostedAuthState("signed_in");
      pushNotification({
        productId: product.id,
        batchId: batch.id,
        tone: "success",
        title: "Strategy running",
        body: `${batch.name} strategy build started on the hosted runtime.`,
      });
      void waitForHostedRun(run.id)
        .then(() => {
          pushNotification({
            productId: product.id,
            batchId: batch.id,
            tone: "success",
            title: "Strategy complete",
            body: `${batch.name} strategy.json is ready on the hosted runtime.`,
          });
        })
        .catch((error) => {
          pushNotification({
            productId: product.id,
            batchId: batch.id,
            tone: "error",
            title: "Strategy blocked",
            body: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    await invoke("wwx_build_strategy", {
      input: {
        productId: product.id,
        batchId: batch.id,
        strategyPlanJson: plan.contentText ?? "",
      },
    });
  }, [productForBatch, pushNotification]);

  const setBatchAutonomous = useCallback(
    async (batch: Pick<BatchSummary, "id" | "productId">, autonomous: boolean) => {
      if (!batch.productId) return;
      await writeWwxArtifact({
        productId: batch.productId,
        batchId: batch.id,
        kind: "json",
        label: "Batch Control",
        filename: "batch-control.json",
        mimeType: "application/json",
        contentText: JSON.stringify({ autonomous }, null, 2),
        source: "desktop",
        public: true,
      });
      setAgentWindows((current) =>
        current.map((item) =>
          item.batchId === batch.id ? { ...item, autonomous } : item,
        ),
      );
    },
    [],
  );

  const setWindowAutonomous = useCallback(
    async (windowId: string, autonomous: boolean) => {
      const window = agentWindows.find((item) => item.id === windowId);
      if (!window?.batchId || !window.productId) return;
      await setBatchAutonomous(
        { id: window.batchId, productId: window.productId },
        autonomous,
      );
    },
    [agentWindows, setBatchAutonomous],
  );

  useGlobalShortcuts({
    "lfs.toggleAutonomy": () => {
      if (!activeWindow?.batchId) return;
      void setWindowAutonomous(activeWindow.id, !activeWindow.autonomous);
    },
  });

  useEffect(() => {
    setLive({
      getCwd: () => effectiveWorkspaceRoot,
      getTerminalContext: () => null,
      isActiveTerminalPrivate: () => false,
      injectIntoActivePty: () => false,
      getWorkspaceRoot: () => effectiveWorkspaceRoot,
      getWwxBinding: () =>
        activeWindow?.productId && activeWindow.batchId
          ? {
              productId: activeWindow.productId,
              productCode: activeWindow.productCode,
              batchId: activeWindow.batchId,
              batchPath: activeWindow.batchPath,
            }
          : null,
      onWwxBatchCreated: handleWwxBatchCreated,
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
  }, [activeWindow, effectiveWorkspaceRoot, handleWwxBatchCreated, setLive, wwxIndex.batches]);

  const shell = hostedEnabled && hostedAuthState !== "signed_in" ? (
    <HostedSignInGate
      busy={hostedAuthBusy || hostedAuthState === "checking"}
      error={hostedAuthError}
      onSignIn={() => void handleHostedSignIn()}
    />
  ) : (
    <ThemeProvider>
      <TooltipProvider>
        <div className="flex h-[100dvh] flex-col overflow-hidden bg-[#17181b] text-slate-100">
          <WwxHeader
            selectedBatch={selectedBatch}
            activeWindows={agentWindows.length}
            hostedEnabled={false}
            hostedSignedIn={hostedSignedIn}
            hostedUserEmail={hostedUser?.email ?? null}
            hostedAuthBusy={hostedAuthBusy}
            onHostedSignIn={() => void handleHostedSignIn()}
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
                  onOpenResearchPreview={openResearchPreview}
                  onOpenBatchAgent={ensureAgentWindowForBatch}
                  researchJobs={researchJobs}
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
                  onOpenDiagnostics={(batch) => {
                    setSelectedBatchId(batch.id);
                    inspectorRef.current?.expand();
                  }}
                  onToggleAutonomy={(window) =>
                    void setWindowAutonomous(window.id, !window.autonomous)
                  }
                  onAddApiKey={() => void openSettingsWindow("models")}
                />
              </ResizablePanel>
              {selectedBatch ? (
                <>
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
                      selectedBatch={selectedBatch}
                      selectedArtifactPath={selectedArtifactPath}
                      onBuildStrategy={(batch) => void handleBuildStrategy(batch)}
                      onRunBatch={(batch) => void handleRunBatch(batch)}
                      onToggleAutonomy={(batch) =>
                        void setBatchAutonomous(batch, !batch.autonomous)
                      }
                    />
                  </ResizablePanel>
                </>
              ) : null}
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
              if (!open) setBatchDialogProduct(null);
            }}
            onCreate={handleCreateBatch}
          />
          <RunResearchDialog
            open={Boolean(currentResearchDialogProduct)}
            product={currentResearchDialogProduct}
            running={Boolean(
              currentResearchDialogProduct &&
                researchJobs[currentResearchDialogProduct.id]?.status === "running",
            )}
            onOpenChange={(open) => {
              if (!open) setResearchDialogProduct(null);
            }}
            onRun={handleRunResearch}
          />
          <ResearchPreviewDialog
            open={Boolean(currentResearchPreviewProduct)}
            product={currentResearchPreviewProduct}
            onOpenChange={(open) => {
              if (!open) setResearchPreviewProduct(null);
            }}
            onRunResearch={openResearchDialog}
          />
          {notifications.length ? (
            <div className="fixed right-4 top-4 z-50 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-2">
              {notifications.slice(0, 4).map((notification) => (
                <div
                  key={notification.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (notification.batchId) {
                      setSelectedBatchId(notification.batchId);
                      setSelectedArtifactPath(null);
                      inspectorRef.current?.expand();
                      setNotifications((current) =>
                        current.filter((item) => item.id !== notification.id),
                      );
                      return;
                    }
                    const product = wwxIndex.products.find(
                      (item) => item.id === notification.productId,
                    );
                    if (product) openResearchPreview(product);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.currentTarget.click();
                    }
                  }}
                  className={cn(
                    "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-xl border bg-[#f8fafc] px-3.5 py-2.5 text-left text-slate-900 shadow-xl outline-none ring-0",
                    notification.tone === "error"
                      ? "border-red-200"
                      : notification.tone === "warning"
                        ? "border-amber-200"
                        : "border-slate-200",
                  )}
                >
                  <HugeiconsIcon
                    icon={
                      notification.tone === "error"
                        ? Alert02Icon
                        : CheckmarkCircle02Icon
                    }
                    size={20}
                    strokeWidth={2}
                    className={cn(
                      "mt-0.5 shrink-0",
                      notification.tone === "error"
                        ? "text-red-600"
                        : notification.tone === "warning"
                          ? "text-amber-600"
                          : "text-emerald-600",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">
                      {notification.body}
                    </span>
                    <span
                      className={cn(
                        "mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
                        notification.tone === "error"
                          ? "bg-red-100 text-red-700"
                          : notification.tone === "warning"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-emerald-100 text-emerald-700",
                      )}
                    >
                      {notification.title.replace(/^Research /, "").replace(/^Batch /, "")}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="rounded-md p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-900"
                    onClick={(event) => {
                      event.stopPropagation();
                      setNotifications((current) =>
                        current.filter((item) => item.id !== notification.id),
                      );
                    }}
                    aria-label="Dismiss notification"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <MatrixRainIntro />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}

function HostedSignInGate({
  busy,
  error,
  onSignIn,
}: {
  busy: boolean;
  error: string | null;
  onSignIn: () => void;
}) {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <div className="flex h-[100dvh] items-center justify-center bg-[#111216] px-6 text-slate-100">
          <div className="w-full max-w-sm border border-white/15 bg-[#1b1c20] p-6 shadow-2xl">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center border border-white/15 bg-[#101114]">
                <span className="text-xs font-semibold tracking-[0.18em] text-slate-200">WWW</span>
              </div>
              <div className="min-w-0">
                <h1 className="text-sm font-semibold text-slate-100">Sign in required</h1>
                <p className="mt-1 text-xs text-slate-400">Use your invited wwworkbench account to continue.</p>
              </div>
            </div>
            {error ? (
              <div className="mb-4 border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
                {error}
              </div>
            ) : null}
            <Button
              className="w-full rounded-md"
              disabled={busy}
              onClick={onSignIn}
            >
              {busy ? <DotmCircular3 /> : null}
              {busy ? "Checking session" : "Sign in"}
            </Button>
          </div>
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}

function stableBatchSessionId(batchId: string): string {
  return `wwx-batch:${batchId}`;
}

function WwxHeader({
  selectedBatch,
  activeWindows,
  hostedEnabled,
  hostedSignedIn,
  hostedUserEmail,
  hostedAuthBusy,
  onHostedSignIn,
  onToggleSidebar,
  onToggleInspector,
  onOpenSettings,
}: {
  selectedBatch: BatchSummary | null;
  activeWindows: number;
  hostedEnabled: boolean;
  hostedSignedIn: boolean;
  hostedUserEmail: string | null;
  hostedAuthBusy: boolean;
  onHostedSignIn: () => void;
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
        className="rounded-md text-slate-400 hover:bg-white/10 hover:text-slate-100"
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
      {hostedEnabled ? (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 rounded-md px-2 text-[11px] hover:bg-white/10",
            hostedSignedIn ? "text-emerald-200" : "text-amber-200",
            hostedSignedIn ? "cursor-default hover:bg-transparent" : "",
          )}
          disabled={hostedAuthBusy}
          onClick={hostedSignedIn ? undefined : onHostedSignIn}
          title={hostedSignedIn ? hostedUserEmail ?? "Hosted runtime connected" : "Sign in to hosted runtime"}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              hostedSignedIn ? "bg-emerald-300" : "bg-amber-300",
            )}
          />
          {hostedSignedIn ? null : "Sign in"}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-md text-slate-400 hover:bg-white/10 hover:text-slate-100"
        onClick={onOpenSettings}
        title="Settings"
      >
        <HugeiconsIcon icon={Settings01Icon} size={15} strokeWidth={1.8} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-md text-slate-400 hover:bg-white/10 hover:text-slate-100"
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
  onOpenDiagnostics,
  onToggleAutonomy,
  onAddApiKey,
}: {
  windows: AgentWindow[];
  batches: BatchSummary[];
  hasComposer: boolean;
  onFocus: (windowId: string) => void;
  onClose: (windowId: string) => void;
  onOpenDiagnostics: (batch: BatchSummary) => void;
  onToggleAutonomy: (window: AgentWindow) => void;
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
          <div className="text-sm font-medium">Open an agent terminal to start.</div>
        </div>
      </div>
    );
  }

  const visibleWindows = maximizedWindowId
    ? windows.filter((window) => window.id === maximizedWindowId)
    : windows;
  const gridStyle = maximizedWindowId
    ? undefined
    : agentCanvasGridStyle(visibleWindows.length);

  return (
    <div
      className={cn(
        "grid h-full min-h-0 overflow-hidden bg-[#17181b]",
        maximizedWindowId ? "grid-cols-1" : "gap-px",
      )}
      style={gridStyle}
    >
      {visibleWindows.map((window) => {
        const batch = window.batchPath
          ? batches.find((item) => item.path === window.batchPath)
          : null;
        return (
          <section
            key={window.id}
            onMouseDownCapture={() => onFocus(window.id)}
            className={cn(
              "relative flex min-h-0 min-w-0 flex-col overflow-hidden border border-white/15 bg-[#1f2024] shadow-[0_0_0_1px_rgba(0,0,0,0.32)]",
              maximizedWindowId && "h-full min-h-0",
              visibleWindows.length > 1 &&
                visibleWindows.length <= 4 &&
                !maximizedWindowId &&
                "min-h-[240px]",
              window.active && !maximizedWindowId && "border-white/20 bg-[#222328]",
            )}
          >
            {window.active ? (
              <div className="absolute left-0 top-0 h-0 w-0 border-r-[12px] border-t-[12px] border-r-transparent border-t-[#9ca3af]" />
            ) : null}
            <div className="grid h-8 shrink-0 grid-cols-[104px_minmax(0,1fr)_104px] items-center border-b border-white/15 bg-[#111216] px-2">
              <div className="z-10 min-w-0">
                {batch ? (
                  <WorkflowStatusPill
                    batch={batch}
                    onClick={() => onOpenDiagnostics(batch)}
                  />
                ) : null}
              </div>
              <div className="pointer-events-none min-w-0 text-center text-[11px] text-slate-400">
                <span className="block min-w-0 truncate leading-none">
                  {batch?.name ?? window.batchId ?? "New product intake"}
                </span>
              </div>
              <div className="relative z-10 flex shrink-0 items-center justify-end gap-1">
                {window.batchId ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      "rounded-md hover:bg-white/10",
                      window.autonomous ? "text-emerald-300" : "text-slate-500 hover:text-slate-200",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleAutonomy(window);
                    }}
                    title={`Autonomous mode ${window.autonomous ? "on" : "off"} (⌘⇧A / Ctrl+Shift+A)`}
                  >
                    <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={2} />
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-md text-slate-500 hover:bg-white/10 hover:text-slate-200"
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
                  className="rounded-md text-slate-500 hover:bg-white/10 hover:text-slate-200"
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

function WorkflowStatusPill({
  batch,
  onClick,
}: {
  batch: BatchSummary;
  onClick: () => void;
}) {
  const latest = batch.runs[0];
  const workflow = batch.workflowState;
  const state =
    workflow?.tone === "success" || batch.finalScripts?.length
      ? "final complete"
      : workflow?.tone === "danger" || batch.status === "blocked"
        ? "blocked"
        : workflow?.tone === "running" || batch.status === "running"
          ? "running"
          : workflow?.tone === "warning" || batch.status === "review"
            ? "needs review"
            : workflow?.primaryAction?.kind === "run_batch"
              ? "ready to run"
              : workflow?.primaryAction?.kind === "build_strategy"
                ? "strategy"
                : "pending";
  const tone = {
    pending: "border-slate-500/40 bg-transparent text-slate-300",
    running: "border-sky-400/40 bg-transparent text-sky-200",
    strategy: "border-emerald-400/40 bg-transparent text-emerald-200",
    "needs review": "border-amber-400/40 bg-transparent text-amber-200",
    blocked: "border-red-400/40 bg-transparent text-red-200",
    "ready to run": "border-sky-400/40 bg-transparent text-sky-100",
    "final complete": "border-emerald-300/50 bg-transparent text-emerald-100",
  }[state];
  const label =
    state === "pending"
      ? "Input"
      : state === "running"
        ? workflow?.stageLabel ?? (latest?.stage ? latest.stage.split(/[/:]/)[0] : "Run")
        : state === "strategy"
          ? "Plan"
          : state === "needs review"
            ? "Review"
            : state === "blocked"
              ? "Blocked"
              : state === "ready to run"
                ? "Ready"
                : "Done";
  const icon =
    state === "blocked"
        ? Cancel01Icon
        : state === "needs review"
          ? Alert02Icon
          : state === "pending"
            ? null
            : CheckmarkCircle02Icon;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn("flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px]", tone)}
      title="Open batch diagnostics"
    >
      {state === "running" ? (
        <DotmCircular3
          size={13}
          dotSize={2}
          color="currentColor"
          ariaLabel="Workflow running"
        />
      ) : (
        icon ? (
          <HugeiconsIcon icon={icon} size={11} strokeWidth={2} />
        ) : (
          <UploadArrowOutlineIcon size={11} className="shrink-0" />
        )
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

function agentCanvasGridStyle(count: number): CSSProperties {
  if (count <= 1) {
    return {
      gridTemplateColumns: "minmax(0, 1fr)",
      gridTemplateRows: "minmax(0, 1fr)",
    };
  }

  const viewportWide =
    typeof window !== "undefined" ? window.innerWidth >= 1280 : true;
  const columns = viewportWide
    ? Math.max(2, Math.ceil(Math.sqrt(count)))
    : count <= 3
      ? 1
      : 2;
  const rows = Math.ceil(count / columns);

  return {
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
  };
}

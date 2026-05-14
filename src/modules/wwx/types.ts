export type WorkspaceSummary = {
  id: string;
  name: string;
  rootPath: string;
  visibility: "account" | "private-local" | "shared";
  scopeLabel: string;
};

export type BatchStatus =
  | "draft"
  | "ready"
  | "running"
  | "review"
  | "complete"
  | "blocked"
  | "unknown";

export type BatchDecisionCounts = {
  ship: number;
  review: number;
  fail: number;
};

export type ArtifactKind =
  | "angles"
  | "strategy"
  | "manifest"
  | "report"
  | "heartbeat"
  | "image"
  | "log"
  | "markdown"
  | "json"
  | "csv"
  | "upload"
  | "directory"
  | "other";

export type ArtifactSummary = {
  id: string;
  batchId: string;
  label: string;
  path: string;
  kind: ArtifactKind;
  content?: string;
  dataUrl?: string;
  source?: "account" | "local";
  description?: string;
  size?: number;
  mtime?: number;
};

export type RunStatus = "running" | "complete" | "blocked" | "idle" | "unknown";

export type RunSummary = {
  id: string;
  batchId: string;
  label: string;
  status: RunStatus;
  stage?: string;
  lastEvent?: string;
  heartbeatPath?: string;
  updatedAt?: number;
};

export type ProductConfigSummary = {
  brand?: string;
  productName?: string;
  price?: string | number;
  guarantee?: string;
  url?: string;
  targetDemographic?: unknown;
};

export type DraftBatchMetadata = {
  schema: "wwx-batch/v1";
  product_folder: string;
  batch_id: string;
  batch_name: string;
  created_at: string;
  status: "draft";
};

export type BatchSummary = {
  id: string;
  name: string;
  path: string;
  product?: string;
  productCode?: string;
  productPath?: string;
  legacy?: boolean;
  format?: string;
  status: BatchStatus;
  updatedAt?: number;
  totalScripts?: number;
  decisionCounts?: BatchDecisionCounts;
  batchMetaPath?: string;
  agentRunPath?: string;
  eventsPath?: string;
  nextAction?: string;
  strategyPath?: string;
  manifestPath?: string;
  reportPath?: string;
  artifacts: ArtifactSummary[];
  runs: RunSummary[];
  alerts: string[];
};

export type ProductSummary = {
  id: string;
  code: string;
  name: string;
  path: string;
  configPath?: string;
  config?: ProductConfigSummary;
  batchCount: number;
  statusCounts: Record<BatchStatus, number>;
  updatedAt?: number;
  batches: BatchSummary[];
};

export type AgentWindow = {
  id: string;
  productId: string;
  productCode?: string;
  batchId: string;
  batchPath: string;
  sessionId: string;
  active: boolean;
  createdAt: number;
  seedPrompt?: string;
};

export type CommandRecipe = {
  id: string;
  label: string;
  description: string;
  command: string;
  batchMode?:
    | "compile-angles"
    | "run-lfs-images"
    | "lfs-v41"
    | "status"
    | "imagebatch"
    | "open-artifacts";
  requiresBatch?: boolean;
};

export type WwxIndexState = {
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  workspace: WorkspaceSummary | null;
  products: ProductSummary[];
  batches: BatchSummary[];
  refreshedAt: number | null;
};

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
  filename?: string;
  path: string;
  kind: ArtifactKind;
  visibilityClass?: "public_final" | "public_asset_input" | "public_summary" | "technical_hidden" | "engine_secret" | string;
  contentSha256?: string;
  content?: string;
  dataUrl?: string;
  source?: "account" | "local" | "hosted";
  description?: string;
  size?: number;
  mtime?: number;
};

export type RunStatus = "running" | "complete" | "review" | "blocked" | "idle" | "unknown";

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

export type StageSummary = {
  stage: string;
  status: string;
  approved: boolean;
  artifactCount: number;
  label?: string;
  summary?: string;
};

export type FinalScriptSummary = {
  taskId: string;
  script: string;
  decision: "ship" | "review" | "fail" | string;
  semanticReason?: string;
};

export type WorkflowTone = "neutral" | "running" | "success" | "warning" | "danger";

export type WorkflowActionKind =
  | "add_direction"
  | "build_strategy"
  | "run_batch"
  | "continue"
  | "repair"
  | "provide_input"
  | "review_final"
  | "export"
  | "open_agent"
  | "wait";

export type WorkflowAction = {
  kind: WorkflowActionKind;
  label: string;
  prompt?: string;
};

export type WorkflowState = {
  status: BatchStatus;
  statusLabel: string;
  stage?: string;
  stageLabel?: string;
  headline: string;
  summary: string;
  tone: WorkflowTone;
  operatorNeeded: boolean;
  retryable: boolean;
  failureKind?: string;
  reason?: string;
  primaryAction?: WorkflowAction;
  secondaryAction?: WorkflowAction;
  importantArtifactIds?: string[];
  diagnosticArtifactIds?: string[];
};

export type ProductConfigSummary = {
  brand?: string;
  productName?: string;
  price?: string | number;
  guarantee?: string;
  url?: string;
  targetDemographic?: unknown;
  readiness?: {
    status?: "draft" | "starter_only" | "needs_evidence" | "production_ready";
    approved?: boolean;
    gaps?: string[];
  };
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
  productId?: string;
  name: string;
  path: string;
  product?: string;
  productCode?: string;
  productPath?: string;
  legacy?: boolean;
  format?: string;
  status: BatchStatus;
  currentStage?: string;
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
  stageTimeline?: StageSummary[];
  finalScripts?: FinalScriptSummary[];
  alerts: string[];
  autonomous?: boolean;
  workflowState?: WorkflowState;
};

export type ProductSummary = {
  id: string;
  code: string;
  name: string;
  path: string;
  configPath?: string;
  config?: ProductConfigSummary;
  rawConfig?: Record<string, unknown>;
  researchArtifactCount?: number;
  researchArtifactUpdatedAt?: number | null;
  researchRuns?: ResearchRunSummary[];
  batchCount: number;
  statusCounts: Record<BatchStatus, number>;
  updatedAt?: number;
  batches: BatchSummary[];
};

export type ProductResearchJob = {
  productId: string;
  topic: string;
  status: "running" | "complete" | "blocked";
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export type ResearchRunSummary = {
  id: string;
  productId: string;
  topicSlug: string;
  topic: string;
  searchTermsJson: string;
  runFolder: string;
  status: string;
  qualityJson: string;
  createdAt: number;
  updatedAt: number;
};

export type AgentWindow = {
  id: string;
  productId?: string;
  productCode?: string;
  batchId?: string;
  batchPath?: string;
  sessionId: string;
  active: boolean;
  autonomous?: boolean;
  createdAt: number;
  seedPrompt?: string;
};

export type CommandRecipe = {
  id: string;
  label: string;
  description: string;
  command: string;
  batchMode?:
    | "create_ads"
    | "get_batch_status"
    | "get_asset_inputs"
    | "analyze_ads"
    | "export_handoff_package";
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

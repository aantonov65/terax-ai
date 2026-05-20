export type VisibilityClass =
  | "public_final"
  | "public_asset_input"
  | "public_summary"
  | "technical_hidden"
  | "engine_secret";

export type RunStatus = "queued" | "running" | "stopped" | "complete" | "failed";
export type JobStatus = "queued" | "running" | "complete" | "failed" | "dead_letter" | "stopped";
export type WorkItemStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";

export type EventType =
  | "run_started"
  | "stage_started"
  | "work_item_started"
  | "artifact_published"
  | "stage_completed"
  | "run_stopped"
  | "run_resumed"
  | "run_failed"
  | "run_completed";

export type Product = {
  id: string;
  workspaceId: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type ResearchRun = {
  id: string;
  workspaceId: string;
  productId: string;
  topic: string;
  topicSlug: string;
  searchTerms: string[];
  status: "queued" | "running" | "complete" | "failed";
  quality: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type Batch = {
  id: string;
  workspaceId: string;
  productId: string;
  name: string;
  status: RunStatus;
  currentStage: string | null;
  requestedAdCount: number;
  createdAt: number;
  updatedAt: number;
};

export type BatchRun = {
  id: string;
  workspaceId: string;
  batchId: string;
  status: RunStatus;
  currentStage: string | null;
  startedAt: number;
  finishedAt: number | null;
  heartbeatAt: number;
};

export type StageState = {
  id: string;
  workspaceId: string;
  batchId: string;
  runId: string;
  stage: string;
  status: WorkItemStatus;
  expectedItems: number;
  completedItems: number;
  updatedAt: number;
};

export type StageWorkItem = {
  id: string;
  workspaceId: string;
  batchId: string;
  runId: string;
  stage: string;
  itemKey: string;
  status: WorkItemStatus;
  artifactId: string | null;
  idempotencyKey: string;
  updatedAt: number;
};

export type Artifact = {
  id: string;
  workspaceId: string;
  batchId: string;
  filename: string;
  label: string;
  mimeType: string;
  visibilityClass: VisibilityClass;
  objectKey: string;
  contentSha256: string;
  size: number;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type RunEvent = {
  id: string;
  workspaceId: string;
  batchId: string;
  runId: string | null;
  type: EventType;
  stage: string | null;
  message: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

export type QueueJob = {
  id: string;
  workspaceId: string;
  batchId: string;
  type: "create_ads" | "continue_batch" | "research_run";
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  runId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type BatchStatus = {
  batch: Batch;
  run: BatchRun | null;
  stages: StageState[];
  workItems: StageWorkItem[];
  artifacts: Artifact[];
};

export type CreateAdsInput = {
  productId: string;
  batchId?: string;
  batchName?: string;
  adCount: number;
  selectedResearchRunIds?: string[];
  formats?: string[];
  constraints?: string[];
  swipes?: string[];
  assetNeeds?: string[];
  launchNotes?: string;
  strategyJson?: Record<string, unknown> | string;
  strategyPath?: string;
  anglesMarkdown?: string;
  runMode?: "app_step" | "full";
  workers?: number;
  generationWorkers?: number;
  fromStage?: string;
};

export type ResearchWorkflowInput = {
  productId: string;
  productCode?: string;
  productName?: string;
  configJson?: Record<string, unknown> | string;
  topic: string;
  searchTerms?: string[];
};

export type StrategyWorkflowInput = {
  productId: string;
  batchId: string;
  productCode?: string;
  productName?: string;
  configJson?: Record<string, unknown> | string;
  strategyPlanJson: Record<string, unknown> | string;
  researchFiles?: {
    archetypes?: string;
    hotwords?: string;
    mechanisms?: string;
  };
  force?: boolean;
};

export type EngineWorkItem = {
  stage: string;
  itemKey: string;
  filename: string;
  label: string;
  visibilityClass: VisibilityClass;
  mimeType: string;
  content: string;
};

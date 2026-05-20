import type {
  ArtifactSummary,
  BatchStatus,
  WorkflowAction,
  WorkflowState,
  WorkflowTone,
} from "./types";

export const STAGE_LABELS: Record<string, string> = {
  compile_input: "Preparing batch",
  research_cards: "Checking research",
  lfs_brief: "Building briefs",
  lfs_outline: "Writing outlines",
  preflight_v41: "Checking readiness",
  batch_generation: "Generating scripts",
  materialize_v41_candidates: "Preparing candidates",
  objective_finish_pre_semantic: "Checking structure",
  semantic_launchable: "Checking launchability",
  objective_finish_final: "Final structure check",
  semantic_final_check: "Final quality check",
  manifest_overview: "Preparing final ads",
  strategy_plan: "Creative direction",
  strategy: "Strategy",
  resume: "Continuing batch",
};

const STAGE_SUMMARIES: Record<string, string> = {
  compile_input: "The batch input is being normalized.",
  research_cards: "Product research is being checked before ad work starts.",
  lfs_brief: "The system is turning direction into briefs for the batch.",
  lfs_outline: "The system is shaping the ad outlines.",
  preflight_v41: "The batch is being checked before script generation.",
  batch_generation: "Scripts are being generated.",
  materialize_v41_candidates: "Generated scripts are being prepared for review.",
  objective_finish_pre_semantic: "Scripts are being checked for structure and required pieces.",
  semantic_launchable: "Scripts are being checked for launchability.",
  objective_finish_final: "The final script set is being checked.",
  semantic_final_check: "The final script set is getting a last quality pass.",
  manifest_overview: "The final ad decisions are being prepared.",
  strategy_plan: "Creative direction has been saved for this batch.",
  strategy: "The batch strategy is ready to run.",
};

export type ArtifactGroupKey = "final_ads" | "strategy" | "summary" | "technical";

export type ArtifactGroup = {
  key: ArtifactGroupKey;
  label: string;
  artifacts: ArtifactSummary[];
};

export function friendlyStageLabel(stage?: string | null): string {
  if (!stage) return "Workflow";
  return STAGE_LABELS[stage] ?? titleize(stage);
}

export function stageSummary(stage?: string | null): string {
  if (!stage) return "The workflow is ready for the next step.";
  return STAGE_SUMMARIES[stage] ?? `${friendlyStageLabel(stage)} is the current step.`;
}

export function artifactAudience(artifact: Pick<ArtifactSummary, "filename" | "label"> & { kind?: string }): ArtifactGroupKey {
  const filename = (artifact.filename || artifact.label || "").replace(/^\/+/, "");
  if (/^output-v41\/.+\.md$/i.test(filename) || /^output\/.+\.md$/i.test(filename)) {
    return "final_ads";
  }
  if (
    filename === "strategy-plan.json" ||
    filename === "strategy.json" ||
    filename === "source-angle.md" ||
    filename === "angles.md"
  ) {
    return "strategy";
  }
  if (
    filename === "lfs-v41-manifest.json" ||
    filename === "lfs-v41-report.json" ||
    filename === "strategy-plan-validation.json" ||
    filename === "lfs-brief-report.json" ||
    filename === "lfs-outline-report.json" ||
    filename === "lfs-v41-finish-report.json" ||
    filename === "lfs-semantic-report.json" ||
    filename === "report.json"
  ) {
    return "summary";
  }
  return "technical";
}

export function groupArtifacts(artifacts: ArtifactSummary[]): ArtifactGroup[] {
  const groups: ArtifactGroup[] = [
    { key: "final_ads", label: "Final Ads", artifacts: [] },
    { key: "strategy", label: "Strategy", artifacts: [] },
    { key: "summary", label: "Run Summary", artifacts: [] },
    { key: "technical", label: "Technical Details", artifacts: [] },
  ];
  const byKey = new Map(groups.map((group) => [group.key, group]));
  for (const artifact of artifacts) {
    byKey.get(artifactAudience(artifact))?.artifacts.push(artifact);
  }
  return groups.filter((group) => group.artifacts.length > 0);
}

export function importantArtifactIds(artifacts: ArtifactSummary[]): string[] {
  return artifacts
    .filter((artifact) => artifactAudience(artifact) !== "technical")
    .map((artifact) => artifact.id);
}

export function diagnosticArtifactIds(artifacts: ArtifactSummary[]): string[] {
  return artifacts
    .filter((artifact) => artifactAudience(artifact) === "technical")
    .map((artifact) => artifact.id);
}

export function actionForKind(kind: WorkflowAction["kind"], autonomous = false): WorkflowAction {
  switch (kind) {
    case "add_direction":
      return {
        kind,
        label: "Add creative direction",
        prompt: "Help me structure creative direction for this batch.",
      };
    case "build_strategy":
      return { kind, label: "Build Strategy" };
    case "run_batch":
      return { kind, label: autonomous ? "Run autonomously" : "Run Batch" };
    case "continue":
      return {
        kind,
        label: "Continue to next stage",
        prompt: "Continue to the next LFS stage for this batch.",
      };
    case "repair":
      return {
        kind,
        label: "Repair and continue",
        prompt: "Repair the current batch issue and continue from the earliest safe stage.",
      };
    case "provide_input":
      return {
        kind,
        label: "Provide missing input",
        prompt: "Tell me exactly what input is missing for this batch.",
      };
    case "review_final":
      return {
        kind,
        label: "Review final ads",
        prompt: "Show me the final ads and call out what is ship-ready versus needs review.",
      };
    case "export":
      return {
        kind,
        label: "Export ship-ready ads",
        prompt: "Export the ship-ready scripts for handoff.",
      };
    case "open_agent":
      return {
        kind,
        label: "Open agent",
        prompt: "Open this batch in the Creative Strategist agent.",
      };
    case "wait":
      return { kind, label: "Running" };
  }
}

export function deriveWorkflowState(batch: {
  status: BatchStatus;
  currentStage?: string | null;
  stage?: string | null;
  artifacts: ArtifactSummary[];
  finalScripts?: unknown[];
  autonomous?: boolean;
  nextAction?: string;
  workflowState?: WorkflowState;
}): WorkflowState {
  if (batch.workflowState) {
    return {
      ...batch.workflowState,
      importantArtifactIds:
        batch.workflowState.importantArtifactIds?.length
          ? batch.workflowState.importantArtifactIds
          : importantArtifactIds(batch.artifacts),
      diagnosticArtifactIds:
        batch.workflowState.diagnosticArtifactIds?.length
          ? batch.workflowState.diagnosticArtifactIds
          : diagnosticArtifactIds(batch.artifacts),
    };
  }

  const hasStrategyPlan = batch.artifacts.some((artifact) => artifact.filename === "strategy-plan.json");
  const hasStrategy = batch.artifacts.some((artifact) => artifact.filename === "strategy.json");
  const hasFinalAds = Boolean(batch.finalScripts?.length) ||
    batch.artifacts.some((artifact) => artifactAudience(artifact) === "final_ads");
  const stage = batch.currentStage ?? batch.stage ?? undefined;
  const stageLabel = friendlyStageLabel(stage);
  const base = {
    status: batch.status,
    statusLabel: statusLabel(batch.status),
    stage,
    stageLabel,
    operatorNeeded: false,
    retryable: false,
    importantArtifactIds: importantArtifactIds(batch.artifacts),
    diagnosticArtifactIds: diagnosticArtifactIds(batch.artifacts),
  };

  if (batch.status === "complete" || hasFinalAds) {
    return {
      ...base,
      headline: "Final ads are ready",
      summary: "Review the ship, review, and fail decisions before upload.",
      tone: "success",
      primaryAction: actionForKind("review_final", batch.autonomous),
      secondaryAction: actionForKind("export", batch.autonomous),
    };
  }
  if (batch.status === "review") {
    return {
      ...base,
      headline: `${stageLabel} is ready. Continue to next stage?`,
      summary: "Skim the checkpoint, then continue when it looks right.",
      tone: "warning",
      primaryAction: actionForKind("continue", batch.autonomous),
      secondaryAction: {
        kind: "open_agent",
        label: "Ask / Hold",
        prompt: "I want to ask a question before continuing this batch.",
      },
    };
  }
  if (batch.status === "blocked") {
    return {
      ...base,
      headline: "Batch needs attention",
      summary: batch.nextAction || "Open the Creative Strategist to see the exact blocker.",
      tone: "danger",
      operatorNeeded: true,
      primaryAction: actionForKind("provide_input", batch.autonomous),
      secondaryAction: actionForKind("open_agent", batch.autonomous),
    };
  }
  if (batch.status === "running") {
    return {
      ...base,
      headline: `${stageLabel} is running`,
      summary: stageSummary(stage),
      tone: "running",
      primaryAction: actionForKind("wait", batch.autonomous),
    };
  }
  if (hasStrategy) {
    return {
      ...base,
      headline: "Strategy is ready",
      summary: "Run the LFS batch when you are ready for generation.",
      tone: "neutral",
      primaryAction: actionForKind("run_batch", batch.autonomous),
    };
  }
  if (hasStrategyPlan) {
    return {
      ...base,
      headline: "Creative direction is saved",
      summary: "Build the strategy before running the LFS batch.",
      tone: "neutral",
      primaryAction: actionForKind("build_strategy", batch.autonomous),
    };
  }
  return {
    ...base,
    headline: "Creative direction needed",
    summary: "Add the ARC, A/B, mechanism, format, count, and any swipes or notes.",
    tone: "neutral",
    primaryAction: actionForKind("add_direction", batch.autonomous),
  };
}

export function statusLabel(status: BatchStatus): string {
  if (status === "review") return "needs review";
  if (status === "blocked") return "blocked";
  if (status === "complete") return "complete";
  if (status === "running") return "running";
  if (status === "ready") return "ready";
  if (status === "draft") return "draft";
  return "unknown";
}

export function workflowToneClass(tone: WorkflowTone): string {
  if (tone === "success") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
  if (tone === "warning") return "border-amber-400/30 bg-amber-400/10 text-amber-100";
  if (tone === "danger") return "border-rose-400/30 bg-rose-400/10 text-rose-100";
  if (tone === "running") return "border-sky-400/30 bg-sky-400/10 text-sky-100";
  return "border-white/15 bg-white/8 text-slate-100";
}

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

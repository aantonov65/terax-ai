import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowUp01Icon,
  File01Icon,
  FolderOpenIcon,
  Image01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { WwxArtifactViewer } from "./WwxArtifactViewer";
import { readWwxArtifact, writeWwxArtifact } from "./store";
import {
  deriveWorkflowState,
  friendlyStageLabel,
  groupArtifacts,
} from "./workflow";
import type {
  ArtifactKind,
  ArtifactSummary,
  BatchSummary,
  FinalScriptSummary,
  RunSummary,
  StageSummary,
  WwxIndexState,
} from "./types";

type Props = {
  cwd: string | null;
  index: WwxIndexState;
  selectedBatch: BatchSummary | null;
  selectedArtifactPath?: string | null;
  onRunBatch: (batch: BatchSummary) => void;
  onBuildStrategy: (batch: BatchSummary) => void;
  onToggleAutonomy: (batch: BatchSummary) => void;
};

function statusClass(status: BatchSummary["status"]): string {
  void status;
  return "border-white/15 bg-white/10 text-slate-200";
}

function kindIcon(kind: ArtifactKind) {
  if (kind === "image") return Image01Icon;
  if (kind === "directory") return FolderOpenIcon;
  return File01Icon;
}

function latestRun(runs: RunSummary[]): RunSummary | null {
  if (!runs.length) return null;
  return [...runs].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

function CreativeDirectionPreview({ plan }: { plan: Record<string, unknown> }) {
  const ads = Array.isArray(plan.ads)
    ? plan.ads.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  if (!ads.length) {
    return (
      <div className="rounded-md border border-white/15 bg-[#191a1e] p-2.5 text-[11px] text-slate-500">
        No ads are defined in the saved strategy plan.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-white/15 bg-[#191a1e]">
      <div className="grid grid-cols-[36px_54px_64px_52px_minmax(0,1fr)] gap-2 border-b border-white/10 px-2 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">
        <span>#</span>
        <span>ARC</span>
        <span>A/B</span>
        <span>M</span>
        <span>Format / Angle</span>
      </div>
      <div className="max-h-48 overflow-y-auto">
        {ads.map((ad, index) => (
          <div
            key={`${String(ad.archetype ?? "ARC")}-${index}`}
            className="grid grid-cols-[36px_54px_64px_52px_minmax(0,1fr)] gap-2 border-b border-white/10 px-2 py-2 text-[11px] text-slate-300 last:border-b-0"
          >
            <span className="text-slate-500">{index + 1}</span>
            <span>{String(ad.archetype ?? "—")}</span>
            <span>{`${String(ad.a_point ?? "—")}/${String(ad.b_point ?? "—")}`}</span>
            <span>{String(ad.mechanism ?? "—")}</span>
            <span className="min-w-0">
              <span className="block text-slate-200">{String(ad.format ?? "—")}</span>
              <span className="block truncate text-slate-500">{String(ad.angle ?? "")}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function EmptyInspector({
  cwd,
  index,
}: {
  cwd: string | null;
  index: WwxIndexState;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-4">
      <div className="max-w-xs border border-dashed border-white/15 bg-[#15161a] p-4 text-center text-slate-100">
        <div className="text-sm font-medium">No batch selected</div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          Select a batch to inspect its artifacts and preview output.
        </p>
        <p className="mt-3 break-all font-mono text-[10px] text-slate-500">
          {cwd ?? index.workspace?.rootPath ?? "No terminal cwd yet"}
        </p>
      </div>
    </div>
  );
}

function DecisionStrip({ batch }: { batch: BatchSummary }) {
  const counts = batch.decisionCounts;
  if (!counts) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5 text-[10.5px]">
      <span className="rounded-md border border-white/15 bg-[#191a1e] px-2 py-1 text-slate-400">
        <span className="font-medium text-slate-100">{counts.ship}</span> ship
      </span>
      <span className="rounded-md border border-white/15 bg-[#191a1e] px-2 py-1 text-slate-400">
        <span className="font-medium text-slate-100">{counts.review}</span> review
      </span>
      <span className="rounded-md border border-white/15 bg-[#191a1e] px-2 py-1 text-slate-400">
        <span className="font-medium text-slate-100">{counts.fail}</span> fail
      </span>
    </div>
  );
}

function RunLine({ run }: { run: RunSummary | null }) {
  if (!run) {
    return (
      <div className="min-w-0 rounded-md border border-white/15 bg-[#191a1e] px-2.5 py-2 text-[11px] text-slate-400">
        No heartbeat or report run is visible yet.
      </div>
    );
  }

  return (
    <div className="min-w-0 rounded-md border border-white/15 bg-[#191a1e] px-2.5 py-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0 truncate text-xs font-medium text-slate-100">{run.label}</div>
        <Badge
          variant="outline"
          className={cn(
            "h-5 rounded-md px-1.5 text-[9.5px]",
            run.status === "review" && "border-amber-400/40 text-amber-200",
            run.status === "blocked" && "border-red-400/40 text-red-200",
            run.status === "complete" && "border-emerald-400/40 text-emerald-200",
            run.status === "running" && "border-sky-400/40 text-sky-200",
          )}
        >
          {run.status}
        </Badge>
      </div>
      <div className="mt-1 truncate text-[10.5px] text-slate-500">
        {run.stage ?? run.lastEvent ?? "last event unknown"}
      </div>
    </div>
  );
}

function StageTimeline({ stages }: { stages: StageSummary[] }) {
  if (!stages.length) {
    return (
      <div className="rounded-md border border-white/15 bg-[#191a1e] px-2.5 py-2 text-[11px] text-slate-400">
        No stage history is visible yet.
      </div>
    );
  }

  return (
    <div className="space-y-0.5 py-1">
      {stages.map((stage, index) => (
        <div key={`${stage.stage}-${index}`} className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-2 text-[11.5px] text-slate-300">
          <div className="relative flex justify-center">
            <span className={cn("mt-1.5 size-2 rounded-full", stage.status === "complete" || stage.status === "ok" ? "bg-emerald-300" : stage.status === "blocked" || stage.status === "failed" ? "bg-red-300" : stage.status === "running" ? "bg-sky-300" : stage.status === "awaiting_review" || stage.status === "held" || !stage.approved ? "bg-amber-300" : "bg-slate-500")} />
            {index < stages.length - 1 ? <span className="absolute top-5 h-[calc(100%-4px)] w-px bg-white/18" /> : null}
          </div>
          <div className="min-w-0 pb-3">
            <div className="truncate text-slate-200">{stage.label ?? friendlyStageLabel(stage.stage)}</div>
            <div className="text-[10px] text-slate-500">
              {stage.summary ?? `${stage.artifactCount} outputs`}{stage.approved ? " · approved" : ""}
            </div>
          </div>
          <HugeiconsIcon
            icon={ArrowUp01Icon}
            size={12}
            strokeWidth={1.8}
            className="mt-0.5 rotate-180 text-slate-500"
          />
        </div>
      ))}
    </div>
  );
}

function finalDecisionTone(decision: string): string {
  if (decision === "ship") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
  if (decision === "review") return "border-amber-400/30 bg-amber-400/10 text-amber-200";
  if (decision === "fail") return "border-rose-400/30 bg-rose-400/10 text-rose-200";
  return "border-white/15 bg-white/10 text-slate-300";
}

function FinalReview({
  scripts,
  onOpenScript,
}: {
  scripts: FinalScriptSummary[];
  onOpenScript: (script: FinalScriptSummary) => void;
}) {
  if (!scripts.length) {
    return (
      <div className="rounded-md border border-white/15 bg-[#191a1e] px-2.5 py-2 text-[11px] text-slate-400">
        Final manifest decisions are not available yet.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {scripts.map((script) => (
        <button
          key={script.taskId}
          type="button"
          onClick={() => onOpenScript(script)}
          className="grid w-full min-w-0 grid-cols-[1fr_auto] items-center gap-2 rounded-md border border-white/15 bg-[#191a1e] px-2.5 py-2 text-left hover:bg-[#202126]"
        >
          <span className="min-w-0">
            <span className="block truncate text-[11.5px] font-medium text-slate-100">
              {script.taskId}
            </span>
            <span className="block truncate text-[10px] text-slate-500">
              {script.semanticReason ?? basename(script.script)}
            </span>
          </span>
          <span className={cn("border px-1.5 py-1 text-[9.5px]", finalDecisionTone(script.decision))}>
            {script.decision}
          </span>
        </button>
      ))}
    </div>
  );
}

function ArtifactRow({
  artifact,
  active,
  onSelect,
}: {
  artifact: ArtifactSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = kindIcon(artifact.kind);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 border-b border-white/10 px-2 py-1.5 text-left outline-none transition-colors",
        "focus-visible:ring-0",
        active ? "bg-[#262832] text-slate-100" : "text-slate-300 hover:bg-[#202126] hover:text-slate-100",
      )}
    >
      <HugeiconsIcon icon={Icon} size={13} strokeWidth={1.75} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] font-medium">
          {basename(artifact.label)}
        </span>
        <span className="block truncate text-[10px] text-slate-500">
          {artifact.kind}
        </span>
      </span>
    </button>
  );
}

export function WwxInspector({
  cwd,
  index,
  selectedBatch,
  selectedArtifactPath,
  onRunBatch,
  onBuildStrategy,
  onToggleAutonomy,
}: Props) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [detailsView, setDetailsView] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  const [artifactExpanded, setArtifactExpanded] = useState(false);
  const run = useMemo(
    () => latestRun(selectedBatch?.runs ?? []),
    [selectedBatch?.runs],
  );
  const finalScripts = selectedBatch?.finalScripts ?? [];
  const workflow = useMemo(
    () =>
      selectedBatch
        ? deriveWorkflowState({
            ...selectedBatch,
            currentStage: selectedBatch.currentStage,
          })
        : null,
    [selectedBatch],
  );
  const artifactGroups = useMemo(
    () => groupArtifacts(selectedBatch?.artifacts ?? []),
    [selectedBatch?.artifacts],
  );
  const [strategyPlan, setStrategyPlan] = useState<Record<string, unknown> | null>(null);
  const [planImportError, setPlanImportError] = useState<string | null>(null);
  const strategyPlanFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!selectedBatch) {
      setSelectedArtifactId(null);
      setDetailsView(false);
      setArtifactExpanded(false);
      return;
    }
    if (selectedArtifactPath) {
      const fromTerminal = selectedBatch.artifacts.find(
        (artifact) => artifact.path === selectedArtifactPath || artifact.id === selectedArtifactPath,
      );
      if (fromTerminal) {
        setSelectedArtifactId(fromTerminal.id);
        return;
      }
    }
    const current = selectedBatch.artifacts.find((artifact) => artifact.id === selectedArtifactId);
    if (current) return;
    const firstImportant =
      artifactGroups.find((group) => group.key !== "technical")?.artifacts[0] ??
      artifactGroups[0]?.artifacts[0] ??
      selectedBatch.artifacts[0];
    setSelectedArtifactId(firstImportant?.id ?? null);
  }, [artifactGroups, selectedBatch, selectedArtifactId, selectedArtifactPath]);

  useEffect(() => {
    setPlanImportError(null);
    setArtifactExpanded(false);
  }, [selectedBatch?.id]);

  useEffect(() => {
    if (!selectedBatch || !finalScripts.length) return;
    setArtifactsOpen(false);
    const firstFinal = selectedBatch.artifacts.find((artifact) =>
      finalScripts.some(
        (script) =>
          artifact.path === script.script ||
          artifact.label === script.script ||
          artifact.path.endsWith(script.script),
      ),
    );
    if (firstFinal) setSelectedArtifactId(firstFinal.id);
  }, [finalScripts.length, selectedBatch?.id]);

  useEffect(() => {
    let alive = true;
    const artifact = selectedBatch?.artifacts.find(
      (item) => item.filename === "strategy-plan.json",
    );
    if (!artifact) {
      setStrategyPlan(null);
      return;
    }
    void readWwxArtifact(artifact.id).then((result) => {
      if (!alive) return;
      try {
        setStrategyPlan(JSON.parse(result.contentText ?? "{}") as Record<string, unknown>);
      } catch {
        setStrategyPlan(null);
      }
    });
    return () => {
      alive = false;
    };
  }, [selectedBatch?.artifacts, selectedBatch?.id]);

  const selectedArtifact =
    selectedBatch?.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  const openFinalScript = (script: FinalScriptSummary) => {
    const artifact = selectedBatch?.artifacts.find(
      (item) => item.path === script.script || item.label === script.script || item.path.endsWith(script.script),
    );
    if (artifact) {
      setSelectedArtifactId(artifact.id);
      setDetailsView(false);
    }
  };
  const importStrategyPlan = async (file: File | undefined) => {
    if (!file || !selectedBatch?.productId) return;
    setPlanImportError(null);
    try {
      const content = await file.text();
      const parsed = JSON.parse(content) as Record<string, unknown>;
      await writeWwxArtifact({
        productId: selectedBatch.productId,
        batchId: selectedBatch.id,
        kind: "json",
        label: "strategy-plan.json",
        filename: "strategy-plan.json",
        mimeType: "application/json",
        contentText: JSON.stringify(parsed, null, 2),
        source: "strategy-plan-import",
        public: true,
      });
      const validation = await invoke<{ ok: boolean; error?: string | null }>("wwx_validate_strategy_plan", {
        input: {
          productId: selectedBatch.productId,
          batchId: selectedBatch.id,
          strategyPlanJson: JSON.stringify(parsed, null, 2),
        },
      });
      if (!validation.ok) {
        setPlanImportError(validation.error ?? "The imported plan is invalid.");
      }
    } catch (error) {
      setPlanImportError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#101114] text-slate-100">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {!selectedBatch ? (
          <EmptyInspector cwd={cwd} index={index} />
        ) : (
          <div className="flex h-full min-h-0 min-w-0 flex-col gap-4 p-3">
            {artifactExpanded ? (
              <WwxArtifactViewer
                artifact={selectedArtifact}
                expanded
                onExpandedChange={setArtifactExpanded}
                className="min-h-0 flex-1"
              />
            ) : detailsView ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
                <section className="flex min-w-0 items-center gap-2 border-b border-white/15 pb-3">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="rounded-md text-slate-400 hover:bg-white/10 hover:text-slate-100"
                    onClick={() => setDetailsView(false)}
                    title="Back"
                  >
                    <HugeiconsIcon icon={ArrowLeft01Icon} size={13} strokeWidth={1.9} />
                  </Button>
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <h2 className="truncate text-sm font-semibold">
                      {selectedBatch.name}
                    </h2>
                    <p className="truncate text-[11px] text-slate-500">
                      {selectedBatch.product ?? selectedBatch.format ?? "WW2 batch"}
                    </p>
                  </div>
                </section>

                <ScrollArea className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overflow-x-hidden">
                  <div className="space-y-4 pr-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge
                        className={cn(
                          "h-5 max-w-24 shrink-0 truncate rounded-md border px-1.5 text-[9.5px]",
                          statusClass(selectedBatch.status),
                        )}
                      >
                        {workflow?.statusLabel ?? selectedBatch.status}
                      </Badge>
                      <DecisionStrip batch={selectedBatch} />
                    </div>

                    <section className="min-w-0 space-y-2 overflow-hidden">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        Run Status
                      </div>
                      <RunLine run={run} />
                    </section>

                    <section className="min-w-0 space-y-2 overflow-hidden">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        Stage Timeline
                      </div>
                      <StageTimeline stages={selectedBatch.stageTimeline ?? []} />
                    </section>

                    <section className="min-w-0 space-y-2 overflow-hidden">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        Final Review
                      </div>
                      <FinalReview
                        scripts={selectedBatch.finalScripts ?? []}
                        onOpenScript={openFinalScript}
                      />
                    </section>

                    {selectedBatch.alerts.length ? (
                      <section className="min-w-0 space-y-1.5 overflow-hidden">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                          Attention
                        </div>
                        <div className="space-y-1">
                          {selectedBatch.alerts.map((alert) => (
                            <div
                              key={alert}
                              className="flex min-w-0 gap-1.5 rounded-md border border-white/15 bg-[#191a1e] px-2.5 py-2 text-[11px] leading-snug text-slate-400"
                            >
                              <HugeiconsIcon
                                icon={Alert02Icon}
                                size={12}
                                strokeWidth={1.75}
                                className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
                              />
                              <span className="min-w-0 break-words">{alert}</span>
                            </div>
                          ))}
                        </div>
                      </section>
                    ) : null}
                  </div>
                </ScrollArea>
              </div>
            ) : (
              <>
                <section className="min-w-0 overflow-hidden border-b border-white/15 pb-3">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <h2 className="truncate text-sm font-semibold">
                        {selectedBatch.name}
                      </h2>
                      <p className="truncate text-[11px] text-slate-500">
                        {selectedBatch.product ?? selectedBatch.format ?? "WW2 batch"}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 rounded-md px-2 text-[10px]"
                      onClick={() => setDetailsView(true)}
                    >
                      Details
                    </Button>
                  </div>
                </section>

                {finalScripts.length ? (
                  <section className="min-w-0 space-y-2 overflow-hidden">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                      Final Ads
                    </div>
                    <FinalReview scripts={finalScripts} onOpenScript={openFinalScript} />
                  </section>
                ) : null}

                {strategyPlan ? (
                  <section className="min-w-0 space-y-2 overflow-hidden">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        Strategy Plan
                      </div>
                      <div className="flex items-center gap-1.5">
                        <input
                          ref={strategyPlanFileRef}
                          type="file"
                          accept="application/json,.json"
                          className="hidden"
                          onChange={(event) => void importStrategyPlan(event.target.files?.[0])}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 rounded-md px-2 text-[10px]"
                          onClick={() => strategyPlanFileRef.current?.click()}
                        >
                          Replace
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 rounded-md px-2 text-[10px]"
                          onClick={() => onToggleAutonomy(selectedBatch)}
                          title="Toggle autonomous mode for this batch"
                        >
                          Auto {selectedBatch.autonomous ? "on" : "off"}
                        </Button>
                        {selectedBatch.strategyPath ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 rounded-md px-2 text-[10px]"
                            onClick={() => onRunBatch(selectedBatch)}
                          >
                            Run LFS4.1
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 rounded-md px-2 text-[10px]"
                            onClick={() => onBuildStrategy(selectedBatch)}
                          >
                            Build strategy
                          </Button>
                        )}
                      </div>
                    </div>
                    <CreativeDirectionPreview plan={strategyPlan} />
                    {planImportError ? (
                      <div className="border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 text-[11px] leading-snug text-amber-200">
                        {planImportError}
                      </div>
                    ) : null}
                  </section>
                ) : null}

                <Collapsible
                  open={artifactsOpen}
                  onOpenChange={setArtifactsOpen}
                  className="min-w-0 overflow-hidden rounded-md border border-white/15 bg-[#191a1e]"
                >
                  <div className="flex min-w-0 items-center justify-between px-2 py-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                      Artifacts
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-slate-500">
                        {selectedBatch.artifacts.length}
                      </span>
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="icon-xs" className="rounded-md text-slate-500 hover:bg-white/10 hover:text-slate-200">
                          <HugeiconsIcon
                            icon={ArrowUp01Icon}
                            size={12}
                            strokeWidth={1.75}
                            className={cn("transition-transform", artifactsOpen && "rotate-180")}
                          />
                        </Button>
                      </CollapsibleTrigger>
                    </div>
                  </div>
                  <CollapsibleContent>
                    {selectedBatch.artifacts.length ? (
                      <div className="max-h-[min(24rem,calc(100dvh-360px))] overflow-y-auto overflow-x-hidden border-t border-white/10">
                        {artifactGroups.map((group) => (
                          <div key={group.key} className={cn(group.key === "technical" && "opacity-80")}>
                            <div className="border-b border-white/10 bg-[#15161a] px-2 py-1 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                              {group.label}
                            </div>
                            {group.artifacts.map((artifact) => (
                              <ArtifactRow
                                key={artifact.id}
                                artifact={artifact}
                                active={artifact.id === selectedArtifactId}
                                onSelect={() => setSelectedArtifactId(artifact.id)}
                              />
                            ))}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="border-t border-white/10 p-3 text-[11px] text-slate-500">
                        No public LFS artifacts yet.
                      </div>
                    )}
                  </CollapsibleContent>
                </Collapsible>

                <WwxArtifactViewer
                  artifact={selectedArtifact}
                  expanded={false}
                  onExpandedChange={setArtifactExpanded}
                  className="min-h-[320px] flex-1"
                />
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

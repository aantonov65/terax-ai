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
import { useEffect, useMemo, useState } from "react";
import { readWwxArtifact } from "./store";
import type {
  ArtifactKind,
  ArtifactSummary,
  BatchSummary,
  RunSummary,
  WwxIndexState,
} from "./types";

type Props = {
  cwd: string | null;
  index: WwxIndexState;
  selectedBatch: BatchSummary | null;
  selectedArtifactPath?: string | null;
  onContinueInAgent: (batch: BatchSummary) => void;
};

const TEXT_KINDS = new Set<ArtifactKind>([
  "angles",
  "strategy",
  "manifest",
  "report",
  "heartbeat",
  "log",
  "markdown",
  "json",
  "csv",
  "upload",
]);

const previewCache = new Map<
  string,
  {
    status: "ready" | "unsupported" | "error";
    content: string;
    dataUrl?: string;
  }
>();

function statusLabel(batch: BatchSummary): string {
  if (batch.status === "review") return "needs review";
  return batch.status;
}

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

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function useTextPreview(artifact: ArtifactSummary | null): {
  status: "idle" | "loading" | "ready" | "unsupported" | "error";
  content: string;
  dataUrl?: string;
} {
  const [state, setState] = useState<{
    status: "idle" | "loading" | "ready" | "unsupported" | "error";
    content: string;
    dataUrl?: string;
  }>({ status: "idle", content: "" });

  useEffect(() => {
    let cancelled = false;
    const artifactId = artifact?.id ?? null;

    if (!artifact || !TEXT_KINDS.has(artifact.kind)) {
      setState({ status: artifact ? "unsupported" : "idle", content: "" });
      return;
    }

    if (artifactId) {
      const cached = previewCache.get(artifactId);
      if (cached) {
        setState(cached);
        return;
      }
    }

    if (artifact.content !== undefined) {
      const excerpt = artifact.content.split("\n").slice(0, 80).join("\n");
      const nextState = {
        status: "ready",
        content: excerpt.length > 5000 ? `${excerpt.slice(0, 5000)}\n...` : excerpt,
      } as const;
      if (artifactId) previewCache.set(artifactId, nextState);
      setState(nextState);
      return;
    }

    setState({ status: "loading", content: "" });
    void readWwxArtifact(artifact.id)
      .then((result) => {
        if (cancelled) return;
        if (result.contentText !== undefined && result.contentText !== null) {
          const excerpt = result.contentText.split("\n").slice(0, 80).join("\n");
          const nextState = {
            status: "ready",
            content: excerpt.length > 5000 ? `${excerpt.slice(0, 5000)}\n...` : excerpt,
          } as const;
          if (artifactId) previewCache.set(artifactId, nextState);
          setState(nextState);
          return;
        }
        if (result.contentBlob?.length && artifact.kind === "image") {
          const bytes = new Uint8Array(result.contentBlob);
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          const mime = artifact.label.endsWith(".webp")
            ? "image/webp"
            : artifact.label.endsWith(".jpg") || artifact.label.endsWith(".jpeg")
              ? "image/jpeg"
              : "image/png";
          const nextState = {
            status: "ready",
            content: "",
            dataUrl: `data:${mime};base64,${window.btoa(binary)}`,
          } as const;
          if (artifactId) previewCache.set(artifactId, nextState);
          setState(nextState);
          return;
        }
        const nextState = { status: "unsupported", content: "" } as const;
        if (artifactId) previewCache.set(artifactId, nextState);
        setState(nextState);
      })
      .catch(() => {
        if (!cancelled) {
          const nextState = { status: "error", content: "" } as const;
          if (artifactId) previewCache.set(artifactId, nextState);
          setState(nextState);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [artifact?.content, artifact?.id, artifact?.kind, artifact?.label]);

  return state;
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
      <span className="border border-white/15 bg-[#191a1e] px-2 py-1 text-slate-400">
        <span className="font-medium text-slate-100">{counts.ship}</span> ship
      </span>
      <span className="border border-white/15 bg-[#191a1e] px-2 py-1 text-slate-400">
        <span className="font-medium text-slate-100">{counts.review}</span> review
      </span>
      <span className="border border-white/15 bg-[#191a1e] px-2 py-1 text-slate-400">
        <span className="font-medium text-slate-100">{counts.fail}</span> fail
      </span>
    </div>
  );
}

function RunLine({ run }: { run: RunSummary | null }) {
  if (!run) {
    return (
      <div className="min-w-0 border border-white/15 bg-[#191a1e] px-2.5 py-2 text-[11px] text-slate-400">
        No heartbeat or report run is visible yet.
      </div>
    );
  }

  return (
    <div className="min-w-0 border border-white/15 bg-[#191a1e] px-2.5 py-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0 truncate text-xs font-medium text-slate-100">{run.label}</div>
        <Badge variant="outline" className="h-5 rounded-none px-1.5 text-[9.5px]">
          {run.status}
        </Badge>
      </div>
      <div className="mt-1 truncate text-[10.5px] text-slate-500">
        {run.stage ?? run.lastEvent ?? "last event unknown"}
      </div>
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

function ArtifactPreview({
  artifact,
}: {
  artifact: ArtifactSummary | null;
}) {
  const text = useTextPreview(artifact);

  if (!artifact) {
    return (
      <div className="flex min-h-[320px] min-w-0 flex-1 items-center justify-center border border-dashed border-white/15 bg-[#15161a] p-3 text-[11px] text-slate-400">
        Select an artifact to preview it here.
      </div>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-white/15 bg-[#191a1e]">
      <div className="min-w-0 overflow-hidden border-b border-white/10 bg-[#15161a] px-2 py-1.5">
        <div className="truncate text-[10px] font-medium text-slate-400" title={artifact.path}>
          {basename(artifact.label)}
        </div>
      </div>

      {artifact.kind === "image" ? (
        <div className="flex min-h-[320px] min-w-0 flex-1 items-center justify-center overflow-hidden bg-[#1c1d21]">
          <img
            src={text.dataUrl ?? artifact.dataUrl ?? ""}
            alt={artifact.label}
            className="block h-full max-h-[520px] w-full max-w-full object-contain"
            loading="lazy"
          />
        </div>
      ) : artifact.kind === "directory" ? (
        <div className="flex min-h-[220px] min-w-0 flex-1 bg-[#1c1d21] p-3 text-[11px] leading-relaxed text-slate-400">
          {artifact.description ?? "Generated files are inside this folder."}
        </div>
      ) : (
        <div className="min-h-[320px] min-w-0 flex-1 overflow-hidden bg-[#1c1d21]">
          <ScrollArea className="h-full min-w-0 [&_[data-slot=scroll-area-viewport]]:overflow-x-hidden">
            <pre className="max-w-full whitespace-pre-wrap break-words px-3 py-2 font-mono text-[10px] leading-relaxed text-slate-200">
              {text.status === "loading"
                ? "Loading..."
                : text.status === "ready"
                  ? text.content || "(empty file)"
                  : "Preview unavailable for this file."}
            </pre>
          </ScrollArea>
        </div>
      )}
    </section>
  );
}

export function WwxInspector({
  cwd,
  index,
  selectedBatch,
  selectedArtifactPath,
  onContinueInAgent,
}: Props) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [detailsView, setDetailsView] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  const run = useMemo(
    () => latestRun(selectedBatch?.runs ?? []),
    [selectedBatch?.runs],
  );

  useEffect(() => {
    if (!selectedBatch) {
      setSelectedArtifactId(null);
      setDetailsView(false);
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
    setSelectedArtifactId(selectedBatch.artifacts[0]?.id ?? null);
  }, [selectedBatch, selectedArtifactId, selectedArtifactPath]);

  const selectedArtifact =
    selectedBatch?.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#101114] text-slate-100">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {!selectedBatch ? (
          <EmptyInspector cwd={cwd} index={index} />
        ) : (
          <div className="flex h-full min-h-0 min-w-0 flex-col gap-4 p-3">
            {detailsView ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
                <section className="flex min-w-0 items-center gap-2 border-b border-white/15 pb-3">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="rounded-none text-slate-400 hover:bg-white/10 hover:text-slate-100"
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
                          "h-5 max-w-24 shrink-0 truncate rounded-none border px-1.5 text-[9.5px]",
                          statusClass(selectedBatch.status),
                        )}
                      >
                        {statusLabel(selectedBatch)}
                      </Badge>
                      <DecisionStrip batch={selectedBatch} />
                    </div>

                    <section className="min-w-0 space-y-2 overflow-hidden">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        Run
                      </div>
                      <RunLine run={run} />
                      <div className="border border-white/15 bg-[#191a1e] px-2.5 py-2 text-[11px] leading-snug text-slate-400">
                        {selectedBatch.nextAction ?? "Open the agent to continue this batch."}
                      </div>
                      {selectedBatch.status !== "complete" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full justify-start rounded-none"
                          onClick={() => onContinueInAgent(selectedBatch)}
                        >
                          Continue in agent
                        </Button>
                      ) : null}
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
                              className="flex min-w-0 gap-1.5 border border-white/15 bg-[#191a1e] px-2.5 py-2 text-[11px] leading-snug text-slate-400"
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
                      className="h-7 shrink-0 rounded-none px-2 text-[10px]"
                      onClick={() => setDetailsView(true)}
                    >
                      Details
                    </Button>
                  </div>
                </section>

                <Collapsible
                  open={artifactsOpen}
                  onOpenChange={setArtifactsOpen}
                  className="min-w-0 overflow-hidden border border-white/15 bg-[#191a1e]"
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
                        <Button variant="ghost" size="icon-xs" className="rounded-none text-slate-500 hover:bg-white/10 hover:text-slate-200">
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
                      <div className="border-t border-white/10">
                        <ScrollArea className="max-h-60 min-w-0 [&_[data-slot=scroll-area-viewport]]:overflow-x-hidden">
                          <div>
                            {selectedBatch.artifacts.map((artifact) => (
                              <ArtifactRow
                                key={artifact.id}
                                artifact={artifact}
                                active={artifact.id === selectedArtifactId}
                                onSelect={() => setSelectedArtifactId(artifact.id)}
                              />
                            ))}
                          </div>
                        </ScrollArea>
                      </div>
                    ) : (
                      <div className="border-t border-white/10 p-3 text-[11px] text-slate-500">
                        No generated assets are visible yet.
                      </div>
                    )}
                  </CollapsibleContent>
                </Collapsible>

                <ArtifactPreview artifact={selectedArtifact} />
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

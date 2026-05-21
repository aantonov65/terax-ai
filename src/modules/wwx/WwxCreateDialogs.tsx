import { Button } from "@/components/ui/button";
import { DotMatrixLoader } from "@/components/ui/dot-matrix-loader";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { invoke } from "@tauri-apps/api/core";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { WwxArtifactViewer } from "./WwxArtifactViewer";
import { safeSegment } from "./mutations";
import { validateProductConfig } from "./research";
import type { ArtifactKind, ArtifactSummary, ProductResearchJob, ProductSummary } from "./types";

export type ProductDraft = {
  productFolder: string;
  config: Record<string, unknown>;
};

export type ResearchDraft = {
  topic: string;
};

type ProductDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (draft: ProductDraft) => Promise<void> | void;
};

type BatchDialogProps = {
  open: boolean;
  product: ProductSummary | null;
  title?: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { batchName: string; autonomous: boolean }) => Promise<void> | void;
};

type ResearchDialogProps = {
  open: boolean;
  product: ProductSummary | null;
  running?: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: (draft: ResearchDraft) => Promise<void> | void;
};

type ResearchPreviewDialogProps = {
  open: boolean;
  product: ProductSummary | null;
  researchJob?: ProductResearchJob | null;
  focusedResearchId?: string | null;
  focusedResearchTopic?: string | null;
  onOpenChange: (open: boolean) => void;
  onRunResearch?: (product: ProductSummary) => void;
};

const WIDE_PRODUCT_DIALOG_WIDTH =
  "!w-[calc(100vw-32px)] !max-w-none sm:!max-w-none xl:!w-[min(1320px,calc(100vw-64px))]";
const PRIMARY_RESEARCH_FILES = ["archetypes.md", "mechanisms.md", "hotwords.md"];

export function CreateProductDialog({ open, onOpenChange, onCreate }: ProductDialogProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [folder, setFolder] = useState("");
  const [rawJson, setRawJson] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
  }, [open]);

  const parsedConfig = useMemo(() => parseRawJson(rawJson), [rawJson]);
  const configPreview = useMemo<Record<string, unknown>>(() => {
    if (!parsedConfig) return {};
    return {
      ...parsedConfig,
      ...(folder.trim() ? { product_code: safeProductCode(folder) } : {}),
    };
  }, [folder, parsedConfig]);
  const validation = useMemo(() => validateProductConfig(configPreview), [configPreview]);
  const canSubmit = Boolean(folder.trim() && parsedConfig && validation.ok);

  const loadConfig = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const content = await file.text();
      const parsed = JSON.parse(content) as Record<string, unknown>;
      setRawJson(JSON.stringify(parsed, null, 2));
      setFolder(
        safeSegment(
          stringValue(parsed.product_code) ||
            stringValue(parsed.brand) ||
            stringValue(parsed.product_name) ||
            file.name.replace(/\.json$/i, ""),
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async () => {
    if (!canSubmit || !parsedConfig) return;
    setError(null);
    try {
      await onCreate({
        productFolder: safeSegment(folder),
        config: configPreview,
      });
      onOpenChange(false);
      setFolder("");
      setRawJson("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-40px)] !w-[calc(100vw-32px)] !max-w-none flex-col gap-4 overflow-hidden rounded-xl border border-white/15 bg-[#17181b] text-slate-100 shadow-2xl sm:!max-w-none xl:!w-[min(1080px,calc(100vw-64px))]">
        <DialogHeader>
          <DialogTitle>Create Product</DialogTitle>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-5 overflow-hidden sm:grid-cols-2">
          <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => void loadConfig(event.target.files?.[0])}
            />
            <Button
              type="button"
              variant="outline"
              className="w-full rounded-md border-white/15 bg-[#1b1c20] text-slate-100 hover:bg-[#222328]"
              onClick={() => fileRef.current?.click()}
            >
              Upload config.json
            </Button>
            <Field label="Product Folder / Code">
              <Input
                value={folder}
                onChange={(event) => setFolder(safeSegment(event.target.value))}
                placeholder="PRVNW"
                className="rounded-md border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
              />
            </Field>
            <section className="rounded-md border border-white/15 bg-[#121317] p-3">
              <div className="mb-2 text-xs font-medium text-slate-200">Required config fields</div>
              <div className="grid gap-1.5">
                {validation.fields.map((field) => (
                  <div key={field.key} className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-slate-300">{field.label}</span>
                    <span className={field.present ? "text-emerald-300" : "text-amber-300"}>
                      {field.present ? "Ready" : field.key}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="min-h-0">
            <Textarea
              value={rawJson}
              onChange={(event) => setRawJson(event.target.value)}
              placeholder="Paste a full config.json here"
              aria-label="Config JSON"
              className="min-h-[420px] rounded-md border-white/15 bg-[#101114] font-mono text-[11px] text-slate-100 placeholder:text-slate-500"
            />
          </div>
        </div>

        {!parsedConfig && rawJson.trim() ? (
          <div className="text-xs text-destructive">config.json is not valid JSON.</div>
        ) : null}
        {error ? <div className="text-xs text-destructive">{error}</div> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={!canSubmit}
            className="text-slate-50 disabled:text-slate-500"
            onClick={() => void submit()}
          >
            Create product
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RunResearchDialog({ open, product, running: alreadyRunning = false, onOpenChange, onRun }: ResearchDialogProps) {
  const [topic, setTopic] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTopic("");
    setStarting(false);
    setError(null);
  }, [open, product?.id]);

  const submit = async () => {
    if (!topic.trim() || !product || alreadyRunning) return;
    const nextTopic = topic.trim();
    setError(null);
    setStarting(true);
    try {
      await onRun({ topic: nextTopic });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-32px)] max-w-[520px] rounded-xl border border-white/15 bg-[#17181b] text-slate-100 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Run Research</DialogTitle>
          <DialogDescription>
            {product ? product.name : "Select a product before running research."}
          </DialogDescription>
        </DialogHeader>
        <Field label="Research topic">
          <Textarea
            autoFocus
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="pregnancy varicose veins tmi suffering stories"
            className="min-h-44 rounded-md border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
          />
        </Field>
        {error ? <div className="text-xs text-destructive">{error}</div> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={!topic.trim() || !product || starting || alreadyRunning}
            className="text-slate-50 disabled:text-slate-500"
            onClick={() => void submit()}
          >
            {starting ? <DotMatrixLoader label="Starting" /> : "Start research"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ResearchPreviewDialog({
  open,
  product,
  researchJob,
  focusedResearchId,
  focusedResearchTopic,
  onOpenChange,
  onRunResearch,
}: ResearchPreviewDialogProps) {
  const [loading, setLoading] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedResearchId, setExpandedResearchId] = useState<string | null>(null);
  const [artifactExpanded, setArtifactExpanded] = useState(false);

  useEffect(() => {
    if (!open || !product) {
      setArtifacts([]);
      setSelectedId(null);
      setExpandedResearchId(null);
      setArtifactExpanded(false);
      setLoading(false);
      return;
    }
    let alive = true;
    const productId = product.id;
    setArtifacts([]);
    setSelectedId(null);
    setExpandedResearchId(null);
    setArtifactExpanded(false);
    if (product.path.startsWith("hosted://")) {
      setLoading(false);
      return () => {
        alive = false;
      };
    }
    setLoading(true);
    void invoke<{
      artifacts: Array<{
        artifact: {
          id: string;
          batchId: string;
          label: string;
          filename: string;
          kind: string;
          updatedAt: number;
          size: number;
        };
      }>;
    }>("wwx_read_product_package", { productId })
      .then((result) => {
        if (!alive) return;
        const researchArtifacts = result.artifacts
          .map((item) => ({
            id: item.artifact.id,
            batchId: item.artifact.batchId,
            label: item.artifact.label || item.artifact.filename,
            filename: item.artifact.filename,
            path: `app://wwx/artifacts/${item.artifact.id}`,
            kind: item.artifact.kind as ArtifactKind,
            size: item.artifact.size,
            mtime: item.artifact.updatedAt,
          }))
          .filter((artifact) => artifact.filename.startsWith("research/") || artifact.filename.startsWith("research-runs/"));
        setArtifacts(researchArtifacts);
        setSelectedId((current) =>
          current && researchArtifacts.some((artifact) => artifact.id === current)
            ? current
            : researchArtifacts.find((artifact) => artifact.filename === "research/archetypes.md")?.id ??
              researchArtifacts.find((artifact) => artifact.filename === "research/mechanisms.md")?.id ??
              researchArtifacts.find((artifact) => artifact.filename === "research/hotwords.md")?.id ??
              researchArtifacts.find((artifact) => artifact.filename === "research/cards-report.json")?.id ??
              researchArtifacts[0]?.id ??
              null,
        );
      })
      .catch(() => {
        if (alive) setArtifacts([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, product?.id, product?.researchArtifactCount, product?.researchArtifactUpdatedAt]);

  const researchItems = useMemo(
    () => buildResearchItems(product, artifacts, researchJob),
    [product, artifacts, researchJob],
  );
  const selected = researchItems
    .flatMap((item) => item.artifacts)
    .find((artifact) => artifact.id === selectedId) ?? null;

  useEffect(() => {
    if (!open) return;
    const focused = researchItems.find((item) => {
      if (focusedResearchId && item.id === focusedResearchId) return true;
      return Boolean(focusedResearchTopic && item.topic === focusedResearchTopic);
    });
    const running = researchItems.find((item) => researchIsRunning(item.status));
    const next = focused?.id ?? running?.id ?? researchItems[0]?.id ?? null;
    setExpandedResearchId((current) =>
      current && researchItems.some((item) => item.id === current) ? current : next,
    );
  }, [focusedResearchId, focusedResearchTopic, open, researchItems]);

  useEffect(() => {
    const expanded = researchItems.find((item) => item.id === expandedResearchId);
    if (!expanded) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) => {
      if (current && expanded.artifacts.some((artifact) => artifact.id === current)) return current;
      return preferredResearchArtifact(expanded.artifacts)?.id ?? null;
    });
  }, [expandedResearchId, researchItems]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`flex h-[calc(100dvh-40px)] ${WIDE_PRODUCT_DIALOG_WIDTH} flex-col overflow-hidden rounded-xl border border-white/15 bg-[#17181b] text-slate-100 shadow-2xl`}
      >
        <DialogHeader className="shrink-0 pr-16">
          <div
            className={[
              "grid items-center gap-4",
              artifactExpanded ? "grid-cols-1" : "lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]",
            ].join(" ")}
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0">
                <DialogTitle>Research Preview</DialogTitle>
                {product ? (
                  <span className="mt-1 block min-w-0 truncate text-sm font-medium text-slate-400">{product.name}</span>
                ) : (
                  <DialogDescription className="mt-1 min-w-0 truncate text-sm">
                    Select a product to preview research.
                  </DialogDescription>
                )}
              </div>
              {product && onRunResearch ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto rounded-md border border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/20 hover:bg-white/10 hover:text-slate-100"
                  onClick={() => onRunResearch(product)}
                  title={`Run new research for ${product.name}`}
                  aria-label={`Run new research for ${product.name}`}
                >
                  <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
                </Button>
              ) : null}
            </div>
          </div>
        </DialogHeader>
        <div
          className={[
            "grid min-h-0 flex-1 gap-4 overflow-hidden",
            artifactExpanded ? "grid-cols-1" : "lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]",
          ].join(" ")}
        >
          <section className={artifactExpanded ? "hidden" : "min-h-0 min-w-0 overflow-y-auto rounded-md border border-white/15 bg-[#101114]"}>
            {loading ? (
              <div className="p-3 text-xs text-slate-400">
                <DotMatrixLoader label="Loading research artifacts" />
              </div>
            ) : artifacts.length ? (
              <ResearchAccordion
                items={researchItems}
                expandedId={expandedResearchId}
                selectedArtifactId={selectedId}
                onExpandedChange={(id) => setExpandedResearchId((current) => current === id ? null : id)}
                onSelectArtifact={(artifact) => setSelectedId(artifact.id)}
              />
            ) : researchItems.length ? (
              <ResearchAccordion
                items={researchItems}
                expandedId={expandedResearchId}
                selectedArtifactId={selectedId}
                onExpandedChange={(id) => setExpandedResearchId((current) => current === id ? null : id)}
                onSelectArtifact={(artifact) => setSelectedId(artifact.id)}
              />
            ) : (
              <div className="p-3 text-xs text-slate-400">No research runs found yet.</div>
            )}
          </section>
          <WwxArtifactViewer
            artifact={selected}
            expanded={artifactExpanded}
            onExpandedChange={setArtifactExpanded}
            emptyMessage="Select a research artifact to preview."
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

type ResearchAccordionItem = {
  id: string;
  topic: string;
  status: string;
  updatedAt?: number;
  artifacts: ArtifactSummary[];
  error?: string;
};

function ResearchAccordion({
  items,
  expandedId,
  selectedArtifactId,
  onExpandedChange,
  onSelectArtifact,
}: {
  items: ResearchAccordionItem[];
  expandedId: string | null;
  selectedArtifactId: string | null;
  onExpandedChange: (id: string) => void;
  onSelectArtifact: (artifact: ArtifactSummary) => void;
}) {
  return (
    <div className="divide-y divide-white/10">
      {items.map((item) => {
        const expanded = expandedId === item.id;
        const running = researchIsRunning(item.status);
        const orderedArtifacts = sortResearchArtifacts(item.artifacts);
        return (
          <div key={item.id}>
            <button
              type="button"
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left hover:bg-[#1c1d22]"
              onClick={() => onExpandedChange(item.id)}
            >
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-slate-200">{item.topic}</span>
                <span className="mt-0.5 block truncate text-[10px] text-slate-500">
                  {researchStatusLabel(item.status)}
                  {item.updatedAt ? ` · ${new Date(item.updatedAt).toLocaleString()}` : ""}
                </span>
                {researchIsBlocked(item.status) && item.error ? (
                  <span className="mt-1 block truncate text-[10px] text-red-300">{item.error}</span>
                ) : null}
              </span>
              {running ? (
                <DotMatrixLoader className="text-emerald-300" label="Running" />
              ) : (
                <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-slate-400">
                  {orderedArtifacts.length}
                </span>
              )}
            </button>
            {expanded ? (
              <div className="border-t border-white/10 bg-[#0d0e11]">
                {orderedArtifacts.length ? (
                  orderedArtifacts.map((artifact) => (
                    <ResearchArtifactButton
                      key={artifact.id}
                      artifact={artifact}
                      active={selectedArtifactId === artifact.id}
                      onSelect={() => onSelectArtifact(artifact)}
                    />
                  ))
                ) : (
                  <div className="px-3 py-3 text-xs text-slate-500">
                    {running ? "Artifacts will appear when research finishes." : "No public research artifacts found for this run."}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function buildResearchItems(
  product: ProductSummary | null,
  localArtifacts: ArtifactSummary[],
  researchJob?: ProductResearchJob | null,
): ResearchAccordionItem[] {
  if (!product) return [];
  const items: ResearchAccordionItem[] = (product.researchRuns ?? []).map((run) => ({
    id: run.id,
    topic: run.topic,
    status: run.status,
    updatedAt: run.updatedAt,
    artifacts: run.artifacts ?? [],
    error: researchIsBlocked(run.status) ? safeResearchError(researchRunFailure(run.qualityJson)) : undefined,
  }));
  if (!items.length && localArtifacts.length) {
    items.push({
      id: "local-research",
      topic: "Local research artifacts",
      status: "complete",
      updatedAt: product.researchArtifactUpdatedAt ?? undefined,
      artifacts: localArtifacts,
    });
  }
  if (
    researchJob &&
    researchJob.productId === product.id &&
    ["queued", "running", "complete", "blocked"].includes(researchJob.status) &&
    !items.some((item) => item.id === researchJob.researchRunId || item.topic === researchJob.topic)
  ) {
    items.push({
      id: researchJob.researchRunId ?? researchJob.runId ?? `job:${product.id}:${researchJob.topic}`,
      topic: researchJob.topic,
      status: researchJob.status,
      updatedAt: researchJob.finishedAt ?? researchJob.startedAt,
      artifacts: [],
      error: researchIsBlocked(researchJob.status) ? safeResearchError(researchJob.error) : undefined,
    });
  }
  return items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function researchIsRunning(status: string): boolean {
  return ["queued", "running", "retrying"].includes(status.toLowerCase());
}

function researchIsBlocked(status: string): boolean {
  return ["blocked", "failed", "cancelled", "canceled", "quarantined"].includes(status.toLowerCase());
}

function safeResearchError(value: unknown): string {
  const message = stringValue(value);
  if (!message) return "Research workflow failed.";
  if (/query returned no rows|enoent|spawnsync|database|sql|trigger|r2|object key|prompt|template|provider/i.test(message)) {
    return "Research workflow failed.";
  }
  return message;
}

function researchRunFailure(qualityJson: string): string {
  const quality = parseRawJson(qualityJson) ?? {};
  return (
    stringValue(quality.failure_message_safe) ||
    stringValue(quality.error_message_safe) ||
    stringValue(quality.failure) ||
    stringValue(quality.error)
  );
}

function researchStatusLabel(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "complete" || normalized === "succeeded") return "complete";
  if (normalized === "queued") return "queued";
  if (normalized === "retrying") return "retrying";
  if (normalized === "running") return "running";
  if (normalized === "blocked" || normalized === "failed") return "blocked";
  return status;
}

function sortResearchArtifacts(artifacts: ArtifactSummary[]): ArtifactSummary[] {
  return [...artifacts].sort((a, b) => {
    const aName = artifactBasename(a.filename ?? a.label);
    const bName = artifactBasename(b.filename ?? b.label);
    const aPrimary = PRIMARY_RESEARCH_FILES.indexOf(aName);
    const bPrimary = PRIMARY_RESEARCH_FILES.indexOf(bName);
    if (aPrimary !== -1 || bPrimary !== -1) {
      if (aPrimary === -1) return 1;
      if (bPrimary === -1) return -1;
      return aPrimary - bPrimary;
    }
    return aName.localeCompare(bName);
  });
}

function preferredResearchArtifact(artifacts: ArtifactSummary[]): ArtifactSummary | null {
  const sorted = sortResearchArtifacts(artifacts);
  return (
    sorted.find((artifact) => artifactBasename(artifact.filename ?? artifact.label) === "archetypes.md") ??
    sorted.find((artifact) => artifactBasename(artifact.filename ?? artifact.label) === "mechanisms.md") ??
    sorted.find((artifact) => artifactBasename(artifact.filename ?? artifact.label) === "hotwords.md") ??
    sorted.find((artifact) => artifactBasename(artifact.filename ?? artifact.label) === "cards-report.json") ??
    sorted[0] ??
    null
  );
}

function ResearchArtifactButton({
  artifact,
  active,
  onSelect,
}: {
  artifact: ArtifactSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={artifact.filename}
      className={[
        "block w-full border-b border-white/10 px-3 py-2 text-left text-xs",
        active ? "bg-[#262832] text-slate-100" : "text-slate-300 hover:bg-[#1c1d22]",
      ].join(" ")}
    >
      <span className="block truncate font-mono text-[11px]">{artifactBasename(artifact.filename ?? artifact.label)}</span>
      <span className="mt-0.5 block text-[10px] text-slate-500">
        {Math.max(1, Math.round((artifact.size ?? 0) / 1024))} KB · {artifact.mtime ? new Date(artifact.mtime).toLocaleString() : "unknown"}
      </span>
    </button>
  );
}

function artifactBasename(filename: string): string {
  const parts = filename.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? filename;
}

export function CreateBatchDialog({
  open,
  product,
  title = "Create Batch",
  onOpenChange,
  onCreate,
}: BatchDialogProps) {
  const [batchName, setBatchName] = useState("");
  const [autonomous, setAutonomous] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBatchName("");
    setAutonomous(false);
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!batchName.trim() || !product) return;
    setError(null);
    try {
      await onCreate({ batchName: batchName.trim(), autonomous });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-xl border border-white/15 bg-[#17181b] text-slate-100">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {product
              ? `Create a batch under ${product.name}. The strategist chat will ask only for batch creative direction.`
              : "Select a product before creating a batch."}
          </DialogDescription>
        </DialogHeader>
        <Field label="Batch Name">
          <Input
            autoFocus
            value={batchName}
            onChange={(event) => setBatchName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            placeholder="PRVNW_LFS_WEIGHT_MIXED_V41_May13"
            className="rounded-md border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
          />
        </Field>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-white/15 bg-[#121317] p-3 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={autonomous}
            onChange={(event) => setAutonomous(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium text-slate-100">Autonomous mode</span>
            <span className="block text-[11px] text-slate-400">
              Once the creative direction validates, continue automatically until the workflow hits a real blocker.
            </span>
          </span>
        </label>
        {error ? <div className="text-xs text-destructive">{error}</div> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={!batchName.trim() || !product}
            className="text-slate-50 disabled:text-slate-500"
            onClick={() => void submit()}
          >
            Create batch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-medium text-slate-400">{label}</Label>
      {children}
    </div>
  );
}

function parseRawJson(value: string): Record<string, unknown> | null {
  if (!value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function safeProductCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9-]+/g, "") || "PRODUCT";
}

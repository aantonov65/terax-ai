import { Button } from "@/components/ui/button";
import { DotmCircular3 } from "@/components/ui/dotm-circular-3";
import { DotmSquare11 } from "@/components/ui/dotm-square-11";
import { UploadArrowOutlineIcon } from "@/components/ui/upload-arrow-outline-icon";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  Alert02Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  File01Icon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import type {
  BatchStatus,
  BatchSummary,
  ProductResearchJob,
  ProductSummary,
  WwxIndexState,
} from "./types";

type Props = {
  index: WwxIndexState;
  selectedBatchId: string | null;
  onSelectBatch: (batchId: string) => void;
  onCreateProduct: () => void;
  onCreateBatch: (product: ProductSummary) => void;
  onOpenResearchPreview: (product: ProductSummary) => void;
  onOpenBatchAgent: (batch: BatchSummary) => void;
  researchJobs?: Record<string, ProductResearchJob>;
};

const STATUS_FILTERS: Array<BatchStatus | "all"> = [
  "all",
  "draft",
  "ready",
  "running",
  "review",
  "complete",
  "blocked",
];

function batchStatusIcon(status: BatchStatus) {
  if (status === "blocked") return Cancel01Icon;
  if (status === "review") return Alert02Icon;
  if (status === "draft") return null;
  return CheckmarkCircle02Icon;
}

function batchStatusTone(status: BatchStatus): string {
  if (status === "complete") return "text-emerald-300";
  if (status === "ready") return "text-violet-300";
  if (status === "running") return "text-sky-200";
  if (status === "review") return "text-amber-300";
  if (status === "blocked") return "text-red-300";
  return "text-slate-400";
}

function BatchRow({
  batch,
  active,
  onSelect,
  onOpenAgent,
}: {
  batch: BatchSummary;
  active: boolean;
  onSelect: () => void;
  onOpenAgent: () => void;
}) {
  const StatusIcon = batchStatusIcon(batch.status);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            "grid min-h-10 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5 overflow-hidden border-b border-white/10 bg-[#191a1e] py-2 pl-5 pr-6 text-left outline-none transition-colors",
            "focus-visible:ring-0",
            active
              ? "bg-[#262832] text-slate-100"
              : "text-slate-300 hover:bg-[#202126] hover:text-slate-100",
          )}
        >
          {batch.status === "running" ? (
            <DotmCircular3
              size={14}
              dotSize={2}
              color="#38bdf8"
              className="shrink-0"
              ariaLabel="Batch running"
            />
          ) : (
            <>
              {StatusIcon ? (
                <HugeiconsIcon
                  icon={StatusIcon}
                  size={13}
                  strokeWidth={2}
                  className={cn("shrink-0", batchStatusTone(batch.status))}
                />
              ) : (
                <UploadArrowOutlineIcon
                  size={13}
                  className={cn("shrink-0", batchStatusTone(batch.status))}
                />
              )}
            </>
          )}
          <span className="min-w-0 flex-1 overflow-hidden">
            <span className="block w-full truncate text-xs font-medium">
              {batch.name}
            </span>
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44 rounded-md border-white/15 bg-[#17181b] text-slate-100">
        <ContextMenuItem onSelect={onOpenAgent}>
          <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} />
          Open in Agent
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function WwxSidebar({
  index,
  selectedBatchId,
  onSelectBatch,
  onCreateProduct,
  onCreateBatch,
  onOpenResearchPreview,
  onOpenBatchAgent,
  researchJobs = {},
}: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<BatchStatus | "all">("all");
  const [openProducts, setOpenProducts] = useState<Record<string, boolean>>({});

  const products = useMemo(() => {
    const q = query.trim().toLowerCase();
    return index.products
      .map((product) => {
        const productMatch =
          !q ||
          product.name.toLowerCase().includes(q) ||
          product.code.toLowerCase().includes(q);
        const batches = product.batches.filter((batch) => {
          const statusMatch = status === "all" || batch.status === status;
          const queryMatch =
            productMatch ||
            !q ||
            batch.name.toLowerCase().includes(q) ||
            batch.id.toLowerCase().includes(q);
          return statusMatch && queryMatch;
        });
        return productMatch && status === "all"
          ? product
          : { ...product, batches, batchCount: batches.length };
      })
      .filter((product) => product.batchCount > 0 || (!q && status === "all"));
  }, [index.products, query, status]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#101114] text-slate-100">
      <div className="border-b border-white/15 bg-[#121316] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">
            Products
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="rounded-md text-slate-400 hover:bg-white/10 hover:text-slate-100"
            onClick={onCreateProduct}
            aria-label="Create product"
            title="Create product"
          >
            <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={2} />
          </Button>
        </div>

        <div className="mt-3 grid gap-2">
          <div className="relative min-w-0">
            <HugeiconsIcon
              icon={Search01Icon}
              size={13}
              strokeWidth={1.8}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              className="h-9 rounded-md border-white/15 bg-[#1b1c20] pl-7 text-xs text-slate-100 placeholder:text-slate-500 focus-visible:border-white/25"
            />
          </div>
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as BatchStatus | "all")}
          >
            <SelectTrigger className="h-9 w-full rounded-md border-white/15 bg-[#1b1c20] px-2 text-xs leading-none text-slate-100 focus:border-white/25 [&>span]:leading-none">
              <SelectValue className="leading-none" />
            </SelectTrigger>
            <SelectContent
              position="popper"
              align="start"
              sideOffset={4}
              className="w-(--radix-select-trigger-width) rounded-md border-white/15 bg-[#17181b] text-slate-100"
            >
              {STATUS_FILTERS.map((item) => (
                <SelectItem key={item} value={item} className="rounded-md text-xs">
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ScrollArea className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overflow-x-hidden">
        <div className="min-w-0">
          {products.length ? (
            products.map((product) => {
              const selectedInProduct = product.batches.some(
                (batch) => batch.id === selectedBatchId,
              );
              const researchJob = researchJobs[product.id];
              const hasPersistedResearch = Boolean(product.researchArtifactCount && product.researchArtifactCount > 0);
              const researchReady =
                product.config?.readiness?.status === "production_ready" ||
                researchJob?.status === "complete" ||
                hasPersistedResearch;
              const researchRunning = ["queued", "running"].includes(researchJob?.status ?? "");
              const researchBlocked = researchJob?.status === "blocked";
              const hasVisibleBatches = product.batches.length > 0;
              const open =
                (openProducts[product.id] ?? selectedInProduct) || products.length <= 4;
              return (
                <Collapsible
                  key={product.path}
                  open={open}
                  onOpenChange={(next) =>
                    setOpenProducts((prev) => ({ ...prev, [product.id]: next }))
                  }
                >
                  <div className="min-w-0 border-b border-white/10">
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_64px] items-center overflow-hidden bg-[#15161a]">
                      <CollapsibleTrigger asChild>
                        <button
                          type="button"
                          className="flex min-h-10 w-full min-w-0 items-center gap-2 overflow-hidden bg-transparent px-3 py-2 pr-1 text-left outline-none focus-visible:ring-0"
                        >
                          <HugeiconsIcon
                            icon={ArrowRight01Icon}
                            size={12}
                            strokeWidth={1.75}
                            className={cn(
                              "shrink-0 text-slate-500 transition-transform",
                              open && "rotate-90",
                            )}
                          />
                          <span className="min-w-0 flex-1 overflow-hidden">
                            <span className="block w-full truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-100">
                              {product.name}
                            </span>
                            {researchBlocked ? (
                              <span className={cn(
                                "block truncate text-[10px]",
                                "text-red-300",
                              )}>
                                research blocked
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </CollapsibleTrigger>
                      <div className="z-10 flex w-16 shrink-0 items-center justify-end gap-1 bg-[#15161a] pr-3">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className={cn(
                            "size-5 rounded-md bg-transparent opacity-90 hover:bg-white/10 hover:text-slate-100 hover:opacity-100",
                            researchRunning
                              ? "text-sky-200"
                              : researchReady
                                ? "text-emerald-300"
                                : researchBlocked
                                  ? "text-red-300"
                                  : "text-slate-500",
                          )}
                          onClick={() => onOpenResearchPreview(product)}
                          title={
                            researchRunning
                              ? `Research running: ${researchJob?.topic ?? product.name}`
                              : researchBlocked
                                ? `Research blocked: ${researchJob?.error ?? "unknown error"}`
                                : researchReady
                                  ? `Open research preview for ${product.name}`
                                  : "No completed research yet"
                          }
                          aria-label={`Open research preview for ${product.name}`}
                        >
                          {researchRunning ? (
                            <DotmSquare11
                              size={15}
                              dotSize={2}
                              color="currentColor"
                              ariaLabel="Research running"
                            />
                          ) : (
                            <HugeiconsIcon icon={File01Icon} size={13} strokeWidth={1.8} />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="size-5 rounded-md bg-transparent text-slate-500 opacity-80 hover:bg-white/10 hover:text-slate-100 hover:opacity-100"
                          onClick={() => onCreateBatch(product)}
                          title={`Create batch for ${product.name}`}
                        >
                          <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2} />
                        </Button>
                      </div>
                    </div>
                    {hasVisibleBatches ? (
                    <CollapsibleContent>
                      <div className="border-t border-white/10 bg-[#101114]">
                        {product.batches.map((batch) => (
                            <BatchRow
                              key={batch.path}
                              batch={batch}
                              active={batch.id === selectedBatchId}
                              onSelect={() => onSelectBatch(batch.id)}
                              onOpenAgent={() => onOpenBatchAgent(batch)}
                            />
                          ))}
                      </div>
                    </CollapsibleContent>
                    ) : null}
                  </div>
                </Collapsible>
              );
            })
          ) : (
            <div className="px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
              No products or batches match the current filters.
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

import { Button } from "@/components/ui/button";
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
  ArrowRight01Icon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import type {
  BatchStatus,
  BatchSummary,
  ProductSummary,
  WwxIndexState,
} from "./types";

type Props = {
  index: WwxIndexState;
  selectedBatchId: string | null;
  onSelectBatch: (batchId: string) => void;
  onCreateProduct: () => void;
  onCreateBatch: (product: ProductSummary) => void;
  onOpenBatchAgent: (batch: BatchSummary) => void;
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

function statusTone(status: BatchStatus): string {
  if (status === "complete") return "bg-emerald-300";
  if (status === "running") return "bg-sky-300";
  if (status === "review") return "bg-amber-300";
  if (status === "blocked") return "bg-red-300";
  return "bg-slate-400";
}

function batchSubtitle(batch: BatchSummary): string {
  if (batch.status === "draft") return "draft batch";
  return batch.format ?? (batch.legacy ? "legacy batch" : "WWX batch");
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
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            "flex min-h-11 w-full min-w-0 items-center gap-3 border-b border-white/10 bg-[#191a1e] px-3 py-2 text-left outline-none transition-colors",
            "focus-visible:ring-0",
            active
              ? "bg-[#262832] text-slate-100"
              : "text-slate-300 hover:bg-[#202126] hover:text-slate-100",
          )}
        >
          <span
            className={cn("mt-0.5 size-1.5 shrink-0", statusTone(batch.status))}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">
              {batch.name}
            </span>
            <span className="block truncate text-[10.5px] leading-snug">
              {batchSubtitle(batch)}
            </span>
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44 rounded-none border-white/15 bg-[#17181b] text-slate-100">
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
  onOpenBatchAgent,
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
            className="rounded-none text-slate-400 hover:bg-white/10 hover:text-slate-100"
            onClick={onCreateProduct}
            aria-label="Create product"
            title="Create product"
          >
            <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={2} />
          </Button>
        </div>

        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_108px] gap-2">
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
              className="h-9 rounded-none border-white/15 bg-[#1b1c20] pl-7 text-xs text-slate-100 placeholder:text-slate-500 focus-visible:border-white/25"
            />
          </div>
          <Select value={status} onValueChange={(value) => setStatus(value as BatchStatus | "all")}>
            <SelectTrigger className="h-9 w-full rounded-none border-white/15 bg-[#1b1c20] px-2 text-xs leading-none text-slate-100 focus:border-white/25 [&>span]:leading-none">
              <SelectValue className="leading-none" />
            </SelectTrigger>
            <SelectContent className="rounded-none border-white/15 bg-[#17181b] text-slate-100">
              {STATUS_FILTERS.map((item) => (
                <SelectItem key={item} value={item} className="rounded-none text-xs">
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
                    <div className="flex min-w-0 items-center bg-[#15161a]">
                      <CollapsibleTrigger asChild>
                        <button
                          type="button"
                          className="flex min-h-10 min-w-0 flex-1 items-center gap-3 bg-transparent px-3 py-2 text-left outline-none focus-visible:ring-0"
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
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-100">
                              {product.name}
                            </span>
                          </span>
                        </button>
                      </CollapsibleTrigger>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="mr-3 rounded-none bg-transparent text-slate-500 opacity-80 hover:bg-transparent hover:text-slate-200 hover:opacity-100"
                        onClick={() => onCreateBatch(product)}
                        title={`Create batch for ${product.name}`}
                      >
                        <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2} />
                      </Button>
                    </div>
                    <CollapsibleContent>
                      <div className="border-t border-white/10 bg-[#101114]">
                        {product.batches.length ? (
                          product.batches.map((batch) => (
                            <BatchRow
                              key={batch.path}
                              batch={batch}
                              active={batch.id === selectedBatchId}
                              onSelect={() => onSelectBatch(batch.id)}
                              onOpenAgent={() => onOpenBatchAgent(batch)}
                            />
                          ))
                        ) : (
                          <div className="px-3 py-2 text-[11px] text-muted-foreground">
                            No batches match this filter.
                          </div>
                        )}
                      </div>
                    </CollapsibleContent>
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

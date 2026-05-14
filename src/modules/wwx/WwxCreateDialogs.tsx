import { Button } from "@/components/ui/button";
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { safeSegment } from "./mutations";
import type { ProductSummary } from "./types";

export type ProductDraft = {
  productFolder: string;
  config: Record<string, unknown>;
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
  onCreate: (batchName: string) => Promise<void> | void;
};

export function CreateProductDialog({
  open,
  onOpenChange,
  onCreate,
}: ProductDialogProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [folder, setFolder] = useState("");
  const [brand, setBrand] = useState("");
  const [productName, setProductName] = useState("");
  const [price, setPrice] = useState("");
  const [guarantee, setGuarantee] = useState("");
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState("");
  const [rawJson, setRawJson] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
  }, [open]);

  const canSubmit = Boolean(folder.trim() && productName.trim());

  const configPreview = useMemo(() => {
    const base = parseRawJson(rawJson) ?? {};
    return {
      ...base,
      brand: brand.trim() || base.brand || folder.trim(),
      product_code: folder.trim(),
      product_name: productName.trim(),
      ...(price.trim() ? { price: coercePrice(price.trim()) } : {}),
      ...(guarantee.trim() ? { guarantee: guarantee.trim() } : {}),
      ...(url.trim() ? { url: url.trim() } : {}),
      ...(target.trim()
        ? { target_demographic: { description: target.trim() } }
        : {}),
    };
  }, [brand, folder, guarantee, price, productName, rawJson, target, url]);

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      await onCreate({
        productFolder: safeSegment(folder),
        config: configPreview,
      });
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadConfig = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const content = await file.text();
      const parsed = JSON.parse(content) as Record<string, unknown>;
      setRawJson(JSON.stringify(parsed, null, 2));
      const nextFolder =
        stringValue(parsed.product_code) ||
        stringValue(parsed.brand) ||
        stringValue(parsed.product_name) ||
        file.name.replace(/\.json$/i, "");
      setFolder(safeSegment(nextFolder));
      setBrand(stringValue(parsed.brand) ?? "");
      setProductName(
        stringValue(parsed.product_name) ||
          stringValue(parsed.name) ||
          stringValue(parsed.product) ||
          "",
      );
      setPrice(parsed.price === undefined ? "" : String(parsed.price));
      setGuarantee(stringValue(parsed.guarantee) ?? "");
      setUrl(stringValue(parsed.url) ?? "");
      setTarget(targetText(parsed.target_demographic));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const reset = () => {
    setFolder("");
    setBrand("");
    setProductName("");
    setPrice("");
    setGuarantee("");
    setUrl("");
    setTarget("");
    setRawJson("");
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-40px)] w-[calc(100vw-32px)] max-w-none overflow-hidden rounded-lg border border-white/15 bg-[#17181b] text-slate-100 shadow-2xl sm:max-w-none xl:w-[min(1755px,calc(100vw-64px))]">
        <DialogHeader>
          <DialogTitle>Create Product</DialogTitle>
          <DialogDescription>
            Upload a product config or fill the core fields. The saved file is
            written under the workspace products directory.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-5 overflow-hidden sm:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
          <div className="space-y-3">
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
              className="w-full rounded-none border-white/15 bg-[#1b1c20] text-slate-100 hover:bg-[#222328]"
              onClick={() => fileRef.current?.click()}
            >
              Upload config.json
            </Button>
            <Field label="Product Folder">
              <Input
                value={folder}
                onChange={(event) => setFolder(safeSegment(event.target.value))}
                placeholder="NR-Joints"
                className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
              />
            </Field>
            <Field label="Brand">
              <Input
                value={brand}
                onChange={(event) => setBrand(event.target.value)}
                placeholder="Brand code or name"
                className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
              />
            </Field>
            <Field label="Product Name">
              <Input
                value={productName}
                onChange={(event) => setProductName(event.target.value)}
                placeholder="Product display name"
                className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Price">
                <Input
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  placeholder="49"
                  className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
                />
              </Field>
              <Field label="Guarantee">
                <Input
                  value={guarantee}
                  onChange={(event) => setGuarantee(event.target.value)}
                  placeholder="60-day"
                  className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
                />
              </Field>
            </div>
            <Field label="URL">
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://..."
                className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
              />
            </Field>
            <Field label="Target">
              <Textarea
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="Women 40-65, condition, market..."
                className="min-h-20 rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
              />
            </Field>
          </div>

          <Field label="Config Preview">
            <Textarea
              value={JSON.stringify(configPreview, null, 2)}
              readOnly
              className="min-h-[490px] rounded-none border-white/15 bg-[#101114] font-mono text-[11px] text-slate-200"
            />
          </Field>
        </div>

        {error ? <div className="text-xs text-destructive">{error}</div> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            Create product
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CreateBatchDialog({
  open,
  product,
  title = "Create Batch",
  onOpenChange,
  onCreate,
}: BatchDialogProps) {
  const [batchName, setBatchName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBatchName("");
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!batchName.trim() || !product) return;
    setError(null);
    try {
      await onCreate(batchName.trim());
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-lg border border-white/15 bg-[#17181b] text-slate-100">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {product
              ? `Create a batch under ${product.name}. An agent window opens for it immediately.`
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
            placeholder="May14 Hair Podcast Batch"
            className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
          />
        </Field>
        {error ? <div className="text-xs text-destructive">{error}</div> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!batchName.trim() || !product} onClick={() => void submit()}>
            Create batch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-medium text-slate-400">
        {label}
      </Label>
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function coercePrice(value: string): string | number {
  const n = Number(value);
  return Number.isFinite(n) && String(n) === value ? n : value;
}

function targetText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

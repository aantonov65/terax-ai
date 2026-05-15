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
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getKey } from "@/modules/ai/lib/keyring";
import { safeSegment, type ProductResearchDraft } from "./mutations";
import { generateStarterResearch, validateResearchDraft } from "./research";
import type { ProductSummary } from "./types";

export type ProductDraft = {
  productFolder: string;
  config: Record<string, unknown>;
  research: ProductResearchDraft;
  sourceBundle?: Record<string, unknown>;
  packageArtifacts?: {
    sourceAngle: string;
    angles: string;
    strategyJson: string;
    reportJson: string;
  };
  approveForProduction?: boolean;
};

type ResearchFileKey = keyof ProductResearchDraft;

type LoadedResearchFile = {
  name: string;
  text: string;
};

type LoadedSourceDocument = {
  label: string;
  content: string;
};

type GeneratedProductPackage = {
  productCode: string;
  batchId: string;
  configJson: string;
  archetypes: string;
  hotwords: string;
  mechanisms: string;
  sourceAngle: string;
  angles: string;
  strategyJson: string;
  reportJson: string;
  sourceBundleJson: string;
};

type PackagePreviewKey =
  | "config"
  | "archetypes"
  | "hotwords"
  | "mechanisms"
  | "sourceAngle"
  | "angles"
  | "strategy"
  | "report";

const RESEARCH_FILES: Array<{
  key: ResearchFileKey;
  filename: `${ResearchFileKey}.md`;
  label: string;
}> = [
  { key: "archetypes", filename: "archetypes.md", label: "Archetypes" },
  { key: "hotwords", filename: "hotwords.md", label: "Hotwords" },
  { key: "mechanisms", filename: "mechanisms.md", label: "Mechanisms" },
];

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
  const sourceFilesRef = useRef<HTMLInputElement | null>(null);
  const researchRefs = useRef<Record<ResearchFileKey, HTMLInputElement | null>>({
    archetypes: null,
    hotwords: null,
    mechanisms: null,
  });
  const [folder, setFolder] = useState("");
  const [brand, setBrand] = useState("");
  const [productName, setProductName] = useState("");
  const [price, setPrice] = useState("");
  const [guarantee, setGuarantee] = useState("60-day");
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState("");
  const [rawJson, setRawJson] = useState("");
  const [researchFiles, setResearchFiles] = useState<
    Partial<Record<ResearchFileKey, LoadedResearchFile>>
  >({});
  const [sourceDocs, setSourceDocs] = useState<LoadedSourceDocument[]>([]);
  const [sourceNotes, setSourceNotes] = useState("");
  const [generatedPackage, setGeneratedPackage] =
    useState<GeneratedProductPackage | null>(null);
  const [packageApproved, setPackageApproved] = useState(false);
  const [packageDirty, setPackageDirty] = useState(false);
  const [packageGenerating, setPackageGenerating] = useState(false);
  const [packagePreview, setPackagePreview] =
    useState<PackagePreviewKey>("config");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
  }, [open]);

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

  const generatedResearch = useMemo(
    () => generateStarterResearch(configPreview, safeSegment(folder)),
    [configPreview, folder],
  );
  const resolvedResearch = useMemo<ProductResearchDraft>(
    () => ({
      archetypes: researchFiles.archetypes?.text ?? generatedResearch.archetypes,
      hotwords: researchFiles.hotwords?.text ?? generatedResearch.hotwords,
      mechanisms: researchFiles.mechanisms?.text ?? generatedResearch.mechanisms,
    }),
    [generatedResearch, researchFiles],
  );
  const researchValidation = useMemo(
    () => validateResearchDraft(resolvedResearch),
    [resolvedResearch],
  );
  const hasPricing = Boolean(price.trim() || hasConfigPricing(configPreview));
  const hasGuarantee = Boolean(guarantee.trim() || hasConfigOffer(configPreview));
  const canSubmit = Boolean(
    folder.trim() && productName.trim() && hasPricing && hasGuarantee && researchValidation.ok,
  );
  const sourceDocuments = useMemo(
    () => [
      ...sourceDocs,
      ...(sourceNotes.trim()
        ? [{ label: "strategist-notes.md", content: sourceNotes.trim() }]
        : []),
    ],
    [sourceDocs, sourceNotes],
  );
  const packagePreviewContent = useMemo(() => {
    if (!generatedPackage) return "";
    switch (packagePreview) {
      case "config":
        return generatedPackage.configJson;
      case "archetypes":
        return generatedPackage.archetypes;
      case "hotwords":
        return generatedPackage.hotwords;
      case "mechanisms":
        return generatedPackage.mechanisms;
      case "sourceAngle":
        return generatedPackage.sourceAngle;
      case "angles":
        return generatedPackage.angles;
      case "strategy":
        return generatedPackage.strategyJson;
      case "report":
        return generatedPackage.reportJson;
    }
  }, [generatedPackage, packagePreview]);

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      const usablePackage = generatedPackage && !packageDirty ? generatedPackage : null;
      const sourceBundle = usablePackage
        ? parseRawJson(usablePackage.sourceBundleJson) ?? undefined
        : undefined;
      await onCreate({
        productFolder: safeSegment(folder),
        config: configPreview,
        research: resolvedResearch,
        sourceBundle,
        packageArtifacts: usablePackage
          ? {
              sourceAngle: usablePackage.sourceAngle,
              angles: usablePackage.angles,
              strategyJson: usablePackage.strategyJson,
              reportJson: usablePackage.reportJson,
            }
          : undefined,
        approveForProduction: Boolean(usablePackage && packageApproved),
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
      markPackageDirty();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadResearchFile = async (
    key: ResearchFileKey,
    file: File | undefined,
  ) => {
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      if (!text.trim()) {
        const filename = RESEARCH_FILES.find((item) => item.key === key)?.filename;
        throw new Error(`${filename} is empty.`);
      }
      setResearchFiles((prev) => ({
        ...prev,
        [key]: { name: file.name, text },
      }));
      markPackageDirty();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadSourceFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    try {
      const loaded = await Promise.all(
        Array.from(files).map(async (file) => ({
          label: file.name,
          content: await file.text(),
        })),
      );
      setSourceDocs((current) => [...current, ...loaded.filter((doc) => doc.content.trim())]);
      markPackageDirty();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const generateProductionPackage = async () => {
    if (!sourceDocuments.length) {
      setError("Add at least one source document or strategist note before generating a package.");
      return;
    }
    setError(null);
    setPackageGenerating(true);
    try {
      const anthropicApiKey = await getKey("anthropic");
      const generated = await invoke<GeneratedProductPackage>("wwx_generate_product_package", {
        input: {
          productCode: safeSegment(folder || brand || productName || "PRODUCT").toUpperCase(),
          documents: sourceDocuments,
          anthropicApiKey,
        },
      });
      const config = parseRawJson(generated.configJson);
      if (!config) {
        throw new Error("Generated config.json was invalid.");
      }
      setGeneratedPackage(generated);
      setPackageApproved(false);
      setPackageDirty(false);
      setPackagePreview("config");
      setRawJson(JSON.stringify(config, null, 2));
      setFolder(safeSegment(stringValue(config.product_code) ?? generated.productCode));
      setBrand(stringValue(config.brand) ?? "");
      setProductName(
        stringValue(config.product_name) ||
          stringValue(config.name) ||
          stringValue(config.product) ||
          "",
      );
      setPrice(config.price === undefined ? "" : String(config.price));
      setGuarantee(stringValue(config.guarantee) ?? "");
      setUrl(stringValue(config.url) ?? "");
      setTarget(targetText(config.target_demographic));
      setResearchFiles({
        archetypes: { name: "Generated archetypes.md", text: generated.archetypes },
        hotwords: { name: "Generated hotwords.md", text: generated.hotwords },
        mechanisms: { name: "Generated mechanisms.md", text: generated.mechanisms },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPackageGenerating(false);
    }
  };

  const markPackageDirty = () => {
    if (generatedPackage) {
      setPackageApproved(false);
      setPackageDirty(true);
    }
  };

  const reset = () => {
    if (fileRef.current) fileRef.current.value = "";
    if (sourceFilesRef.current) sourceFilesRef.current.value = "";
    for (const ref of Object.values(researchRefs.current)) {
      if (ref) ref.value = "";
    }
    setFolder("");
    setBrand("");
    setProductName("");
    setPrice("");
    setGuarantee("60-day");
    setUrl("");
    setTarget("");
    setRawJson("");
    setResearchFiles({});
    setSourceDocs([]);
    setSourceNotes("");
    setGeneratedPackage(null);
    setPackageApproved(false);
    setPackageDirty(false);
    setPackageGenerating(false);
    setPackagePreview("config");
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-40px)] w-[calc(100vw-32px)] max-w-none flex-col gap-4 overflow-hidden rounded-lg border border-white/15 bg-[#17181b] text-slate-100 shadow-2xl sm:max-w-none xl:w-[min(1755px,calc(100vw-64px))]">
        <DialogHeader>
          <DialogTitle>Create Product</DialogTitle>
          <DialogDescription>
            Create a draft manually, or generate a production package from raw evidence and
            approve it before LFS can run as production.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-5 overflow-hidden sm:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
          <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
            <div className="space-y-2 border border-white/15 bg-[#121317] p-3">
              <div>
                <div className="text-xs font-medium text-slate-200">
                  Production package
                </div>
                <div className="text-[11px] text-slate-400">
                  Upload messy source material, generate the upstream package, then approve it.
                </div>
              </div>
              <input
                ref={sourceFilesRef}
                type="file"
                multiple
                accept=".md,.txt,.json,.csv,text/plain,text/markdown,application/json"
                className="hidden"
                onChange={(event) => void loadSourceFiles(event.target.files)}
              />
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start rounded-none border-white/15 bg-[#1b1c20] text-slate-100 hover:bg-[#222328]"
                  onClick={() => sourceFilesRef.current?.click()}
                >
                  Upload raw sources
                </Button>
                <Button
                  type="button"
                  disabled={packageGenerating || !sourceDocuments.length}
                  className="rounded-none"
                  onClick={() => void generateProductionPackage()}
                >
                  {packageGenerating ? "Generating..." : "Generate"}
                </Button>
              </div>
              {sourceDocs.length ? (
                <div className="flex flex-wrap gap-1">
                  {sourceDocs.map((doc, index) => (
                    <span
                      key={`${doc.label}-${index}`}
                      className="border border-white/15 bg-[#1b1c20] px-2 py-1 text-[10px] text-slate-300"
                    >
                      {doc.label}
                    </span>
                  ))}
                </div>
              ) : null}
              <Textarea
                value={sourceNotes}
                onChange={(event) => {
                  setSourceNotes(event.target.value);
                  markPackageDirty();
                }}
                placeholder="Paste strategist notes, landing page copy, evidence, product facts..."
                className="min-h-20 rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
              />
              {generatedPackage ? (
                <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-2">
                  <div className="text-[11px] text-slate-400">
                    {packageDirty
                      ? "Source or package fields changed; regenerate before approval"
                      : packageApproved
                        ? "Approved for production"
                        : "Generated, awaiting approval"}
                  </div>
                  <Button
                    type="button"
                    variant={packageApproved ? "outline" : "default"}
                    className="h-7 rounded-none px-2 text-[11px]"
                    disabled={packageDirty}
                    onClick={() => setPackageApproved((current) => !current)}
                  >
                    {packageDirty ? "Needs regenerate" : packageApproved ? "Approved" : "Approve package"}
                  </Button>
                </div>
              ) : null}
            </div>
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
                onChange={(event) => {
                  setFolder(safeSegment(event.target.value));
                  markPackageDirty();
                }}
                placeholder="NR-Joints"
                className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
              />
            </Field>
            <Field label="Brand">
              <Input
                value={brand}
                onChange={(event) => {
                  setBrand(event.target.value);
                  markPackageDirty();
                }}
                placeholder="Brand code or name"
                className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
              />
            </Field>
            <Field label="Product Name">
              <Input
                value={productName}
                onChange={(event) => {
                  setProductName(event.target.value);
                  markPackageDirty();
                }}
                placeholder="Product display name"
                className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Price">
                <Input
                  value={price}
                  onChange={(event) => {
                    setPrice(event.target.value);
                    markPackageDirty();
                  }}
                  placeholder="49"
                  className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
                />
              </Field>
              <Field label="Guarantee">
                <Input
                  value={guarantee}
                  onChange={(event) => {
                    setGuarantee(event.target.value);
                    markPackageDirty();
                  }}
                  placeholder="60-day"
                  className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
                />
              </Field>
            </div>
            <Field label="URL">
              <Input
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  markPackageDirty();
                }}
                placeholder="https://..."
                className="rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
              />
            </Field>
            <Field label="Target">
              <Textarea
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value);
                  markPackageDirty();
                }}
                placeholder="Women 40-65, condition, market..."
                className="min-h-20 rounded-none border-white/15 bg-[#1b1c20] text-slate-100 placeholder:text-slate-500"
              />
            </Field>
            <div className="space-y-2 border-t border-white/10 pt-3">
              <div>
                <div className="text-xs font-medium text-slate-200">
                  Required LFS research
                </div>
                <div className="text-[11px] text-slate-400">
                  Auto-generated draft files do not satisfy production readiness.
                </div>
              </div>
              {RESEARCH_FILES.map(({ key, filename, label }) => (
                <div key={key}>
                  <input
                    ref={(node) => {
                      researchRefs.current[key] = node;
                    }}
                    type="file"
                    accept="text/markdown,.md"
                    className="hidden"
                    onChange={(event) =>
                      void loadResearchFile(key, event.target.files?.[0])
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="flex h-auto w-full items-center justify-between rounded-none border-white/15 bg-[#1b1c20] px-3 py-2 text-left text-slate-100 hover:bg-[#222328]"
                    onClick={() => researchRefs.current[key]?.click()}
                  >
                    <span className="flex flex-col">
                      <span className="text-xs">{label}</span>
                      <span className="text-[11px] text-slate-400">
                        {researchFiles[key]?.name ?? `Auto-generated ${filename}`}
                      </span>
                    </span>
                    <span className="text-[11px] text-slate-400">
                      {researchFiles[key] ? "Replace" : "Optional"}
                    </span>
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-2">
            {generatedPackage ? (
              <>
                <div className="grid grid-cols-4 gap-1">
                  {PACKAGE_PREVIEWS.map((preview) => (
                    <Button
                      key={preview.key}
                      type="button"
                      variant="outline"
                      className={`h-7 rounded-none px-2 text-[10px] ${
                        packagePreview === preview.key ? "bg-[#262832]" : "bg-[#1b1c20]"
                      }`}
                      onClick={() => setPackagePreview(preview.key)}
                    >
                      {preview.label}
                    </Button>
                  ))}
                </div>
                <Textarea
                  value={packagePreviewContent}
                  readOnly
                  className="min-h-0 flex-1 rounded-none border-white/15 bg-[#101114] font-mono text-[11px] text-slate-200"
                />
              </>
            ) : (
              <>
                <Label className="text-[11px] font-medium text-slate-400">
                  Config Preview
                </Label>
                <Textarea
                  value={JSON.stringify(configPreview, null, 2)}
                  readOnly
                  className="min-h-0 flex-1 rounded-none border-white/15 bg-[#101114] font-mono text-[11px] text-slate-200"
                />
              </>
            )}
          </div>
        </div>

        {!hasPricing ? (
          <div className="text-xs text-amber-300">Add a price or upload a config with pricing_rules.</div>
        ) : null}
        {!hasGuarantee ? (
          <div className="text-xs text-amber-300">Add a guarantee or upload a config with offer_architecture.</div>
        ) : null}
        {!researchValidation.ok ? (
          <div className="text-xs text-destructive">{researchValidation.missing.join("; ")}</div>
        ) : null}
        {error ? <div className="text-xs text-destructive">{error}</div> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {packageApproved ? "Create production product" : "Create draft product"}
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

function hasConfigPricing(config: Record<string, unknown>): boolean {
  const pricing = config.pricing_rules;
  if (!isRecord(pricing)) return false;
  return pricing.single_bag_price_usd !== undefined && Array.isArray(pricing.canonical_phrasings);
}

function hasConfigOffer(config: Record<string, unknown>): boolean {
  const offer = config.offer_architecture;
  if (!isRecord(offer)) return false;
  return Array.isArray(offer.what_you_get) && Array.isArray(offer.price_anchor_stack);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

const PACKAGE_PREVIEWS: Array<{ key: PackagePreviewKey; label: string }> = [
  { key: "config", label: "Config" },
  { key: "archetypes", label: "Archetypes" },
  { key: "hotwords", label: "Hotwords" },
  { key: "mechanisms", label: "Mechanisms" },
  { key: "sourceAngle", label: "Source" },
  { key: "angles", label: "Angles" },
  { key: "strategy", label: "Strategy" },
  { key: "report", label: "Report" },
];

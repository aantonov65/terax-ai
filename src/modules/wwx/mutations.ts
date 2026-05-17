import {
  createBatchInStore,
  createProductInStore,
  writeWwxArtifact,
  type CreatedBatch,
} from "./store";
import {
  assessProductReadiness,
  completeProductConfig,
  completeResearchDraft,
  validateResearchDraft,
  type ProductResearchDraft,
} from "./research";

export type { ProductResearchDraft } from "./research";

export type CreateProductInput = {
  workspaceRoot: string;
  productFolder?: string;
  config: Record<string, unknown>;
  research?: Partial<ProductResearchDraft>;
  sourceBundle?: Record<string, unknown>;
  packageArtifacts?: {
    batchId: string;
    sourceAngle: string;
    angles: string;
    strategyJson: string;
    operatorInputJson: string;
    readinessAssessmentJson: string;
    conceptMatrixJson: string;
    reportJson: string;
  };
  approveForProduction?: boolean;
};

export type CreateBatchInput = {
  workspaceRoot: string;
  productFolder: string;
  batchName: string;
};

export async function createWwxProduct({
  productFolder,
  config,
  research,
  sourceBundle,
  packageArtifacts,
  approveForProduction = false,
}: CreateProductInput): Promise<{ productFolder: string; productPath: string; productCode: string; productId: string }> {
  const folder = safeSegment(
    productFolder ||
      stringValue(config.product_code) ||
      stringValue(config.brand) ||
      stringValue(config.product_name) ||
      "product",
  );
  const normalized = normalizeConfig(config, folder);
  const completedResearch = completeResearchDraft(research, normalized, folder);
  const validation = validateResearchDraft(completedResearch);
  if (!validation.ok) {
    throw new Error(`Generated product research is invalid: ${validation.missing.join("; ")}`);
  }
  const readiness = assessProductReadiness(normalized, completedResearch, approveForProduction);
  normalized.wwx_readiness = readiness;
  const created = await createProductInStore({ productFolder: folder, config: normalized });
  await Promise.all([
    persistResearchFile(created.productId, "archetypes", completedResearch.archetypes),
    persistResearchFile(created.productId, "hotwords", completedResearch.hotwords),
    persistResearchFile(created.productId, "mechanisms", completedResearch.mechanisms),
    persistJsonArtifact(created.productId, "source-bundle.json", sourceBundle ?? {
      schema: "wwx-source-bundle/v1",
      documents: [
        { label: "config.json", content: JSON.stringify(config, null, 2) },
        { label: "research/archetypes.md", content: completedResearch.archetypes },
        { label: "research/hotwords.md", content: completedResearch.hotwords },
        { label: "research/mechanisms.md", content: completedResearch.mechanisms },
      ],
    }),
    persistJsonArtifact(created.productId, "product-readiness.json", {
      schema: "wwx-product-readiness/v1",
      ...readiness,
    }),
  ]);
  if (packageArtifacts) {
    await Promise.all([
      persistPackageFile(created.productId, "source-angle.md", "text/markdown", packageArtifacts.sourceAngle),
      persistPackageFile(created.productId, "angles.md", "text/markdown", packageArtifacts.angles),
      persistPackageFile(created.productId, "strategy.json", "application/json", packageArtifacts.strategyJson),
      persistPackageFile(created.productId, "operator-input.json", "application/json", packageArtifacts.operatorInputJson),
      persistPackageFile(created.productId, "readiness-assessment.json", "application/json", packageArtifacts.readinessAssessmentJson),
      persistPackageFile(created.productId, "concept-matrix.json", "application/json", packageArtifacts.conceptMatrixJson),
      persistPackageFile(created.productId, "product-package-report.json", "application/json", packageArtifacts.reportJson),
    ]);
  }
  return created;
}

export async function createWwxBatch({
  productFolder,
  batchName,
}: CreateBatchInput): Promise<CreatedBatch> {
  return createBatchInStore({ productId: productFolder, batchName });
}

export async function seedWwxBatchFromPackage(input: {
  productId: string;
  batchId: string;
  packageArtifacts: NonNullable<CreateProductInput["packageArtifacts"]>;
}): Promise<void> {
  const { productId, batchId, packageArtifacts } = input;
  await Promise.all([
    persistBatchFile(productId, batchId, "source-angle.md", "text/markdown", packageArtifacts.sourceAngle),
    persistBatchFile(productId, batchId, "angles.md", "text/markdown", packageArtifacts.angles),
    persistBatchFile(productId, batchId, "strategy.json", "application/json", packageArtifacts.strategyJson),
    persistBatchFile(productId, batchId, "operator-input.json", "application/json", packageArtifacts.operatorInputJson),
    persistBatchFile(productId, batchId, "readiness-assessment.json", "application/json", packageArtifacts.readinessAssessmentJson),
    persistBatchFile(productId, batchId, "concept-matrix.json", "application/json", packageArtifacts.conceptMatrixJson),
    persistBatchFile(productId, batchId, "product-package-report.json", "application/json", packageArtifacts.reportJson),
  ]);
}

function normalizeConfig(
  config: Record<string, unknown>,
  productFolder: string,
): Record<string, unknown> {
  const next = { ...config };
  const productCode = stringValue(next.product_code) || productCodeFromFolder(productFolder);
  if (!/^[A-Z][A-Z0-9-]*$/.test(productCode)) {
    throw new Error(
      `Product code ${productCode} is invalid for WW-2 task IDs. Use one token with no underscores, for example ANTESTS.`,
    );
  }
  next.product_code = productCode;
  if (!stringValue(next.product_name)) {
    next.product_name =
      stringValue(next.name) || stringValue(next.brand) || productFolder;
  }
  return completeProductConfig(next, productFolder);
}

export function safeSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function productCodeFromFolder(folder: string): string {
  const compact = folder.toUpperCase().replace(/[^A-Z0-9-]+/g, "");
  return compact || "PRODUCT";
}

async function persistResearchFile(
  productId: string,
  name: keyof ProductResearchDraft,
  contentText: string,
): Promise<void> {
  await writeWwxArtifact({
    productId,
    batchId: productId,
    kind: "research",
    label: `${name}.md`,
    filename: `research/${name}.md`,
    mimeType: "text/markdown",
    contentText,
    source: "product-create",
    public: false,
  });
}

async function persistJsonArtifact(
  productId: string,
  filename: string,
  value: Record<string, unknown>,
): Promise<void> {
  await writeWwxArtifact({
    productId,
    batchId: productId,
    kind: "json",
    label: filename,
    filename,
    mimeType: "application/json",
    contentText: JSON.stringify(value, null, 2),
    source: "product-create",
    public: false,
  });
}

async function persistPackageFile(
  productId: string,
  filename: string,
  mimeType: string,
  contentText: string,
): Promise<void> {
  await writeWwxArtifact({
    productId,
    batchId: productId,
    kind: filename.endsWith(".md") ? "markdown" : "json",
    label: filename,
    filename: `package/${filename}`,
    mimeType,
    contentText,
    source: "product-package",
    public: false,
  });
}

async function persistBatchFile(
  productId: string,
  batchId: string,
  filename: string,
  mimeType: string,
  contentText: string,
): Promise<void> {
  await writeWwxArtifact({
    productId,
    batchId,
    kind: filename.endsWith(".md") ? "markdown" : "json",
    label: filename,
    filename,
    mimeType,
    contentText,
    source: "product-package",
    public: true,
  });
}

import {
  createBatchInStore,
  createProductInStore,
  writeWwxArtifact,
  type CreatedBatch,
} from "./store";
import {
  validateProductConfig,
  type ProductConfigValidation,
  type ProductResearchDraft,
} from "./research";

export type { ProductResearchDraft } from "./research";

export type CreateProductInput = {
  workspaceRoot: string;
  productFolder?: string;
  config: Record<string, unknown>;
  // Legacy product-package fields are accepted so older internal callers do not
  // explode while the new drive-aligned path becomes primary. They are ignored.
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
}: CreateProductInput): Promise<{ productFolder: string; productPath: string; productCode: string; productId: string }> {
  const folder = safeSegment(
    productFolder ||
      stringValue(config.product_code) ||
      stringValue(config.brand) ||
      stringValue(config.product_name) ||
      "product",
  );
  const normalized = normalizeConfig(config, folder);
  const validation = validateProductConfig(normalized);
  if (!validation.ok) throw productValidationError(validation);
  normalized.wwx_readiness = {
    status: "draft",
    approved: false,
    gaps: ["research has not been run yet"],
  };
  const created = await createProductInStore({ productFolder: folder, config: normalized });
  await persistJsonArtifact(created.productId, "product-config-validation.json", {
    schema: "wwx-product-config-validation/v1",
    ...validation,
  });
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
  return next;
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

function productValidationError(validation: ProductConfigValidation): Error {
  return new Error(`Product config is invalid: ${validation.missing.join("; ")}`);
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
    source: "legacy-product-package",
    public: true,
  });
}

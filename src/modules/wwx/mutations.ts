import { createBatchInStore, createProductInStore, type CreatedBatch } from "./store";

export type CreateProductInput = {
  workspaceRoot: string;
  productFolder?: string;
  config: Record<string, unknown>;
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
  return createProductInStore({ productFolder: folder, config: normalized });
}

export async function createWwxBatch({
  productFolder,
  batchName,
}: CreateBatchInput): Promise<CreatedBatch> {
  return createBatchInStore({ productId: productFolder, batchName });
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

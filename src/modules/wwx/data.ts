import type { BatchSummary, CommandRecipe, WorkspaceSummary } from "./types";

export const LOCAL_WORKSPACE: WorkspaceSummary = {
  id: "account",
  name: "Creative Strategist Account",
  rootPath: "",
  visibility: "account",
  scopeLabel: "Account assets",
};

export const recipes: CommandRecipe[] = [
  {
    id: "create-ads",
    label: "Create Ads",
    command: "create_ads",
    description: "Start the autonomous blackbox LFS4.1 workflow from product, research, count, and constraints.",
    batchMode: "create_ads",
    requiresBatch: true,
  },
  {
    id: "status",
    label: "Batch Status",
    command: "get_batch_status",
    description: "Read the current stage, retry state, and sanitized blockers for a batch.",
    batchMode: "get_batch_status",
    requiresBatch: true,
  },
  {
    id: "asset-inputs",
    label: "Asset Inputs",
    command: "get_asset_inputs",
    description: "Return approved scripts and asset-generation fields for handoff.",
    batchMode: "get_asset_inputs",
    requiresBatch: true,
  },
  {
    id: "analyze-ads",
    label: "Analyze Ads",
    command: "analyze_ads",
    description: "Cluster duplicates and summarize tested angles, mechanisms, formats, and coverage.",
    batchMode: "analyze_ads",
    requiresBatch: true,
  },
  {
    id: "export-handoff",
    label: "Export Handoff",
    command: "export_handoff_package",
    description: "Export public final scripts, asset inputs, and batch analysis for the strategist.",
    batchMode: "export_handoff_package",
    requiresBatch: true,
  },
];

export function resolveRecipeCommand(
  recipe: CommandRecipe,
  batch?: BatchSummary | null,
): string {
  if (!recipe.batchMode || !batch) return recipe.command;

  switch (recipe.batchMode) {
    case "create_ads":
      return `create_ads(batch_id=${shellQuote(batch.id)})`;
    case "get_batch_status":
      return `get_batch_status(batch_id=${shellQuote(batch.id)})`;
    case "get_asset_inputs":
      return `get_asset_inputs(batch_id=${shellQuote(batch.id)})`;
    case "analyze_ads":
      return `analyze_ads(batch_id=${shellQuote(batch.id)})`;
    case "export_handoff_package":
      return `export_handoff_package(batch_id=${shellQuote(batch.id)})`;
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

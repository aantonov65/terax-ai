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
    id: "create-batch-from-angles",
    label: "Create Batch From Angles",
    command: "ww compile-angles products/PRODUCT/batches/BATCH/angles.md",
    description: "Compile angles.md into a product-scoped LFS/image batch.",
    batchMode: "compile-angles",
    requiresBatch: true,
  },
  {
    id: "run-lfs-images",
    label: "Run LFS + Images",
    command: "ww lfs-v41 products/PRODUCT/batches/BATCH/strategy.json && ww imagebatch BATCH",
    description: "Run the current batch through LFS V4.1, then image generation.",
    batchMode: "run-lfs-images",
    requiresBatch: true,
  },
  {
    id: "generate-images",
    label: "Generate Images",
    command: "ww imagebatch EXAMPLE_BATCH",
    description: "Generate or repair image assets inside the selected batch.",
    batchMode: "imagebatch",
    requiresBatch: true,
  },
  {
    id: "inspect-status",
    label: "Inspect Status",
    command: "ww status EXAMPLE_BATCH",
    description: "Inspect the current batch report from the terminal.",
    batchMode: "status",
    requiresBatch: true,
  },
  {
    id: "open-artifacts",
    label: "Open Artifacts",
    command: "python3 -m json.tool products/PRODUCT/batches/BATCH/wwx-artifacts.json",
    description: "Open the public artifact manifest for the selected batch.",
    batchMode: "open-artifacts",
    requiresBatch: true,
  },
];

export function resolveRecipeCommand(
  recipe: CommandRecipe,
  batch?: BatchSummary | null,
): string {
  if (!recipe.batchMode || !batch) return recipe.command;

  switch (recipe.batchMode) {
    case "compile-angles":
      return `ww compile-angles ${shellQuote(`${batch.path}/angles.md`)}`;
    case "run-lfs-images":
      return [
        `ww lfs-v41 ${shellQuote(batch.strategyPath ?? `${batch.path}/strategy.json`)}`,
        `ww imagebatch ${shellQuote(batch.id)}`,
      ].join(" && ");
    case "lfs-v41":
      return `ww lfs-v41 ${shellQuote(batch.strategyPath ?? `${batch.path}/strategy.json`)}`;
    case "status":
      return `ww status ${shellQuote(batch.id)}`;
    case "imagebatch":
      return `ww imagebatch ${shellQuote(batch.id)}`;
    case "open-artifacts":
      return `python3 -m json.tool ${shellQuote(`${batch.path}/wwx-artifacts.json`)}`;
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

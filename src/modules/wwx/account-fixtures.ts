import type { BatchSummary, ProductSummary, WorkspaceSummary } from "./types";

export const ACCOUNT_WORKSPACE: WorkspaceSummary = {
  id: "acct_demo",
  name: "Creative Strategist Account",
  rootPath: "",
  visibility: "account",
  scopeLabel: "Account assets",
};

const now = Date.now();

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const hairImage = svgDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1125" viewBox="0 0 900 1125">
  <rect width="900" height="1125" fill="#f4f0e8"/>
  <rect x="72" y="76" width="756" height="973" rx="28" fill="#202124"/>
  <rect x="112" y="116" width="676" height="893" rx="20" fill="#f7d7c4"/>
  <circle cx="450" cy="330" r="122" fill="#7a4b36"/>
  <rect x="342" y="445" width="216" height="312" rx="108" fill="#f0b99b"/>
  <rect x="318" y="662" width="264" height="150" rx="18" fill="#ffffff"/>
  <rect x="386" y="706" width="128" height="238" rx="20" fill="#111827"/>
  <rect x="420" y="746" width="60" height="156" rx="12" fill="#f9fafb"/>
  <text x="450" y="930" text-anchor="middle" font-family="Arial, sans-serif" font-size="54" font-weight="700" fill="#111827">Hair falling out?</text>
  <text x="450" y="988" text-anchor="middle" font-family="Arial, sans-serif" font-size="31" fill="#374151">account artifact preview</text>
</svg>`);

const sleepImage = svgDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">
  <rect width="1000" height="1000" fill="#eef2f7"/>
  <rect x="120" y="210" width="760" height="520" rx="36" fill="#d9c7ad"/>
  <rect x="236" y="324" width="528" height="300" rx="30" fill="#ffffff"/>
  <rect x="304" y="388" width="392" height="168" rx="24" fill="#111827"/>
  <text x="500" y="470" text-anchor="middle" font-family="Arial, sans-serif" font-size="52" font-weight="700" fill="#ffffff">Sleep Patch</text>
  <text x="500" y="536" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" fill="#d1d5db">account artifact preview</text>
  <circle cx="244" cy="224" r="78" fill="#f8fafc" opacity="0.9"/>
</svg>`);

const batches: BatchSummary[] = [
  {
    id: "HAIR_LFS_IMAGE_001",
    name: "HAIR_LFS_IMAGE_001",
    path: "wwx://account/acct_demo/products/WWX-Demo-Hair/batches/HAIR_LFS_IMAGE_001",
    product: "WWX Demo Hair Serum",
    productCode: "WWX-Demo-Hair",
    format: "podcast + image",
    status: "complete",
    updatedAt: now - 90_000,
    totalScripts: 1,
    decisionCounts: { ship: 1, review: 0, fail: 0 },
    alerts: [],
    runs: [
      {
        id: "acct-run-hair-lfs",
        batchId: "HAIR_LFS_IMAGE_001",
        label: "LFS V4.1",
        status: "complete",
        stage: "objective finish final",
        lastEvent: "stage_finished",
        updatedAt: now - 95_000,
      },
      {
        id: "acct-run-hair-images",
        batchId: "HAIR_LFS_IMAGE_001",
        label: "Images",
        status: "complete",
        stage: "image generation",
        lastEvent: "artifact_created",
        updatedAt: now - 90_000,
      },
    ],
    artifacts: [
      {
        id: "acct-hair-angles",
        batchId: "HAIR_LFS_IMAGE_001",
        label: "Angles",
        path: "wwx://account/acct_demo/artifacts/HAIR_LFS_IMAGE_001/angles.md",
        kind: "angles",
        source: "account",
        content:
          "# Angle\n\nHair falling out after every shower, but the clip opens a loop around what she noticed near the roots.\n\n# Notes\n\nPodcast style, third person POV, one avatar only.",
      },
      {
        id: "acct-hair-script",
        batchId: "HAIR_LFS_IMAGE_001",
        label: "output-v41/HAIR_ANCHOR_001.md",
        path: "wwx://account/acct_demo/artifacts/HAIR_LFS_IMAGE_001/output-v41/HAIR_ANCHOR_001.md",
        kind: "markdown",
        source: "account",
        content:
          "# HAIR_ANCHOR_001\n\nHair falling out was the part that made this clip go viral.\n\nThe woman on the podcast is talking about a friend who thought the shower drain was the whole story, until she noticed the same thing happening around her roots every time she brushed her hair.\n\nJust watch this clip / it explains things way better than I do.",
      },
      {
        id: "acct-hair-image",
        batchId: "HAIR_LFS_IMAGE_001",
        label: "images/podcast_thumb_01.svg",
        path: "wwx://account/acct_demo/artifacts/HAIR_LFS_IMAGE_001/images/podcast_thumb_01.svg",
        kind: "image",
        source: "account",
        dataUrl: hairImage,
      },
      {
        id: "acct-hair-summary",
        batchId: "HAIR_LFS_IMAGE_001",
        label: "batch-summary.json",
        path: "wwx://account/acct_demo/artifacts/HAIR_LFS_IMAGE_001/batch-summary.json",
        kind: "report",
        source: "account",
        visibilityClass: "public_summary",
        content: JSON.stringify(
          {
            schema: "wwx-public-batch-summary/v1",
            batch_id: "HAIR_LFS_IMAGE_001",
            total_ads: 1,
            decision_counts: { ship: 1, review: 0, fail: 0 },
            formats: ["podcast"],
            duplicate_clusters: [],
          },
          null,
          2,
        ),
      },
    ],
  },
  {
    id: "HAIR_REPAIR_002",
    name: "HAIR_REPAIR_002",
    path: "wwx://account/acct_demo/products/WWX-Demo-Hair/batches/HAIR_REPAIR_002",
    product: "WWX Demo Hair Serum",
    productCode: "WWX-Demo-Hair",
    format: "podcast",
    status: "review",
    updatedAt: now - 40_000,
    totalScripts: 1,
    decisionCounts: { ship: 0, review: 1, fail: 0 },
    alerts: ["CTA tone needs repair before this script can ship."],
    runs: [
      {
        id: "acct-run-hair-repair",
        batchId: "HAIR_REPAIR_002",
        label: "LFS V4.1",
        status: "blocked",
        stage: "objective finish final",
        lastEvent: "CTA tone needs repair",
        updatedAt: now - 40_000,
      },
    ],
    artifacts: [
      {
        id: "acct-repair-script",
        batchId: "HAIR_REPAIR_002",
        label: "output-v41/HAIR_REPAIR_002_A.md",
        path: "wwx://account/acct_demo/artifacts/HAIR_REPAIR_002/output-v41/HAIR_REPAIR_002_A.md",
        kind: "markdown",
        source: "account",
        content:
          "# HAIR_REPAIR_002_A\n\nThinning hair is why this clip started spreading.\n\nThe unresolved piece is how follicle anchoring peptides support the look of thicker roots.\n\nWatch now.",
      },
      {
        id: "acct-repair-summary",
        batchId: "HAIR_REPAIR_002",
        label: "batch-summary.json",
        path: "wwx://account/acct_demo/artifacts/HAIR_REPAIR_002/batch-summary.json",
        kind: "report",
        source: "account",
        visibilityClass: "public_summary",
        content: JSON.stringify(
          {
            schema: "wwx-public-batch-summary/v1",
            batch_id: "HAIR_REPAIR_002",
            total_ads: 1,
            decision_counts: { ship: 0, review: 1, fail: 0 },
            duplicate_clusters: [],
            public_blocker: "CTA tone needs repair",
          },
          null,
          2,
        ),
      },
    ],
  },
  {
    id: "SLEEP_IMAGES_001",
    name: "SLEEP_IMAGES_001",
    path: "wwx://account/acct_demo/products/WWX-Demo-Sleep/batches/SLEEP_IMAGES_001",
    product: "WWX Demo Sleep Patches",
    productCode: "WWX-Demo-Sleep",
    format: "image",
    status: "complete",
    updatedAt: now - 20_000,
    alerts: [],
    runs: [
      {
        id: "acct-run-sleep-images",
        batchId: "SLEEP_IMAGES_001",
        label: "Images",
        status: "complete",
        stage: "image generation",
        lastEvent: "artifact_created",
        updatedAt: now - 20_000,
      },
    ],
    artifacts: [
      {
        id: "acct-sleep-image",
        batchId: "SLEEP_IMAGES_001",
        label: "images/bedside_patch_01.svg",
        path: "wwx://account/acct_demo/artifacts/SLEEP_IMAGES_001/images/bedside_patch_01.svg",
        kind: "image",
        source: "account",
        dataUrl: sleepImage,
      },
      {
        id: "acct-sleep-asset-inputs",
        batchId: "SLEEP_IMAGES_001",
        label: "asset-inputs.json",
        path: "wwx://account/acct_demo/artifacts/SLEEP_IMAGES_001/asset-inputs.json",
        kind: "json",
        source: "account",
        visibilityClass: "public_asset_input",
        content: JSON.stringify(
          {
            schema: "wwx-asset-inputs/v1",
            batch_id: "SLEEP_IMAGES_001",
            ads: [
              {
                task_id: "SLEEP_IMAGES_001",
                asset_readiness: {
                  scene: "bedside patch product reveal",
                  product_reveal: "sleep patch on bedside table",
                },
              },
            ],
          },
          null,
          2,
        ),
      },
    ],
  },
];

const products: ProductSummary[] = [
  {
    id: "WWX-Demo-Hair",
    code: "WWX-Demo-Hair",
    name: "WWX Demo Hair Serum",
    path: "wwx://account/acct_demo/products/WWX-Demo-Hair",
    batchCount: 2,
    statusCounts: { draft: 0, ready: 0, running: 0, review: 1, complete: 1, blocked: 0, unknown: 0 },
    updatedAt: now - 40_000,
    batches: batches.filter((batch) => batch.productCode === "WWX-Demo-Hair"),
  },
  {
    id: "WWX-Demo-Sleep",
    code: "WWX-Demo-Sleep",
    name: "WWX Demo Sleep Patches",
    path: "wwx://account/acct_demo/products/WWX-Demo-Sleep",
    batchCount: 1,
    statusCounts: { draft: 0, ready: 0, running: 0, review: 0, complete: 1, blocked: 0, unknown: 0 },
    updatedAt: now - 20_000,
    batches: batches.filter((batch) => batch.productCode === "WWX-Demo-Sleep"),
  },
];

export function getAccountFixtures() {
  return { products, batches };
}

import type { Artifact, VisibilityClass } from "./model.js";

const SECRET_PATTERNS = [
  "system prompt",
  "developer message",
  "lfs prompt",
  "prompt template",
  "outline",
  "raw model",
  "qa rubric",
  "hidden report",
  "backend template",
  "environment variable",
  "secret key",
  "canary",
  "hidden_read",
  "../",
  "..\\",
];

export function classifyVisibility(filename: string, requestedPublic: boolean): VisibilityClass {
  const raw = filename.trim();
  const isPublicResearchSummary = /^research-runs\/[^/]+\/(archetypes|hotwords|mechanisms)\.md$/.test(raw) ||
    /^research-runs\/[^/]+\/(cards-report|queries|summary)\.json$/.test(raw) ||
    /^research-runs\/[^/]+\/README\.md$/.test(raw);
  if (
    raw.startsWith("/") ||
    raw.includes("\\") ||
    raw.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    return "engine_secret";
  }
  if (
    raw.startsWith("prompts/") ||
    raw.startsWith("outlines/") ||
    raw === "strategy.json" ||
    raw === "spec.json" ||
    raw === "lfs-v41-manifest.json" ||
    (raw.endsWith("-report.json") && !isPublicResearchSummary) ||
    raw === "batch-research-code-map.json"
  ) {
    return "engine_secret";
  }
  if (!requestedPublic) return "technical_hidden";
  if (raw.startsWith("output-v41/") && raw.endsWith(".md")) return "public_final";
  if (raw === "asset-inputs.json" || raw === "handoff-package.json" || raw.startsWith("images/")) {
    return "public_asset_input";
  }
  if (isPublicResearchSummary) {
    return "public_summary";
  }
  if (raw === "batch-summary.json" || raw === "ad-analysis-index.json" || raw === "research-selection.json") {
    return "public_summary";
  }
  return "technical_hidden";
}

export function isPublicArtifact(artifact: Artifact): boolean {
  return artifact.visibilityClass.startsWith("public_");
}

export function isSecretQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return SECRET_PATTERNS.some((needle) => q.includes(needle)) ||
    (q.includes("base64") && (q.includes("prompt") || q.includes("template") || q.includes("secret")));
}

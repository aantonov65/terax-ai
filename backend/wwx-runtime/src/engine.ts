import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CreateAdsInput, EngineWorkItem, ResearchWorkflowInput, StrategyWorkflowInput } from "./model.js";

export type Engine = {
  planCreateAds(input: CreateAdsInput): EngineWorkItem[];
};

export class FakeLfsEngine implements Engine {
  planCreateAds(input: CreateAdsInput): EngineWorkItem[] {
    const count = Math.max(1, Math.min(input.adCount || 1, 50));
    const items: EngineWorkItem[] = [];
    for (let i = 1; i <= count; i += 1) {
      const taskId = `LFS_${String(i).padStart(3, "0")}`;
      items.push({
        stage: "lfs_generation",
        itemKey: taskId,
        filename: `output-v41/${taskId}.md`,
        label: `Final Ad ${i}`,
        visibilityClass: "public_final",
        mimeType: "text/markdown",
        content: [
          `# ${taskId}`,
          "",
          `Hair loss is why this clip ${i} started spreading.`,
          "",
          "The woman on the podcast explains the pattern without giving away the hidden backend workflow.",
          "",
          "Just watch this clip / it explains things way better than I do.",
        ].join("\n"),
      });
    }
    return items;
  }
}

export class LegacyLfs41Engine implements Engine {
  constructor(
    private readonly engineRoot: string,
    private readonly workRoot = tmpdir(),
  ) {}

  planCreateAds(input: CreateAdsInput): EngineWorkItem[] {
    const root = mkdtempSync(join(this.workRoot, "wwx-lfs41-"));
    try {
      const sourcePath = this.writeSource(root, input);
      const python = this.pythonBin();
      const args = [join(this.engineRoot, "tools", "lfs_agent.py"), sourcePath];
      args.push(input.runMode === "full" ? "--yolo" : "--app-step");
      args.push("--base-path", root);
      if (input.workers) args.push("--workers", String(input.workers));
      if (input.generationWorkers) args.push("--generation-workers", String(input.generationWorkers));
      if (input.fromStage) args.push("--from", input.fromStage);

      const output = spawnSync(python, args, {
        cwd: this.engineRoot,
        encoding: "utf8",
        env: process.env,
        maxBuffer: 1024 * 1024 * 100,
      });
      if (output.error) throw output.error;
      if (output.status !== 0) {
        throw new Error(`LFS41_RUN_FAILED:${output.status ?? "unknown"}`);
      }
      return this.readFinalOutputs(root, input);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  runResearchPipeline(input: ResearchWorkflowInput): { items: EngineWorkItem[]; searchTerms: string[]; quality: Record<string, unknown> } {
    const root = mkdtempSync(join(this.workRoot, "wwx-research-"));
    try {
      const productCode = productCodeFrom(input.productCode ?? input.productId);
      const productDir = join(root, "products", productCode);
      mkdirSync(join(productDir, "research"), { recursive: true });
      writeFileSync(join(productDir, "config.json"), stringifyJson(input.configJson ?? { product_code: productCode, name: input.productName ?? input.productId }));

      this.runWw(["research", productCode, "--topic", input.topic.trim(), "--base-path", root]);
      const researchRoot = join(productDir, "research");
      const runDir = latestResearchRunDir(researchRoot);
      if (!runDir) throw new Error("RESEARCH_RUN_FOLDER_MISSING");
      this.runWw(["research", "synthesize", productCode, "--from", runDir, "--base-path", root]);
      this.runWw(["research-cards", productCode, "--force", "--base-path", root]);
      this.runWw(["research-cards", productCode, "--verify", "--base-path", root]);

      const runFolder = basename(runDir);
      const items: EngineWorkItem[] = [];
      for (const name of ["archetypes.md", "hotwords.md", "mechanisms.md", "cards-report.json"]) {
        pushFile(items, "research", join(researchRoot, name), `research/${name}`, name, "technical_hidden");
      }
      for (const name of ["README.md", "queries.json", "filtered_threads.json", "filtered-corpus.md", "opus-analysis.md", "opus-usage.txt", "summary.json"]) {
        pushFile(items, "research", join(runDir, name), `research-runs/${runFolder}/${name}`, name, "technical_hidden");
      }
      return {
        items,
        searchTerms: researchSearchTerms(runDir, input.topic),
        quality: researchQuality(researchRoot),
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  runStrategyBuild(input: StrategyWorkflowInput): { strategyJson: string; items: EngineWorkItem[] } {
    const root = mkdtempSync(join(this.workRoot, "wwx-strategy-"));
    try {
      const productCode = productCodeFrom(input.productCode ?? input.productId);
      this.linkStaticRuntimeDirs(root);
      const productDir = join(root, "products", productCode);
      const batchDir = join(productDir, "batches", input.batchId);
      const researchDir = join(productDir, "research");
      mkdirSync(batchDir, { recursive: true });
      mkdirSync(researchDir, { recursive: true });
      writeFileSync(join(productDir, "config.json"), stringifyJson(input.configJson ?? { product_code: productCode, name: input.productName ?? input.productId }));
      if (input.researchFiles?.archetypes) writeFileSync(join(researchDir, "archetypes.md"), input.researchFiles.archetypes);
      if (input.researchFiles?.hotwords) writeFileSync(join(researchDir, "hotwords.md"), input.researchFiles.hotwords);
      if (input.researchFiles?.mechanisms) writeFileSync(join(researchDir, "mechanisms.md"), input.researchFiles.mechanisms);

      const planPath = join(batchDir, "strategy-plan.json");
      writeFileSync(planPath, stringifyJson(input.strategyPlanJson));
      this.runWw(["research-cards", productCode, "--force", "--base-path", root]);
      this.runWw(["research-cards", productCode, "--verify", "--base-path", root]);
      this.runWw([
        "strategy",
        "build",
        "--product",
        productCode,
        "--batch-id",
        input.batchId,
        "--plan",
        planPath,
        "--force",
        "--base-path",
        root,
      ]);

      const strategyPath = join(batchDir, "strategy.json");
      if (!existsSync(strategyPath)) throw new Error("STRATEGY_OUTPUT_MISSING");
      const strategyJson = readFileSync(strategyPath, "utf8");
      return {
        strategyJson,
        items: [
          {
            stage: "strategy",
            itemKey: "strategy-plan",
            filename: "strategy-plan.json",
            label: "Strategy Plan",
            visibilityClass: "technical_hidden",
            mimeType: "application/json",
            content: readFileSync(planPath, "utf8"),
          },
          {
            stage: "strategy",
            itemKey: "strategy-json",
            filename: "strategy.json",
            label: "Strategy JSON",
            visibilityClass: "engine_secret",
            mimeType: "application/json",
            content: strategyJson,
          },
        ],
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  private writeSource(root: string, input: CreateAdsInput): string {
    if (input.strategyPath) return input.strategyPath;
    if (input.strategyJson) {
      const path = join(root, "strategy.json");
      const body = typeof input.strategyJson === "string" ? input.strategyJson : JSON.stringify(input.strategyJson, null, 2);
      writeFileSync(path, body);
      return path;
    }
    if (input.anglesMarkdown) {
      const path = join(root, "angles.md");
      writeFileSync(path, input.anglesMarkdown);
      return path;
    }
    throw new Error("LFS41_INPUT_MISSING");
  }

  private readFinalOutputs(root: string, input: CreateAdsInput): EngineWorkItem[] {
    const batchId = input.batchId ?? this.batchIdFromInput(input) ?? this.onlyBatchDir(root);
    if (!batchId) throw new Error("LFS41_BATCH_NOT_FOUND");
    const outputDir = join(root, "batches", batchId, "output-v41");
    if (!existsSync(outputDir)) throw new Error("LFS41_OUTPUT_MISSING");
    const files = readdirSync(outputDir)
      .filter((name) => name.endsWith(".md"))
      .sort((a, b) => a.localeCompare(b));
    if (!files.length) throw new Error("LFS41_FINAL_ADS_MISSING");
    return files.map((file, index) => ({
      stage: "lfs_generation",
      itemKey: file.replace(/\.md$/, "") || `LFS_${String(index + 1).padStart(3, "0")}`,
      filename: `output-v41/${file}`,
      label: file,
      visibilityClass: "public_final",
      mimeType: "text/markdown",
      content: readFileSync(join(outputDir, file), "utf8"),
    }));
  }

  private batchIdFromInput(input: CreateAdsInput): string | null {
    const raw = typeof input.strategyJson === "string"
      ? safeJson(input.strategyJson)
      : input.strategyJson;
    const batchId = raw?.batch_id ?? raw?.batchId;
    return typeof batchId === "string" && batchId.trim() ? batchId.trim() : null;
  }

  private onlyBatchDir(root: string): string | null {
    const batchesDir = join(root, "batches");
    if (!existsSync(batchesDir)) return null;
    const entries = readdirSync(batchesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    return entries.length === 1 ? basename(entries[0].name) : null;
  }

  private pythonBin(): string {
    if (process.env.WWX_PYTHON_BIN) return process.env.WWX_PYTHON_BIN;
    const venvPython = join(this.engineRoot, ".venv", "bin", "python");
    return existsSync(venvPython) ? venvPython : "python3";
  }

  private runWw(args: string[]): void {
    const output = spawnSync(join(this.engineRoot, "tools", "ww"), args, {
      cwd: this.engineRoot,
      encoding: "utf8",
      env: { ...process.env, WW_BASE_PATH: basePathFromArgs(args) ?? process.env.WW_BASE_PATH ?? this.engineRoot },
      maxBuffer: 1024 * 1024 * 100,
    });
    if (output.error) throw output.error;
    if (output.status !== 0) {
      throw new Error(`WW_COMMAND_FAILED:${args.slice(0, 2).join("_")}:${output.status ?? "unknown"}`);
    }
  }

  private linkStaticRuntimeDirs(root: string): void {
    for (const name of ["components", "formats"]) {
      const source = join(this.engineRoot, name);
      const target = join(root, name);
      if (!existsSync(source) || existsSync(target)) continue;
      try {
        symlinkSync(source, target, "dir");
      } catch {
        cpSync(source, target, { recursive: true });
      }
    }
  }
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringifyJson(value: Record<string, unknown> | string): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function productCodeFrom(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase() || "PRODUCT";
}

function latestResearchRunDir(researchRoot: string): string | null {
  if (!existsSync(researchRoot)) return null;
  const dirs = readdirSync(researchRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("ww-research-"))
    .map((entry) => join(researchRoot, entry.name))
    .sort();
  return dirs.at(-1) ?? null;
}

function pushFile(
  items: EngineWorkItem[],
  stage: string,
  path: string,
  filename: string,
  label: string,
  visibilityClass: EngineWorkItem["visibilityClass"],
): void {
  if (!existsSync(path)) return;
  items.push({
    stage,
    itemKey: filename,
    filename,
    label,
    visibilityClass,
    mimeType: filename.endsWith(".json") ? "application/json" : "text/markdown",
    content: readFileSync(path, "utf8"),
  });
}

function researchSearchTerms(runDir: string, topic: string): string[] {
  const terms = [topic.trim()].filter(Boolean);
  const queriesPath = join(runDir, "queries.json");
  if (existsSync(queriesPath)) {
    try {
      const parsed = JSON.parse(readFileSync(queriesPath, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const value = typeof item === "string"
            ? item
            : item && typeof item === "object" && "query" in item && typeof item.query === "string"
              ? item.query
              : null;
          if (value) terms.push(value);
        }
      }
    } catch {
      // Ignore malformed query exports; the research run itself remains valid.
    }
  }
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}

function researchQuality(researchRoot: string): Record<string, unknown> {
  return {
    archetype_count: sectionCount(join(researchRoot, "archetypes.md"), "ARC"),
    hotword_a_count: sectionCount(join(researchRoot, "hotwords.md"), "A"),
    hotword_b_count: sectionCount(join(researchRoot, "hotwords.md"), "B"),
    mechanism_count: sectionCount(join(researchRoot, "mechanisms.md"), "M"),
  };
}

function sectionCount(path: string, prefix: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split(/\r?\n/).filter((line) => {
    const clean = line.replace(/^#+/, "").trimStart();
    return clean.startsWith(prefix) && /\d/.test(clean.slice(prefix.length, prefix.length + 1));
  }).length;
}

function basePathFromArgs(args: string[]): string | null {
  const index = args.indexOf("--base-path");
  return index >= 0 ? args[index + 1] ?? null : null;
}

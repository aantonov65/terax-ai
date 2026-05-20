import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CreateAdsInput, EngineWorkItem } from "./model.js";

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
    const venvPython = join(this.engineRoot, ".venv", "bin", "python");
    return existsSync(venvPython) ? venvPython : "python3";
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

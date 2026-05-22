import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { CreateAdsInput, EngineWorkItem, ResearchWorkflowInput, StrategyWorkflowInput } from "./model.js";

export class EngineRunError extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "EngineRunError";
  }
}

export type Engine = {
  planCreateAds(input: CreateAdsInput): EngineWorkItem[] | Promise<EngineWorkItem[]>;
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
  ) {
    this.engineRoot = resolve(engineRoot);
  }

  async planCreateAds(input: CreateAdsInput): Promise<EngineWorkItem[]> {
    const chunks = chunkedCreateAdsInputs(input);
    if (chunks.length > 1) {
      const allItems: EngineWorkItem[] = [];
      for (const chunk of chunks) {
        console.error("Running hosted LFS chunk", {
          batchId: input.batchId,
          chunk: chunk.index,
          chunks: chunks.length,
          adCount: chunk.adCount,
        });
        allItems.push(...await this.planCreateAdsOnce(chunk.input));
      }
      return uniqueItems(allItems);
    }
    return this.planCreateAdsOnce(input);
  }

  private async planCreateAdsOnce(input: CreateAdsInput): Promise<EngineWorkItem[]> {
    const root = this.makeTempRoot("wwx-lfs41-");
    try {
      const sourcePath = this.writeSource(root, input);
      const python = this.pythonBin();
      this.linkStaticRuntimeDirs(root);
      this.writeRuntimeContext(root, input);
      const args = [join(this.engineRoot, "tools", "lfs_agent.py"), sourcePath];
      args.push(input.runMode === "full" ? "--yolo" : "--app-step");
      args.push("--base-path", root);
      args.push("--workers", String(input.workers ?? hostedLfsWorkers()));
      args.push("--generation-workers", String(input.generationWorkers ?? hostedLfsGenerationWorkers()));
      if (input.fromStage) args.push("--from", input.fromStage);

      await this.runPythonLfs(python, args);
      return this.readFinalOutputs(root, input);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  runResearchPipeline(input: ResearchWorkflowInput): { items: EngineWorkItem[]; searchTerms: string[]; quality: Record<string, unknown> } {
    const root = this.makeTempRoot("wwx-research-");
    try {
      const productCode = productCodeFrom(input.productCode ?? input.productId);
      const productDir = join(root, "products", productCode);
      mkdirSync(join(productDir, "research"), { recursive: true });
      writeFileSync(join(productDir, "config.json"), stringifyJson(input.configJson ?? { product_code: productCode, name: input.productName ?? input.productId }));

      const maxThreads = parsePositiveInt(process.env.WWX_RESEARCH_MAX_THREADS, 24);
      this.runWw(
        ["research", productCode, "--topic", input.topic.trim(), "--max-threads", String(maxThreads), "--base-path", root],
        { timeoutMs: parsePositiveInt(process.env.WWX_RESEARCH_COMMAND_TIMEOUT_MS, 10 * 60 * 1000), env: hostedResearchEnv() },
      );
      const researchRoot = join(productDir, "research");
      const runDir = latestResearchRunDir(researchRoot);
      if (!runDir) throw new Error("RESEARCH_RUN_FOLDER_MISSING");
      this.runWw(
        ["research", "synthesize", productCode, "--from", runDir, "--base-path", root],
        { timeoutMs: parsePositiveInt(process.env.WWX_SYNTHESIS_COMMAND_TIMEOUT_MS, 10 * 60 * 1000), env: hostedResearchEnv() },
      );
      this.runWw(["research-cards", productCode, "--force", "--base-path", root], { timeoutMs: 60_000 });
      this.runWw(["research-cards", productCode, "--verify", "--base-path", root], { timeoutMs: 60_000 });

      const runFolder = basename(runDir);
      const items: EngineWorkItem[] = [];
      for (const name of ["archetypes.md", "hotwords.md", "mechanisms.md", "cards-report.json"]) {
        pushFile(items, "research", join(researchRoot, name), `research-runs/${runFolder}/${name}`, name, "public_summary");
      }
      for (const name of ["README.md", "queries.json", "summary.json"]) {
        pushFile(items, "research", join(runDir, name), `research-runs/${runFolder}/${name}`, name, "public_summary");
      }
      for (const name of ["filtered_threads.json", "filtered-corpus.md", "opus-analysis.md", "opus-usage.txt"]) {
        pushFile(items, "research", join(runDir, name), `research-runs/${runFolder}/${name}`, name, "technical_hidden", {
          maxBytes: hiddenArtifactMaxBytes(),
        });
      }
      return {
        items,
        searchTerms: researchSearchTerms(runDir, input.topic),
        quality: { ...researchQuality(researchRoot), runFolder },
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  runStrategyBuild(input: StrategyWorkflowInput): { strategyJson: string; items: EngineWorkItem[] } {
    const root = this.makeTempRoot("wwx-strategy-");
    try {
      const productCode = productCodeFrom(input.productCode ?? input.productId);
      this.linkStaticRuntimeDirs(root);
      const productDir = this.productDir(root, productCode);
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

  private makeTempRoot(prefix: string): string {
    mkdirSync(this.workRoot, { recursive: true });
    return mkdtempSync(join(this.workRoot, prefix));
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
    const batchIds = this.outputBatchCandidates(root, input);
    if (!batchIds.length) throw new Error("LFS41_BATCH_NOT_FOUND");
    const outputDir = batchIds.map((batchId) => this.outputDirFor(root, batchId)).find((candidate) => existsSync(candidate));
    if (!outputDir) throw new Error("LFS41_OUTPUT_MISSING");
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

  private outputDirFor(root: string, batchId: string): string {
    const legacy = join(root, "batches", batchId, "output-v41");
    if (existsSync(legacy)) return legacy;
    const productsDir = join(root, "products");
    if (existsSync(productsDir)) {
      for (const entry of readdirSync(productsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(productsDir, entry.name, "batches", batchId, "output-v41");
        if (existsSync(candidate)) return candidate;
      }
    }
    return legacy;
  }

  private batchIdFromInput(input: CreateAdsInput): string | null {
    const raw = typeof input.strategyJson === "string"
      ? safeJson(input.strategyJson)
      : input.strategyJson;
    const batchId = raw?.batch_id ?? raw?.batchId;
    return typeof batchId === "string" && batchId.trim() ? batchId.trim() : null;
  }

  private outputBatchCandidates(root: string, input: CreateAdsInput): string[] {
    return [...new Set([
      input.batchId,
      this.batchIdFromInput(input),
      this.onlyBatchDir(root),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
  }

  private onlyBatchDir(root: string): string | null {
    const batchesDir = join(root, "batches");
    if (!existsSync(batchesDir)) return null;
    const entries = readdirSync(batchesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    return entries.length === 1 ? basename(entries[0].name) : null;
  }

  private pythonBin(): string {
    const configured = validExecutablePath(process.env.PYTHON_BIN_PATH) ?? validExecutablePath(process.env.WWX_PYTHON_BIN);
    if (configured) return configured;
    const venvPython = join(this.engineRoot, ".venv", "bin", "python");
    return existsSync(venvPython) ? venvPython : "python3";
  }

  private runWw(args: string[], options: { timeoutMs?: number; env?: Record<string, string> } = {}): void {
    const python = validExecutablePath(process.env.WW_PYTHON)
      ?? validExecutablePath(process.env.PYTHON_BIN_PATH)
      ?? validExecutablePath(process.env.WWX_PYTHON_BIN);
    const wwBin = join(this.engineRoot, "tools", "ww");
    if (!existsSync(wwBin)) throw new Error("WW_ENGINE_BINARY_MISSING");
    try {
      chmodSync(wwBin, 0o755);
    } catch {
      // Some deployment filesystems disallow chmod; keep going and let spawn report the actual failure.
    }
    const output = spawnSync(wwBin, args, {
      cwd: this.engineRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...options.env,
        ...(python ? { WW_PYTHON: python } : {}),
        WW_BASE_PATH: basePathFromArgs(args) ?? process.env.WW_BASE_PATH ?? this.engineRoot,
      },
      timeout: options.timeoutMs,
      maxBuffer: subprocessMaxBufferBytes(),
    });
    if (output.error) {
      const timedOut = output.signal === "SIGTERM" && options.timeoutMs;
      console.error("WW command errored", {
        command: args.slice(0, 2).join(" "),
        error: timedOut ? "ETIMEDOUT" : output.error.name,
        message: sanitizeSubprocessOutput(output.error.message),
        signal: output.signal ?? undefined,
        stdout: sanitizeSubprocessOutput(output.stdout),
        stderr: sanitizeSubprocessOutput(output.stderr),
      });
      if (timedOut || output.error.name === "ETIMEDOUT") {
        throw new Error(`WW_COMMAND_TIMEOUT:${args.slice(0, 2).join("_")}`);
      }
      throw output.error;
    }
    if (output.status !== 0) {
      console.error("WW command failed", {
        command: args.slice(0, 2).join(" "),
        status: output.status ?? "unknown",
        stdout: sanitizeSubprocessOutput(output.stdout),
        stderr: sanitizeSubprocessOutput(output.stderr),
      });
      throw new Error(`WW_COMMAND_FAILED:${args.slice(0, 2).join("_")}:${output.status ?? "unknown"}`);
    }
  }

  private runPythonLfs(python: string, args: string[]): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(python, args, {
        cwd: this.engineRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdoutTail = "";
      let stderrTail = "";
      let timedOut = false;
      const timeoutMs = parsePositiveInt(process.env.WWX_LFS_COMMAND_TIMEOUT_MS, 90 * 60 * 1000);
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      }, timeoutMs);
      timeout.unref();

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutTail = appendTail(stdoutTail, chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = appendTail(stderrTail, chunk.toString("utf8"));
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (timedOut) {
        console.error("LFS command timed out", {
          signal: signal ?? undefined,
          stdout: sanitizeSubprocessOutput(stdoutTail),
          stderr: sanitizeSubprocessOutput(stderrTail),
        });
          reject(new EngineRunError("LFS41_RUN_TIMEOUT", {
            signal: signal ?? undefined,
            stdout_tail: sanitizeSubprocessOutput(stdoutTail),
            stderr_tail: sanitizeSubprocessOutput(stderrTail),
          }));
          return;
        }
        if (code !== 0) {
          const stdout = sanitizeSubprocessOutput(stdoutTail);
          const stderr = sanitizeSubprocessOutput(stderrTail);
          console.error("LFS command failed", {
            status: code ?? "unknown",
            signal: signal ?? undefined,
            stdout,
            stderr,
          });
          reject(new EngineRunError(`LFS41_RUN_FAILED:${code ?? "unknown"}`, {
            status: code ?? "unknown",
            signal: signal ?? undefined,
            stdout_tail: stdout,
            stderr_tail: stderr,
          }));
          return;
        }
        resolvePromise();
      });
    });
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

  private writeRuntimeContext(root: string, input: CreateAdsInput): void {
    const strategy = typeof input.strategyJson === "string" ? safeJson(input.strategyJson) : input.strategyJson;
    const productCode = stringValue(strategy?.product) ?? productCodeFrom(input.productId);
    for (const productDir of this.productDirs(root, productCode)) {
      const researchDir = join(productDir, "research");
      mkdirSync(researchDir, { recursive: true });
      if (input.configJson) {
        writeFileSync(join(productDir, "config.json"), stringifyJson(input.configJson));
      }
      if (input.researchFiles?.archetypes) writeFileSync(join(researchDir, "archetypes.md"), input.researchFiles.archetypes);
      if (input.researchFiles?.hotwords) writeFileSync(join(researchDir, "hotwords.md"), input.researchFiles.hotwords);
      if (input.researchFiles?.mechanisms) writeFileSync(join(researchDir, "mechanisms.md"), input.researchFiles.mechanisms);
    }
  }

  private productDir(root: string, productCode: string): string {
    return join(root, "products", this.productFolder(productCode));
  }

  private productDirs(root: string, productCode: string): string[] {
    return [...new Set([productCode, this.productFolder(productCode)])].map((folder) => join(root, "products", folder));
  }

  private productFolder(productCode: string): string {
    const contextPath = join(this.engineRoot, "tools", "context.py");
    if (!existsSync(contextPath)) return productCode;
    const text = readFileSync(contextPath, "utf8");
    const escaped = productCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`[\"']${escaped}[\"']\\s*:\\s*[\"']([^\"']+)[\"']`));
    return match?.[1] ?? productCode;
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

function chunkedCreateAdsInputs(input: CreateAdsInput): Array<{ index: number; adCount: number; input: CreateAdsInput }> {
  const strategy = typeof input.strategyJson === "string" ? safeJson(input.strategyJson) : input.strategyJson;
  if (!strategy || typeof strategy !== "object") return [{ index: 1, adCount: input.adCount || 1, input }];
  const ads = strategy.ads;
  if (!Array.isArray(ads) || ads.length === 0) return [{ index: 1, adCount: input.adCount || 1, input }];
  const chunkSize = lfsChunkSize();
  if (ads.length <= chunkSize) return [{ index: 1, adCount: ads.length, input }];

  const chunks: Array<{ index: number; adCount: number; input: CreateAdsInput }> = [];
  for (let offset = 0; offset < ads.length; offset += chunkSize) {
    const chunkAds = ads.slice(offset, offset + chunkSize);
    const taskIds = chunkAds
      .map((ad) => ad && typeof ad === "object" && !Array.isArray(ad) ? (ad as Record<string, unknown>).task_id : null)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const chunkStrategy = JSON.parse(JSON.stringify(strategy)) as Record<string, unknown>;
    chunkStrategy.ads = chunkAds;
    chunkStrategy.task_ids = taskIds;
    chunks.push({
      index: chunks.length + 1,
      adCount: chunkAds.length,
      input: {
        ...input,
        adCount: chunkAds.length,
        strategyJson: chunkStrategy,
      },
    });
  }
  return chunks;
}

function uniqueItems(items: EngineWorkItem[]): EngineWorkItem[] {
  const seen = new Set<string>();
  const unique: EngineWorkItem[] = [];
  for (const item of items) {
    const key = `${item.stage}:${item.filename}:${item.itemKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.sort((a, b) => a.filename.localeCompare(b.filename));
}

function validExecutablePath(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const path = value.trim();
  return isAbsolute(path) && !existsSync(path) ? undefined : path;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hostedLfsWorkers(): number {
  return parsePositiveInt(process.env.WWX_LFS_WORKERS, 1);
}

function hostedLfsGenerationWorkers(): number {
  return parsePositiveInt(process.env.WWX_LFS_GENERATION_WORKERS, 1);
}

function lfsChunkSize(): number {
  return parsePositiveInt(process.env.WWX_LFS_CHUNK_SIZE, 3);
}

function subprocessMaxBufferBytes(): number {
  return parsePositiveInt(process.env.WWX_SUBPROCESS_MAX_BUFFER_BYTES, 8 * 1024 * 1024);
}

function subprocessLogTailBytes(): number {
  return parsePositiveInt(process.env.WWX_SUBPROCESS_LOG_TAIL_BYTES, 128 * 1024);
}

function appendTail(current: string, next: string): string {
  const combined = current + next;
  const maxBytes = subprocessLogTailBytes();
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return combined.slice(Math.max(0, combined.length - maxBytes));
}

function hiddenArtifactMaxBytes(): number {
  return parsePositiveInt(process.env.WWX_HIDDEN_ARTIFACT_MAX_BYTES, 512 * 1024);
}

function hostedResearchEnv(): Record<string, string> {
  return {
    // Hosted workers should not spend minutes rate-limiting a background smoke
    // run before the first observable progress event. Operators see the run
    // state; engineers can tune this in Trigger env for heavier research.
    WW_RESEARCH_RATE_LIMIT_SECONDS: process.env.WW_RESEARCH_RATE_LIMIT_SECONDS ?? "0.25",
    WW_RESEARCH_QUERY_COUNT: process.env.WW_RESEARCH_QUERY_COUNT ?? "10",
    ANTHROPIC_TIMEOUT_SECONDS: process.env.ANTHROPIC_TIMEOUT_SECONDS ?? "120",
    ANTHROPIC_MAX_RETRIES: process.env.ANTHROPIC_MAX_RETRIES ?? "1",
  };
}

function sanitizeSubprocessOutput(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/(?<=api[_-]?key[=:]\s*)[A-Za-z0-9._-]+/gi, "[redacted]")
    .replace(/(?<=authorization:\s*bearer\s+)[A-Za-z0-9._-]+/gi, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/https?:\/\/[^\s]*X-Amz-[^\s]+/gi, "[redacted-url]")
    .slice(-4000);
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
  options: { maxBytes?: number } = {},
): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (options.maxBytes && size > options.maxBytes) {
    items.push({
      stage,
      itemKey: `${filename}.metadata`,
      filename: `${filename}.metadata.json`,
      label: `${label} metadata`,
      visibilityClass,
      mimeType: "application/json",
      content: JSON.stringify({
        schema: "wwx-hidden-artifact-omitted/v1",
        original_filename: filename,
        original_size_bytes: size,
        omitted_reason: "hidden_artifact_exceeded_hosted_publish_cap",
      }, null, 2),
    });
    return;
  }
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

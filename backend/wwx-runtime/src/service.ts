import type { Store } from "./store.js";
import type { ObjectStorage } from "./storage.js";
import type { Artifact, CreateAdsInput, EngineWorkItem, Product, ResearchRun, RunEvent } from "./model.js";
import { classifyVisibility, isSecretQuestion } from "./security.js";
import { sha256 } from "./ids.js";

export class RuntimeService {
  constructor(
    readonly store: Store,
    private readonly storage: ObjectStorage,
  ) {}

  async createAds(workspaceId: string, batchId: string, input: CreateAdsInput) {
    await this.store.ensureProduct(workspaceId, input.productId);
    const batch = await this.store.ensureBatch(workspaceId, batchId, input);
    const job = await this.store.enqueueJob(workspaceId, batch.id, "create_ads", input as Record<string, unknown>);
    await this.store.appendEvent({
      workspaceId,
      batchId,
      runId: null,
      type: "run_started",
      stage: null,
      message: "Batch queued",
      payload: { jobId: job.id },
    });
    return { batch, job };
  }

  async createProduct(workspaceId: string, config: Record<string, unknown>, productFolder?: string): Promise<Product> {
    const productCode = productCodeFromConfig(config, productFolder);
    const productId = `prod_${productCode}`;
    await this.store.ensureProduct(workspaceId, productId, productNameFromConfig(config, productCode), config);
    const product = (await this.store.listProducts(workspaceId)).find((item) => item.id === productId);
    if (!product) throw new Error("product not found after create");
    return product;
  }

  async listProductIndex(workspaceId: string) {
    const products = await this.store.listProducts(workspaceId);
    return Promise.all(products.map(async (product) => {
      const batches = await this.store.listBatches(workspaceId, product.id);
      const researchRuns = await this.store.listResearchRuns(workspaceId, product.id);
      const researchArtifacts = await this.store.listPublicArtifacts(workspaceId, product.id);
      const mappedBatches = await Promise.all(batches.map(async (batch) => ({
        ...batch,
        artifacts: await this.store.listPublicArtifacts(workspaceId, batch.id),
      })));
      return {
        ...product,
        researchRuns,
        researchArtifacts,
        batches: mappedBatches,
      };
    }));
  }

  async createBatch(workspaceId: string, productId: string, batchName: string, adCount = 1) {
    await this.store.ensureProduct(workspaceId, productId);
    const batchId = batchIdFromName(batchName);
    return this.store.ensureBatch(workspaceId, batchId, {
      productId,
      batchId,
      batchName,
      adCount: Math.max(1, Math.trunc(adCount)),
    });
  }

  async startResearchRun(
    workspaceId: string,
    productId: string,
    topic: string,
    searchTerms: string[] = [],
    status: ResearchRun["status"] = "complete",
    quality?: Record<string, unknown>,
  ): Promise<ResearchRun> {
    await this.store.ensureProduct(workspaceId, productId);
    return this.store.createResearchRun(workspaceId, productId, topic, searchTerms.length ? searchTerms : [topic], status, quality);
  }

  completeResearchRun(
    workspaceId: string,
    researchRunId: string,
    searchTerms: string[],
    quality: Record<string, unknown> = {},
  ): Promise<ResearchRun> {
    return this.store.updateResearchRun(workspaceId, researchRunId, {
      status: "complete",
      searchTerms,
      quality: {
        searchTermCount: searchTerms.length,
        corpusRefs: searchTerms.length,
        ...quality,
      },
    });
  }

  failResearchRun(workspaceId: string, researchRunId: string, reason = "research_failed"): Promise<ResearchRun> {
    return this.store.updateResearchRun(workspaceId, researchRunId, {
      status: "failed",
      quality: { failure: reason },
    });
  }

  listResearchRuns(workspaceId: string, productId: string): Promise<ResearchRun[]> {
    return this.store.listResearchRuns(workspaceId, productId);
  }

  async stopBatch(workspaceId: string, batchId: string, reason?: string) {
    await this.store.requestStop(workspaceId, batchId, reason);
    await this.store.appendEvent({
      workspaceId,
      batchId,
      runId: null,
      type: "run_stopped",
      stage: null,
      message: "Stop requested",
      payload: { reason: reason ?? null },
    });
    return { ok: true };
  }

  async continueBatch(workspaceId: string, batchId: string) {
    await this.store.clearStop(workspaceId, batchId);
    const status = await this.store.getBatchStatus(workspaceId, batchId);
    if (!status) throw new Error("batch not found");
    const lastPayload = await this.store.getLatestJobPayload(workspaceId, batchId);
    const job = await this.store.enqueueJob(workspaceId, batchId, "continue_batch", {
      ...(lastPayload ?? {}),
      productId: status.batch.productId,
      batchId,
      adCount: status.batch.requestedAdCount,
    });
    await this.store.appendEvent({
      workspaceId,
      batchId,
      runId: null,
      type: "run_resumed",
      stage: null,
      message: "Continue requested",
      payload: { jobId: job.id },
    });
    return { ok: true, job };
  }

  getBatchStatus(workspaceId: string, batchId: string) {
    return this.store.getBatchStatus(workspaceId, batchId);
  }

  listEvents(workspaceId: string, batchId: string, afterEventId?: string): Promise<RunEvent[]> {
    return this.store.listEvents(workspaceId, batchId, afterEventId);
  }

  async listFinalAds(workspaceId: string, batchId: string) {
    const artifacts = await this.store.listPublicArtifacts(workspaceId, batchId);
    return artifacts.filter((artifact) => artifact.visibilityClass === "public_final");
  }

  async getPublicArtifactContent(workspaceId: string, artifactId: string) {
    const artifact = await this.store.getPublicArtifact(workspaceId, artifactId);
    if (!artifact) throw new Error("artifact not available");
    return {
      artifact,
      content: await this.readArtifactText(artifact),
    };
  }

  async getAssetInputs(workspaceId: string, batchId: string) {
    return this.readPublicJson(workspaceId, batchId, "asset-inputs.json");
  }

  async getMetrics(workspaceId: string, batchId: string) {
    const analysis = await this.readPublicJson(workspaceId, batchId, "ad-analysis-index.json");
    const ads = Array.isArray(analysis.ads) ? analysis.ads as Array<Record<string, unknown>> : [];
    return {
      batchId,
      totalAds: analysis.total_ads ?? 0,
      decisionCounts: analysis.decision_counts ?? {},
      formats: analysis.formats ?? [],
      mechanisms: analysis.mechanisms ?? [],
      angles: uniqueStrings(ads.map((ad) => ad.angle)),
      archetypes: analysis.archetypes ?? [],
      researchTopics: analysis.research_topics ?? [],
      averageWordCount: average(ads.map((ad) => Number(ad.word_count) || 0)),
      duplicateClusters: Array.isArray(analysis.duplicate_clusters) ? analysis.duplicate_clusters.length : 0,
    };
  }

  async analyze(workspaceId: string, batchId: string) {
    return this.readPublicJson(workspaceId, batchId, "ad-analysis-index.json");
  }

  async answerQuestion(workspaceId: string, batchId: string, question: string) {
    if (isSecretQuestion(question)) {
      return {
        refused: true,
        answer: "I can summarize final ads, asset inputs, counts, duplicate clusters, and public batch metadata. I cannot expose hidden LFS prompts, outlines, raw model messages, backend templates, or QA rubrics.",
        citations: [],
      };
    }
    const metrics = await this.getMetrics(workspaceId, batchId);
    const q = question.toLowerCase();
    if (q.includes("duplicate")) {
      return { refused: false, answer: `${metrics.duplicateClusters} duplicate cluster(s) were detected.`, citations: ["ad-analysis-index.json"] };
    }
    if (q.includes("angle") || q.includes("tested") || q.includes("vary")) {
      const angles = Array.isArray(metrics.angles) && metrics.angles.length ? metrics.angles.join(", ") : "no named angle metadata yet";
      const formats = Array.isArray(metrics.formats) && metrics.formats.length ? metrics.formats.join(", ") : "lfs";
      return {
        refused: false,
        answer: `This batch tested ${metrics.totalAds} final ad(s). Formats: ${formats}. Angles: ${angles}. Duplicate clusters: ${metrics.duplicateClusters}.`,
        citations: ["ad-analysis-index.json", "batch-summary.json"],
      };
    }
    if (q.includes("research")) {
      const topics = Array.isArray(metrics.researchTopics) && metrics.researchTopics.length ? metrics.researchTopics.join(", ") : "no public research topic labels on this batch";
      return {
        refused: false,
        answer: `This batch is linked to: ${topics}.`,
        citations: ["ad-analysis-index.json", "batch-summary.json"],
      };
    }
    return {
      refused: false,
      answer: `The batch contains ${metrics.totalAds} final ad(s).`,
      citations: ["ad-analysis-index.json", "batch-summary.json"],
    };
  }

  async compareBatches(workspaceId: string, batchIds: string[]) {
    const rows = [];
    for (const batchId of batchIds) {
      rows.push(await this.getMetrics(workspaceId, batchId));
    }
    return {
      schema: "wwx-batch-comparison/v1",
      batches: rows,
    };
  }

  async exportHandoff(workspaceId: string, batchId: string) {
    const finalAds = await this.listFinalAds(workspaceId, batchId);
    const scripts = [];
    for (const artifact of finalAds) {
      scripts.push({ filename: artifact.filename, content: await this.readArtifactText(artifact) });
    }
    const payload = JSON.stringify({ schema: "wwx-handoff-package/v1", batch_id: batchId, scripts }, null, 2);
    return this.publishArtifact(workspaceId, batchId, {
      stage: "export",
      itemKey: "handoff-package",
      filename: "handoff-package.json",
      label: "Handoff Package",
      visibilityClass: "public_asset_input",
      mimeType: "application/json",
      content: payload,
    });
  }

  async publishArtifact(workspaceId: string, batchId: string, item: EngineWorkItem): Promise<Artifact> {
    const visibilityClass = classifyVisibility(item.filename, item.visibilityClass.startsWith("public_"));
    const contentSha256 = sha256(item.content);
    const objectKey = `${workspaceId}/${batchId}/${visibilityClass}/${contentSha256}`;
    await this.storage.put(objectKey, item.content, item.mimeType);
    const artifact = await this.store.publishArtifact({
      workspaceId,
      batchId,
      filename: item.filename,
      label: item.label,
      mimeType: item.mimeType,
      visibilityClass,
      objectKey,
      contentSha256,
      size: Buffer.byteLength(item.content),
    });
    if (artifact.visibilityClass.startsWith("public_")) {
      await this.store.setArtifactContent(artifact.id, item.content);
    }
    return artifact;
  }

  async publishIndexes(workspaceId: string, batchId: string): Promise<void> {
    const finalAds = await this.listFinalAds(workspaceId, batchId);
    const ads = [];
    for (const [index, artifact] of finalAds.entries()) {
      const script = await this.readArtifactText(artifact);
      const hook = extractHook(script);
      ads.push({
        task_id: artifact.filename.split("/").pop()?.replace(/\.md$/, "") ?? artifact.id,
        script_filename: artifact.filename,
        decision: "ship",
        format: "lfs",
        mechanism: "",
        archetype: "",
        angle: `Final ad ${index + 1}`,
        hook,
        first_five_words: firstWords(hook, 5),
        word_count: wordCount(script),
        divider_count: (script.match(/========/g) ?? []).length,
        product_mention_placement: "unknown",
        semantic_fingerprint: artifact.contentSha256,
        failed_solution_count: countMarker(script, "failed"),
        proof_type: inferProofType(script),
        cta_present: /watch this clip|learn more|article below/i.test(script),
        ps_present: /p\.s\./i.test(script),
        asset_readiness: {
          persona: "single avatar",
          scene: hook,
          product_reveal: "script dependent",
          visual_constraints: [],
          forbidden_visuals: [],
        },
      });
    }
    const duplicateClusters = duplicateClustersFrom(ads);
    const analysis = {
      schema: "wwx-ad-analysis-index/v1",
      batch_id: batchId,
      total_ads: ads.length,
      decision_counts: { ship: ads.length, review: 0, fail: 0 },
      formats: ["lfs"],
      mechanisms: [],
      archetypes: [],
      research_topics: [],
      duplicate_clusters: duplicateClusters,
      ads,
    };
    const assetInputs = { schema: "wwx-asset-inputs/v1", batch_id: batchId, ads };
    const summary = {
      schema: "wwx-public-batch-summary/v1",
      batch_id: batchId,
      total_ads: ads.length,
      decision_counts: analysis.decision_counts,
      formats: analysis.formats,
      mechanisms: analysis.mechanisms,
      archetypes: analysis.archetypes,
      research_topics: analysis.research_topics,
      duplicate_clusters: duplicateClusters,
    };
    for (const [filename, label, value] of [
      ["ad-analysis-index.json", "Ad Analysis Index", analysis],
      ["asset-inputs.json", "Asset Inputs", assetInputs],
      ["batch-summary.json", "Batch Summary", summary],
    ] as const) {
      await this.publishArtifact(workspaceId, batchId, {
        stage: "publish_indexes",
        itemKey: filename,
        filename,
        label,
        visibilityClass: filename === "asset-inputs.json" ? "public_asset_input" : "public_summary",
        mimeType: "application/json",
        content: JSON.stringify(value, null, 2),
      });
    }
  }

  private async readPublicJson(workspaceId: string, batchId: string, filename: string): Promise<Record<string, unknown>> {
    const artifacts = await this.store.listPublicArtifacts(workspaceId, batchId);
    const artifact = artifacts.find((item) => item.filename === filename);
    if (!artifact) throw new Error(`public artifact not found: ${filename}`);
    const content = await this.readArtifactText(artifact);
    return JSON.parse(content ?? "{}") as Record<string, unknown>;
  }

  private async readArtifactText(artifact: Artifact): Promise<string> {
    const cached = await this.store.getArtifactContent(artifact.id);
    if (cached !== null) return cached;
    const object = await this.storage.get(artifact.objectKey);
    if (!object) throw new Error("artifact body missing");
    return object.toString("utf8");
  }
}

function productCodeFromConfig(config: Record<string, unknown>, fallback?: string): string {
  return safeSegment(stringValue(config.product_code) ?? stringValue(config.productCode) ?? fallback ?? "product").toUpperCase();
}

function productNameFromConfig(config: Record<string, unknown>, fallback: string): string {
  return stringValue(config.product_name) ?? stringValue(config.productName) ?? stringValue(config.name) ?? fallback;
}

function batchIdFromName(name: string): string {
  const compact = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return compact || `BATCH_${Date.now()}`;
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "product";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractHook(script: string): string {
  return script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#")) ?? "";
}

function firstWords(value: string, count: number): string {
  return value.split(/\s+/).filter(Boolean).slice(0, count).join(" ");
}

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function countMarker(value: string, marker: string): number {
  const regex = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return value.match(regex)?.length ?? 0;
}

function inferProofType(script: string): string {
  if (/study|clinical|trial|doctor|specialist/i.test(script)) return "authority";
  if (/before|after|review|testimonial|clip/i.test(script)) return "social";
  return "narrative";
}

function duplicateClustersFrom(ads: Array<{ task_id: string; semantic_fingerprint: string }>) {
  const byFingerprint = new Map<string, string[]>();
  for (const ad of ads) {
    const group = byFingerprint.get(ad.semantic_fingerprint) ?? [];
    group.push(ad.task_id);
    byFingerprint.set(ad.semantic_fingerprint, group);
  }
  return [...byFingerprint.values()]
    .filter((taskIds) => taskIds.length > 1)
    .map((taskIds, index) => ({ cluster_id: `dup_${index + 1}`, task_ids: taskIds }));
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean))];
}

function average(values: number[]): number {
  const present = values.filter((value) => Number.isFinite(value) && value > 0);
  if (!present.length) return 0;
  return Math.round(present.reduce((sum, value) => sum + value, 0) / present.length);
}

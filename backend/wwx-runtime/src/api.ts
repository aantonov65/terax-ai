import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Artifact, BatchStatus, CreateAdsInput, RunEvent } from "./model.js";
import type { RuntimeService } from "./service.js";

type BatchParams = { id: string };
type ProductParams = { id: string };
type ArtifactParams = { id: string; artifactId: string };

export function buildApi(service: RuntimeService): FastifyInstance {
  const app = Fastify({ logger: true });

  app.post<{ Params: BatchParams; Body: CreateAdsInput }>("/batches/:id/create-ads", async (request) => {
    const workspaceId = requireWorkspace(request);
    const input = request.body;
    if (!input?.productId || !Number.isInteger(input.adCount) || input.adCount < 1) {
      throw publicError("INVALID_CREATE_ADS_INPUT", 400);
    }
    const { batch, job } = await service.createAds(workspaceId, request.params.id, input);
    return {
      batch,
      job_id: job.id,
    };
  });

  app.post<{ Params: BatchParams; Body: { reason?: string } }>("/batches/:id/stop", async (request) => {
    return service.stopBatch(requireWorkspace(request), request.params.id, request.body?.reason);
  });

  app.post<{ Params: BatchParams }>("/batches/:id/continue", async (request) => {
    const result = await service.continueBatch(requireWorkspace(request), request.params.id);
    return { ok: result.ok, job_id: result.job.id };
  });

  app.get<{ Params: BatchParams }>("/batches/:id/status", async (request) => {
    const status = await service.getBatchStatus(requireWorkspace(request), request.params.id);
    if (!status) throw publicError("BATCH_NOT_FOUND", 404);
    return sanitizeBatchStatus(status);
  });

  app.get<{ Params: BatchParams; Querystring: { after?: string; once?: string } }>("/batches/:id/events", async (request, reply) => {
    const workspaceId = requireWorkspace(request);
    const after = request.headers["last-event-id"]?.toString() || request.query.after;
    const once = request.query.once === "1" || request.query.once === "true";
    const writeEvents = async (events: RunEvent[], target: FastifyReply) => {
      for (const event of events) {
        target.raw.write(formatSse(sanitizeEvent(event)));
      }
    };

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let cursor = after;
    const replay = await service.listEvents(workspaceId, request.params.id, cursor);
    await writeEvents(replay, reply);
    cursor = replay.at(-1)?.id ?? cursor;
    if (once) {
      reply.raw.end();
      return reply;
    }

    const interval = setInterval(async () => {
      try {
        const events = await service.listEvents(workspaceId, request.params.id, cursor);
        await writeEvents(events, reply);
        cursor = events.at(-1)?.id ?? cursor;
        reply.raw.write(": heartbeat\n\n");
      } catch {
        reply.raw.write("event: run_failed\ndata: {\"reason\":\"STREAM_REPLAY_FAILED\"}\n\n");
      }
    }, 1_000);
    request.raw.on("close", () => clearInterval(interval));
    return reply;
  });

  app.get<{ Params: BatchParams }>("/batches/:id/final-ads", async (request) => {
    const artifacts = await service.listFinalAds(requireWorkspace(request), request.params.id);
    return { ads: artifacts.map(sanitizeArtifact) };
  });

  app.get<{ Params: ArtifactParams }>("/batches/:id/final-ads/:artifactId", async (request) => {
    const result = await service.getPublicArtifactContent(requireWorkspace(request), request.params.artifactId)
      .catch(() => null);
    if (!result) throw publicError("ARTIFACT_NOT_FOUND", 404);
    if (result.artifact.batchId !== request.params.id || result.artifact.visibilityClass !== "public_final") {
      throw publicError("ARTIFACT_NOT_FOUND", 404);
    }
    return { artifact: sanitizeArtifact(result.artifact), content: result.content };
  });

  app.get<{ Params: BatchParams }>("/batches/:id/asset-inputs", async (request) => {
    return service.getAssetInputs(requireWorkspace(request), request.params.id);
  });

  app.get<{ Params: BatchParams }>("/batches/:id/metrics", async (request) => {
    return service.getMetrics(requireWorkspace(request), request.params.id);
  });

  app.post<{ Params: BatchParams }>("/batches/:id/analyze", async (request) => {
    return service.analyze(requireWorkspace(request), request.params.id);
  });

  app.post<{ Params: BatchParams; Body: { batchIds?: string[] } }>("/batches/:id/compare", async (request) => {
    const batchIds = [request.params.id, ...(request.body?.batchIds ?? [])]
      .map((batchId) => batchId.trim())
      .filter(Boolean);
    return service.compareBatches(requireWorkspace(request), [...new Set(batchIds)]);
  });

  app.post<{ Params: BatchParams; Body: { question?: string } }>("/batches/:id/question", async (request) => {
    const question = request.body?.question?.trim();
    if (!question) throw publicError("QUESTION_REQUIRED", 400);
    return service.answerQuestion(requireWorkspace(request), request.params.id, question);
  });

  app.post<{ Params: BatchParams }>("/batches/:id/export", async (request) => {
    const artifact = await service.exportHandoff(requireWorkspace(request), request.params.id);
    return { artifact: sanitizeArtifact(artifact) };
  });

  app.post<{ Params: ProductParams; Body: { topic?: string; searchTerms?: string[] } }>("/products/:id/research-runs", async (request) => {
    const topic = request.body?.topic?.trim();
    if (!topic) throw publicError("RESEARCH_TOPIC_REQUIRED", 400);
    return service.startResearchRun(requireWorkspace(request), request.params.id, topic, request.body?.searchTerms ?? []);
  });

  app.get<{ Params: ProductParams }>("/products/:id/research-runs", async (request) => {
    const researchRuns = await service.listResearchRuns(requireWorkspace(request), request.params.id);
    return { research_runs: researchRuns };
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    const reason = statusCode >= 500 ? "INTERNAL_RUNTIME_ERROR" : error.message;
    reply.status(statusCode).send({ error: reason });
  });

  return app;
}

function requireWorkspace(request: FastifyRequest): string {
  const workspaceId = request.headers["x-workspace-id"]?.toString().trim();
  if (!workspaceId) throw publicError("WORKSPACE_REQUIRED", 401);
  return workspaceId;
}

function publicError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function sanitizeBatchStatus(status: BatchStatus) {
  return {
    batch: status.batch,
    run: status.run,
    stages: status.stages,
    work_items: status.workItems,
    artifacts: status.artifacts.map(sanitizeArtifact),
  };
}

function sanitizeArtifact(artifact: Artifact) {
  return {
    id: artifact.id,
    batch_id: artifact.batchId,
    filename: artifact.filename,
    label: artifact.label,
    mime_type: artifact.mimeType,
    visibility_class: artifact.visibilityClass,
    content_sha256: artifact.contentSha256,
    size: artifact.size,
    version: artifact.version,
    created_at: artifact.createdAt,
    updated_at: artifact.updatedAt,
  };
}

function sanitizeEvent(event: RunEvent) {
  const payload = { ...event.payload };
  if (event.type === "artifact_published" && typeof payload.visibilityClass === "string" && !payload.visibilityClass.startsWith("public_")) {
    delete payload.artifactId;
    delete payload.filename;
    payload.visibilityClass = "hidden";
  }
  return {
    id: event.id,
    run_id: event.runId,
    batch_id: event.batchId,
    type: event.type,
    stage: event.stage,
    message: event.message,
    payload,
    created_at: event.createdAt,
  };
}

function formatSse(event: ReturnType<typeof sanitizeEvent>): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

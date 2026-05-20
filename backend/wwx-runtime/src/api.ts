import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ObservabilityClient, RunEventRecord } from "../../../packages/observability/src/index.js";
import { authenticateRequest, publicError as workflowPublicError, requireAdmin } from "./auth.js";
import type { Artifact, BatchStatus, CreateAdsInput, RunEvent } from "./model.js";
import { captureRuntimeException } from "./sentry.js";
import type { RuntimeService } from "./service.js";
import type { WorkflowRuntimeService, WorkflowRunInput } from "./workflow-service.js";

type BatchParams = { id: string };
type ProductParams = { id: string };
type ArtifactParams = { id: string; artifactId: string };

export function buildApi(
  service: RuntimeService,
  workflow?: WorkflowRuntimeService,
  observability?: ObservabilityClient,
): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/", async () => ({
    service: "wwx-runtime-api",
    ok: true,
    endpoints: {
      health: "/healthz",
      capabilities: "/capabilities",
      admin: "/admin",
    },
  }));

  app.get("/healthz", async () => ({
    ok: true,
    service: "wwx-runtime-api",
  }));

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

  if (workflow && observability) {
    registerWorkflowRoutes(app, workflow, observability);
  }

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    captureRuntimeException(error, { status_code: error.statusCode ?? 500 });
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    const reason = statusCode >= 500 ? "INTERNAL_RUNTIME_ERROR" : error.message;
    reply.status(statusCode).send({ error: reason });
  });

  return app;
}

function registerWorkflowRoutes(app: FastifyInstance, workflow: WorkflowRuntimeService, observability: ObservabilityClient): void {
  app.get("/capabilities", async () => workflow.capabilities());

  app.get("/me", async (request) => {
    const auth = await authenticateRequest(request, observability);
    return {
      user: {
        id: auth.user.id,
        email: auth.user.email,
        name: auth.user.name,
        role: auth.role,
        workspace_id: auth.workspaceId,
        desktop_client_version: auth.clientVersion,
      },
    };
  });

  app.post<{ Body: WorkflowRunInput }>("/runs", async (request) => {
    const auth = await authenticateRequest(request, observability);
    return workflow.createRun(auth, request.body ?? {});
  });

  app.post<{ Params: { id: string } }>("/runs/:id/stop", async (request) => {
    const auth = await authenticateRequest(request, observability);
    return { run: await workflow.stopRun(auth, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/runs/:id/continue", async (request) => {
    const auth = await authenticateRequest(request, observability);
    return { run: await workflow.continueRun(auth, request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/runs/:id/retry", async (request) => {
    const auth = await authenticateRequest(request, observability);
    return { run: await workflow.retryRun(auth, request.params.id) };
  });

  app.get<{ Params: { id: string } }>("/runs/:id/status", async (request) => {
    const auth = await authenticateRequest(request, observability);
    return workflow.getStatus(auth, request.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; once?: string } }>("/runs/:id/events", async (request, reply) => {
    const auth = await authenticateRequest(request, observability);
    const after = request.headers["last-event-id"]?.toString() || request.query.after;
    const once = request.query.once === "1" || request.query.once === "true";
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let cursor = after;
    const writeEvents = async () => {
      const events = await workflow.listEvents(auth, request.params.id, cursor);
      for (const event of events) reply.raw.write(formatWorkflowSse(event));
      cursor = events.at(-1)?.id ?? cursor;
    };
    await writeEvents();
    if (once) {
      reply.raw.end();
      return reply;
    }
    const interval = setInterval(async () => {
      try {
        await writeEvents();
        reply.raw.write(": heartbeat\n\n");
      } catch {
        reply.raw.write("event: run_failed\ndata: {\"reason\":\"STREAM_REPLAY_FAILED\"}\n\n");
      }
    }, 1_000);
    request.raw.on("close", () => clearInterval(interval));
    return reply;
  });

  app.get<{ Params: { id: string } }>("/runs/:id/artifacts", async (request) => {
    const auth = await authenticateRequest(request, observability);
    return { artifacts: await workflow.listArtifacts(auth, request.params.id) };
  });

  app.get<{ Params: { id: string } }>("/artifacts/:id", async (request) => {
    const auth = await authenticateRequest(request, observability);
    return { artifact: await workflow.getArtifact(auth, request.params.id) };
  });

  app.post<{ Params: { id: string }; Body: { question?: string } }>("/runs/:id/question", async (request) => {
    const auth = await authenticateRequest(request, observability);
    const question = request.body?.question?.trim();
    if (!question) throw workflowPublicError("QUESTION_REQUIRED", 400);
    return workflow.answerQuestion(auth, request.params.id, question);
  });

  app.post<{ Params: { id: string } }>("/runs/:id/export", async (request) => {
    const auth = await authenticateRequest(request, observability);
    return { artifact: await workflow.exportRun(auth, request.params.id) };
  });

  app.get("/admin", async (request, reply) => {
    if (process.env.WWX_ADMIN_SHELL_REQUIRE_AUTH === "1") {
      const auth = await authenticateRequest(request, observability);
      requireAdmin(auth);
    }
    reply.header("content-type", "text/html; charset=utf-8");
    return adminShellHtml();
  });

  app.get("/admin/runs", async (request) => {
    const auth = await authenticateRequest(request, observability);
    requireAdmin(auth);
    return { runs: await workflow.adminRuns(auth) };
  });

  app.get<{ Params: { id: string } }>("/admin/runs/:id", async (request) => {
    const auth = await authenticateRequest(request, observability);
    requireAdmin(auth);
    return workflow.adminRunDetail(auth, request.params.id);
  });

  app.get("/admin/stages", async (request) => {
    const auth = await authenticateRequest(request, observability);
    requireAdmin(auth);
    return { stages: await workflow.adminStages(auth) };
  });

  app.get("/admin/costs", async (request) => {
    const auth = await authenticateRequest(request, observability);
    requireAdmin(auth);
    return { costs: await workflow.adminCosts(auth) };
  });

  app.get("/admin/users", async (request) => {
    const auth = await authenticateRequest(request, observability);
    requireAdmin(auth);
    return { users: await workflow.adminUsers(auth) };
  });

  app.get("/admin/artifacts", async (request) => {
    const auth = await authenticateRequest(request, observability);
    requireAdmin(auth);
    return { artifacts: await workflow.adminArtifacts(auth) };
  });

  app.get("/admin/alerts", async (request) => {
    const auth = await authenticateRequest(request, observability);
    requireAdmin(auth);
    return { alerts: await workflow.adminAlerts() };
  });
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

function formatWorkflowSse(event: RunEventRecord): string {
  const payload = {
    id: event.id,
    run_id: event.runId,
    stage_id: event.stageId,
    type: event.eventType,
    message: event.messageSafe,
    metadata: event.metadataSafe,
    created_at: event.createdAt,
  };
  return `id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function adminShellHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>WWX Admin</title>
  <style>
    :root { color-scheme: light; --bg: #f7f8fa; --ink: #17202a; --muted: #667085; --line: #d9dee7; --panel: #ffffff; --accent: #0f766e; --bad: #b42318; --warn: #b54708; --good: #067647; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
    button, input, select { font: inherit; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 220px minmax(0, 1fr); }
    aside { border-right: 1px solid var(--line); background: #111827; color: #e5e7eb; padding: 18px 14px; }
    aside h1 { margin: 0 0 18px; font-size: 16px; letter-spacing: 0; }
    nav { display: grid; gap: 6px; }
    nav button { width: 100%; border: 0; border-radius: 6px; background: transparent; color: #cbd5e1; padding: 9px 10px; text-align: left; cursor: pointer; }
    nav button.active, nav button:hover { background: rgba(255,255,255,.09); color: white; }
    main { min-width: 0; padding: 22px; }
    .topbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: start; margin-bottom: 16px; }
    .title h2 { margin: 0; font-size: 22px; }
    .title p { margin: 4px 0 0; color: var(--muted); }
    .auth { display: grid; grid-template-columns: 120px 260px 120px; gap: 8px; align-items: center; }
    .auth input { min-width: 0; border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; background: white; }
    .auth button, .action { border: 1px solid var(--line); border-radius: 6px; background: white; color: var(--ink); padding: 7px 10px; cursor: pointer; }
    .auth button:hover, .action:hover { border-color: #a7b0be; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .card, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    .card { padding: 12px; }
    .card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .card .value { margin-top: 4px; font-size: 20px; font-weight: 700; }
    .panel { overflow: hidden; }
    .panel-head { display: flex; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
    .panel-head h3 { margin: 0; font-size: 14px; }
    .panel-head span { color: var(--muted); }
    .table-wrap { overflow: auto; max-height: calc(100vh - 240px); }
    table { width: 100%; border-collapse: collapse; min-width: 880px; }
    th, td { border-bottom: 1px solid #edf0f5; padding: 9px 10px; text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; background: white; z-index: 1; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    tr.clickable { cursor: pointer; }
    tr.clickable:hover td { background: #f8fafc; }
    code { background: #eef2f7; padding: 2px 4px; border-radius: 4px; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 7px; font-size: 11px; font-weight: 600; background: #eef2f7; color: #344054; }
    .pill.succeeded, .pill.uploaded, .pill.resolved { background: #dcfae6; color: var(--good); }
    .pill.running, .pill.queued { background: #e0f2fe; color: #026aa2; }
    .pill.failed, .pill.quarantined, .pill.open { background: #fee4e2; color: var(--bad); }
    .pill.retrying, .pill.cancelled { background: #fef0c7; color: var(--warn); }
    .detail { margin-top: 14px; display: none; }
    .detail.visible { display: block; }
    .grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    pre { margin: 0; padding: 12px; overflow: auto; max-height: 360px; background: #0b1220; color: #dbeafe; border-radius: 8px; }
    .error { color: var(--bad); font-weight: 600; }
    @media (max-width: 920px) { .shell { grid-template-columns: 1fr; } aside { position: sticky; top: 0; z-index: 3; } nav { grid-template-columns: repeat(3, 1fr); } .topbar, .grid2, .cards { grid-template-columns: 1fr; } .auth { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>WWX Admin</h1>
      <nav id="nav"></nav>
    </aside>
    <main>
      <div class="topbar">
        <div class="title">
          <h2 id="viewTitle">Runs</h2>
          <p id="viewSubtitle">Internal observability for workflow reliability, cost, output, and alerts.</p>
        </div>
        <form class="auth" aria-label="Admin API access" onsubmit="return false">
          <input id="workspace" value="ws_default" autocomplete="username" aria-label="Workspace" />
          <input id="token" type="password" autocomplete="current-password" placeholder="Clerk admin bearer token" aria-label="Bearer token" />
          <button id="reload" type="button">Reload</button>
        </form>
      </div>
      <div id="cards" class="cards"></div>
      <section class="panel">
        <div class="panel-head">
          <h3 id="panelTitle">Runs</h3>
          <span id="updatedAt">Not loaded</span>
        </div>
        <div id="content" class="table-wrap"></div>
      </section>
      <section id="detail" class="detail panel"></section>
    </main>
  </div>
  <script>
    const views = [
      { key: "runs", label: "Runs", path: "/admin/runs", title: "Runs", subtitle: "Who ran what, current state, durations, and Trigger linkage." },
      { key: "stages", label: "Stages", path: "/admin/stages", title: "Stage Reliability", subtitle: "Duration, failure rate, retry rate, and provider hotspots." },
      { key: "costs", label: "Costs", path: "/admin/costs", title: "Costs", subtitle: "Cost attribution by user, product, workflow, stage, and provider." },
      { key: "users", label: "Users", path: "/admin/users", title: "Users", subtitle: "Operator activity, client versions, output counts, and failure rates." },
      { key: "artifacts", label: "Artifacts", path: "/admin/artifacts", title: "Artifacts", subtitle: "Output ledger with safe storage references only." },
      { key: "alerts", label: "Alerts", path: "/admin/alerts", title: "Alerts", subtitle: "Stuck runs, provider/R2 failures, canary leaks, and old clients." }
    ];
    const state = {
      view: sessionStorage.getItem("wwxAdminView") || "runs",
      token: sessionStorage.getItem("wwxAdminToken") || "",
      workspace: sessionStorage.getItem("wwxAdminWorkspace") || "ws_default"
    };
    const nav = document.getElementById("nav");
    const workspaceInput = document.getElementById("workspace");
    const tokenInput = document.getElementById("token");
    workspaceInput.value = state.workspace;
    tokenInput.value = state.token;
    for (const view of views) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = view.label;
      button.dataset.view = view.key;
      button.addEventListener("click", () => {
        state.view = view.key;
        sessionStorage.setItem("wwxAdminView", state.view);
        loadView();
      });
      nav.appendChild(button);
    }
    document.getElementById("reload").addEventListener("click", () => {
      state.workspace = workspaceInput.value.trim() || "ws_default";
      state.token = tokenInput.value.trim();
      sessionStorage.setItem("wwxAdminWorkspace", state.workspace);
      sessionStorage.setItem("wwxAdminToken", state.token);
      loadView();
    });
    function headers() {
      const output = {
        "x-workspace-id": state.workspace,
        "x-user-id": "admin-dashboard",
        "x-user-role": "admin",
        "x-client-version": "admin-web"
      };
      if (state.token) output.authorization = "Bearer " + state.token;
      return output;
    }
    async function api(path) {
      const response = await fetch(path, { headers: headers() });
      const text = await response.text();
      if (!response.ok) throw new Error(safeError(text, response.status));
      return text ? JSON.parse(text) : {};
    }
    function safeError(text, status) {
      try {
        const parsed = JSON.parse(text);
        return parsed.error || ("Request failed with " + status);
      } catch {
        return "Request failed with " + status;
      }
    }
    async function loadView() {
      const view = views.find((item) => item.key === state.view) || views[0];
      document.querySelectorAll("nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view.key));
      document.getElementById("viewTitle").textContent = view.title;
      document.getElementById("viewSubtitle").textContent = view.subtitle;
      document.getElementById("panelTitle").textContent = view.title;
      document.getElementById("detail").className = "detail panel";
      document.getElementById("content").innerHTML = "<p style='padding:14px;color:#667085'>Loading...</p>";
      try {
        const data = await api(view.path);
        renderCards(view.key, data);
        renderContent(view.key, data);
        document.getElementById("updatedAt").textContent = "Updated " + new Date().toLocaleTimeString();
      } catch (error) {
        document.getElementById("cards").innerHTML = "";
        document.getElementById("content").innerHTML = "<p class='error' style='padding:14px'>" + escapeHtml(error.message) + "</p>";
      }
    }
    function renderCards(key, data) {
      const rows = rowsFor(key, data);
      const cards = [];
      if (key === "runs") {
        cards.push(["Runs", rows.length], ["Running", countWhere(rows, "status", "running")], ["Failed", countWhere(rows, "status", "failed")], ["Cost", money(sum(rows, "total_cost_usd"))]);
      } else if (key === "alerts") {
        cards.push(["Alerts", rows.length], ["Open", countWhere(rows, "status", "open")], ["High", countWhere(rows, "severity", "high")], ["Canary", rows.filter((row) => row.alertType === "canary_leak_detected" || row.alert_type === "canary_leak_detected").length]);
      } else if (key === "artifacts") {
        cards.push(["Artifacts", rows.length], ["Uploaded", countWhere(rows, "status", "uploaded")], ["Quarantined", countWhere(rows, "status", "quarantined")], ["Exportable", rows.filter((row) => row.publicExportAllowed || row.public_export_allowed).length]);
      } else if (key === "costs") {
        cards.push(["Rows", rows.length], ["Total Cost", money(sum(rows, "totalCostUsd") + sum(rows, "total_cost_usd"))], ["AI Calls", sum(rows, "aiCallCount") + sum(rows, "ai_call_count")], ["Artifacts", sum(rows, "artifactCount") + sum(rows, "artifact_count")]);
      } else {
        cards.push(["Rows", rows.length], ["Succeeded", countWhere(rows, "status", "succeeded")], ["Failed", countWhere(rows, "status", "failed")], ["Retrying", countWhere(rows, "status", "retrying")]);
      }
      document.getElementById("cards").innerHTML = cards.map((card) => "<div class='card'><div class='label'>" + escapeHtml(card[0]) + "</div><div class='value'>" + escapeHtml(String(card[1])) + "</div></div>").join("");
    }
    function renderContent(key, data) {
      if (key === "runs") return renderRuns(data.runs || []);
      if (key === "stages") return renderTable(rowsFor(key, data), ["stageName", "provider", "attempts", "failureRate", "retryRate", "avgDurationMs", "p95DurationMs", "totalCostUsd"]);
      if (key === "costs") return renderTable(rowsFor(key, data), ["userEmail", "productId", "workflowType", "provider", "totalCostUsd", "aiCallCount", "artifactCount"]);
      if (key === "users") return renderTable(rowsFor(key, data), ["email", "role", "runsStarted", "runsCompleted", "artifactCount", "averageRunCostUsd", "failureRate", "desktopClientVersion", "lastActiveAt"]);
      if (key === "artifacts") return renderTable(rowsFor(key, data), ["id", "runId", "workflowType", "artifactType", "status", "sizeBytes", "storageRefId", "publicExportAllowed", "createdAt"]);
      return renderTable(rowsFor(key, data), ["alertType", "severity", "status", "messageSafe", "createdAt", "resolvedAt"]);
    }
    function renderRuns(rows) {
      const columns = ["id", "created_by_user_id", "product_id", "workflow_type", "status", "current_stage", "total_cost_usd", "duration", "trigger_run_id"];
      const table = baseTable(columns);
      const tbody = table.querySelector("tbody");
      for (const row of rows) {
        const tr = document.createElement("tr");
        tr.className = "clickable";
        tr.addEventListener("click", () => showRun(row.id));
        appendCells(tr, columns.map((column) => column === "duration" ? durationBetween(row.started_at || row.created_at, row.completed_at || row.failed_at) : valueFor(row, column)));
        tbody.appendChild(tr);
      }
      setTable(table);
    }
    async function showRun(runId) {
      const detail = document.getElementById("detail");
      detail.className = "detail visible panel";
      detail.innerHTML = "<div class='panel-head'><h3>Run detail</h3><span>" + escapeHtml(runId) + "</span></div><p style='padding:14px;color:#667085'>Loading detail...</p>";
      try {
        const data = await api("/admin/runs/" + encodeURIComponent(runId));
        detail.innerHTML = "<div class='panel-head'><h3>Run detail</h3><span>" + escapeHtml(runId) + "</span></div><div class='grid2' style='padding:14px'><div><h3>Stages</h3><pre>" + escapeHtml(JSON.stringify(data.stages || [], null, 2)) + "</pre></div><div><h3>Events</h3><pre>" + escapeHtml(JSON.stringify(data.events || [], null, 2)) + "</pre></div><div><h3>AI calls</h3><pre>" + escapeHtml(JSON.stringify(data.ai_calls || [], null, 2)) + "</pre></div><div><h3>Artifacts</h3><pre>" + escapeHtml(JSON.stringify(data.artifacts || [], null, 2)) + "</pre></div></div>";
      } catch (error) {
        detail.innerHTML = "<p class='error' style='padding:14px'>" + escapeHtml(error.message) + "</p>";
      }
    }
    function renderTable(rows, columns) {
      const table = baseTable(columns);
      const tbody = table.querySelector("tbody");
      for (const row of rows) {
        const tr = document.createElement("tr");
        appendCells(tr, columns.map((column) => valueFor(row, column)));
        tbody.appendChild(tr);
      }
      setTable(table);
    }
    function baseTable(columns) {
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const tr = document.createElement("tr");
      for (const column of columns) {
        const th = document.createElement("th");
        th.textContent = human(column);
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      table.appendChild(thead);
      table.appendChild(document.createElement("tbody"));
      return table;
    }
    function appendCells(tr, values) {
      for (const value of values) {
        const td = document.createElement("td");
        if (isStatus(value)) td.innerHTML = "<span class='pill " + escapeHtml(String(value)) + "'>" + escapeHtml(String(value)) + "</span>";
        else if (typeof value === "string" && value.length > 42) td.innerHTML = "<code title='" + escapeHtml(value) + "'>" + escapeHtml(value.slice(0, 42)) + "</code>";
        else td.textContent = formatValue(value);
        tr.appendChild(td);
      }
    }
    function setTable(table) {
      const content = document.getElementById("content");
      content.innerHTML = "";
      content.appendChild(table);
    }
    function rowsFor(key, data) {
      return data[key] || data.runs || data.stages || data.costs || data.users || data.artifacts || data.alerts || [];
    }
    function valueFor(row, key) {
      const direct = row[key];
      if (direct !== undefined) return direct;
      const snake = key.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase());
      const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      if (row[snake] !== undefined) return row[snake];
      if (row[camel] !== undefined) return row[camel];
      return "";
    }
    function human(value) {
      return value.replace(/_/g, " ").replace(/[A-Z]/g, (letter) => " " + letter).trim();
    }
    function formatValue(value) {
      if (value === null || value === undefined || value === "") return "-";
      if (typeof value === "number" && /cost/i.test(String(value))) return money(value);
      if (typeof value === "boolean") return value ? "yes" : "no";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    }
    function isStatus(value) {
      return typeof value === "string" && ["queued","running","succeeded","failed","cancelled","quarantined","uploaded","created","open","resolved","retrying"].includes(value);
    }
    function countWhere(rows, key, value) {
      return rows.filter((row) => valueFor(row, key) === value).length;
    }
    function sum(rows, key) {
      return rows.reduce((total, row) => total + (Number(valueFor(row, key)) || 0), 0);
    }
    function money(value) {
      return "$" + (Number(value) || 0).toFixed(4);
    }
    function durationBetween(start, end) {
      if (!start || !end) return "-";
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "-";
      return Math.round((endMs - startMs) / 1000) + "s";
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
    loadView();
  </script>
</body>
</html>`;
}

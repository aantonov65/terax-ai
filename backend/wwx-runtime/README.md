# WWX Hosted Blackbox Runtime

This service is the hosted blackbox boundary for LFS4.1 handoff. WWX Desktop should treat it as the source of truth for batch state, events, final scripts, asset inputs, analysis, and exports.

## Services

- API service: `pnpm backend:api`
- Trigger.dev task bundle: `pnpm trigger:deploy`
- Worker service: `pnpm backend:worker` for local/fallback queue processing only
- Local one-process smoke mode: `WWX_RUNTIME_EMBED_WORKER=1 pnpm backend:api`

The compatibility API exposes only public-safe batch tools: create ads, research runs, status, replayable SSE, final ads, asset inputs, metrics, analysis, Q&A, stop, continue, and export.

The workflow-first API adds the generic creative runtime:

- `GET /capabilities`
- `GET /me`
- `POST /runs`
- `POST /runs/:id/stop`
- `POST /runs/:id/continue`
- `POST /runs/:id/retry`
- `GET /runs/:id/status`
- `GET /runs/:id/events`
- `GET /runs/:id/artifacts`
- `GET /artifacts/:id`
- `POST /runs/:id/question`
- `POST /runs/:id/export`

Admin observability lives behind `/admin` and `/admin/*`. The operator desktop must not call those routes.

## Required Production Environment

- `DATABASE_URL`: Railway Postgres connection string.
- `R2_BUCKET`: Cloudflare R2 bucket name.
- `R2_ENDPOINT`: S3-compatible R2 endpoint.
- `R2_ACCESS_KEY_ID`: R2 access key.
- `R2_SECRET_ACCESS_KEY`: R2 secret key.
- `WORKER_CONCURRENCY`: defaults to `6`.
- `PORT`: API port, supplied by Railway.
- `WW2_ENGINE_ROOT`: absolute path to the private `ww-2/main` checkout for production LFS4.1 execution.
- `WWX_RUNTIME_ENGINE=fake`: optional local/test override to force deterministic fake scripts.
- `CLERK_SECRET_KEY`: enables Clerk token verification. Without it, local dev headers are accepted.
- `WWX_DEFAULT_WORKSPACE_ID`: fallback workspace for invite-only internal usage.
- `WWX_MINIMUM_DESKTOP_VERSION`: returns `426 Upgrade Required` for older clients.
- `TRIGGER_SECRET_KEY`: enables Trigger.dev Cloud dispatch for `/runs`. Without it, runs use a no-op trigger for local testing.
- `TRIGGER_PROJECT_REF`: Trigger.dev project reference used by `trigger.config.ts`.
- `TRIGGER_API_URL`: optional Trigger API base URL, defaults to `https://api.trigger.dev`.
- `TRIGGER_LFS_CONCURRENCY`: defaults to `6`.
- `SENTRY_DSN`: optional backend/worker crash reporting with pre-send redaction.

Run the migration before starting workers:

```bash
psql "$DATABASE_URL" -f backend/wwx-runtime/migrations/001_initial.sql
psql "$DATABASE_URL" -f backend/wwx-runtime/migrations/002_workflow_observability.sql
```

## Hosted v1 Layout

Create these hosted resources:

- Managed Postgres.
- API service using `backend/wwx-runtime/Dockerfile.api`.
- Trigger.dev Cloud project for durable workflow tasks.
- Optional worker service using `backend/wwx-runtime/Dockerfile.worker` only for local migration/fallback queue processing.
- Cloudflare R2 bucket for artifact bodies.
- Clerk invite-only application for Desktop OAuth/OIDC.

Set the same `DATABASE_URL`, R2 variables, `WW2_ENGINE_ROOT`, `WWX_RUNTIME_WORK_ROOT`, Clerk/Sentry variables, and provider keys in the Trigger.dev task environment. Set `TRIGGER_SECRET_KEY` on the API service so `/runs` can schedule tasks. Do not set `WWX_RUNTIME_EMBED_WORKER` in hosted production.

Deploy Trigger tasks after environment variables are present:

```bash
pnpm trigger:deploy
```

The API enqueues the exact runtime job first, then triggers Trigger.dev with only safe task payload fields such as `runId`, `jobId`, `batchId`, `workflowType`, and `correlationId`. Strategy JSON and angle markdown stay in the backend job ledger and are not sent as Trigger-visible payload.

## Desktop Hosted Runtime Environment

Set these at Desktop build time:

- `VITE_WWX_API_URL`: hosted API base URL.
- `VITE_WWX_RUNTIME_MODE=hosted`: forces hosted runs. `auto` uses hosted when `VITE_WWX_API_URL` exists. `local` keeps the Tauri local fallback.
- `VITE_WWX_WORKSPACE_ID`: default workspace, normally `ws_default` for the first internal rollout.
- `VITE_WWX_AUTH_ISSUER`: Clerk/OIDC issuer URL.
- `VITE_WWX_AUTH_CLIENT_ID`: Clerk public OAuth/OIDC client ID.
- `VITE_WWX_AUTH_REDIRECT_PORT`: defaults to `17891`.
- `VITE_WWX_AUTH_REDIRECT_URI`: defaults to `http://127.0.0.1:17891/auth/callback`; add this callback to Clerk.
- `VITE_WWX_AUTH_SCOPE`: defaults to `openid profile email offline_access`.
- `VITE_WWX_CLIENT_VERSION`: sent to the API for minimum-version enforcement.

The Desktop stores the Clerk/OIDC session in the OS keychain, starts LFS through `POST /runs`, records hosted runs into local SQLite as a read cache, polls safe run status, and mirrors public final scripts/asset inputs/analysis back into the existing artifact viewer. The local Tauri LFS command remains available only when the hosted runtime is disabled.

## Runtime Guarantees

- Postgres is the durable source of truth for products, research runs, batches, runs, stage states, work items, events, jobs, artifact metadata, agent memory, and audit records.
- The queue claims jobs with `FOR UPDATE SKIP LOCKED`, leases, retry budgets, and one active leased run per batch.
- Trigger.dev Cloud is the production orchestration layer for workflow-first `/runs`; the Postgres queue remains available for local migration and fallback.
- SSE is backed by append-only `run_events` for compatibility batches and `workflow_run_events` for workflow-first runs. Both support replay via `Last-Event-ID`.
- Public API responses strip object keys and never return hidden artifacts.
- Stop/continue is work-item based: succeeded work items remain succeeded, canceled or pending items resume without regenerating completed final ads.
- The observability SDK writes `runs`, `run_stages`, `ai_calls`, `media_compute_events`, `run_artifacts`, `workflow_run_events`, and `observability_alerts` with sanitized fields only.
- Operator routes omit costs, Trigger run IDs, raw logs, provider errors, object keys, signed URLs, canaries, hidden prompts, and hidden reports.
- Admin routes expose costs, stage durations, retries, artifact counts, client versions, and alerts.
- Sentry receives crash/error context only after local redaction.

## Engine Adapter

The runtime uses `LegacyLfs41Engine` when `WW2_ENGINE_ROOT` is set. It invokes the existing private `tools/lfs_agent.py` runner and publishes final `output-v41/*.md` scripts through the blackbox artifact path. Without `WW2_ENGINE_ROOT`, it falls back to `FakeLfsEngine` for deterministic local tests.

Production `create_ads` calls must provide hidden strategy JSON, a hidden strategy path, or hidden angle markdown after the product/research validation layer has materialized those inputs. Public API responses still expose only final scripts, asset inputs, summaries, metrics, and exports.

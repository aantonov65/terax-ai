# WWX Hosted Blackbox Runtime

This service is the hosted blackbox boundary for LFS4.1 handoff. WWX Desktop should treat it as the source of truth for batch state, events, final scripts, asset inputs, analysis, and exports.

## Services

- API service: `pnpm backend:api`
- Worker service: `pnpm backend:worker`
- Local one-process smoke mode: `WWX_RUNTIME_EMBED_WORKER=1 pnpm backend:api`

The API exposes only public-safe tools: create ads, research runs, status, replayable SSE, final ads, asset inputs, metrics, analysis, Q&A, stop, continue, and export.

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

Run the migration before starting workers:

```bash
psql "$DATABASE_URL" -f backend/wwx-runtime/migrations/001_initial.sql
```

## Railway v1 Layout

Create three Railway resources:

- Managed Postgres.
- API service using `backend/wwx-runtime/Dockerfile.api`.
- Worker service using `backend/wwx-runtime/Dockerfile.worker`.

Set the same `DATABASE_URL` and R2 variables on both API and worker services. Set `WORKER_CONCURRENCY=6` on the worker. Do not set `WWX_RUNTIME_EMBED_WORKER` in hosted production.

## Runtime Guarantees

- Postgres is the durable source of truth for products, research runs, batches, runs, stage states, work items, events, jobs, artifact metadata, agent memory, and audit records.
- The queue claims jobs with `FOR UPDATE SKIP LOCKED`, leases, retry budgets, and one active leased run per batch.
- SSE is backed by append-only `run_events` and supports replay via `Last-Event-ID`.
- Public API responses strip object keys and never return hidden artifacts.
- Stop/continue is work-item based: succeeded work items remain succeeded, canceled or pending items resume without regenerating completed final ads.

## Engine Adapter

The runtime uses `LegacyLfs41Engine` when `WW2_ENGINE_ROOT` is set. It invokes the existing private `tools/lfs_agent.py` runner and publishes final `output-v41/*.md` scripts through the blackbox artifact path. Without `WW2_ENGINE_ROOT`, it falls back to `FakeLfsEngine` for deterministic local tests.

Production `create_ads` calls must provide hidden strategy JSON, a hidden strategy path, or hidden angle markdown after the product/research validation layer has materialized those inputs. Public API responses still expose only final scripts, asset inputs, summaries, metrics, and exports.

# WWX Desktop

Private creative terminal shell for blackbox WW-2 workflows.

This repo is the desktop/client layer only. It is based on [Terax](https://github.com/crynta/terax-ai) and keeps Terax's useful local primitives: Tauri, a native PTY terminal, xterm.js rendering, file explorer, CodeMirror editor, local web previews, and BYOK-friendly key storage.

WW-2 engine logic does **not** belong in this repo.

## Current MVP

- Real local terminal in the center.
- WWX workspace/navigation sidebar.
- Hosted blackbox LFS4.1 runtime wiring through Fastify, Postgres, R2, Trigger.dev, Clerk/OIDC PKCE, and a local SQLite read cache.
- Safe strategist agent tools for creating ads, stopping/continuing hosted runs, reading final scripts, asset inputs, metrics, analysis, and public batch Q&A.
- Internal admin dashboard at `/admin` for runs, stages, costs, users, artifacts, alerts, and sanitized run detail.
- File explorer/editor/preview functionality inherited from Terax.
- Branding changed from Terax to WWX for the app shell.

## Intended Architecture

```text
WWX Desktop
  - local terminal
  - local files
  - local previews
  - thin ww client

Private backend
  - auth
  - workspaces
  - Postgres run ledger
  - Trigger.dev workflow tasks
  - R2 artifact storage
  - protected WW-2/LFS4.1 engine
  - admin observability dashboard
```

Protected workflows should run remotely and sync artifact bundles back into the local workspace. This keeps prompts, templates, QA rubrics, and orchestration out of the distributed desktop app.

## Development

Prerequisites:

- Node 20+
- pnpm
- Rust stable
- Tauri prerequisites for your OS

Run the web shell:

```bash
pnpm install
pnpm dev
```

Run the desktop shell:

```bash
pnpm tauri dev
```

Type-check:

```bash
pnpm exec tsc --noEmit
```

Run the real LFS upload smoke harness:

```bash
pnpm smoke:wwx:lfs-upload
```

That ignored Rust smoke test exercises the desktop-native submission path against
the local WW-2 engine checkout: it seeds stale batch state, submits a real angle
markdown, then verifies the fresh prompt, outline, final output, and public
manifest artifacts are rebuilt without dated leftovers.

Hosted runtime checks:

```bash
pnpm backend:typecheck
pnpm backend:test
pnpm exec tsc --noEmit
cd src-tauri && cargo check
```

See `backend/wwx-runtime/README.md` for the production env list and Trigger.dev deployment steps.

## Terax Attribution

This app is adapted from Terax, licensed under Apache-2.0. Keep upstream attribution and license notices intact.

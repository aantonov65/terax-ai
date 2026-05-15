# WWX Desktop

Private creative terminal shell for blackbox WW-2 workflows.

This repo is the desktop/client layer only. It is based on [Terax](https://github.com/crynta/terax-ai) and keeps Terax's useful local primitives: Tauri, a native PTY terminal, xterm.js rendering, file explorer, CodeMirror editor, local web previews, and BYOK-friendly key storage.

WW-2 engine logic does **not** belong in this repo.

## Current MVP

- Real local terminal in the center.
- WWX workspace/navigation sidebar.
- Command recipe cards that insert future `ww` commands into the active terminal.
- Right-side workspace control panel with mock auth, command registry, job stream, and file-visibility guidance.
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
  - command registry
  - job queue
  - BYOK provider proxy
  - protected WW-2 engine
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

## Terax Attribution

This app is adapted from Terax, licensed under Apache-2.0. Keep upstream attribution and license notices intact.

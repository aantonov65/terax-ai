#!/usr/bin/env python3
"""WWX artifact manifest writer.

The desktop app and blackbox-facing agent consume this public manifest instead
of inferring protected workflow internals from command logs.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT_FILES = {
    "angle.md": ("angles", "Angle"),
    "source-angle.md": ("angles", "Source Angle"),
    "angles.md": ("angles", "Angles"),
    "strategy.json": ("strategy", "Strategy"),
    "spec.json": ("json", "Spec"),
    "lfs-v41-manifest.json": ("manifest", "LFS V4.1 Manifest"),
    "lfs-v41-report.json": ("report", "LFS V4.1 Report"),
    "lfs-v41-finish-report.json": ("report", "V4.1 Finish Report"),
    "lfs-outline-report.json": ("report", "Outline Report"),
    "lfs-brief-report.json": ("report", "Brief Report"),
    "product-package-report.json": ("report", "Product Package Report"),
    "source-bundle.json": ("json", "Source Bundle"),
    "image-report.json": ("report", "Image Report"),
    "report.json": ("report", "Legacy Report"),
}

DIRECTORIES = {
    "output-v41": "script",
    "prompts": "prompt",
    "outlines": "outline",
    "generation-heartbeats": "heartbeat",
    "images": "image",
    "logs": "log",
    "lfs-v41-parallel-runs": "log",
}

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
TEXT_EXTENSIONS = {".md", ".mdx", ".txt"}
JSON_EXTENSIONS = {".json", ".jsonl"}


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def classify(path: Path, fallback: str = "other") -> str:
    ext = path.suffix.lower()
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in TEXT_EXTENSIONS:
        return "markdown"
    if ext in JSON_EXTENSIONS:
        return "heartbeat" if ext == ".jsonl" else "json"
    return fallback


def artifact_entry(batch_dir: Path, path: Path, *, kind: str, label: str | None = None) -> dict[str, Any]:
    stat = path.stat()
    return {
        "id": str(path),
        "label": label or str(path.relative_to(batch_dir)),
        "path": str(path),
        "kind": kind,
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "preview": kind in {"angles", "strategy", "manifest", "report", "image", "markdown", "json", "heartbeat"},
    }


def collect_artifacts(batch_dir: Path) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []

    for filename, (kind, label) in ROOT_FILES.items():
        path = batch_dir / filename
        if path.exists() and path.is_file():
            artifacts.append(artifact_entry(batch_dir, path, kind=kind, label=label))

    for dirname, fallback_kind in DIRECTORIES.items():
        root = batch_dir / dirname
        if not root.exists():
            continue
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            artifacts.append(artifact_entry(batch_dir, path, kind=classify(path, fallback_kind)))

    return artifacts


def write_artifact_manifest(batch_dir: Path, *, batch_id: str | None = None, product: str | None = None) -> dict[str, Any]:
    manifest = {
        "schema": "wwx-artifacts/v1",
        "batch_id": batch_id or batch_dir.name,
        "product": product,
        "batch_path": str(batch_dir),
        "generated_at": now(),
        "artifacts": collect_artifacts(batch_dir),
    }
    path = batch_dir / "wwx-artifacts.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({
        "event": "artifact_manifest_written",
        "batch_id": manifest["batch_id"],
        "path": str(path),
        "artifact_count": len(manifest["artifacts"]),
    }, sort_keys=True), flush=True)
    return manifest

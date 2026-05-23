#!/usr/bin/env python3
"""Guided terminal-first LFS V4.1 agent runner.

This module wraps the existing LFS V4.1 stage functions with durable state,
artifact previews, review pauses, and conservative edit guards. It intentionally
keeps the generation logic in the existing stage modules.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import termios
import time
import tty
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

THIS = Path(__file__).resolve()
REPO = THIS.parent.parent
sys.path.insert(0, str(THIS.parent))

from batch import run_batch as run_generation_batch  # noqa: E402
from compile_angles import compile_angles  # noqa: E402
from compile_spec import compile_spec, load_strategy  # noqa: E402
from context import PRODUCT_FOLDERS, load_product_config  # noqa: E402
from lfs_brief import run_lfs_brief  # noqa: E402
from lfs_outline import run_outline_batch  # noqa: E402
from lfs_semantic import run_semantic_batch  # noqa: E402
from lfs_v41 import (  # noqa: E402
    BatchLock,
    build_v41_manifest,
    materialize_v41_candidates,
    objective_repair_count,
    run_v41_objective_finish,
    semantic_clean,
    step_ok,
    write_manifest,
)
from preflight import run_preflight  # noqa: E402
from research_cards import run_research_cards  # noqa: E402
from ww_artifacts import write_artifact_manifest  # noqa: E402
from ww_paths import batch_dir_for_write, resolve_batch_dir  # noqa: E402


STAGE_ORDER = [
    "compile_input",
    "research_cards",
    "lfs_brief",
    "lfs_outline",
    "preflight_v41",
    "batch_generation",
    "materialize_v41_candidates",
    "objective_finish_pre_semantic",
    "semantic_launchable",
    "objective_finish_final",
    "semantic_final_check",
    "manifest_overview",
]

HELD_EXIT_CODE = 2
NON_BLOCKING_PAYLOAD_STAGES = {"semantic_launchable", "semantic_final_check", "manifest_overview"}

OPERATOR_STAGE_LABELS = {
    "compile_input": "Preparing batch",
    "research_cards": "Checking research",
    "lfs_brief": "Building briefs",
    "lfs_outline": "Writing outlines",
    "preflight_v41": "Checking readiness",
    "batch_generation": "Generating scripts",
    "materialize_v41_candidates": "Preparing candidates",
    "objective_finish_pre_semantic": "Checking structure",
    "semantic_launchable": "Checking launchability",
    "objective_finish_final": "Final structure check",
    "semantic_final_check": "Final quality check",
    "manifest_overview": "Preparing final ads",
}

OPERATOR_STAGE_SUMMARIES = {
    "compile_input": "The batch input is ready for LFS.",
    "research_cards": "Research cards are available for this batch.",
    "lfs_brief": "Briefs are ready for the next step.",
    "lfs_outline": "Outlines are ready for the next step.",
    "preflight_v41": "The batch passed the pre-generation checks.",
    "batch_generation": "Draft scripts have been generated.",
    "materialize_v41_candidates": "Candidate scripts are ready for checks.",
    "objective_finish_pre_semantic": "Script structure checks are complete.",
    "semantic_launchable": "Launchability checks are complete.",
    "objective_finish_final": "Final structure checks are complete.",
    "semantic_final_check": "Final quality checks are complete.",
    "manifest_overview": "Final ad decisions are ready.",
}


@dataclass(frozen=True)
class StageSpec:
    name: str
    title: str
    artifact_patterns: tuple[str, ...]
    editable_patterns: tuple[str, ...] = ()


STAGE_SPECS: dict[str, StageSpec] = {
    "compile_input": StageSpec(
        "compile_input",
        "Compile input",
        ("angles.md", "strategy.json", "spec.json", "wwx-artifacts.json"),
        ("strategy.json",),
    ),
    "research_cards": StageSpec(
        "research_cards",
        "Research cards",
        ("wwx-artifacts.json",),
    ),
    "lfs_brief": StageSpec(
        "lfs_brief",
        "LFS brief prompts",
        ("prompts/*.md", "lfs-brief-report.json", "wwx-artifacts.json"),
        ("prompts/*.md",),
    ),
    "lfs_outline": StageSpec(
        "lfs_outline",
        "LFS outlines",
        ("outlines/*.md", "lfs-outline-report.json", "wwx-artifacts.json"),
        ("outlines/*.md",),
    ),
    "preflight_v41": StageSpec(
        "preflight_v41",
        "V4.1 preflight",
        ("preflight-v41-report.json", "wwx-artifacts.json"),
    ),
    "batch_generation": StageSpec(
        "batch_generation",
        "Raw script generation",
        ("output/*.md", "report.json", "generation-heartbeats/*", "wwx-artifacts.json"),
    ),
    "materialize_v41_candidates": StageSpec(
        "materialize_v41_candidates",
        "V4.1 candidates",
        ("output-v41/*.md", "wwx-artifacts.json"),
        ("output-v41/*.md",),
    ),
    "objective_finish_pre_semantic": StageSpec(
        "objective_finish_pre_semantic",
        "Objective finish",
        ("output-v41/*.md", "lfs-v41-finish-report.json", "wwx-artifacts.json"),
        ("output-v41/*.md",),
    ),
    "semantic_launchable": StageSpec(
        "semantic_launchable",
        "Semantic launchability",
        ("output-v41/*.md", "lfs-semantic-report.json", "wwx-artifacts.json"),
        ("output-v41/*.md",),
    ),
    "objective_finish_final": StageSpec(
        "objective_finish_final",
        "Final objective finish",
        ("output-v41/*.md", "lfs-v41-finish-report.json", "wwx-artifacts.json"),
        ("output-v41/*.md",),
    ),
    "semantic_final_check": StageSpec(
        "semantic_final_check",
        "Final semantic check",
        ("output-v41/*.md", "lfs-semantic-report.json", "wwx-artifacts.json"),
        ("output-v41/*.md",),
    ),
    "manifest_overview": StageSpec(
        "manifest_overview",
        "Manifest overview",
        ("lfs-v41-manifest.json", "lfs-v41-report.json", "agent-run.json", "wwx-artifacts.json"),
    ),
}


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def env_context() -> tuple[str | None, str | None]:
    product = (
        os.environ.get("WW_PRODUCT")
        or os.environ.get("WW_PRODUCT_CODE")
        or os.environ.get("WWX_PRODUCT")
        or os.environ.get("WWX_PRODUCT_CODE")
    )
    batch_id = os.environ.get("WW_BATCH_ID") or os.environ.get("WWX_BATCH_ID")
    return (product.strip() if product else None, batch_id.strip() if batch_id else None)


def product_from_folder(folder: str, base_path: Path) -> str:
    inverse = {folder_name: code for code, folder_name in PRODUCT_FOLDERS.items()}
    if folder in inverse:
        return inverse[folder]
    cfg_path = base_path / "products" / folder / "config.json"
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text())
        except Exception:
            cfg = {}
        for key in ("product", "product_code", "code"):
            value = str(cfg.get(key) or "").strip()
            if value:
                return value
    return folder


def env_int(name: str, default: int, *, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.environ.get(name, str(default))))
    except (TypeError, ValueError):
        return max(minimum, default)


ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def preflight_failures_from_output(output: str) -> list[dict[str, str]]:
    lines = [strip_ansi(line).rstrip() for line in output.splitlines()]
    failures: list[dict[str, str]] = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith("✗ "):
            continue
        label = stripped[2:].strip()
        detail = ""
        for next_line in lines[index + 1:]:
            next_stripped = next_line.strip()
            if not next_stripped:
                continue
            if next_stripped.startswith(("✓ ", "✗ ", "⚠ ")) or re.match(r"^[A-Z][A-Z0-9 ._/()-]+$", next_stripped):
                break
            detail = next_stripped
            break
        failures.append({"label": label, "detail": detail})
    return failures


def context_from_dir(path: Path, base_path: Path) -> tuple[str | None, str | None, Path | None]:
    current = path if path.is_dir() else path.parent
    for parent in (current, *current.parents):
        spec_path = parent / "spec.json"
        strategy_path = parent / "strategy.json"
        if spec_path.exists():
            try:
                spec = json.loads(spec_path.read_text())
            except Exception:
                spec = {}
            product = spec.get("product") or spec.get("product_code")
            batch_id = spec.get("batch_id") or parent.name
            if product and batch_id:
                return str(product), str(batch_id), parent
        if strategy_path.exists():
            try:
                strategy = load_strategy(strategy_path)
            except Exception:
                strategy = {}
            product = strategy.get("product") or strategy.get("product_code")
            batch_id = strategy.get("batch_id") or parent.name
            if product and batch_id:
                return str(product), str(batch_id), parent
        if parent.parent.name == "batches":
            product_folder = parent.parent.parent.name
            return product_from_folder(product_folder, base_path), parent.name, parent
    return None, None, None


def json_shape(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: json_shape(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [json_shape(item) for item in value]
    return type(value).__name__


def assert_json_content_only(before: Any, after: Any, *, path: Path) -> None:
    if json_shape(before) != json_shape(after):
        raise ValueError(f"{path} changed JSON structure; only content edits are allowed")


def assert_strategy_immutables(before: dict[str, Any], after: dict[str, Any], *, path: Path) -> None:
    immutable_root = ("batch_id", "product", "format", "variant", "lfs_format_template", "task_ids")
    for key in immutable_root:
        if before.get(key) != after.get(key):
            raise ValueError(f"{path} changed immutable strategy field {key!r}")
    before_ads = before.get("ads") or []
    after_ads = after.get("ads") or []
    if len(before_ads) != len(after_ads):
        raise ValueError(f"{path} changed ads length")
    for idx, (old, new) in enumerate(zip(before_ads, after_ads), 1):
        for key in ("task_id", "format", "mechanism"):
            if old.get(key) != new.get(key):
                raise ValueError(f"{path} changed immutable ads[{idx}].{key}")


def strategy_immutables_snapshot(strategy: dict[str, Any]) -> dict[str, Any]:
    return {
        "root": {
            key: strategy.get(key)
            for key in ("batch_id", "product", "format", "variant", "lfs_format_template", "task_ids")
        },
        "ads": [
            {key: ad.get(key) for key in ("task_id", "format", "mechanism")}
            for ad in strategy.get("ads", []) or []
            if isinstance(ad, dict)
        ],
    }


def artifact_metadata(path: Path) -> dict[str, Any]:
    meta: dict[str, Any] = {"sha256": sha256_file(path)}
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text())
        meta["json_shape"] = json_shape(data)
        if path.name == "strategy.json" and isinstance(data, dict):
            meta["strategy_immutables"] = strategy_immutables_snapshot(data)
    return meta


def anthropic_credentials_available() -> bool:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    config_dir = Path(os.environ.get("ANTHROPIC_CONFIG_DIR") or Path.home() / ".config" / "anthropic")
    profile = os.environ.get("ANTHROPIC_PROFILE")
    if not profile and (config_dir / "active_config").exists():
        profile = (config_dir / "active_config").read_text(errors="ignore").strip()
    profile = profile or "default"
    return (config_dir / "configs" / f"{profile}.json").exists()


def strip_markdown_copy(text: str) -> str:
    lines: list[str] = []
    in_full_copy = False
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped.lower().startswith("## full ad copy"):
            in_full_copy = True
            continue
        if not in_full_copy and (stripped.startswith("#") or stripped.startswith("**")):
            continue
        if stripped.startswith(">"):
            stripped = stripped.lstrip("> ")
        stripped = stripped.replace("**", "").replace("“", '"').replace("”", '"').replace("’", "'")
        if stripped and not stripped.startswith("---"):
            lines.append(stripped)
    return "\n".join(lines).strip()


def short_paragraphs(text: str, *, max_words: int = 28) -> list[str]:
    clean = re.sub(r"\s+", " ", text).strip()
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", clean) if s.strip()]
    paragraphs: list[str] = []
    for sentence in sentences:
        words = sentence.split()
        if len(words) <= max_words:
            paragraphs.append(sentence)
            continue
        for i in range(0, len(words), max_words):
            chunk = " ".join(words[i : i + max_words]).strip(" ,;:")
            if chunk:
                paragraphs.append(chunk + ".")
    return paragraphs


def guard_edited_artifact(path: Path, before_text: str, after_text: str, *, batch_dir: Path) -> None:
    if not is_relative_to(path, batch_dir):
        raise ValueError(f"refusing edit outside active batch directory: {path}")
    if path.suffix.lower() == ".json":
        before = json.loads(before_text)
        after = json.loads(after_text)
        assert_json_content_only(before, after, path=path)
        if path.name == "strategy.json":
            assert_strategy_immutables(before, after, path=path)
            compile_spec(after)
    elif not after_text.strip():
        raise ValueError(f"refusing empty artifact: {path}")


def markdown_artifact_link(path: Path, label: str | None = None) -> str:
    target = str(path.resolve())
    if any(ch.isspace() for ch in target):
        target = f"<{target}>"
    return f"[{label or path.name}]({target})"


class LfsAgentRunner:
    def __init__(
        self,
        *,
        input_path: Path | None,
        resume: str | None,
        base_path: Path = REPO,
        yolo: bool = False,
        from_stage: str | None = None,
        workers: int = 4,
        generation_workers: int = 20,
        context_product: str | None = None,
        context_batch_id: str | None = None,
        reviewer: Callable[["LfsAgentRunner", str, list[Path]], str] | None = None,
    ) -> None:
        if not input_path and not resume:
            raise ValueError("provide an input angle.md/strategy.json or --resume BATCH_ID")
        if from_stage and from_stage not in STAGE_SPECS:
            expected = ", ".join(STAGE_ORDER)
            raise ValueError(f"unknown --from stage {from_stage!r}; expected one of: {expected}")

        self.input_path = input_path.resolve() if input_path else None
        self.resume = resume
        self.base_path = base_path
        self.yolo = yolo
        self.from_stage = from_stage
        self.workers = max(workers, 1)
        self.generation_workers = max(generation_workers, 1)
        self.context_product = context_product
        self.context_batch_id = context_batch_id
        self.reviewer = reviewer
        self.strategy_path: Path | None = None
        self.batch_dir: Path | None = None
        self.batch_id: str | None = None
        self.product: str | None = None
        self.strategy: dict[str, Any] = {}
        self.spec: dict[str, Any] = {}
        self.state: dict[str, Any] = {}
        self.stage_payloads: dict[str, Any] = {}

    @property
    def state_path(self) -> Path:
        return self.require_batch_dir() / "agent-run.json"

    @property
    def event_path(self) -> Path:
        return self.require_batch_dir() / "agent-events.jsonl"

    def require_batch_dir(self) -> Path:
        if not self.batch_dir:
            raise RuntimeError("batch_dir is not initialized")
        return self.batch_dir

    def batch_ref(self) -> str:
        """Return the active batch directory for downstream stage resolution."""
        return str(self.require_batch_dir())

    def normalize_batch_report(self, filename: str, payload: Any) -> Any:
        if not isinstance(payload, dict) or payload.get("batch_id") == self.batch_id:
            return payload
        normalized = {**payload, "batch_id": self.batch_id}
        path = self.require_batch_dir() / filename
        if path.exists():
            path.write_text(json.dumps(normalized, indent=2) + "\n")
        return normalized

    def initialize_context(self) -> None:
        if self.resume:
            self.batch_dir = resolve_batch_dir(self.resume, base_path=self.base_path)
            state = read_json(self.batch_dir / "agent-run.json") if (self.batch_dir / "agent-run.json").exists() else {}
            self.state = state
            self.batch_id = state.get("batch_id") or self.batch_dir.name
            self.strategy_path = self.batch_dir / "strategy.json"
            if not self.strategy_path.exists():
                raise FileNotFoundError(f"missing strategy for resume: {self.strategy_path}")
            self.strategy = load_strategy(self.strategy_path)
            self.spec = read_json(self.batch_dir / "spec.json")
            self.product = self.spec.get("product")
            if self.input_path and self.input_path.resolve() != self.strategy_path.resolve():
                raise ValueError(f"--resume {self.resume} already owns strategy {self.strategy_path}")
            return

        assert self.input_path is not None
        if self.input_path.suffix.lower() == ".md":
            env_product, env_batch_id = env_context()
            input_product, input_batch_id, _input_batch_dir = context_from_dir(self.input_path, self.base_path)
            context_product = self.context_product or env_product or input_product
            context_batch_id = self.context_batch_id or env_batch_id or input_batch_id
            result = compile_angles(
                self.input_path,
                base_path=self.base_path,
                dry_run=True,
                context_product=context_product,
                context_batch_id=context_batch_id,
            )
            self.batch_dir = Path(result["batch_dir"])
            self.strategy = result["strategy"]
            self.spec = result["spec"]
            self.batch_id = result["batch_id"]
            self.product = result["product"]
            self.strategy_path = self.batch_dir / "strategy.json"
            return

        if self.input_path.suffix.lower() != ".json":
            raise ValueError("input must be an angles .md file or strategy .json file")
        self.strategy = load_strategy(self.input_path)
        self.spec = compile_spec(self.strategy)
        self.batch_id = str(self.spec["batch_id"])
        self.product = str(self.spec["product"])
        self.batch_dir = batch_dir_for_write(
            base_path=self.base_path,
            batch_id=self.batch_id,
            product=self.product,
            source_path=self.input_path,
        )
        self.strategy_path = self.batch_dir / "strategy.json"

    def load_or_create_state(self) -> None:
        batch_dir = self.require_batch_dir()
        if self.state_path.exists():
            self.state = read_json(self.state_path)
        else:
            self.state = {
                "schema": "lfs-agent-run/v1",
                "batch_id": self.batch_id,
                "product": self.product,
                "batch_dir": str(batch_dir),
                "input_path": str(self.input_path) if self.input_path else None,
                "mode": "yolo" if self.yolo else "guided",
                "status": "initialized",
                "current_stage": None,
                "stage_order": STAGE_ORDER,
                "stages": {},
                "artifact_hashes": {},
                "artifact_metadata": {},
                "created_at": now(),
                "updated_at": now(),
            }
        self.state["mode"] = "yolo" if self.yolo else "guided"
        self.save_state()

    def save_state(self) -> None:
        batch_dir = self.require_batch_dir()
        batch_dir.mkdir(parents=True, exist_ok=True)
        self.state["updated_at"] = now()
        self.state_path.write_text(json.dumps(self.state, indent=2) + "\n")

    def event(self, event: str, **payload: Any) -> None:
        record = {"ts": now(), "event": event, "batch_id": self.batch_id, **payload}
        self.event_path.parent.mkdir(parents=True, exist_ok=True)
        with self.event_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True) + "\n")
        print(json.dumps(record, sort_keys=True), flush=True)

    def stage_artifacts(self, stage: str) -> list[Path]:
        batch_dir = self.require_batch_dir()
        paths: list[Path] = []
        for pattern in STAGE_SPECS[stage].artifact_patterns:
            for path in sorted(batch_dir.glob(pattern)):
                if path.is_file() and path not in paths:
                    paths.append(path)
        return paths

    def editable_artifacts(self, stage: str) -> list[Path]:
        batch_dir = self.require_batch_dir()
        paths: list[Path] = []
        for pattern in STAGE_SPECS[stage].editable_patterns:
            for path in sorted(batch_dir.glob(pattern)):
                if path.is_file() and is_relative_to(path, batch_dir) and path not in paths:
                    paths.append(path)
        return paths

    def artifact_hashes(self, artifacts: list[Path]) -> dict[str, str]:
        return {str(path): sha256_file(path) for path in artifacts if path.exists() and path.is_file()}

    def artifact_links(self, stage: str, artifacts: list[Path]) -> list[dict[str, Any]]:
        batch_dir = self.require_batch_dir()
        links = []
        for path in artifacts:
            if not path.exists() or not path.is_file():
                continue
            try:
                rel = str(path.relative_to(batch_dir))
            except ValueError:
                rel = path.name
            label = f"{stage}: {rel}"
            links.append({
                "label": label,
                "path": str(path.resolve()),
                "markdown": markdown_artifact_link(path, label),
                "preview": path.suffix.lower() in {".md", ".json", ".jsonl", ".txt"},
            })
        return links

    def print_artifact_links(self, stage: str, artifacts: list[Path]) -> None:
        links = self.artifact_links(stage, artifacts)
        print(f"\nARTIFACTS READY: {STAGE_SPECS[stage].title} [{stage}]")
        if not links:
            print("  (no file artifacts)")
            return
        for item in links[:12]:
            print(f"  - {item['markdown']}")
        if len(links) > 12:
            print(f"  ... and {len(links) - 12} more in {markdown_artifact_link(self.require_batch_dir() / 'wwx-artifacts.json', 'artifact manifest')}")
        print(flush=True)

    def operator_stage_ui(
        self,
        stage: str,
        *,
        status: str,
        payload: Any | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        label = OPERATOR_STAGE_LABELS.get(stage, STAGE_SPECS.get(stage, StageSpec(stage, stage, ())).title)
        summary = OPERATOR_STAGE_SUMMARIES.get(stage, f"{label} is ready.")
        if status == "failed":
            summary = error or f"{label} could not finish."
        elif stage == "manifest_overview" and isinstance(payload, dict):
            ship = payload.get("ship")
            review = payload.get("review")
            fail = payload.get("fail")
            if ship is not None or review is not None or fail is not None:
                summary = f"Final decisions: {ship or 0} ship, {review or 0} review, {fail or 0} fail."
        return {
            "stage_label": label,
            "summary": summary,
            "status_label": "needs review" if status == "ok" and not self.yolo else status,
            "operator_needed": status == "failed",
            "retryable": status == "failed",
            "primary_action": {
                "kind": "continue" if status == "ok" and not self.yolo else "wait",
                "label": "Continue to next stage" if status == "ok" and not self.yolo else "Running",
            },
        }

    def update_public_ui(
        self,
        *,
        headline: str,
        summary: str,
        tone: str,
        primary_action: dict[str, Any] | None = None,
        secondary_action: dict[str, Any] | None = None,
        operator_needed: bool = False,
        retryable: bool = False,
        failure_kind: str | None = None,
        reason: str | None = None,
    ) -> None:
        self.state["public_ui"] = {
            "headline": headline,
            "summary": summary,
            "tone": tone,
            "operator_needed": operator_needed,
            "retryable": retryable,
            "failure_kind": failure_kind,
            "reason": reason,
            "primary_action": primary_action,
            "secondary_action": secondary_action,
        }

    def write_overall_report(self) -> None:
        report = {
            "schema": "lfs-v4.1-report/v1",
            "batch_id": self.batch_id,
            "generated_at": now(),
            "runner": "lfs-agent",
            "mode": self.state.get("mode"),
            "clean": self.state.get("status") == "complete",
            "steps": self.state.get("stages", {}),
            "agent_state_path": str(self.state_path),
            "agent_events_path": str(self.event_path),
        }
        (self.require_batch_dir() / "lfs-v41-report.json").write_text(json.dumps(report, indent=2) + "\n")

    def run_stage(self, stage: str) -> Any:
        started = time.monotonic()
        self.state["status"] = "running"
        self.state["current_stage"] = stage
        self.state["active_lock_owner"] = {"pid": os.getpid(), "stage": stage, "started_at": now()}
        self.save_state()
        self.event("stage_started", stage=stage)
        try:
            payload = getattr(self, f"stage_{stage}")()
            ok = step_ok(payload) or stage in NON_BLOCKING_PAYLOAD_STAGES
            status = "ok" if ok else "failed"
            if not ok:
                raise RuntimeError(self.payload_failure_summary(stage, payload))
            return payload
        except Exception as exc:
            self.state["stages"][stage] = {
                "status": "failed",
                "error": str(exc),
                "finished_at": now(),
                "elapsed_seconds": round(time.monotonic() - started, 1),
                "public_ui": self.operator_stage_ui(stage, status="failed", error=str(exc)),
            }
            self.state["status"] = "failed"
            self.update_public_ui(
                headline=f"{OPERATOR_STAGE_LABELS.get(stage, stage)} needs attention",
                summary=str(exc),
                tone="danger",
                primary_action={"kind": "repair", "label": "Repair and continue"},
                secondary_action={"kind": "provide_input", "label": "Provide missing input"},
                operator_needed=True,
                retryable=True,
                reason=str(exc),
            )
            self.save_state()
            self.event("stage_failed", stage=stage, error=str(exc))
            raise

    def payload_failure_summary(self, stage: str, payload: Any) -> str:
        if not isinstance(payload, dict):
            return f"{stage} failed"
        if payload.get("error"):
            return str(payload["error"])
        failed = int(payload.get("failed") or 0)
        total = payload.get("total_tasks") or payload.get("total_scripts") or payload.get("completed_tasks")
        bits = [f"{stage} failed"]
        if failed:
            bits.append(f"{failed}/{total or '?'} task(s) failed")
        results = payload.get("results")
        if isinstance(results, list):
            for item in results:
                if not isinstance(item, dict):
                    continue
                status = str(item.get("status") or "")
                success = item.get("success")
                generated = item.get("generated")
                if status == "failed" or success is False or generated is False:
                    task_id = str(item.get("task_id") or "task")
                    error = str(item.get("error") or item.get("reason") or "no safe failure detail")
                    bits.append(f"{task_id}: {error[:240]}")
                    break
        return "; ".join(bits)

    def finish_stage(self, stage: str, payload: Any) -> list[Path]:
        artifacts = self.stage_artifacts(stage)
        hashes = self.artifact_hashes(artifacts)
        metadata = {str(path): artifact_metadata(path) for path in artifacts if path.exists() and path.is_file()}
        validation = self.validation_summary(stage, payload, artifacts)
        links = self.artifact_links(stage, artifacts)
        self.stage_payloads[stage] = payload
        self.state["stages"][stage] = {
            "status": "ok",
            "approved": bool(self.yolo),
            "finished_at": now(),
            "artifacts": [str(path) for path in artifacts],
            "artifact_links": links,
            "hashes": hashes,
            "metadata": metadata,
            "validation": validation,
            "payload_summary": self.payload_summary(payload),
            "public_ui": self.operator_stage_ui(stage, status="ok", payload=payload),
        }
        self.state["artifact_hashes"].update(hashes)
        self.state.setdefault("artifact_metadata", {}).update(metadata)
        self.state["status"] = "awaiting_review" if not self.yolo else "running"
        if not self.yolo:
            self.update_public_ui(
                headline=f"{OPERATOR_STAGE_LABELS.get(stage, STAGE_SPECS[stage].title)} is ready. Continue to next stage?",
                summary="Skim the checkpoint, then continue when it looks right.",
                tone="warning",
                primary_action={"kind": "continue", "label": "Continue to next stage"},
                secondary_action={"kind": "open_agent", "label": "Ask / Hold"},
            )
        else:
            self.update_public_ui(
                headline=f"{OPERATOR_STAGE_LABELS.get(stage, STAGE_SPECS[stage].title)} finished",
                summary=OPERATOR_STAGE_SUMMARIES.get(stage, "The workflow is continuing."),
                tone="running",
                primary_action={"kind": "wait", "label": "Running"},
            )
        self.state.pop("active_lock_owner", None)
        self.save_state()
        write_artifact_manifest(self.require_batch_dir(), batch_id=self.batch_id, product=self.product)
        self.write_overall_report()
        self.event("stage_finished", stage=stage, artifact_count=len(artifacts), validation=validation)
        self.print_artifact_links(stage, artifacts)
        return artifacts

    def payload_summary(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            return {"type": type(payload).__name__}
        summary: dict[str, Any] = {}
        for key in ("failed", "passed", "repaired", "generated", "copied", "skipped", "clean", "total_scripts"):
            if key in payload:
                summary[key] = payload[key]
        return summary

    def deterministic_fallback_enabled(self) -> bool:
        return os.environ.get("LFS_AGENT_ALLOW_DETERMINISTIC_FALLBACK") == "1" and not anthropic_credentials_available()

    def require_generation_credentials(self, stage: str) -> None:
        if anthropic_credentials_available() or self.deterministic_fallback_enabled():
            return
        raise RuntimeError(
            f"{stage} requires Anthropic credentials; refusing to fabricate production artifacts without them"
        )

    def task_items(self) -> list[dict[str, Any]]:
        ads = self.strategy.get("ads")
        if isinstance(ads, list) and ads:
            return [ad for ad in ads if isinstance(ad, dict)]
        return [{"task_id": task_id, "angle": task_id, "format": self.strategy.get("lfs_format_template", "confession")} for task_id in self.spec.get("task_ids", [])]

    def item_for_task(self, task_id: str) -> dict[str, Any]:
        for item in self.task_items():
            if item.get("task_id") == task_id:
                return item
        return {"task_id": task_id}

    def missing_prompt_task_ids(self) -> list[str]:
        prompt_dir = self.require_batch_dir() / "prompts"
        missing = []
        for task_id in self.spec.get("task_ids", []):
            task = str(task_id)
            if not (prompt_dir / f"{task}.md").exists():
                missing.append(task)
        return missing

    def ensure_lfs_brief_prompts(self, *, required_by: str) -> None:
        missing = self.missing_prompt_task_ids()
        if not missing:
            return
        self.event("dependency_missing", stage=required_by, dependency="lfs_brief", missing_prompts=missing)
        payload = self.stage_lfs_brief()
        ok = step_ok(payload)
        artifacts = self.finish_stage("lfs_brief", payload)
        self.state["stages"]["lfs_brief"]["approved"] = True
        self.state["stages"]["lfs_brief"]["approval_source"] = f"auto_dependency_for_{required_by}"
        self.save_state()
        self.event("dependency_rebuilt", stage=required_by, dependency="lfs_brief", artifact_count=len(artifacts))
        if not ok:
            raise RuntimeError(payload.get("error", "lfs_brief dependency rebuild failed") if isinstance(payload, dict) else "lfs_brief dependency rebuild failed")
        missing_after = self.missing_prompt_task_ids()
        if missing_after:
            raise RuntimeError(f"lfs_brief dependency rebuild did not create prompt(s): {', '.join(missing_after)}")

    def source_copy_for_item(self, item: dict[str, Any]) -> str:
        raw = str(item.get("source_swipe") or "").strip()
        if raw:
            source = Path(raw)
            if not source.is_absolute():
                source = self.base_path / source
            if source.exists():
                return strip_markdown_copy(source.read_text(errors="replace"))
        return str(item.get("angle") or item.get("edge_to_preserve") or item.get("task_id") or "")

    def forbidden_phrases(self) -> list[str]:
        cfg = load_product_config(str(self.product), self.base_path)
        phrases = ((cfg.get("prompt_context") or {}).get("forbidden_phrases") or [])
        return [str(phrase).strip() for phrase in phrases if str(phrase).strip()]

    def sanitize_prompt_text(self, text: str) -> str:
        clean = text
        for phrase in sorted(self.forbidden_phrases(), key=len, reverse=True):
            replacement = "the specialist" if re.search(r"\b(?:dr|doctor)\b", phrase, re.IGNORECASE) else "approved wording"
            token = phrase.strip()
            if re.match(r"^\w+$", token):
                pattern = rf"\b{re.escape(token)}\b"
            else:
                pattern = re.escape(token)
            clean = re.sub(pattern, replacement, clean, flags=re.IGNORECASE)
        return clean

    def write_fallback_prompt(self, task_id: str, item: dict[str, Any], out_path: Path) -> None:
        lfs_format = str(item.get("format") or self.strategy.get("lfs_format_template") or "confession")
        source = str(item.get("source_swipe") or "")
        hook = self.sanitize_prompt_text(str(item.get("angle") or task_id))
        text = f"""---
task_id: {task_id}
concept: {task_id.lower()}
strategist: deterministic-fallback
product: {self.product}
format: lfs
lfs_format: {lfs_format}
---

## VERBATIM HOOK
{hook}

## OUTLINE INTENT
Use the source swipe pressure curve, the selected product mechanism, and the product offer truth.

## MECHANISM LOCK
Use the product mechanism selected by the task id. Do not invent another mechanism.

## SOURCE SWIPE
{source}
"""
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text.rstrip() + "\n")

    def write_fallback_outline(self, task_id: str, item: dict[str, Any], out_path: Path) -> None:
        product_name = load_product_config(str(self.product), self.base_path).get("product_name") or str(self.product)
        lfs_format = str(item.get("format") or self.strategy.get("lfs_format_template") or "confession")
        text = f"""## LFS V4.1 Format-Merged Outline: {lfs_format} / source angle -> {product_name}

## Beat 1: Source-Pressure Hook
Restate the source swipe's opening problem in plain customer language.

## Beat 2: Daily Friction
Show the visible swelling, tight clothes, rings, shoes, or evening discomfort.

## Beat 3: Failed Search
Name the reasonable failed attempts without adding new medical claims.

## Beat 4: Mechanism Turn
Explain defensive water weight and lymphatic drainage using the approved product mechanism.

## Beat 5: Product Entry
Introduce {product_name} as the practical way to support the drainage routine.

## Beat 6: Proof Markers
Use grounded timeline markers and concrete daily-life improvements.

## Beat 7: Offer Close
Use the exact CTA and guarantee from the batch spec.

## Scale Check
Plain native LFS formatting, product truth, short paragraphs, and no extra claims.
"""
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text.rstrip() + "\n")

    def fallback_script_text(self, task_id: str, item: dict[str, Any]) -> str:
        cfg = load_product_config(str(self.product), self.base_path)
        product_name = str(cfg.get("product_name") or self.product)
        cta = str(self.spec.get("cta_text") or self.strategy.get("cta_text") or "")
        source_paragraphs = short_paragraphs(self.source_copy_for_item(item))
        source_paragraphs = [
            p for p in source_paragraphs
            if not re.search(r"\b(?:Dr\.|Doctor)\b", p, re.IGNORECASE)
        ][:18]
        if not source_paragraphs:
            source_paragraphs = [
                "I was swollen everywhere and no one could explain why.",
                "My face looked puffy in the morning and my legs felt heavy by dinner.",
                "I kept trying the obvious fixes and kept ending up in the same place.",
            ]

        sections = [
            source_paragraphs[:4],
            [
                "The part that bothered me most was how fast it changed during the day.",
                "Fat does not appear by dinner and disappear by morning.",
                "That was the first clue that I was looking at fluid, not failure.",
            ],
            [
                "I had tried compression, elevation, cleaner meals, and every little routine people recommend.",
                "Some things helped for a few hours.",
                "Nothing made the pattern stop coming back.",
            ],
            [
                "Then I learned the simple drainage idea that finally made the pattern make sense.",
                "Your gut carries a huge amount of lymph tissue.",
                "When that drainage gets sluggish, fluid can pool instead of moving out.",
                "That is why a belly can feel hard, tight, and inflated even when food is not the real issue.",
            ],
            [
                f"That is why I started using {product_name}.",
                f"{product_name} is built around four drainage herbs: cleavers, red clover, prickly ash bark, and stillingia root.",
                "The point is not to force the body or chase water for a few hours.",
                "The point is to support the drainage system that was supposed to move that fluid in the first place.",
            ],
            [
                "The first thing I noticed was not dramatic.",
                "I just felt less heavy at the end of the day.",
                "Then my rings stopped feeling like they were cutting into my fingers.",
                "Then my shoes fit later in the evening.",
                "The old panic around getting dressed started to quiet down.",
            ],
            [
                "I am not saying every body is the same.",
                "I am saying this was the first explanation that matched what I was actually living through.",
                f"If your swelling pattern feels like mine did, {product_name} is the thing I would look at first.",
                cta,
                f"P.S. {product_name} is backed by the 60-day money-back guarantee, so the easiest way to know is to try it and watch your own pattern.",
            ],
        ]
        return "\n\n========\n\n".join("\n\n".join(part for part in section if part.strip()) for section in sections) + "\n"

    def write_fallback_script(self, task_id: str, item: dict[str, Any], out_path: Path) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(self.fallback_script_text(task_id, item))

    def validation_summary(self, stage: str, payload: Any, artifacts: list[Path]) -> dict[str, Any]:
        status = "ok" if step_ok(payload) else "failed"
        summary = {"status": status, "artifact_count": len(artifacts)}
        if isinstance(payload, dict):
            for key in ("failed", "clean", "passed", "repaired", "total_scripts"):
                if key in payload:
                    summary[key] = payload[key]
        if stage == "manifest_overview":
            manifest_path = self.require_batch_dir() / "lfs-v41-manifest.json"
            if manifest_path.exists():
                manifest = read_json(manifest_path)
                summary["ship"] = manifest.get("ship", 0)
                summary["review"] = manifest.get("review", 0)
                summary["fail"] = manifest.get("fail", 0)
        return summary

    def review_stage(self, stage: str, artifacts: list[Path]) -> str:
        if self.yolo:
            self.state["stages"][stage]["approved"] = True
            self.save_state()
            return "y"
        while True:
            self.print_review(stage, artifacts)
            action = self.reviewer(self, stage, artifacts) if self.reviewer else read_review_key()
            action = action.lower().strip()[:1]
            if action == "y":
                self.state["stages"][stage]["approved"] = True
                self.state["status"] = "running"
                self.save_state()
                self.event("stage_approved", stage=stage)
                return "y"
            if action == "n":
                self.state["status"] = "held"
                self.state["current_stage"] = stage
                self.state["stages"][stage]["held_at"] = now()
                self.save_state()
                self.event("stage_held", stage=stage)
                return "n"
            if action == "e":
                edit_result = self.handle_edit(stage)
                if edit_result == "hold":
                    return "n"
                artifacts = self.stage_artifacts(stage)
                self.state["stages"][stage]["artifacts"] = [str(path) for path in artifacts]
                self.state["stages"][stage]["artifact_links"] = self.artifact_links(stage, artifacts)
                self.state["stages"][stage]["hashes"] = self.artifact_hashes(artifacts)
                metadata = {str(path): artifact_metadata(path) for path in artifacts if path.exists() and path.is_file()}
                self.state["stages"][stage]["metadata"] = metadata
                self.state.setdefault("artifact_metadata", {}).update(metadata)
                self.save_state()
                continue
            print("Use y, n, or e.", flush=True)

    def pending_review_stage(self) -> str | None:
        stage = self.state.get("current_stage")
        if stage not in STAGE_ORDER:
            return None
        entry = self.state.get("stages", {}).get(stage, {})
        if entry.get("status") == "ok" and not entry.get("approved"):
            return str(stage)
        return None

    def approve_pending_stage(self, *, source: str = "app") -> str | None:
        stage = self.pending_review_stage()
        if not stage:
            return None
        self.state["stages"][stage]["approved"] = True
        self.state["stages"][stage]["approved_at"] = now()
        self.state["stages"][stage]["approval_source"] = source
        self.state["status"] = "running"
        self.save_state()
        self.event("stage_approved", stage=stage, source=source)
        return stage

    def next_start_index_app(self) -> int:
        if self.from_stage:
            return STAGE_ORDER.index(self.from_stage)
        approved = self.approve_pending_stage(source="app")
        if approved:
            return STAGE_ORDER.index(approved) + 1
        completed = [
            STAGE_ORDER.index(name)
            for name, entry in self.state.get("stages", {}).items()
            if name in STAGE_ORDER and entry.get("status") == "ok" and entry.get("approved", False)
        ]
        return max(completed) + 1 if completed else 0

    def should_force_stage(self, stage: str) -> bool:
        """Force deterministic regeneration for explicitly resumed stages.

        A retry from an earlier checkpoint is supposed to rebuild the affected
        artifact layer. Without this, generators that protect existing files
        report "skipped", leaving the desktop stuck on the same stale failed
        outline/prompt artifacts.
        """
        if not self.from_stage:
            return False
        return STAGE_ORDER.index(self.from_stage) <= STAGE_ORDER.index(stage)

    def print_review(self, stage: str, artifacts: list[Path]) -> None:
        spec = STAGE_SPECS[stage]
        validation = self.state["stages"].get(stage, {}).get("validation", {})
        print("\n" + "=" * 72)
        print(f"WAITING FOR REVIEW: {spec.title} [{stage}]")
        print(f"Batch: {self.batch_id}")
        print(f"Validation: {json.dumps(validation, sort_keys=True)}")
        print("Artifacts:")
        if not artifacts:
            print("  (no file artifacts)")
        for path in artifacts[:10]:
            print(f"  - {path}")
            preview = preview_artifact(path)
            if preview:
                for line in preview.splitlines()[:6]:
                    print(f"      {line}")
        if len(artifacts) > 10:
            print(f"  ... and {len(artifacts) - 10} more")
        print("WAITING FOR REVIEW: press y=yes, n=hold, e=edit")
        print("=" * 72, flush=True)

    def handle_edit(self, stage: str) -> str:
        editable = self.editable_artifacts(stage)
        if not editable:
            print("No editable artifacts for this stage.", flush=True)
            return "continue"
        print("\nEditable artifacts:")
        for idx, path in enumerate(editable, 1):
            print(f"  {idx}. {path}")
        raw = input("Edit artifact number, or type instruction for agent edit: ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(editable):
            path = editable[int(raw) - 1]
            before = path.read_text()
            editor = os.environ.get("EDITOR", "vi")
            subprocess.run([editor, str(path)], check=True)
            after = path.read_text()
            guard_edited_artifact(path, before, after, batch_dir=self.require_batch_dir())
            self.event("artifact_edited", stage=stage, path=str(path))
            return "continue"
        if raw:
            self.state["status"] = "edit_requested"
            self.state["current_stage"] = stage
            self.state.setdefault("edit_requests", []).append({
                "stage": stage,
                "instruction": raw,
                "created_at": now(),
                "editable_artifacts": [str(path) for path in editable],
            })
            self.save_state()
            self.event("agent_edit_requested", stage=stage, instruction=raw)
            print("Agent edit request recorded. Resume after the artifact is edited.", flush=True)
            return "hold"
        return "continue"

    def next_start_index(self) -> int:
        if self.from_stage:
            return STAGE_ORDER.index(self.from_stage)
        if self.state.get("status") in {"held", "edit_requested"} and self.state.get("current_stage") in STAGE_ORDER:
            stage = str(self.state["current_stage"])
            entry = self.state.get("stages", {}).get(stage, {})
            if entry.get("status") == "ok" and not entry.get("approved") and not self.yolo:
                artifacts = [Path(p) for p in entry.get("artifacts", []) if Path(p).exists()]
                action = self.review_stage(stage, artifacts)
                if action == "n":
                    raise HeldRun()
                return STAGE_ORDER.index(stage) + 1
        completed = [
            STAGE_ORDER.index(name)
            for name, entry in self.state.get("stages", {}).items()
            if name in STAGE_ORDER and entry.get("status") == "ok" and entry.get("approved", True)
        ]
        return max(completed) + 1 if completed else 0

    def verify_resume_hashes(self) -> None:
        mismatches: list[str] = []
        for path_str, expected in (self.state.get("artifact_hashes") or {}).items():
            path = Path(path_str)
            if path.exists() and sha256_file(path) != expected:
                mismatches.append(path_str)
        if mismatches:
            for path_str in mismatches:
                self.revalidate_resume_artifact(Path(path_str))
            self.state["manual_edits_detected"] = {"paths": mismatches, "detected_at": now()}
            self.save_state()
            self.event("manual_edits_detected", paths=mismatches)
            self.event("manual_edits_revalidated", paths=mismatches)

    def revalidate_resume_artifact(self, path: Path) -> None:
        if not is_relative_to(path, self.require_batch_dir()):
            raise ValueError(f"tracked artifact moved outside batch directory: {path}")
        if not path.exists():
            raise FileNotFoundError(f"tracked artifact missing during resume: {path}")
        text = path.read_text(errors="replace")
        if path.suffix.lower() != ".json":
            if not text.strip():
                raise ValueError(f"tracked artifact is empty during resume: {path}")
            return
        if path.name in {"wwx-artifacts.json", "agent-run.json", "lfs-v41-report.json"}:
            return
        current = json.loads(text)
        meta = (self.state.get("artifact_metadata") or {}).get(str(path), {})
        if meta.get("json_shape") and meta["json_shape"] != json_shape(current):
            raise ValueError(f"{path} changed JSON structure since last approved checkpoint")
        if path.name == "strategy.json":
            expected = meta.get("strategy_immutables")
            if expected and expected != strategy_immutables_snapshot(current):
                raise ValueError(f"{path} changed immutable strategy identity since last approved checkpoint")
            if isinstance(current, dict):
                compile_spec(current)

    def run(self) -> dict[str, Any]:
        self.initialize_context()
        self.load_or_create_state()
        self.verify_resume_hashes()
        batch_dir = self.require_batch_dir()
        agent_lock = BatchLock(batch_dir / ".lfs-agent.lock", batch_id=str(self.batch_id), strategy_path=self.strategy_path or batch_dir)
        v41_lock = BatchLock(batch_dir / ".lfs-v41.lock", batch_id=str(self.batch_id), strategy_path=self.strategy_path or batch_dir)
        agent_lock.acquire()
        v41_lock.acquire()
        try:
            start = self.next_start_index()
            for stage in STAGE_ORDER[start:]:
                payload = self.run_stage(stage)
                artifacts = self.finish_stage(stage, payload)
                action = self.review_stage(stage, artifacts)
                if action == "n":
                    raise HeldRun()
            self.state["status"] = "complete"
            self.state["current_stage"] = "manifest_overview"
            self.state.pop("active_lock_owner", None)
            self.update_public_ui(
                headline="Final ads are ready",
                summary="Review the ship, review, and fail decisions before upload.",
                tone="success",
                primary_action={"kind": "review_final", "label": "Review final ads"},
                secondary_action={"kind": "export", "label": "Export ship-ready ads"},
            )
            self.save_state()
            self.event("run_complete", upload_command=f"./tools/ww upload {self.batch_id}")
            self.print_final_overview()
            return self.state
        finally:
            try:
                self.write_overall_report()
            finally:
                v41_lock.release()
                agent_lock.release()

    def run_app_step(self) -> dict[str, Any]:
        """Run one checkpoint for app-native review.

        The desktop app cannot feed raw y/n/e into the terminal review loop, so
        each call approves the previously reviewed stage, runs exactly one next
        stage, then leaves state at awaiting_review for the UI/panel.
        """
        self.initialize_context()
        self.load_or_create_state()
        self.verify_resume_hashes()
        batch_dir = self.require_batch_dir()
        agent_lock = BatchLock(batch_dir / ".lfs-agent.lock", batch_id=str(self.batch_id), strategy_path=self.strategy_path or batch_dir)
        v41_lock = BatchLock(batch_dir / ".lfs-v41.lock", batch_id=str(self.batch_id), strategy_path=self.strategy_path or batch_dir)
        agent_lock.acquire()
        v41_lock.acquire()
        try:
            start = self.next_start_index_app()
            if start >= len(STAGE_ORDER):
                self.state["status"] = "complete"
                self.state["current_stage"] = "manifest_overview"
                self.state.pop("active_lock_owner", None)
                self.update_public_ui(
                    headline="Final ads are ready",
                    summary="Review the ship, review, and fail decisions before upload.",
                    tone="success",
                    primary_action={"kind": "review_final", "label": "Review final ads"},
                    secondary_action={"kind": "export", "label": "Export ship-ready ads"},
                )
                self.save_state()
                self.event("run_complete", upload_command=f"./tools/ww upload {self.batch_id}")
                self.print_final_overview()
                return self.state

            stage = STAGE_ORDER[start]
            payload = self.run_stage(stage)
            self.finish_stage(stage, payload)
            self.state["status"] = "awaiting_review"
            self.state["current_stage"] = stage
            self.save_state()
            self.event("app_step_awaiting_review", stage=stage)
            return self.state
        finally:
            try:
                self.write_overall_report()
            finally:
                v41_lock.release()
                agent_lock.release()

    def stage_compile_input(self) -> dict[str, Any]:
        assert self.input_path is not None or self.strategy_path is not None
        batch_dir = self.require_batch_dir()
        if self.input_path and self.input_path.suffix.lower() == ".md":
            result = compile_angles(
                self.input_path,
                base_path=self.base_path,
                dry_run=False,
                context_product=self.product,
                context_batch_id=self.batch_id,
            )
            self.strategy_path = batch_dir / "strategy.json"
            self.strategy = result["strategy"]
            self.spec = result["spec"]
        else:
            strategy_source = self.input_path or self.strategy_path
            assert strategy_source is not None
            batch_dir.mkdir(parents=True, exist_ok=True)
            strategy = load_strategy(strategy_source)
            spec = compile_spec(strategy)
            for filename, payload in (("strategy.json", strategy), ("spec.json", spec)):
                out = batch_dir / filename
                if out.exists():
                    try:
                        existing = json.loads(out.read_text())
                    except Exception:
                        existing = None
                    if existing != payload:
                        raise FileExistsError(f"refusing to overwrite different {out}")
                out.write_text(json.dumps(payload, indent=2) + "\n")
            self.strategy_path = batch_dir / "strategy.json"
            self.strategy = strategy
            self.spec = spec
            write_artifact_manifest(batch_dir, batch_id=self.batch_id, product=self.product)
        return {"failed": 0, "batch_dir": str(batch_dir), "strategy_path": str(self.strategy_path)}

    def stage_research_cards(self) -> dict[str, Any]:
        return run_research_cards(str(self.product), base_path=self.base_path)

    def stage_lfs_brief(self) -> dict[str, Any]:
        self.require_generation_credentials("lfs_brief")
        if self.deterministic_fallback_enabled():
            results = []
            for item in self.task_items():
                task_id = str(item.get("task_id"))
                out_path = self.require_batch_dir() / "prompts" / f"{task_id}.md"
                self.write_fallback_prompt(task_id, item, out_path)
                results.append({"task_id": task_id, "path": str(out_path), "status": "generated"})
            report = {
                "schema": "lfs-brief-report/v1",
                "batch_id": self.batch_id,
                "deterministic_fallback": True,
                "generated": len(results),
                "failed": 0,
                "results": results,
            }
            (self.require_batch_dir() / "lfs-brief-report.json").write_text(json.dumps(report, indent=2) + "\n")
            self.event("deterministic_fallback_used", stage="lfs_brief", reason="anthropic credentials unavailable")
            return report
        return run_lfs_brief(
            self.strategy_path or self.require_batch_dir() / "strategy.json",
            base_path=self.base_path,
            workers=self.workers,
            force=self.should_force_stage("lfs_brief"),
        )

    def stage_lfs_outline(self) -> dict[str, Any]:
        self.ensure_lfs_brief_prompts(required_by="lfs_outline")
        self.require_generation_credentials("lfs_outline")
        if self.deterministic_fallback_enabled():
            results = []
            for task_id in self.spec.get("task_ids", []):
                item = self.item_for_task(str(task_id))
                out_path = self.require_batch_dir() / "outlines" / f"{task_id}.md"
                self.write_fallback_outline(str(task_id), item, out_path)
                results.append({"task_id": task_id, "output_file": str(out_path), "status": "generated"})
            report = {
                "schema": "lfs-outline-report/v1",
                "batch_id": self.batch_id,
                "deterministic_fallback": True,
                "generated": len(results),
                "failed": 0,
                "results": results,
            }
            (self.require_batch_dir() / "lfs-outline-report.json").write_text(json.dumps(report, indent=2) + "\n")
            self.event("deterministic_fallback_used", stage="lfs_outline", reason="anthropic credentials unavailable")
            return report
        report = run_outline_batch(
            self.batch_ref(),
            base_path=self.base_path,
            model=os.environ.get("LFS_OUTLINE_MODEL", "claude-sonnet-4-6"),
            workers=self.workers,
            force=self.should_force_stage("lfs_outline"),
            dry_run=False,
            max_attempts=env_int("LFS_OUTLINE_MAX_ATTEMPTS", 4, minimum=2),
        )
        for attempt in range(env_int("WWX_LFS_OUTLINE_STAGE_RETRIES", 1, minimum=0)):
            if step_ok(report):
                break
            self.event(
                "stage_retrying",
                stage="lfs_outline",
                attempt=attempt + 1,
                failed=report.get("failed"),
                completed_tasks=report.get("completed_tasks"),
                pending_tasks=report.get("pending_tasks"),
            )
            report = run_outline_batch(
                self.batch_ref(),
                base_path=self.base_path,
                model=os.environ.get("LFS_OUTLINE_MODEL", "claude-sonnet-4-6"),
                workers=self.workers,
                force=False,
                dry_run=False,
                max_attempts=env_int("LFS_OUTLINE_RETRY_MAX_ATTEMPTS", 3, minimum=1),
            )
        return self.normalize_batch_report("lfs-outline-report.json", report)

    def stage_preflight_v41(self) -> dict[str, Any]:
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            passed = run_preflight(self.batch_ref(), self.base_path, check_output_flag=False, lfs_policy="v41")
        output = captured.getvalue()
        print(output, end="")
        failures = preflight_failures_from_output(output)
        report = {
            "schema": "lfs-preflight-report/v1",
            "batch_id": self.batch_id,
            "stage": "preflight_v41",
            "passed": passed,
            "failed": len(failures),
            "failures": failures,
            "lfs_policy": "v41",
        }
        (self.require_batch_dir() / "preflight-v41-report.json").write_text(json.dumps(report, indent=2) + "\n")
        if not passed and failures:
            report["error"] = "; ".join(
                f"{item['label']}: {item['detail']}" if item.get("detail") else item["label"]
                for item in failures[:5]
            )
        return report

    def stage_batch_generation(self) -> dict[str, Any]:
        self.require_generation_credentials("batch_generation")
        if self.deterministic_fallback_enabled():
            results = []
            output_dir = self.require_batch_dir() / "output"
            for task_id in self.spec.get("task_ids", []):
                item = self.item_for_task(str(task_id))
                out_path = output_dir / f"{task_id}.md"
                self.write_fallback_script(str(task_id), item, out_path)
                results.append({
                    "task_id": str(task_id),
                    "generated": True,
                    "success": True,
                    "output_file": str(out_path),
                    "error": None,
                })
            report = {
                "schema": "batch-report/v1",
                "batch_id": self.batch_id,
                "deterministic_fallback": True,
                "generated": len(results),
                "failed": 0,
                "results": results,
            }
            (self.require_batch_dir() / "report.json").write_text(json.dumps(report, indent=2) + "\n")
            self.event("deterministic_fallback_used", stage="batch_generation", reason="anthropic credentials unavailable")
            return report
        return self.normalize_batch_report(
            "report.json",
            run_generation_batch(
                self.batch_ref(),
                workers=self.generation_workers,
                base_path=self.base_path,
                output_mode="resume",
                preflight_policy="v41",
            ),
        )

    def stage_materialize_v41_candidates(self) -> dict[str, Any]:
        return materialize_v41_candidates(self.batch_ref(), base_path=self.base_path, output_subdir="output-v41")

    def stage_objective_finish_pre_semantic(self) -> dict[str, Any]:
        return self.normalize_batch_report(
            "lfs-v41-finish-report.json",
            run_v41_objective_finish(
                self.batch_ref(),
                base_path=self.base_path,
                output_subdir="output-v41",
                max_rounds=env_int("WWX_LFS_OBJECTIVE_MAX_ROUNDS", 3, minimum=0),
            ),
        )

    def stage_semantic_launchable(self) -> dict[str, Any]:
        self.require_generation_credentials("semantic_launchable")
        if self.deterministic_fallback_enabled():
            return self.write_fallback_semantic_report(stage="semantic_launchable")
        return self.normalize_batch_report(
            "lfs-semantic-report.json",
            run_semantic_batch(
                self.batch_ref(),
                base_path=self.base_path,
                output_subdir="output-v41",
                workers=self.workers,
                max_attempts=1,
                mode="launchable",
                preserve_opener=False,
            ),
        )

    def stage_objective_finish_final(self) -> dict[str, Any]:
        return self.normalize_batch_report(
            "lfs-v41-finish-report.json",
            run_v41_objective_finish(
                self.batch_ref(),
                base_path=self.base_path,
                output_subdir="output-v41",
                max_rounds=env_int("WWX_LFS_OBJECTIVE_MAX_ROUNDS", 3, minimum=0),
            ),
        )

    def stage_semantic_final_check(self) -> dict[str, Any]:
        self.require_generation_credentials("semantic_final_check")
        if self.deterministic_fallback_enabled():
            return self.write_fallback_semantic_report(stage="semantic_final_check")
        semantic_report = self.stage_payloads.get("semantic_launchable")
        objective_report = self.stage_payloads.get("objective_finish_final")
        if semantic_report is None and (self.require_batch_dir() / "lfs-semantic-report.json").exists():
            semantic_report = read_json(self.require_batch_dir() / "lfs-semantic-report.json")
        if objective_report is None and (self.require_batch_dir() / "lfs-v41-finish-report.json").exists():
            objective_report = read_json(self.require_batch_dir() / "lfs-v41-finish-report.json")
        if (
            isinstance(semantic_report, dict)
            and isinstance(objective_report, dict)
            and semantic_clean(semantic_report)
            and objective_repair_count(objective_report) == 0
        ):
            self.event(
                "semantic_final_reused",
                stage="semantic_final_check",
                reason="prior semantic verdict reused; final objective pass made no script changes",
            )
            return {
                "skipped": "prior semantic verdict reused; final objective pass made no script changes",
                "failed": 0,
                "total_scripts": semantic_report.get("total_scripts"),
                "passed": semantic_report.get("passed"),
                "repaired": semantic_report.get("repaired", 0),
            }
        return self.normalize_batch_report(
            "lfs-semantic-report.json",
            run_semantic_batch(
                self.batch_ref(),
                base_path=self.base_path,
                output_subdir="output-v41",
                workers=self.workers,
                max_attempts=0,
                mode="launchable",
                preserve_opener=False,
            ),
        )

    def write_fallback_semantic_report(self, *, stage: str) -> dict[str, Any]:
        results = []
        for task_id in self.spec.get("task_ids", []):
            results.append({
                "task_id": str(task_id),
                "passed": True,
                "status": "passed",
                "reason": "Deterministic desktop fallback used because Anthropic credentials were unavailable.",
            })
        report = {
            "schema": "lfs-semantic-report/v1",
            "batch_id": self.batch_id,
            "deterministic_fallback": True,
            "stage": stage,
            "failed": 0,
            "results": results,
        }
        (self.require_batch_dir() / "lfs-semantic-report.json").write_text(json.dumps(report, indent=2) + "\n")
        self.event("deterministic_fallback_used", stage=stage, reason="anthropic credentials unavailable")
        return report

    def stage_manifest_overview(self) -> dict[str, Any]:
        objective = self.stage_payloads.get("objective_finish_final")
        semantic = self.stage_payloads.get("semantic_final_check")
        if objective is None and (self.require_batch_dir() / "lfs-v41-finish-report.json").exists():
            objective = read_json(self.require_batch_dir() / "lfs-v41-finish-report.json")
        if semantic is None and (self.require_batch_dir() / "lfs-semantic-report.json").exists():
            semantic = read_json(self.require_batch_dir() / "lfs-semantic-report.json")
        manifest = build_v41_manifest(
            batch_id=str(self.batch_id),
            output_subdir="output-v41",
            objective_report=(objective or {}).get("objective", {}),
            semantic_report=semantic,
        )
        write_manifest(self.require_batch_dir(), manifest)
        write_artifact_manifest(self.require_batch_dir(), batch_id=self.batch_id, product=self.product)
        return {"failed": 0, "manifest_clean": manifest.get("fail", 0) == 0, **manifest}

    def print_final_overview(self) -> None:
        artifacts_path = self.require_batch_dir() / "wwx-artifacts.json"
        print("\nLFS agent complete.")
        print(f"Batch: {self.batch_id}")
        print(f"Overview: {self.state_path}")
        print(f"Artifacts: {markdown_artifact_link(artifacts_path, 'artifact manifest')}")
        manifest_path = self.require_batch_dir() / "lfs-v41-manifest.json"
        if manifest_path.exists():
            print(f"Manifest: {markdown_artifact_link(manifest_path, 'LFS V4.1 manifest')}")
        final_scripts = sorted((self.require_batch_dir() / "output-v41").glob("*.md"))
        if final_scripts:
            print("Final scripts:")
            for path in final_scripts[:12]:
                print(f"  - {markdown_artifact_link(path, path.name)}")
            if len(final_scripts) > 12:
                print(f"  ... and {len(final_scripts) - 12} more")
        print(f"Upload command: ./tools/ww upload {self.batch_id}")


class HeldRun(Exception):
    pass


def preview_artifact(path: Path) -> str:
    try:
        if path.suffix.lower() == ".json":
            data = json.loads(path.read_text())
            bits = []
            for key in ("schema", "batch_id", "product", "total_scripts", "ship", "review", "fail"):
                if key in data:
                    bits.append(f"{key}={data[key]}")
            if not bits:
                bits.append("keys=" + ",".join(list(data)[:8]) if isinstance(data, dict) else type(data).__name__)
            return "; ".join(bits)
        text = path.read_text(errors="replace")
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        return "\n".join(lines[:5])[:500]
    except Exception as exc:
        return f"preview unavailable: {exc}"


def read_review_key() -> str:
    if not sys.stdin.isatty():
        return input("Review action [y/n/e]: ")
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        ch = sys.stdin.read(1)
        print(ch)
        return ch
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def run_lfs_agent(
    input_path: Path | None = None,
    *,
    resume: str | None = None,
    base_path: Path = REPO,
    yolo: bool = False,
    from_stage: str | None = None,
    workers: int = 4,
    generation_workers: int = 20,
    context_product: str | None = None,
    context_batch_id: str | None = None,
    reviewer: Callable[[LfsAgentRunner, str, list[Path]], str] | None = None,
) -> dict[str, Any]:
    runner = LfsAgentRunner(
        input_path=input_path,
        resume=resume,
        base_path=base_path,
        yolo=yolo,
        from_stage=from_stage,
        workers=workers,
        generation_workers=generation_workers,
        context_product=context_product,
        context_batch_id=context_batch_id,
        reviewer=reviewer,
    )
    return runner.run()


def run_lfs_agent_app_step(
    input_path: Path | None = None,
    *,
    resume: str | None = None,
    base_path: Path = REPO,
    from_stage: str | None = None,
    workers: int = 4,
    generation_workers: int = 20,
    context_product: str | None = None,
    context_batch_id: str | None = None,
) -> dict[str, Any]:
    runner = LfsAgentRunner(
        input_path=input_path,
        resume=resume,
        base_path=base_path,
        yolo=False,
        from_stage=from_stage,
        workers=workers,
        generation_workers=generation_workers,
        context_product=context_product,
        context_batch_id=context_batch_id,
    )
    return runner.run_app_step()


def main() -> int:
    ap = argparse.ArgumentParser(description="Run guided terminal-first LFS V4.1 agent workflow")
    ap.add_argument("input", nargs="?", type=Path, help="angles.md or strategy.json")
    ap.add_argument("--resume", help="Resume a held or partial batch id")
    ap.add_argument("--from", dest="from_stage", choices=STAGE_ORDER, help="Start from a specific stage")
    ap.add_argument("--yolo", action="store_true", help="Run all stages without review pauses")
    ap.add_argument("--app-step", action="store_true", help="Approve the current checkpoint and run one stage for app-native review")
    ap.add_argument("--workers", "-w", type=int, default=4)
    ap.add_argument("--generation-workers", type=int, default=20)
    ap.add_argument("--product", help="Active product code supplied by the desktop/workflow data model for uploaded angle.md")
    ap.add_argument("--batch-id", help="Active batch id supplied by the desktop/workflow data model for uploaded angle.md")
    ap.add_argument("--base-path", type=Path, default=REPO)
    args = ap.parse_args()

    try:
        if args.app_step:
            state = run_lfs_agent_app_step(
                args.input,
                resume=args.resume,
                base_path=args.base_path,
                from_stage=args.from_stage,
                workers=args.workers,
                generation_workers=args.generation_workers,
                context_product=args.product,
                context_batch_id=args.batch_id,
            )
            print(json.dumps({
                "schema": "lfs-agent-app-step/v1",
                "batch_id": state.get("batch_id"),
                "product": state.get("product"),
                "status": state.get("status"),
                "current_stage": state.get("current_stage"),
                "stage": state.get("stages", {}).get(str(state.get("current_stage")), {}),
                "public_ui": state.get("public_ui"),
                "state_path": str(Path(state.get("batch_dir", "")) / "agent-run.json") if state.get("batch_dir") else None,
                "events_path": str(Path(state.get("batch_dir", "")) / "agent-events.jsonl") if state.get("batch_dir") else None,
                "artifacts_path": str(Path(state.get("batch_dir", "")) / "wwx-artifacts.json") if state.get("batch_dir") else None,
            }, sort_keys=True), flush=True)
        else:
            run_lfs_agent(
                args.input,
                resume=args.resume,
                base_path=args.base_path,
                yolo=args.yolo,
                from_stage=args.from_stage,
                workers=args.workers,
                generation_workers=args.generation_workers,
                context_product=args.product,
                context_batch_id=args.batch_id,
            )
    except HeldRun:
        print("LFS agent held for review. Resume with: ./tools/ww lfs-agent --resume BATCH_ID", flush=True)
        return HELD_EXIT_CODE
    except Exception as exc:
        print(f"LFS agent failed: {exc}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

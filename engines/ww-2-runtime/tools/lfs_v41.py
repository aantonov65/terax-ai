#!/usr/bin/env python3
"""LFS V4.1 semantic-first compiler.

V4.1 runs beside V4. Deterministic checks protect objective product truth and
deployability; Mystic-prompted semantic QA owns launchability and craft. The
runner reuses clean upstream artifacts and treats raw generation as the first
candidate, then repairs only the scripts that need objective or semantic work.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

THIS = Path(__file__).resolve()
REPO = THIS.parent.parent
sys.path.insert(0, str(THIS.parent))

from batch import run_batch as run_generation_batch  # noqa: E402
from compile_spec import compile_spec, load_strategy  # noqa: E402
from lfs_brief import run_lfs_brief  # noqa: E402
from lfs_chief import load_batch_cfg_cta  # noqa: E402
from lfs_fix import fix_one, structured_trim_word_high  # noqa: E402
from lfs_outline import run_outline_batch  # noqa: E402
from lfs_policy import V41_HARD_CODES, build_v41_objective_report, v41_objective_clean  # noqa: E402
from lfs_semantic import run_semantic_batch  # noqa: E402
from lfs_verify import check_text  # noqa: E402
from preflight import run_preflight  # noqa: E402
from research_cards import run_research_cards  # noqa: E402
from ww_artifacts import write_artifact_manifest  # noqa: E402
from ww_paths import batch_dir_for_write, resolve_batch_dir  # noqa: E402

STAGE_ALIASES = {
    "research_cards": "research_cards",
    "research": "research_cards",
    "brief": "lfs_brief",
    "lfs_brief": "lfs_brief",
    "outline": "lfs_outline",
    "lfs_outline": "lfs_outline",
    "preflight": "preflight_v41",
    "preflight_v41": "preflight_v41",
    "batch": "batch",
    "generation": "batch",
    "candidate": "materialize_v41_candidates",
    "materialize": "materialize_v41_candidates",
    "semantic": "lfs_semantic_launchable",
    "lfs_semantic": "lfs_semantic_launchable",
    "finish": "objective_finish",
    "objective": "objective_finish",
    "objective_finish": "objective_finish",
    "final": "semantic_final_check",
    "semantic_final": "semantic_final_check",
}

PARALLEL_REPORT_NAME = "lfs-v41-parallel-report.json"
PARALLEL_MAX_ATTEMPTS = 2
PARALLEL_OUTLINE_RETRY_ATTEMPTS = 5
MODEL_CALL_STAGES = {
    "lfs_brief",
    "lfs_outline",
    "batch",
    "lfs_semantic_launchable",
    "semantic_final_check",
}
TRANSIENT_RETRY_TOKENS = (
    "anthropic",
    "apierror",
    "internalservererror",
    "overloaded",
    "rate limit",
    "rate_limit",
    "readtimeout",
    "timeout",
    "timed out",
    "connectionerror",
    "connection reset",
    "error code: 500",
    "error code: 502",
    "error code: 503",
    "error code: 504",
    "error code: 529",
)


def utcish_now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def log_event(event: str, **payload: Any) -> None:
    record = {
        "ts": utcish_now(),
        "event": event,
        "attempt": int(os.environ.get("LFS_V41_ATTEMPT", "1") or "1"),
        **payload,
    }
    retry_bucket = os.environ.get("LFS_V41_RETRY_BUCKET")
    if retry_bucket:
        record["retry_bucket"] = retry_bucket
    print(json.dumps(record, sort_keys=True), flush=True)


def safe_filename(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "_" for ch in value)


def pid_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class BatchLock:
    """Filesystem lock for one batch_id so parallel V4.1 cannot collide on disk."""

    def __init__(self, path: Path, *, batch_id: str, strategy_path: Path):
        self.path = path
        self.batch_id = batch_id
        self.strategy_path = strategy_path
        self.acquired = False

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "pid": os.getpid(),
            "batch_id": self.batch_id,
            "strategy_path": str(self.strategy_path),
            "created_at": utcish_now(),
        }
        while True:
            try:
                fd = os.open(str(self.path), os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            except FileExistsError:
                existing = self._read_existing()
                pid = int(existing.get("pid") or 0) if isinstance(existing, dict) else 0
                if pid and not pid_is_alive(pid):
                    self.path.unlink(missing_ok=True)
                    continue
                detail = f" pid={pid}" if pid else ""
                raise RuntimeError(f"batch is already locked: {self.path}{detail}")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(payload, indent=2) + "\n")
            self.acquired = True
            return

    def release(self) -> None:
        if self.acquired:
            self.path.unlink(missing_ok=True)
            self.acquired = False

    def _read_existing(self) -> dict[str, Any]:
        try:
            return json.loads(self.path.read_text())
        except Exception:
            return {}


def step_ok(payload: Any) -> bool:
    if isinstance(payload, dict):
        if payload.get("failed", 0):
            return False
        if payload.get("clean") is False:
            return False
    return True


def script_files(batch_dir: Path, output_subdir: str) -> list[Path]:
    output_dir = batch_dir / output_subdir
    if not output_dir.exists():
        raise FileNotFoundError(f"output directory not found: {output_dir}")
    return [
        p for p in sorted(output_dir.glob("*.md"))
        if "_OUTLINE" not in p.name and "_VISUALS" not in p.name
    ]


def objective_results(batch_id: str, *, base_path: Path, output_subdir: str) -> list[Any]:
    cfg, cta = load_batch_cfg_cta(base_path, batch_id)
    batch_dir = resolve_batch_dir(batch_id, base_path=base_path)
    scripts = script_files(batch_dir, output_subdir)
    if not scripts:
        raise ValueError(f"no scripts found in {batch_dir / output_subdir}")
    return [
        check_text(path.read_text(), str(path), cfg, cta)
        for path in scripts
    ]


def run_v41_objective_finish(
    batch_id: str,
    *,
    base_path: Path,
    output_subdir: str,
    max_rounds: int = 1,
) -> dict[str, Any]:
    """Patch only objective hard failures; leave taste/advisory issues to semantic QA."""
    cfg, cta = load_batch_cfg_cta(base_path, batch_id)
    batch_dir = resolve_batch_dir(batch_id, base_path=base_path)
    rounds: list[dict[str, Any]] = []
    results = objective_results(batch_id, base_path=base_path, output_subdir=output_subdir)
    rounds.append({"round": 0, "objective": build_v41_objective_report(results)})

    repair_round = 1
    while repair_round <= max(max_rounds, 0) and not v41_objective_clean(results):
        repaired = 0
        for result in results:
            hard_codes = {
                violation.code for violation in result.violations
                if violation.code in V41_HARD_CODES
            }
            if not hard_codes:
                continue
            if "WORD_COUNT_HIGH" in hard_codes:
                max_words = next(
                    (
                        violation.detail.get("max", 2000)
                        for violation in result.violations
                        if violation.code == "WORD_COUNT_HIGH"
                    ),
                    2000,
                )
                if structured_trim_word_high(Path(result.script_path), cta, max_words=max_words):
                    repaired += 1
                    if hard_codes == {"WORD_COUNT_HIGH"}:
                        continue
            fix_one(
                Path(result.script_path),
                cfg,
                cta,
                dry_run=False,
                max_passes=1,
                only_codes=V41_HARD_CODES,
            )
            repaired += 1
        results = objective_results(batch_id, base_path=base_path, output_subdir=output_subdir)
        rounds.append({
            "round": repair_round,
            "scripts_repaired": repaired,
            "objective": build_v41_objective_report(results),
        })
        repair_round += 1

    objective = build_v41_objective_report(results)
    report = {
        "schema": "lfs-v4.1-objective-finish/v1",
        "batch_id": batch_id,
        "output_subdir": output_subdir,
        "generated_at": utcish_now(),
        "clean": objective["hard_clean"],
        "max_rounds": max_rounds,
        "rounds": rounds,
        "objective": objective,
    }
    report_path = batch_dir / "lfs-v41-finish-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    return report


def materialize_v41_candidates(
    batch_id: str,
    *,
    base_path: Path,
    source_subdir: str = "output",
    output_subdir: str = "output-v41",
) -> dict[str, Any]:
    """Copy raw generated scripts into the V4.1 candidate dir without clobbering."""
    batch_dir = resolve_batch_dir(batch_id, base_path=base_path)
    source_dir = batch_dir / source_subdir
    output_dir = batch_dir / output_subdir
    if not source_dir.exists():
        raise FileNotFoundError(f"raw output directory not found: {source_dir}")
    scripts = [
        p for p in sorted(source_dir.glob("*.md"))
        if "_OUTLINE" not in p.name and "_VISUALS" not in p.name
    ]
    if not scripts:
        raise ValueError(f"no raw scripts found in {source_dir}")

    output_dir.mkdir(parents=True, exist_ok=True)
    copied = 0
    skipped = 0
    records: list[dict[str, Any]] = []
    for source in scripts:
        dest = output_dir / source.name
        if dest.exists():
            skipped += 1
            status = "skipped_existing"
        else:
            shutil.copy2(source, dest)
            copied += 1
            status = "copied"
        records.append({"source": str(source), "dest": str(dest), "status": status})
    return {
        "source_subdir": source_subdir,
        "output_subdir": output_subdir,
        "total_scripts": len(records),
        "copied": copied,
        "skipped": skipped,
        "failed": 0,
        "records": records,
    }


def semantic_clean(report: dict[str, Any]) -> bool:
    return int(report.get("failed", 0) or 0) == 0


def objective_repair_count(report: dict[str, Any]) -> int:
    return sum(int(item.get("scripts_repaired", 0) or 0) for item in report.get("rounds", []) or [])


def build_v41_manifest(
    *,
    batch_id: str,
    output_subdir: str,
    objective_report: dict[str, Any],
    semantic_report: dict[str, Any] | None,
) -> dict[str, Any]:
    semantic_by_task = {
        str(item.get("task_id") or ""): item
        for item in (semantic_report or {}).get("results", []) or []
    }
    scripts: list[dict[str, Any]] = []
    for item in objective_report.get("scripts", []) or []:
        script_name = str(item.get("script") or "")
        task_id = script_name.removesuffix(".md")
        if "_" in task_id:
            parts = task_id.rsplit("_", 2)
            if len(parts) == 3 and parts[1].isdigit() and parts[2].isdigit():
                task_id = parts[0]
        semantic = semantic_by_task.get(task_id, {})
        hard_clean = bool(item.get("hard_clean"))
        semantic_passed = bool(semantic.get("passed")) if semantic_report else False
        decision = "ship" if hard_clean and semantic_passed else "fail" if not hard_clean else "review"
        scripts.append({
            "task_id": task_id,
            "script": script_name,
            "path": item.get("script_path"),
            "decision": decision,
            "hard_clean": hard_clean,
            "semantic_passed": semantic_passed,
            "semantic_status": semantic.get("status") if semantic else None,
            "hard_violations": item.get("hard_violations", []),
            "advisory_violations": item.get("advisory_violations", []),
            "semantic_reason": semantic.get("reason") if semantic else "semantic report missing",
        })

    counts: dict[str, int] = {}
    for item in scripts:
        counts[item["decision"]] = counts.get(item["decision"], 0) + 1
    return {
        "schema": "lfs-v4.1-manifest/v1",
        "batch_id": batch_id,
        "generated_at": utcish_now(),
        "output_subdir": output_subdir,
        "total_scripts": len(scripts),
        "decision_counts": counts,
        "ship": counts.get("ship", 0),
        "review": counts.get("review", 0),
        "fail": counts.get("fail", 0),
        "scripts": scripts,
    }


def write_manifest(batch_dir: Path, manifest: dict[str, Any]) -> None:
    (batch_dir / "lfs-v41-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def ensure_spec_artifact(batch_dir: Path, spec: dict[str, Any]) -> None:
    """Ensure the compiled spec exists without adding policy side effects."""
    batch_dir.mkdir(parents=True, exist_ok=True)
    spec_path = batch_dir / "spec.json"
    if spec_path.exists():
        existing = json.loads(spec_path.read_text())
        existing_clean = {k: v for k, v in existing.items() if k not in {"preflight_policy", "lfs_policy"}}
        if existing_clean != spec:
            raise ValueError(f"refusing to overwrite different spec.json: {spec_path}")
        if existing != spec:
            spec_path.write_text(json.dumps(spec, indent=2) + "\n")
        return
    spec_path.write_text(json.dumps(spec, indent=2) + "\n")


def write_report(batch_dir: Path, report: dict[str, Any]) -> None:
    batch_dir.mkdir(parents=True, exist_ok=True)
    (batch_dir / "lfs-v41-report.json").write_text(json.dumps(report, indent=2) + "\n")


def task_files_exist(batch_dir: Path, task_ids: list[str], subdir: str) -> bool:
    return bool(task_ids) and all((batch_dir / subdir / f"{task_id}.md").exists() for task_id in task_ids)


def dry_run_skip(stage: str, reason: str, *, task_count: int | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "dry_run": task_count if task_count is not None else 1,
        "skipped": reason,
        "failed": 0,
    }
    if stage == "preflight_v41":
        payload["lfs_policy"] = "v41"
    return payload


def run_step(
    report: dict[str, Any],
    name: str,
    fn: Callable[[], Any],
    *,
    fail_on_payload: bool = True,
) -> Any:
    started = time.monotonic()
    log_event("stage_started", stage=name)
    if name in MODEL_CALL_STAGES:
        log_event("model_call_started", stage=name)
    print(f"\n=== LFS V4.1: {name} ===", flush=True)
    try:
        payload = fn()
    except Exception as exc:
        report["steps"][name] = {"status": "failed", "error": str(exc)}
        log_event("stage_failed", stage=name, elapsed_seconds=round(time.monotonic() - started, 1), error=str(exc))
        raise
    status = "ok" if step_ok(payload) else "failed"
    entry: dict[str, Any] = {"status": status, "payload": payload}
    if status != "ok" and fail_on_payload:
        entry["error"] = payload.get("error", f"{name} failed") if isinstance(payload, dict) else f"{name} failed"
        report["steps"][name] = entry
        log_event("stage_failed", stage=name, elapsed_seconds=round(time.monotonic() - started, 1), error=entry["error"])
        raise RuntimeError(entry["error"])
    report["steps"][name] = entry
    log_event("stage_finished", stage=name, elapsed_seconds=round(time.monotonic() - started, 1), status=status)
    return payload


def run_lfs_v41(
    strategy_path: Path,
    *,
    base_path: Path = REPO,
    workers: int = 4,
    generation_workers: int = 20,
    objective_repair_rounds: int = 1,
    output_subdir: str = "output-v41",
    brief_model: str | None = None,
    outline_model: str | None = None,
    semantic_model: str | None = None,
    outline_max_attempts: int = 2,
    outline_task_timeout_seconds: int | None = None,
    until: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    strategy = load_strategy(strategy_path)
    spec = compile_spec(strategy)
    batch_id = spec["batch_id"]
    batch_dir = batch_dir_for_write(
        base_path=base_path,
        batch_id=batch_id,
        product=spec.get("product"),
        source_path=strategy_path,
    )
    report: dict[str, Any] = {
        "schema": "lfs-v4.1-report/v1",
        "batch_id": batch_id,
        "strategy_path": str(strategy_path),
        "generated_at": utcish_now(),
        "clean": False,
        "quality_target": "8/10 launchable at 100 scripts/day",
        "human_touchpoints": "beginning approval + final approval",
        "output_subdir": output_subdir,
        "dry_run": dry_run,
        "until": None,
        "until_requested": until,
        "steps": {},
    }
    stop_stage = STAGE_ALIASES.get(until or "") if until else None
    if until and not stop_stage:
        expected = ", ".join(sorted(STAGE_ALIASES))
        raise ValueError(f"Unsupported --until stage {until!r}; expected one of {expected}")

    def stop_after(stage_name: str) -> bool:
        if stop_stage != stage_name:
            return False
        report["until"] = stop_stage
        report["stopped_at"] = stage_name
        return True

    task_ids = [str(task_id) for task_id in spec.get("task_ids", [])]

    def prompts_ready() -> bool:
        return task_files_exist(batch_dir, task_ids, "prompts")

    def outlines_ready() -> bool:
        return task_files_exist(batch_dir, task_ids, "outlines")

    def outline_payload() -> dict[str, Any]:
        if dry_run and not prompts_ready():
            return dry_run_skip(
                "lfs_outline",
                "outline dry-run skipped because lfs_brief --dry-run does not materialize prompt files",
                task_count=len(task_ids),
            )
        return run_outline_batch(
            batch_id,
            base_path=base_path,
            model=outline_model or os.environ.get("LFS_OUTLINE_MODEL", "claude-sonnet-4-6"),
            workers=workers,
            force=False,
            dry_run=dry_run,
            max_attempts=max(outline_max_attempts, 1),
            task_timeout_seconds=outline_task_timeout_seconds or int(os.environ.get("LFS_OUTLINE_TASK_TIMEOUT_SECONDS", "600")),
        )

    def preflight_payload() -> dict[str, Any]:
        if dry_run and (not prompts_ready() or not outlines_ready()):
            return dry_run_skip(
                "preflight_v41",
                "preflight dry-run skipped because prompt/outline artifacts are not materialized",
            )
        passed = run_preflight(batch_id, base_path, check_output_flag=False, lfs_policy="v41")
        return {"passed": passed, "failed": 0 if passed else 1, "lfs_policy": "v41"}

    lock = BatchLock(batch_dir / ".lfs-v41.lock", batch_id=batch_id, strategy_path=strategy_path)
    lock.acquire()
    try:
        ensure_spec_artifact(batch_dir, spec)
        run_step(
            report,
            "research_cards",
            lambda: run_research_cards(spec["product"], base_path=base_path, dry_run=dry_run),
        )
        if stop_after("research_cards"):
            return report
        def brief_payload() -> dict[str, Any]:
            return run_lfs_brief(
                strategy_path,
                base_path=base_path,
                model=brief_model or os.environ.get("LFS_BRIEF_MODEL", "claude-sonnet-4-6"),
                workers=workers,
                force=False,
                dry_run=dry_run,
            )

        run_step(
            report,
            "lfs_brief",
            brief_payload,
        )
        if stop_after("lfs_brief"):
            return report
        run_step(
            report,
            "lfs_outline",
            outline_payload,
        )
        if stop_after("lfs_outline"):
            return report
        run_step(report, "preflight_v41", preflight_payload)
        if stop_after("preflight_v41"):
            return report
        run_step(
            report,
            "batch",
            lambda: (
                {"dry_run": 1, "skipped": "generation skipped by --dry-run", "failed": 0}
                if dry_run
                else run_generation_batch(
                    batch_id,
                    workers=generation_workers,
                    base_path=base_path,
                    output_mode="resume",
                    preflight_policy="v41",
                )
            ),
        )
        if stop_after("batch"):
            return report
        run_step(
            report,
            "materialize_v41_candidates",
            lambda: (
                {"dry_run": 1, "skipped": "candidate materialization skipped by --dry-run", "failed": 0}
                if dry_run
                else materialize_v41_candidates(
                    batch_id,
                    base_path=base_path,
                    output_subdir=output_subdir,
                )
            ),
        )
        if stop_after("materialize_v41_candidates"):
            return report
        run_step(
            report,
            "objective_finish_pre_semantic",
            lambda: (
                {"dry_run": 1, "skipped": "objective finish skipped by --dry-run", "failed": 0, "clean": True}
                if dry_run
                else run_v41_objective_finish(
                    batch_id,
                    base_path=base_path,
                    output_subdir=output_subdir,
                    max_rounds=objective_repair_rounds,
                )
            ),
        )
        if stop_after("objective_finish"):
            return report
        semantic_report = run_step(
            report,
            "lfs_semantic_launchable",
            lambda: (
                {"dry_run": 1, "skipped": "semantic judge skipped by --dry-run", "failed": 0}
                if dry_run
                else run_semantic_batch(
                    batch_id,
                    base_path=base_path,
                    output_subdir=output_subdir,
                    model=semantic_model or os.environ.get("LFS_SEMANTIC_MODEL", "claude-sonnet-4-6"),
                    workers=workers,
                    max_attempts=1,
                    mode="launchable",
                    preserve_opener=False,
                )
            ),
            fail_on_payload=False,
        )
        if stop_after("lfs_semantic_launchable"):
            return report
        objective_report = run_step(
            report,
            "objective_finish_final",
            lambda: (
                {"dry_run": 1, "skipped": "objective finish skipped by --dry-run", "failed": 0, "clean": True}
                if dry_run
                else run_v41_objective_finish(
                    batch_id,
                    base_path=base_path,
                    output_subdir=output_subdir,
                    max_rounds=objective_repair_rounds,
                )
            ),
        )
        if dry_run:
            final_semantic = {"dry_run": 1, "skipped": "final semantic check skipped by --dry-run", "failed": 0}
            report["steps"]["semantic_final_check"] = {"status": "ok", "payload": final_semantic}
        elif semantic_clean(semantic_report) and objective_repair_count(objective_report) == 0:
            final_semantic = semantic_report
            report["steps"]["semantic_final_check"] = {
                "status": "ok",
                "payload": {
                    "skipped": "prior semantic verdict reused; final objective pass made no script changes",
                    "failed": 0,
                },
            }
        else:
            final_semantic = run_step(
                report,
                "semantic_final_check",
                lambda: run_semantic_batch(
                    batch_id,
                    base_path=base_path,
                    output_subdir=output_subdir,
                    model=semantic_model or os.environ.get("LFS_SEMANTIC_MODEL", "claude-sonnet-4-6"),
                    workers=workers,
                    max_attempts=0,
                    mode="launchable",
                    preserve_opener=False,
                ),
                fail_on_payload=False,
            )
        if stop_after("semantic_final_check"):
            return report
        if not dry_run:
            manifest = build_v41_manifest(
                batch_id=batch_id,
                output_subdir=output_subdir,
                objective_report=objective_report.get("objective", {}),
                semantic_report=final_semantic,
            )
            write_manifest(batch_dir, manifest)
            report["manifest"] = manifest
        report["clean"] = bool(objective_report.get("clean")) and semantic_clean(final_semantic)
    finally:
        try:
            write_report(batch_dir, report)
            write_artifact_manifest(batch_dir, batch_id=batch_id, product=spec.get("product"))
        finally:
            lock.release()

    return report


def strategy_json_candidates(strategy_root: Path) -> list[Path]:
    if strategy_root.is_file():
        return [strategy_root]
    if not strategy_root.is_dir():
        raise FileNotFoundError(f"strategy path not found: {strategy_root}")
    return [
        path for path in sorted(strategy_root.glob("*.json"))
        if path.name not in {PARALLEL_REPORT_NAME, "report.json"}
        and not path.name.endswith("-report.json")
        and not path.name.endswith("_report.json")
    ]


def discover_strategy_jobs(strategy_root: Path, *, base_path: Path) -> list[dict[str, str]]:
    paths = strategy_json_candidates(strategy_root)
    if not paths:
        raise ValueError(f"no strategy JSON files found in {strategy_root}")

    jobs: list[dict[str, str]] = []
    errors: list[str] = []
    seen: dict[str, Path] = {}
    duplicates: list[str] = []
    for path in paths:
        try:
            strategy = load_strategy(path)
            if not isinstance(strategy, dict) or not strategy.get("batch_id") or not strategy.get("product"):
                continue
            if not strategy.get("task_ids") and not strategy.get("ads"):
                continue
            spec = compile_spec(strategy)
            batch_id = str(spec["batch_id"])
        except Exception as exc:
            errors.append(f"{path}: {exc}")
            continue
        if batch_id in seen:
            duplicates.append(f"{batch_id}: {seen[batch_id]} and {path}")
            continue
        seen[batch_id] = path
        jobs.append({"strategy_path": str(path), "batch_id": batch_id})

    if errors:
        raise ValueError("invalid strategy JSON files:\n" + "\n".join(errors))
    if duplicates:
        raise ValueError("duplicate V4.1 batch_id values are unsafe for parallel runs:\n" + "\n".join(duplicates))
    return jobs


def build_parallel_child_cmd(
    strategy_path: Path,
    *,
    base_path: Path,
    objective_repair_rounds: int,
    output_subdir: str,
    brief_model: str | None,
    outline_model: str | None,
    semantic_model: str | None,
    outline_max_attempts: int,
    outline_task_timeout_seconds: int | None,
    until: str | None,
    dry_run: bool,
) -> list[str]:
    cmd = [
        sys.executable,
        str(THIS),
        str(strategy_path),
        "--base-path",
        str(base_path),
        "--workers",
        "1",
        "--generation-workers",
        "1",
        "--objective-repair-rounds",
        str(max(objective_repair_rounds, 0)),
        "--output-subdir",
        output_subdir,
        "--outline-max-attempts",
        str(max(outline_max_attempts, 1)),
    ]
    if brief_model:
        cmd.extend(["--brief-model", brief_model])
    if outline_model:
        cmd.extend(["--outline-model", outline_model])
    if semantic_model:
        cmd.extend(["--semantic-model", semantic_model])
    if outline_task_timeout_seconds:
        cmd.extend(["--outline-task-timeout-seconds", str(outline_task_timeout_seconds)])
    if until:
        cmd.extend(["--until", until])
    if dry_run:
        cmd.append("--dry-run")
    return cmd


def load_json_if_exists(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def read_text_if_exists(path: Path) -> str:
    try:
        return path.read_text()
    except Exception:
        return ""


def failed_stage_names(child_report: dict[str, Any]) -> list[str]:
    steps = child_report.get("steps") if isinstance(child_report, dict) else {}
    if not isinstance(steps, dict):
        return []
    return [
        name for name, entry in steps.items()
        if isinstance(entry, dict) and entry.get("status") == "failed"
    ]


def classify_parallel_retry_bucket(
    *,
    returncode: int,
    child_report: dict[str, Any],
    log_text: str,
) -> str | None:
    """Return the folder-mode retry bucket for recoverable V4.1 failures."""
    if returncode == 0:
        return None
    stages = failed_stage_names(child_report)
    combined = (json.dumps(child_report, sort_keys=True) + "\n" + log_text).lower()
    if "lfs_outline" in stages:
        return "outline_contract"
    if any(token in combined for token in TRANSIENT_RETRY_TOKENS):
        return "anthropic_transient"
    return None


def parallel_job_result(
    job: dict[str, str],
    *,
    returncode: int,
    log_path: Path,
    base_path: Path,
    started_at: float,
) -> dict[str, Any]:
    batch_id = job["batch_id"]
    batch_dir = resolve_batch_dir(batch_id, base_path=base_path)
    child_report_path = batch_dir / "lfs-v41-report.json"
    child_report = load_json_if_exists(child_report_path) or {}
    manifest_path = batch_dir / "lfs-v41-manifest.json"
    manifest = load_json_if_exists(manifest_path) or child_report.get("manifest") or {}
    elapsed = round(time.monotonic() - started_at, 1)
    clean = bool(child_report.get("clean")) if child_report else False
    decision_counts = manifest.get("decision_counts") or {}
    log_text = read_text_if_exists(log_path)
    retry_bucket = classify_parallel_retry_bucket(
        returncode=returncode,
        child_report=child_report,
        log_text=log_text,
    )
    return {
        "strategy_path": job["strategy_path"],
        "batch_id": batch_id,
        "attempt": int(job.get("attempt", 1) or 1),
        "retry_bucket": retry_bucket,
        "retryable": bool(retry_bucket),
        "returncode": returncode,
        "status": "ok" if returncode == 0 else "failed",
        "clean": clean,
        "ship": int(decision_counts.get("ship", 0) or 0),
        "review": int(decision_counts.get("review", 0) or 0),
        "fail": int(decision_counts.get("fail", 0) or 0),
        "elapsed_seconds": elapsed,
        "log_path": str(log_path),
        "report_path": str(child_report_path) if child_report_path.exists() else None,
        "manifest_path": str(manifest_path) if manifest_path.exists() else None,
    }


def write_parallel_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n")


def run_lfs_v41_parallel(
    strategy_root: Path,
    *,
    base_path: Path = REPO,
    jobs: int = 20,
    objective_repair_rounds: int = 1,
    output_subdir: str = "output-v41",
    brief_model: str | None = None,
    outline_model: str | None = None,
    semantic_model: str | None = None,
    outline_max_attempts: int = 2,
    outline_task_timeout_seconds: int | None = None,
    until: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Run many strategy files as isolated V4.1 child processes."""
    jobs_to_run = discover_strategy_jobs(strategy_root, base_path=base_path)
    max_jobs = max(min(jobs, len(jobs_to_run)), 1)
    run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = strategy_root / "lfs-v41-parallel-runs" / run_id
    report_path = run_dir / PARALLEL_REPORT_NAME
    report: dict[str, Any] = {
        "schema": "lfs-v4.1-parallel-report/v1",
        "strategy_root": str(strategy_root),
        "run_id": run_id,
        "started_at": utcish_now(),
        "finished_at": None,
        "jobs_requested": jobs,
        "jobs_running": max_jobs,
        "inner_workers": 1,
        "inner_generation_workers": 1,
        "retry_policy": {
            "max_attempts_per_strategy": PARALLEL_MAX_ATTEMPTS,
            "outline_contract_retry_attempts": PARALLEL_OUTLINE_RETRY_ATTEMPTS,
            "retry_buckets": ["outline_contract", "anthropic_transient"],
        },
        "total": len(jobs_to_run),
        "completed": 0,
        "failed": 0,
        "attempts_completed": 0,
        "retries_scheduled": 0,
        "attempts": [],
        "results": [],
        "report_path": str(report_path),
    }
    write_parallel_report(report_path, report)
    print(
        f"LFS V4.1 parallel: {len(jobs_to_run)} strategies, {max_jobs} jobs "
        f"(inner workers forced to 1)",
        flush=True,
    )

    pending: list[dict[str, Any]] = [
        {
            **job,
            "attempt": 1,
            "outline_max_attempts": outline_max_attempts,
            "retry_bucket": None,
        }
        for job in jobs_to_run
    ]
    running: dict[int, dict[str, Any]] = {}
    attempts: list[dict[str, Any]] = []
    final_by_batch: dict[str, dict[str, Any]] = {}
    env = {**os.environ, "PYTHONPATH": str(base_path / "tools"), "PYTHONUNBUFFERED": "1"}

    def launch_next() -> None:
        job = pending.pop(0)
        batch_id = job["batch_id"]
        attempt = int(job.get("attempt", 1) or 1)
        retry_bucket = str(job.get("retry_bucket") or "")
        suffix = "" if attempt == 1 else f".retry{attempt}"
        log_path = run_dir / f"{safe_filename(batch_id)}{suffix}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_file = log_path.open("w", encoding="utf-8")
        cmd = build_parallel_child_cmd(
            Path(job["strategy_path"]),
            base_path=base_path,
            objective_repair_rounds=objective_repair_rounds,
            output_subdir=output_subdir,
            brief_model=brief_model,
            outline_model=outline_model,
            semantic_model=semantic_model,
            outline_max_attempts=int(job.get("outline_max_attempts", outline_max_attempts) or outline_max_attempts),
            outline_task_timeout_seconds=outline_task_timeout_seconds,
            until=until,
            dry_run=dry_run,
        )
        log_file.write(
            json.dumps({
                "ts": utcish_now(),
                "event": "child_command",
                "batch_id": batch_id,
                "attempt": attempt,
                "retry_bucket": retry_bucket or None,
                "cmd": cmd,
            }, sort_keys=True)
            + "\n"
        )
        log_file.write("$ " + " ".join(cmd) + "\n\n")
        log_file.flush()
        child_env = {
            **env,
            "LFS_V41_ATTEMPT": str(attempt),
            "LFS_V41_RETRY_BUCKET": retry_bucket,
        }
        proc = subprocess.Popen(
            cmd,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            cwd=str(base_path),
            env=child_env,
        )
        running[proc.pid] = {
            "proc": proc,
            "job": job,
            "log_file": log_file,
            "log_path": log_path,
            "started_at": time.monotonic(),
        }
        print(
            f"  start {batch_id} attempt={attempt} pid={proc.pid} log={log_path}",
            flush=True,
        )

    def maybe_retry(result: dict[str, Any]) -> bool:
        attempt = int(result.get("attempt", 1) or 1)
        retry_bucket = result.get("retry_bucket")
        if not retry_bucket or attempt >= PARALLEL_MAX_ATTEMPTS:
            return False
        retry_job = {
            "strategy_path": result["strategy_path"],
            "batch_id": result["batch_id"],
            "attempt": attempt + 1,
            "outline_max_attempts": outline_max_attempts,
            "retry_bucket": retry_bucket,
        }
        if retry_bucket == "outline_contract":
            retry_job["outline_max_attempts"] = max(outline_max_attempts, PARALLEL_OUTLINE_RETRY_ATTEMPTS)
        pending.append(retry_job)
        result["retry_scheduled"] = True
        report["retries_scheduled"] = int(report.get("retries_scheduled", 0) or 0) + 1
        print(
            f"  retry {result['batch_id']} bucket={retry_bucket} "
            f"attempt={attempt + 1} outline_attempts={retry_job['outline_max_attempts']}",
            flush=True,
        )
        return True

    try:
        while pending or running:
            while pending and len(running) < max_jobs:
                launch_next()
            time.sleep(0.5)
            for pid, item in list(running.items()):
                proc = item["proc"]
                returncode = proc.poll()
                if returncode is None:
                    continue
                item["log_file"].close()
                result = parallel_job_result(
                    item["job"],
                    returncode=returncode,
                    log_path=item["log_path"],
                    base_path=base_path,
                    started_at=item["started_at"],
                )
                attempts.append(result)
                del running[pid]
                if not maybe_retry(result):
                    final_by_batch[result["batch_id"]] = result
                final_results = [
                    final_by_batch[job["batch_id"]]
                    for job in jobs_to_run
                    if job["batch_id"] in final_by_batch
                ]
                report["attempts"] = attempts
                report["results"] = final_results
                report["attempts_completed"] = len(attempts)
                report["completed"] = len(final_results)
                report["failed"] = sum(1 for row in final_results if row["returncode"] != 0)
                write_parallel_report(report_path, report)
                icon = "✓" if returncode == 0 else "✗"
                print(f"  {icon} {result['batch_id']} rc={returncode} elapsed={result['elapsed_seconds']}s", flush=True)
    except KeyboardInterrupt:
        report["interrupted_at"] = utcish_now()
        for item in running.values():
            item["proc"].terminate()
            item["log_file"].close()
        write_parallel_report(report_path, report)
        raise

    report["finished_at"] = utcish_now()
    results = [
        final_by_batch[job["batch_id"]]
        for job in jobs_to_run
        if job["batch_id"] in final_by_batch
    ]
    report["attempts"] = attempts
    report["results"] = results
    report["attempts_completed"] = len(attempts)
    report["completed"] = len(results)
    report["failed"] = sum(1 for row in results if row["returncode"] != 0)
    report["clean"] = report["failed"] == 0
    report["ship"] = sum(int(row.get("ship", 0) or 0) for row in results)
    report["review"] = sum(int(row.get("review", 0) or 0) for row in results)
    report["fail"] = sum(int(row.get("fail", 0) or 0) for row in results)
    write_parallel_report(report_path, report)
    print(f"\nLFS V4.1 parallel report: {report_path}", flush=True)
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description="Run LFS V4.1 semantic-first compiler beside V4")
    ap.add_argument("strategy", type=Path, help="Strategy JSON file, or a folder of strategy JSON files")
    ap.add_argument("--base-path", type=Path, default=REPO)
    ap.add_argument("--workers", "-w", type=int, default=4)
    ap.add_argument("--generation-workers", type=int, default=20)
    ap.add_argument("--jobs", type=int, default=20,
                    help="Folder mode only: number of isolated V4.1 child jobs (default: 20)")
    ap.add_argument("--objective-repair-rounds", type=int, default=1)
    ap.add_argument("--output-subdir", default="output-v41")
    ap.add_argument("--brief-model")
    ap.add_argument("--outline-model")
    ap.add_argument("--semantic-model")
    ap.add_argument("--outline-max-attempts", type=int, default=2,
                    help="Generation + repair attempts per outline inside V4.1 (default: 2)")
    ap.add_argument("--outline-task-timeout-seconds", type=int,
                    help="Fail pending outline tasks after this many seconds without progress")
    ap.add_argument("--until", choices=sorted(STAGE_ALIASES),
                    help="Stop after a V4.1 stage for staged smoke tests")
    ap.add_argument("--dry-run", action="store_true",
                    help="Validate wiring without script generation, semantic calls, or objective repair")
    args = ap.parse_args()

    try:
        if args.strategy.is_dir():
            report = run_lfs_v41_parallel(
                args.strategy,
                base_path=args.base_path,
                jobs=max(args.jobs, 1),
                objective_repair_rounds=max(args.objective_repair_rounds, 0),
                output_subdir=args.output_subdir,
                brief_model=args.brief_model,
                outline_model=args.outline_model,
                semantic_model=args.semantic_model,
                outline_max_attempts=max(args.outline_max_attempts, 1),
                outline_task_timeout_seconds=args.outline_task_timeout_seconds,
                until=args.until,
                dry_run=args.dry_run,
            )
            return 0 if report.get("clean") or report.get("dry_run") else 1
        report = run_lfs_v41(
            args.strategy,
            base_path=args.base_path,
            workers=max(args.workers, 1),
            generation_workers=max(args.generation_workers, 1),
            objective_repair_rounds=max(args.objective_repair_rounds, 0),
            output_subdir=args.output_subdir,
            brief_model=args.brief_model,
            outline_model=args.outline_model,
            semantic_model=args.semantic_model,
            outline_max_attempts=max(args.outline_max_attempts, 1),
            outline_task_timeout_seconds=args.outline_task_timeout_seconds,
            until=args.until,
            dry_run=args.dry_run,
        )
    except Exception as exc:
        print(f"LFS V4.1 failed: {exc}", file=sys.stderr, flush=True)
        return 1

    report_dir = resolve_batch_dir(report["batch_id"], base_path=args.base_path)
    print(f"\nLFS V4.1 report: {report_dir / 'lfs-v41-report.json'}", flush=True)
    return 0 if report.get("clean") or report.get("stopped_at") or report.get("dry_run") else 1


if __name__ == "__main__":
    raise SystemExit(main())

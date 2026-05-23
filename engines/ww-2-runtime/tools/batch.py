#!/usr/bin/env python3
"""Single-pass batch generator for WW-2.

`ww batch` is intentionally dumb: read `spec.json`, generate each task once,
preserve every artifact, and write a report. Quality gates live downstream in
the LFS QA flow (`ww lfs-finish`) or other format-specific review tools.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import shutil
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from preflight import run_preflight
from ww_artifacts import write_artifact_manifest
from ww_paths import load_batch_spec, resolve_batch_dir

TOOLS_DIR = Path(__file__).resolve().parent
REPO = TOOLS_DIR.parent


def generation_python() -> str:
    configured = os.environ.get("WW_GENERATE_PYTHON") or os.environ.get("WW_PYTHON")
    if configured:
        return configured
    venv_python = REPO / ".venv" / "bin" / "python"
    if venv_python.exists():
        return str(venv_python)
    return sys.executable


@dataclass
class TaskResult:
    """Result from a single task generation."""

    task_id: str
    generated: bool
    output_file: str | None
    error: str | None = None
    heartbeat_file: str | None = None

    @property
    def success(self) -> bool:
        """Backward-compatible alias for old report consumers."""
        return self.generated


def generate_once(task_id: str, output_dir: Path, base_path: Path) -> TaskResult:
    """Run generate.py once for a task."""
    generate_script = TOOLS_DIR / "generate.py"
    heartbeat_file = output_dir.parent / "generation-heartbeats" / f"{task_id}.jsonl"
    cmd = [
        generation_python(),
        str(generate_script),
        task_id,
        "--output-dir",
        str(output_dir),
        "--base-path",
        str(base_path),
        "--heartbeat-file",
        str(heartbeat_file),
    ]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=str(base_path),
        env={**os.environ, "PYTHONPATH": str(TOOLS_DIR), "PYTHONUNBUFFERED": "1"},
    )
    forward_ai_call_events(result.stdout)

    if result.returncode != 0:
        return TaskResult(
            task_id=task_id,
            generated=False,
            output_file=None,
            error=(result.stderr or result.stdout).strip(),
            heartbeat_file=str(heartbeat_file),
        )

    output_file = None
    for line in result.stdout.splitlines():
        if line.startswith("Generated: "):
            output_file = line.removeprefix("Generated: ").strip()
            break

    if not output_file:
        return TaskResult(
            task_id=task_id,
            generated=False,
            output_file=None,
            error="generate.py exited 0 but did not print a Generated: path",
            heartbeat_file=str(heartbeat_file),
        )

    if not Path(output_file).exists():
        return TaskResult(
            task_id=task_id,
            generated=False,
            output_file=output_file,
            error="generate.py reported an output path that does not exist",
            heartbeat_file=str(heartbeat_file),
        )

    return TaskResult(task_id=task_id, generated=True, output_file=output_file, heartbeat_file=str(heartbeat_file))


def forward_ai_call_events(stdout: str) -> None:
    for line in stdout.splitlines():
        raw = line.strip()
        if not raw.startswith("{") or not raw.endswith("}"):
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if payload.get("event") in {"ai_call_finished", "ai_call_failed"}:
            print(json.dumps(payload, sort_keys=True), flush=True)


def load_spec(batch_id: str, base_path: Path | None = None) -> dict:
    """Load a batch specification."""
    if base_path is None:
        base_path = Path(__file__).parent.parent

    _, spec = load_batch_spec(batch_id, base_path=base_path)
    return spec


def _run_task(args: tuple[str, Path, Path]) -> TaskResult:
    """Pickle-friendly process-pool wrapper."""
    task_id, output_dir, base_path = args
    return generate_once(task_id, output_dir, base_path)


def is_lfs_spec(spec: dict, task_ids: list[str]) -> bool:
    """Return true when this batch should be protected by LFS preflight."""
    if str(spec.get("format") or "").lower() == "lfs":
        return True
    return any("_LFS_" in task_id.upper() for task_id in task_ids)


def run_batch(
    batch_id: str,
    workers: int = 20,
    base_path: Path | None = None,
    output_mode: str = "fail",
    preflight_policy: str | None = None,
    task_filter: list[str] | None = None,
) -> dict:
    """Generate all tasks in a batch once and write report.json."""
    if base_path is None:
        base_path = Path(__file__).parent.parent

    batch_dir = resolve_batch_dir(batch_id, base_path=base_path)
    spec = json.loads((batch_dir / "spec.json").read_text())
    all_task_ids = spec.get("task_ids", [])
    task_ids = filter_task_ids(all_task_ids, task_filter)
    if not task_ids:
        raise ValueError(f"No task_ids found in spec for batch '{batch_id}'")
    resolved_preflight_policy = preflight_policy or "strict"
    if resolved_preflight_policy not in {"strict", "v41"}:
        raise ValueError(f"Unsupported preflight_policy {resolved_preflight_policy!r}; expected 'strict' or 'v41'")

    if is_lfs_spec(spec, task_ids):
        print(f"Running LFS preflight ({resolved_preflight_policy}) before generation for '{batch_id}'", flush=True)
        if not run_preflight(batch_id, base_path, check_output_flag=False, lfs_policy=resolved_preflight_policy):
            raise ValueError(f"LFS preflight ({resolved_preflight_policy}) failed for batch '{batch_id}'. Fix prompts/outlines before generation.")

    output_dir = batch_dir / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    existing_files = [p for p in output_dir.iterdir() if p.is_file()]
    if existing_files and output_mode == "fail":
        raise ValueError(
            f"Output directory is not empty: {output_dir}. "
            "Use --clean-output to replace it, --resume-missing to generate only missing task IDs, "
            "or --append-version to preserve old artifacts and add new ones."
        )
    if existing_files and output_mode == "clean":
        shutil.rmtree(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        existing_files = []

    print(f"Starting batch '{batch_id}' with {len(task_ids)} tasks ({workers} workers, single pass)", flush=True)

    results: list[TaskResult] = []
    skipped: list[TaskResult] = []
    if output_mode == "resume":
        for task_id in task_ids:
            matches = [
                p for p in output_dir.glob(f"{task_id}_*.md")
                if "_OUTLINE" not in p.name and "_VISUALS" not in p.name
            ]
            if matches:
                latest = sorted(matches)[-1]
                skipped.append(TaskResult(task_id=task_id, generated=True, output_file=str(latest)))
        skipped_ids = {r.task_id for r in skipped}
        task_ids_to_generate = [task_id for task_id in task_ids if task_id not in skipped_ids]
        if skipped:
            print(f"Resuming: {len(skipped)} task(s) already have output, {len(task_ids_to_generate)} missing", flush=True)
    else:
        task_ids_to_generate = list(task_ids)

    task_args = [(task_id, output_dir, base_path) for task_id in task_ids_to_generate]

    if not task_args:
        results = []
    elif workers == 1:
        for item in task_args:
            result = _run_task(item)
            results.append(result)
            print_result(result)
    else:
        executor_cls = ThreadPoolExecutor if generation_executor_mode(spec) == "thread" else ProcessPoolExecutor
        with executor_cls(max_workers=workers) as executor:
            future_to_task = {executor.submit(_run_task, item): item[0] for item in task_args}
            for future in as_completed(future_to_task):
                task_id = future_to_task[future]
                try:
                    result = future.result()
                except Exception as e:
                    result = TaskResult(task_id=task_id, generated=False, output_file=None, error=str(e))
                results.append(result)
                print_result(result)

    results.extend(skipped)
    generated = sum(1 for r in results if r.generated)
    failed = len(results) - generated

    report = {
        "batch_id": batch_id,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "total_tasks": len(task_ids),
        "generated": generated,
        "failed": failed,
        "task_filter": task_filter or [],
        "needs_lfs_qa": True,
        "output_mode": output_mode,
        "skipped_existing": len(skipped),
        # Backward-compatible summary fields for `ww status` and old readers.
        "successful": generated,
        "results": [
            {
                "task_id": r.task_id,
                "generated": r.generated,
                "success": r.success,
                "output_file": r.output_file,
                "error": r.error,
                "heartbeat_file": r.heartbeat_file,
            }
            for r in results
        ],
    }

    report_file = batch_dir / "report.json"
    report_file.write_text(json.dumps(report, indent=2))
    write_artifact_manifest(batch_dir, batch_id=batch_id, product=spec.get("product"))
    print(f"\nReport saved to: {report_file}", flush=True)

    history_dir = base_path / "logs"
    history_dir.mkdir(exist_ok=True)
    history_entry = json.dumps({
        "batch": batch_id,
        "date": datetime.now().strftime("%Y-%m-%d"),
        "total": len(task_ids),
        "generated": generated,
        "failed": failed,
    })
    with open(history_dir / "batch-history.jsonl", "a") as f:
        f.write(history_entry + "\n")

    print(f"\nBatch complete: {generated}/{len(task_ids)} generated, {failed} failed", flush=True)
    if report["needs_lfs_qa"]:
        print("Next gate: run `ww lfs-finish <batch_id>` for LFS batches.", flush=True)

    return report


def filter_task_ids(task_ids: list[str], task_filter: list[str] | None) -> list[str]:
    if not task_filter:
        return list(task_ids)
    allowed = {item.strip() for item in task_filter if item and item.strip()}
    missing = sorted(allowed.difference(task_ids))
    if missing:
        raise ValueError(f"Unknown task_id(s) for batch spec: {', '.join(missing)}")
    return [task_id for task_id in task_ids if task_id in allowed]


def generation_executor_mode(spec: dict) -> str:
    """Choose the safest parallel executor for hosted generation.

    LFS generation is network-bound. A process pool duplicates the full Python
    runtime and prompt context per task, which is wasteful on small hosted
    workers and has caused OOM failures. Threads preserve the same generation
    logic while keeping memory compact.
    """
    configured = os.environ.get("WW_GENERATE_EXECUTOR", "").strip().lower()
    if configured in {"thread", "process"}:
        return configured
    if str(spec.get("format") or "").lower() == "lfs":
        return "thread"
    return "process"


def print_result(result: TaskResult) -> None:
    if result.generated:
        print(f"  ✓ {result.task_id}", flush=True)
    else:
        print(f"  ✗ {result.task_id}", flush=True)
        if result.error:
            print(f"    Error: {result.error}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a batch of scripts once")
    parser.add_argument("batch_id", help="Batch identifier (e.g., TEST_001)")
    parser.add_argument("--workers", "-w", type=int, default=20, help="Max parallel workers (default: 20)")
    parser.add_argument("--base-path", "-b", type=Path, help="Base project path")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--clean-output", action="store_true", help="Delete output/ before generating")
    mode.add_argument("--resume-missing", action="store_true", help="Generate only task IDs with no existing output")
    mode.add_argument("--append-version", action="store_true", help="Preserve existing output and add new timestamped files")
    parser.add_argument("--preflight-policy", choices=["strict", "v41"],
                        help="LFS preflight policy for this run (default: strict)")
    parser.add_argument("--task-id", dest="task_ids", action="append",
                        help="Only generate this task id. May be passed more than once.")
    args = parser.parse_args()
    output_mode = "clean" if args.clean_output else "resume" if args.resume_missing else "append" if args.append_version else "fail"

    try:
        report = run_batch(
            batch_id=args.batch_id,
            workers=max(args.workers, 1),
            base_path=args.base_path,
            output_mode=output_mode,
            preflight_policy=args.preflight_policy,
            task_filter=args.task_ids,
        )
        if report["failed"] > 0:
            sys.exit(1)
    except (FileNotFoundError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Simple LFS V4 semantic outline adherence gate.

The first V4 semantic check is deliberately narrow: does the script follow its
saved outline? If not, ask for a bounded repair, then re-check. This is a
semantic gate, not a craft audit.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

THIS = Path(__file__).resolve()
REPO = THIS.parent.parent
sys.path.insert(0, str(THIS.parent))
from ww_paths import resolve_batch_dir  # noqa: E402

try:
    from dotenv import load_dotenv
    load_dotenv(REPO / ".env")
except ImportError:
    pass

from lfs_fix import normalize_lfs_divider_spacing, split_lfs_wall_paragraphs  # noqa: E402


DEFAULT_MODEL = os.environ.get("LFS_SEMANTIC_MODEL", "claude-sonnet-4-6")


def emit_ai_call_event(*, model: str, status: str, started_at: float, usage: Any = None) -> None:
    payload = {
        "event": "ai_call_finished" if status == "succeeded" else "ai_call_failed",
        "stage": "semantic_check",
        "provider": "anthropic",
        "model": model,
        "status": status,
        "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
        "output_tokens": int(getattr(usage, "output_tokens", 0) or 0),
        "cached_tokens": int(getattr(usage, "cache_read_input_tokens", 0) or 0),
        "latency_ms": int((time.monotonic() - started_at) * 1000),
        "ts": datetime.utcnow().isoformat(timespec="seconds"),
    }
    print(json.dumps(payload, sort_keys=True), flush=True)
DEFAULT_REQUEST_TIMEOUT_SECONDS = float(os.environ.get("LFS_SEMANTIC_REQUEST_TIMEOUT_SECONDS", "300"))


@dataclass
class SemanticResult:
    task_id: str
    script_path: str
    outline_path: str
    status: str
    passed: bool
    reason: str = ""
    missing_or_reordered_beats: list[str] | None = None
    repair_instruction: str = ""
    attempts: int = 0
    mode: str = "adherence"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def strip_code_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9_-]*\n", "", text)
        text = re.sub(r"\n```$", "", text)
    return text.strip()


def parse_json(raw: str) -> dict[str, Any]:
    text = strip_code_fences(raw)
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        text = match.group(0)
    return json.loads(text)


def task_id_from_script(path: Path) -> str:
    return re.sub(r"_\d{8}_\d{6}$", "", path.stem)


def first_sentence(text: str) -> str:
    body = text.strip()
    match = re.search(r"[.!?](?:\s+|$)", body)
    if match:
        return body[:match.end()].strip()
    return body.splitlines()[0].strip() if body.splitlines() else ""


def normalize_sentence(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def build_judge_prompt(script: str, outline: str, *, mode: str = "adherence") -> str:
    if mode == "launchable":
        return f"""You are a direct-response LFS judge for a desk that needs to launch 100 ads a day.

You are looking for an 8/10 script: clear angle, emotionally alive, product-truthful, easy to skim, and faithful to the outline's emotional mechanism.

SCRIPT
<script>
{script}
</script>

OUTLINE
<outline>
{outline}
</outline>

CONTRASTIVE JUDGMENT

Near-miss pass:
The script follows the beat order but the scandal, humiliation, anger, or emotional mechanism is softened into generic product copy.
Verdict: fail. It needs one repair that restores voltage.

Near-miss fail:
The script changes the opener wording or moves one scene, but the emotional mechanism, angle, product truth, and lazy-reader flow are stronger.
Verdict: pass. Improvement is allowed.

Near-miss source fidelity:
The script does not mirror the competitor structure exactly, but it preserves the emotional mechanism and angle in the advertised product's world.
Verdict: pass. Emotional mechanism matters more than surface structure.

PRE-MORTEM
Likely failures: planner labels leaking into copy, timid scandal, generic confidence language, explanation replacing story, mechanism pasted beside the wound instead of answering it, dense unreadable blocks, or a repair instruction that asks for perfection instead of launchability.

Return strict JSON only:
{{
  "passed": true | false,
  "reason": "one short explanation",
  "missing_or_reordered_beats": ["quality issue", "..."],
  "repair_instruction": "if failed, one direct instruction that would make this launchable while preserving product truth"
}}"""

    return f"""Does this script:

<script>
{script}
</script>

follow the outline here:

<outline>
{outline}
</outline>

Return strict JSON only:
{{
  "passed": true | false,
  "reason": "one short explanation",
  "missing_or_reordered_beats": ["beat issue", "..."],
  "repair_instruction": "if failed, one direct instruction for fixing the script while preserving copy quality"
}}"""


def build_repair_prompt(
    script: str,
    outline: str,
    judge: dict[str, Any],
    *,
    preserve_opener: bool = True,
    mode: str = "adherence",
) -> str:
    opener_line = "- first sentence" if preserve_opener else "- opener standards: improve the opener when needed while preserving narrator POV and product truth"
    repair_line = (
        "Repair for launchability: restore emotional voltage, human language, clear angle, lazy-reader flow, and outline faithfulness."
        if mode == "launchable"
        else "Repair this LFS script so it follows the outline."
    )
    return f"""{repair_line}

Preserve:
{opener_line}
- narrator POV
- CTA text
- product price and product truth
- native LFS formatting with short paragraphs and ======== section dividers

Semantic failure:
{json.dumps(judge, indent=2)}

OUTLINE
<outline>
{outline}
</outline>

SCRIPT
<script>
{script}
</script>

Return exactly the full repaired script text."""


def call_claude(prompt: str, model: str, max_tokens: int = 12_000) -> str:
    try:
        import anthropic
    except ImportError as exc:
        raise RuntimeError("anthropic SDK not installed; run `pip install anthropic`") from exc
    client = anthropic.Anthropic(timeout=DEFAULT_REQUEST_TIMEOUT_SECONDS, max_retries=0)
    started_at = time.monotonic()
    try:
        msg = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            temperature=0.1,
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception:
        emit_ai_call_event(model=model, status="failed", started_at=started_at)
        raise
    emit_ai_call_event(model=model, status="succeeded", started_at=started_at, usage=getattr(msg, "usage", None))
    return msg.content[0].text


def judge(script: str, outline: str, model: str, *, mode: str = "adherence") -> dict[str, Any]:
    prompt = build_judge_prompt(script, outline, mode=mode)
    last_error: Exception | None = None
    for _attempt in range(2):
        try:
            data = parse_json(call_claude(prompt, model, max_tokens=2048))
            break
        except (json.JSONDecodeError, ValueError) as exc:
            last_error = exc
            prompt += (
                "\n\nYour previous response was not strict JSON. "
                "Return only one JSON object with the requested keys."
            )
    else:
        raise ValueError(f"semantic judge returned invalid JSON after retry: {last_error}") from last_error
    return {
        "passed": bool(data.get("passed")),
        "reason": str(data.get("reason") or ""),
        "missing_or_reordered_beats": list(data.get("missing_or_reordered_beats") or []),
        "repair_instruction": str(data.get("repair_instruction") or ""),
    }


def repair_script(
    script: str,
    outline: str,
    judge_data: dict[str, Any],
    model: str,
    *,
    preserve_opener: bool = True,
    mode: str = "adherence",
) -> str:
    candidate = strip_code_fences(call_claude(build_repair_prompt(script, outline, judge_data, preserve_opener=preserve_opener, mode=mode), model))
    candidate, _ = split_lfs_wall_paragraphs(candidate)
    candidate, _ = normalize_lfs_divider_spacing(candidate)
    return candidate


def check_one(
    script_path: Path,
    *,
    batch_dir: Path,
    model: str,
    max_attempts: int,
    dry_run: bool,
    mode: str = "adherence",
    preserve_opener: bool = True,
) -> SemanticResult:
    task_id = task_id_from_script(script_path)
    outline_path = batch_dir / "outlines" / f"{task_id}.md"
    if not outline_path.exists():
        return SemanticResult(task_id, str(script_path), str(outline_path), "failed", False, "missing outline", attempts=0, mode=mode)

    outline = outline_path.read_text()
    script = script_path.read_text()
    attempts = 0
    last = judge(script, outline, model, mode=mode)
    if last["passed"]:
        return SemanticResult(
            task_id, str(script_path), str(outline_path), "passed", True,
            last["reason"], last["missing_or_reordered_beats"], last["repair_instruction"], attempts=0, mode=mode,
        )

    for attempt in range(1, max(max_attempts, 0) + 1):
        attempts = attempt
        candidate = repair_script(script, outline, last, model, preserve_opener=preserve_opener, mode=mode)
        if preserve_opener and normalize_sentence(first_sentence(script)) != normalize_sentence(first_sentence(candidate)):
            last = {
                "passed": False,
                "reason": "repair changed the first sentence",
                "missing_or_reordered_beats": ["first sentence drift"],
                "repair_instruction": f"Repair the outline mismatch while keeping this exact first sentence: {first_sentence(script)}",
            }
            continue
        next_judge = judge(candidate, outline, model, mode=mode)
        if next_judge["passed"]:
            if not dry_run:
                script_path.write_text(candidate.rstrip() + "\n")
            return SemanticResult(
                task_id, str(script_path), str(outline_path), "repaired", True,
                next_judge["reason"], next_judge["missing_or_reordered_beats"], next_judge["repair_instruction"], attempts=attempts, mode=mode,
            )
        script = candidate
        last = next_judge

    return SemanticResult(
        task_id, str(script_path), str(outline_path), "failed", False,
        last["reason"], last["missing_or_reordered_beats"], last["repair_instruction"], attempts=attempts, mode=mode,
    )


def run_semantic_batch(
    batch_id: str,
    *,
    base_path: Path = REPO,
    output_subdir: str = "output-chiefed",
    model: str = DEFAULT_MODEL,
    workers: int = 4,
    max_attempts: int = 2,
    dry_run: bool = False,
    mode: str = "adherence",
    preserve_opener: bool = True,
) -> dict[str, Any]:
    batch_dir = resolve_batch_dir(batch_id, base_path=base_path)
    output_dir = batch_dir / output_subdir
    if not output_dir.exists():
        raise FileNotFoundError(f"output directory not found: {output_dir}")
    scripts = [
        p for p in sorted(output_dir.glob("*.md"))
        if "_OUTLINE" not in p.name and "_VISUALS" not in p.name
    ]
    if not scripts:
        raise ValueError(f"no scripts found in {output_dir}")

    print(f"Semantic {mode} check for {len(scripts)} scripts in {output_subdir}")
    print(f"Model: {model}")

    results: list[SemanticResult] = []
    kwargs = {
        "batch_dir": batch_dir,
        "model": model,
        "max_attempts": max_attempts,
        "dry_run": dry_run,
        "mode": mode,
        "preserve_opener": preserve_opener,
    }
    if workers == 1:
        for script in scripts:
            result = check_one(script, **kwargs)
            results.append(result)
            print_result(result)
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(check_one, script, **kwargs): script for script in scripts}
            for fut in concurrent.futures.as_completed(futs):
                try:
                    result = fut.result()
                except Exception as exc:
                    script = futs[fut]
                    result = SemanticResult(task_id_from_script(script), str(script), "", "failed", False, str(exc), mode=mode)
                results.append(result)
                print_result(result)

    report = {
        "schema": "lfs-semantic-report/v1",
        "batch_id": batch_id,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "model": model,
        "mode": mode,
        "preserve_opener": preserve_opener,
        "output_subdir": output_subdir,
        "total_scripts": len(results),
        "passed": sum(1 for r in results if r.status == "passed"),
        "repaired": sum(1 for r in results if r.status == "repaired"),
        "failed": sum(1 for r in results if not r.passed),
        "results": [r.as_dict() for r in sorted(results, key=lambda r: r.task_id)],
    }
    if not dry_run:
        (batch_dir / "lfs-semantic-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def print_result(result: SemanticResult) -> None:
    marker = "✓" if result.passed else "✗"
    attempt_note = f" attempts={result.attempts}" if result.attempts else ""
    print(f"  {marker} {result.task_id} [{result.status}{attempt_note}]")
    if result.reason:
        print(f"    {result.reason}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Run simple LFS semantic outline check")
    ap.add_argument("batch_id")
    ap.add_argument("--base-path", type=Path, default=REPO)
    ap.add_argument("--output-subdir", default="output-chiefed")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--workers", "-w", type=int, default=4)
    ap.add_argument("--max-attempts", type=int, default=2)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--mode", choices=["adherence", "launchable"], default="adherence")
    ap.add_argument("--allow-opener-change", action="store_true", help="Allow semantic repair to improve weak openers")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    try:
        report = run_semantic_batch(
            args.batch_id,
            base_path=args.base_path,
            output_subdir=args.output_subdir,
            model=args.model,
            workers=max(args.workers, 1),
            max_attempts=max(args.max_attempts, 0),
            dry_run=args.dry_run,
            mode=args.mode,
            preserve_opener=not args.allow_opener_change,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, indent=2))
    return 0 if report["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

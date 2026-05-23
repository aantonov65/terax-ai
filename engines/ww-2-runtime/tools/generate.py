#!/usr/bin/env python3
"""
Single ad generator for WW-2.

Loads surgical context, calls Claude API, saves output.
One ad per process = fresh context window.

Usage:
    python generate.py <task_id> [--output-dir <path>]
    python generate.py NOOR_YAPFEST_ARC1_A1B2_M1_RAGE_RBPUB_V001
"""

import os
import sys
import re
import json
import argparse
import threading
import time
from pathlib import Path
from datetime import datetime, timezone

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

# Load .env from project root when python-dotenv is available. Desktop app
# runners may provide environment variables without installing python-dotenv.
if load_dotenv:
    load_dotenv(Path(__file__).parent.parent / ".env")

import anthropic

from context import load_context, render_prompt


class GenerationValidationError(Exception):
    """Model output is not a shippable generated script."""


class GenerationHeartbeat:
    """Append-only progress trail for long single-script generation calls."""

    def __init__(self, path: Path | None, task_id: str, interval_seconds: float = 15.0):
        self.path = path
        self.task_id = task_id
        self.interval_seconds = max(float(interval_seconds), 1.0)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._model_started_at: float | None = None

    def mark(self, stage: str, **payload) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "task_id": self.task_id,
            "stage": stage,
            **payload,
        }
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
            f.flush()

    def start_model_call(self, *, model: str, prompt_chars: int, system_chars: int) -> None:
        self._model_started_at = time.monotonic()
        self.mark(
            "model_call_started",
            model=model,
            prompt_chars=prompt_chars,
            system_chars=system_chars,
        )
        if not self.path:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._pulse_model_call, daemon=True)
        self._thread.start()

    def stop_model_call(self, *, status: str) -> None:
        elapsed = self._elapsed_model_seconds()
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1)
            self._thread = None
        self.mark(f"model_call_{status}", elapsed_seconds=elapsed)

    def _pulse_model_call(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            self.mark("model_call_alive", elapsed_seconds=self._elapsed_model_seconds())

    def _elapsed_model_seconds(self) -> float | None:
        if self._model_started_at is None:
            return None
        return round(time.monotonic() - self._model_started_at, 1)


def emit_ai_call_event(*, model: str, status: str, started_at: float, usage=None) -> None:
    payload = {
        "event": "ai_call_finished" if status == "succeeded" else "ai_call_failed",
        "stage": "batch_generation",
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


def strip_outline(text: str) -> tuple[str, str]:
    """Extract <outline> block and return (outline, clean_script)."""
    match = re.search(r'<outline>(.*?)</outline>', text, re.DOTALL)
    if match:
        outline = match.group(1).strip()
        clean = re.sub(r'<outline>.*?</outline>\s*', '', text, flags=re.DOTALL)
        return outline, clean.strip()
    return "", text


REFUSAL_PATTERNS = [
    re.compile(r"^\s*I (?:cannot|can't|can not|am unable to|won't)\b", re.IGNORECASE),
    re.compile(r"^\s*I (?:need|would need|do not have|don't have)\b.{0,120}\b(?:brief|briefing|context|information)\b", re.IGNORECASE),
    re.compile(r"^\s*(?:Here'?s|Here is) (?:the )?(?:script|copy|ad|draft|LFS)", re.IGNORECASE),
    re.compile(r"^\s*As an AI\b", re.IGNORECASE),
]

SCAFFOLD_PATTERNS = [
    re.compile(r"CRITICAL OVERRIDE BRIEFING", re.IGNORECASE),
    re.compile(r"BRIEFING FOR THIS SPECIFIC SCRIPT", re.IGNORECASE),
    re.compile(r"SCRIPT OUTLINE\s+[-—]\s+REQUIRED BLUEPRINT", re.IGNORECASE),
    re.compile(r"LFS WRITER PERSONA", re.IGNORECASE),
    re.compile(r"LFS NATIVE FORMAT CONTRACT", re.IGNORECASE),
    re.compile(r"PRODUCTION FACTS\s+[-—]", re.IGNORECASE),
    re.compile(r"WRITE COMMAND\s+[-—]", re.IGNORECASE),
    re.compile(r"^##\s+VERBATIM HOOK\b", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^##\s+VERBATIM BRIDGE PHRASE\b", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^##\s+VERBATIM DATED LOG\b", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^##\s+PERMISSION BEAT\b", re.IGNORECASE | re.MULTILINE),
]


def validate_generated_output(output_text: str, ctx) -> None:
    """Fail malformed generation before it gets saved as a script."""
    if ctx.format != "lfs":
        return

    body = output_text.strip()
    words = body.split()
    for pattern in REFUSAL_PATTERNS:
        if pattern.search(body[:600]):
            raise GenerationValidationError(
                f"LFS generation returned refusal/meta output matching {pattern.pattern!r}"
            )

    for pattern in SCAFFOLD_PATTERNS:
        if pattern.search(body):
            raise GenerationValidationError(
                f"LFS generation leaked prompt scaffolding matching {pattern.pattern!r}"
            )

    if len(words) < 600:
        raise GenerationValidationError(
            f"LFS generation too short ({len(words)} words); likely refusal or malformed output"
        )


def batch_dir_for_output_dir(output_dir: Path | None) -> Path | None:
    """Return the containing batch directory for any batch output subdir."""
    if not output_dir:
        return None
    candidates = [output_dir, output_dir.parent]
    for candidate in candidates:
        if candidate and (candidate / "spec.json").exists():
            return candidate
    return None


def load_spec_for_output_dir(output_dir: Path) -> dict | None:
    """
    Try to load batch spec from output directory's parent.

    Args:
        output_dir: Output directory (expected to be batches/{batch}/output/)

    Returns:
        Spec dict if found, None otherwise
    """
    batch_dir = batch_dir_for_output_dir(output_dir)
    if batch_dir:
        spec_file = batch_dir / "spec.json"
        return json.loads(spec_file.read_text())
    return None


def generate_ad(
    task_id: str,
    output_dir: Path | None = None,
    base_path: Path | None = None,
    heartbeat: GenerationHeartbeat | None = None,
) -> Path:
    """
    Generate a single ad for the given task_id.

    Args:
        task_id: Task identifier (e.g., NOOR_YAPFEST_ARC1_A1B2_M1_RAGE_RBPUB_V001)
        output_dir: Directory to save output (defaults to batches/{batch}/output/)
        base_path: Base path for project files
    Returns:
        Path to the generated output file
    """
    if base_path is None:
        base_path = Path(__file__).parent.parent
    if heartbeat is None:
        heartbeat = GenerationHeartbeat(None, task_id)
    heartbeat.mark("started", output_dir=str(output_dir) if output_dir else None)

    # Try to load batch spec for briefing/CTA overrides
    spec = load_spec_for_output_dir(output_dir) if output_dir else None
    heartbeat.mark("spec_loaded", has_spec=bool(spec))

    # Load surgical context and render prompt
    ctx = load_context(task_id, base_path, spec=spec)
    batch_dir = batch_dir_for_output_dir(output_dir)
    prompt = render_prompt(ctx, base_path, batch_dir=batch_dir, spec=spec)
    heartbeat.mark("context_rendered", format=ctx.format, prompt_chars=len(prompt))

    # Load format constants for model config
    constants_file = base_path / "formats" / ctx.format / "constants.json"
    constants = json.loads(constants_file.read_text())

    # Load distilled DR copywriting system prompt. Raw project reference files
    # are archival and intentionally not auto-loaded into every generation.
    system_prompt_file = base_path / "components" / "dr-system.md"
    system_prompt = system_prompt_file.read_text() if system_prompt_file.exists() else ""

    # Call Claude API
    client = anthropic.Anthropic()
    model = (
        os.environ.get("LFS_GENERATION_MODEL")
        or os.environ.get("WW_GENERATE_MODEL")
        or constants.get("model")
        or "claude-sonnet-4-6"
    )
    max_tokens = int(os.environ.get("WW_GENERATE_MAX_TOKENS") or constants.get("max_tokens") or 8192)
    api_kwargs = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    if system_prompt:
        api_kwargs["system"] = system_prompt

    heartbeat.start_model_call(
        model=api_kwargs["model"],
        prompt_chars=len(prompt),
        system_chars=len(system_prompt),
    )
    started_at = time.monotonic()
    try:
        message = client.messages.create(**api_kwargs)
    except Exception:
        emit_ai_call_event(model=api_kwargs["model"], status="failed", started_at=started_at)
        heartbeat.stop_model_call(status="failed")
        raise
    emit_ai_call_event(model=api_kwargs["model"], status="succeeded", started_at=started_at, usage=getattr(message, "usage", None))
    heartbeat.stop_model_call(status="finished")

    # Extract generated text and strip outline
    raw_text = message.content[0].text
    outline, output_text = strip_outline(raw_text)
    validate_generated_output(output_text, ctx)
    heartbeat.mark("output_validated", word_count=len(output_text.split()), has_outline=bool(outline))

    # Prepend editor brief if present in spec
    if spec and spec.get("editor_brief"):
        brief = spec["editor_brief"].strip()
        output_text = f"""---
EDITOR BRIEF
---

{brief}

---
SCRIPT START
---

{output_text}"""

    # Determine output path
    if output_dir is None:
        output_dir = base_path / "output"
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = output_dir / f"{task_id}_{timestamp}.md"
    output_file.write_text(output_text)
    heartbeat.mark("output_written", output_file=str(output_file), word_count=len(output_text.split()))

    # Save outline separately for observability
    if outline:
        outline_file = output_dir / f"{task_id}_{timestamp}_OUTLINE.md"
        outline_file.write_text(outline)

    return output_file


def main():
    """CLI interface for single ad generation."""
    parser = argparse.ArgumentParser(description="Generate a single ad from task_id")
    parser.add_argument("task_id", help="Task identifier (e.g., NOOR_YAPFEST_ARC1_A1B2_M1_RAGE_RBPUB_V001)")
    parser.add_argument("--output-dir", "-o", type=Path, help="Output directory")
    parser.add_argument("--base-path", "-b", type=Path, help="Base project path")
    parser.add_argument("--heartbeat-file", type=Path, help="Append JSONL progress events here")
    parser.add_argument(
        "--heartbeat-interval",
        type=float,
        default=float(os.environ.get("WW_GENERATE_HEARTBEAT_SECONDS", "15")),
        help="Seconds between model-call heartbeat events (default: 15)",
    )

    args = parser.parse_args()
    heartbeat = GenerationHeartbeat(args.heartbeat_file, args.task_id, args.heartbeat_interval)

    try:
        output_file = generate_ad(
            task_id=args.task_id,
            output_dir=args.output_dir,
            base_path=args.base_path,
            heartbeat=heartbeat,
        )
        print(f"Generated: {output_file}", flush=True)
    except anthropic.APIError as e:
        heartbeat.mark("failed", error=str(e), error_type=type(e).__name__)
        print(f"API Error: {e}", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError as e:
        heartbeat.mark("failed", error=str(e), error_type=type(e).__name__)
        print(f"File not found: {e}", file=sys.stderr)
        sys.exit(1)
    except GenerationValidationError as e:
        heartbeat.mark("failed", error=str(e), error_type=type(e).__name__)
        print(f"Generation validation failed: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        heartbeat.mark("failed", error=str(e), error_type=type(e).__name__)
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

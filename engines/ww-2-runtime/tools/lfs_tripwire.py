#!/usr/bin/env python3
"""LFS post-patch tripwire — integrity gate for LLM output.

Every LLM patch (lfs_fix, lfs_opener_rewrite) routes its candidate output through
safe_apply() before commit. The tripwire enforces three layers:

    1. Sanity     — refusal/preamble/truncation/length-out-of-band detection
    2. Frozen     — declared frozen regions stayed byte-equivalent
    3. Delta      — violation count strictly decreased; no new violations introduced

Failed checks REVERT — the original script stays on disk, the operator sees the reason.

The tripwire never modifies a script. It only commits or refuses.
"""
from __future__ import annotations

import json
import os
import re
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from lfs_verify import Result, check_text

try:
    import fcntl  # POSIX advisory locks
    _HAS_FCNTL = True
except ImportError:
    # Windows fallback — no concurrency protection, single-host only.
    fcntl = None
    _HAS_FCNTL = False


@contextmanager
def _file_lock(lock_path: Path):
    """Per-file advisory lock around the history sidecar read-modify-write cycle.

    Prevents the concurrent-append race where N threads hammering the same
    .qa-history.json each read the existing list, append their entry, and write
    back — overwriting each other's work. Held only for one append (microseconds).
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_path), os.O_WRONLY | os.O_CREAT, 0o644)
    try:
        if _HAS_FCNTL:
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        if _HAS_FCNTL:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
        os.close(fd)


# ---------- contract ----------

@dataclass
class PatchContract:
    """What a patch tool intends to do. The tripwire enforces this contract."""

    # The violation codes this patch attempts to resolve.
    # After patching, these MUST be gone. Other violations MUST NOT increase.
    requested_fixes: list[str] = field(default_factory=list)

    # Length envelope — % of original word count
    length_lo_pct: float = 0.70   # candidate must be ≥70% of input length
    length_hi_pct: float = 1.50   # candidate must be ≤150% of input length
    expansion_target: int | None = None  # if expansion was requested, hard target

    # Frozen regions — declared by the patch tool
    freeze_paragraphs_from: int | None = None   # freeze paragraph N..end (0-indexed)
    freeze_first_n_sentences: int | None = None # freeze the first N sentences
    freeze_lines_matching: list[str] = field(default_factory=list)  # regex of lines that must be preserved

    # Whitespace tolerance — single spaces, line breaks normalized before comparison
    whitespace_tolerant: bool = True


# ---------- result ----------

@dataclass
class TripwireResult:
    committed: bool
    reason: str       # "ok" | "sanity" | "frozen" | "regression"
    issues: list[str]
    before: Result | None = None
    after: Result | None = None

    def summary(self) -> str:
        if self.committed:
            return f"✓ committed"
        return f"✗ REVERT [{self.reason}]: {'; '.join(self.issues)}"


# ---------- layer 1: sanity ----------

REFUSAL_PATTERNS = [
    re.compile(r"^\s*I (can|cannot|can't|won't|am unable)", re.IGNORECASE),
    re.compile(r"^\s*I'?ll help", re.IGNORECASE),
    re.compile(r"^\s*Sure[,!]", re.IGNORECASE),
    re.compile(r"^\s*Here'?s the (corrected|fixed|patched|updated|revised) (script|version|copy)", re.IGNORECASE),
    re.compile(r"^\s*Here is the (corrected|fixed|patched|updated|revised)", re.IGNORECASE),
    re.compile(r"^\s*Could you provide", re.IGNORECASE),
    re.compile(r"^\s*```"),
    re.compile(r"^\s*\{"),
]


def sanity_checks(original: str, candidate: str, contract: PatchContract) -> list[str]:
    """Cheap deterministic checks. Catches refusals, preamble, truncation, length collapse."""
    issues: list[str] = []

    # Non-trivial output
    if len(candidate.strip()) < 200:
        issues.append(f"candidate too short ({len(candidate.strip())} chars)")
        return issues  # short-circuit — other checks meaningless

    # Refusal / preamble / wrong format
    candidate_head = candidate.lstrip()[:200]
    for pat in REFUSAL_PATTERNS:
        if pat.search(candidate_head):
            issues.append(f"output has preamble/refusal/wrong-format prefix: {candidate_head[:80]!r}")
            break

    # Truncation — well-formed copy ends on terminal punctuation
    tail = candidate.rstrip()[-3:]
    if not any(tail.endswith(c) for c in (".", "?", "!", '"', ")", "”", "—", "...")):
        issues.append(f"candidate may be truncated (ends with {tail!r})")

    # Length envelope
    orig_wc = len(original.split())
    cand_wc = len(candidate.split())
    if contract.expansion_target:
        # Expansion was requested — accept anything from 90% to 130% of target
        lo, hi = int(contract.expansion_target * 0.85), int(contract.expansion_target * 1.30)
    else:
        lo = int(orig_wc * contract.length_lo_pct)
        hi = int(orig_wc * contract.length_hi_pct)
    if cand_wc < lo:
        issues.append(f"length collapse: {cand_wc}w < {lo}w (original {orig_wc}w)")
    elif cand_wc > hi:
        issues.append(f"length explosion: {cand_wc}w > {hi}w (original {orig_wc}w)")

    return issues


# ---------- layer 2: frozen regions ----------

def _normalize_ws(s: str) -> str:
    """Collapse runs of whitespace to single spaces. Used for tolerant comparison."""
    return re.sub(r"\s+", " ", s).strip()


def _split_sentences(text: str) -> list[str]:
    """Quick-and-dirty sentence split. Good enough for the hook lock."""
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z])", text.strip())
    return [p for p in parts if p.strip()]


def _split_paragraphs(text: str) -> list[str]:
    """Split on blank lines. Preserves the body in document order."""
    return [p for p in re.split(r"\n\s*\n", text) if p.strip()]


def frozen_checks(original: str, candidate: str, contract: PatchContract) -> list[str]:
    """Verify declared frozen regions did not change beyond whitespace tolerance."""
    issues: list[str] = []
    norm = _normalize_ws if contract.whitespace_tolerant else (lambda s: s)

    # Frozen-from-paragraph: the LLM was allowed to change paragraphs 0..N-1.
    # Paragraphs N..end must be byte-identical (modulo whitespace).
    if contract.freeze_paragraphs_from is not None:
        orig_paras = _split_paragraphs(original)
        cand_paras = _split_paragraphs(candidate)
        n = contract.freeze_paragraphs_from
        orig_frozen = orig_paras[n:]
        cand_frozen = cand_paras[n:] if len(cand_paras) >= n else []

        if len(cand_frozen) != len(orig_frozen):
            issues.append(
                f"paragraph count changed past freeze-line {n}: "
                f"original had {len(orig_frozen)} frozen paragraphs, candidate has {len(cand_frozen)}"
            )
        else:
            for i, (op, cp) in enumerate(zip(orig_frozen, cand_frozen)):
                if norm(op) != norm(cp):
                    issues.append(
                        f"frozen paragraph {n + i} drifted: "
                        f"orig={op[:60]!r}... cand={cp[:60]!r}..."
                    )
                    break  # one is enough — no need to spam

    # First-N-sentences lock (the hook lock)
    if contract.freeze_first_n_sentences is not None:
        n = contract.freeze_first_n_sentences
        orig_sents = _split_sentences(original)[:n]
        cand_sents = _split_sentences(candidate)[:n]
        if len(cand_sents) < n:
            issues.append(f"hook truncated: candidate has fewer than {n} sentences")
        else:
            for i, (os_, cs) in enumerate(zip(orig_sents, cand_sents)):
                if norm(os_) != norm(cs):
                    issues.append(f"hook sentence {i+1} changed (was meant to be frozen)")
                    break

    # Line-pattern preservation — every line in original matching the pattern
    # must still appear in the candidate
    if contract.freeze_lines_matching:
        orig_lines = original.split("\n")
        cand_norm = norm(candidate)
        for pattern_str in contract.freeze_lines_matching:
            pat = re.compile(pattern_str)
            preserved_lines = [ln for ln in orig_lines if pat.search(ln)]
            for line in preserved_lines:
                if norm(line) and norm(line) not in cand_norm:
                    issues.append(f"frozen line dropped: {line[:80]!r}")
                    # don't break — report every dropped line

    return issues


# ---------- layer 3: violation delta ----------

def diff_verify(before: Result, after: Result, requested_fixes: list[str]) -> list[str]:
    """Confirm the patch monotonically reduced violations.

    - Every requested fix must be RESOLVED in the candidate.
    - No NEW violations may appear that weren't in the original.
    """
    issues: list[str] = []
    before_codes = {v.code for v in before.violations}
    after_codes = {v.code for v in after.violations}
    requested = set(requested_fixes)

    # Requested fixes that are still failing
    still_failing = (before_codes & requested) & after_codes
    if still_failing:
        issues.append(f"requested fixes did not land: {sorted(still_failing)}")

    # New violations introduced by the patch
    new_violations = after_codes - before_codes
    if new_violations:
        issues.append(f"patch introduced new violations: {sorted(new_violations)}")

    return issues


# ---------- audit ledger ----------

def _history_path(script_path: Path) -> Path:
    """Sidecar ledger lives next to the script: foo.md -> foo.qa-history.json."""
    return script_path.with_suffix(".qa-history.json")


def append_history(
    script_path: Path,
    *,
    tool: str,
    before: Result,
    after: Result,
    requested_fixes: list[str],
    committed: bool,
    reason: str,
    issues: list[str] | None = None,
    model: str | None = None,
    extra: dict | None = None,
) -> None:
    """Append one entry to the script's QA history sidecar.

    Records every tripwire decision (commit and revert) so we can later analyze:
    - which violation codes recur most often
    - which scripts get patched repeatedly
    - which patches succeed on first pass vs need retry
    - which products produce the highest violation rate

    The ledger is append-only. Each entry is self-contained — no foreign keys,
    no migration story. Read with json.loads, analyze with whatever.
    """
    history_path = _history_path(script_path)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tool": tool,
        "model": model,
        "committed": committed,
        "reason": reason,
        "issues": issues or [],
        "requested_fixes": list(requested_fixes),
        "fixes_resolved": sorted(
            {v.code for v in before.violations} & set(requested_fixes)
            - {v.code for v in after.violations}
        ),
        "fixes_introduced": sorted(
            {v.code for v in after.violations} - {v.code for v in before.violations}
        ),
        "violations_before": sorted({v.code for v in before.violations}),
        "violations_after": sorted({v.code for v in after.violations}),
        "word_count_before": before.word_count,
        "word_count_after": after.word_count,
        "brand_count_before": before.brand_count_total,
        "brand_count_after": after.brand_count_total,
    }
    if extra:
        entry["extra"] = extra

    # File-locked read-modify-write so concurrent appenders cannot clobber each other.
    # Lock file is a sibling .lock; auto-created. Held only for one append (microseconds).
    lock_path = history_path.with_suffix(".lock")
    with _file_lock(lock_path):
        existing: list[dict] = []
        if history_path.exists():
            try:
                existing = json.loads(history_path.read_text())
                if not isinstance(existing, list):
                    existing = []
            except (json.JSONDecodeError, OSError):
                existing = []
        existing.append(entry)
        history_path.write_text(json.dumps(existing, indent=2))


def read_history(script_path: Path) -> list[dict]:
    """Read the QA history sidecar for a script. Empty list if none."""
    history_path = _history_path(script_path)
    if not history_path.exists():
        return []
    try:
        data = json.loads(history_path.read_text())
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


# ---------- the gate ----------

def safe_apply(
    path: Path,
    candidate: str,
    contract: PatchContract,
    cfg: dict,
    cta_text: str,
    dry_run: bool = False,
    *,
    tool: str = "unknown",
    model: str | None = None,
    log_history: bool = True,
) -> TripwireResult:
    """Run the three tripwire layers. Commit on pass; revert on fail.

    On commit, append a structured entry to the script's QA history sidecar
    (set log_history=False to suppress — used by dry-runs and previews).
    The original script stays on disk if anything fails.
    """
    original = path.read_text()
    before_result = check_text(original, str(path), cfg, cta_text)

    def _log(result: TripwireResult) -> None:
        if log_history and not dry_run:
            append_history(
                path,
                tool=tool,
                before=before_result,
                after=result.after or before_result,
                requested_fixes=contract.requested_fixes,
                committed=result.committed,
                reason=result.reason,
                issues=result.issues,
                model=model,
            )

    # Layer 1 — sanity
    issues = sanity_checks(original, candidate, contract)
    if issues:
        result = TripwireResult(False, "sanity", issues, before=before_result)
        _log(result)
        return result

    # Layer 2 — frozen regions
    issues = frozen_checks(original, candidate, contract)
    if issues:
        result = TripwireResult(False, "frozen", issues, before=before_result)
        _log(result)
        return result

    # Layer 3 — violation delta
    after_result = check_text(candidate, str(path), cfg, cta_text)
    issues = diff_verify(before_result, after_result, contract.requested_fixes)
    if issues:
        result = TripwireResult(False, "regression", issues,
                                before=before_result, after=after_result)
        _log(result)
        return result

    # Commit
    if not dry_run:
        path.write_text(candidate)
    result = TripwireResult(True, "ok", [], before=before_result, after=after_result)
    _log(result)
    return result

#!/usr/bin/env python3
"""LFS surgical fixer.

Reads violations from lfs_verify.py and patches them in-place. Two modes:

1. DETERMINISTIC patches (no LLM): strip bold markdown, strip bullet markers, append CTA verbatim.
2. SURGICAL LLM patches: brand insertions, price corrections, forbidden-phrase swaps, word-count expansion.

The fixer is FORBIDDEN from rewriting voice, format, beats, hook, dated log, or persona.
It receives the script + the specific violations and produces the same script with surgical edits.

Usage:
    python tools/lfs_fix.py --batch BATCH_ID                      # fix all in batch, in place
    python tools/lfs_fix.py --batch BATCH_ID --dry-run            # show patches, don't write
    python tools/lfs_fix.py --batch BATCH_ID --max-passes 2       # how many fix → verify cycles
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

# Local import via direct path so the file can run from anywhere
THIS = Path(__file__).resolve()
REPO = THIS.parent.parent
sys.path.insert(0, str(THIS.parent))

try:
    from dotenv import load_dotenv
    load_dotenv(REPO / ".env")
except ImportError:
    pass

from lfs_verify import (  # noqa: E402
    Result,
    check_script,
    check_text,
    canonical_prices,
    load_batch_context,
    load_batch_spec,
    load_product_config,
    print_report,
    run_batch,
)
from lfs_tripwire import PatchContract, TripwireResult, append_history, safe_apply  # noqa: E402
from ww_paths import resolve_batch_dir  # noqa: E402


# ---------- deterministic patches ----------

def strip_bold(body: str) -> tuple[str, int]:
    """Remove all `**` markdown bold markers. Returns (body, count_removed)."""
    count = body.count("**")
    return body.replace("**", ""), count // 2


def strip_italic_underscores(body: str) -> tuple[str, int]:
    # `__word__` style — rare but appears
    pattern = re.compile(r"__([^_\n]+)__")
    new_body, n = pattern.subn(r"\1", body)
    return new_body, n


def strip_single_asterisk_italics(body: str) -> tuple[str, int]:
    """Remove `*phrase*` italics. Only single-line, non-greedy, with letter on either side."""
    pattern = re.compile(r"(?<![\*\w])\*([^\*\n]+?)\*(?![\*\w])")
    new_body, n = pattern.subn(r"\1", body)
    return new_body, n


def append_cta_if_missing(body: str, cta_text: str) -> tuple[str, bool]:
    """If CTA anchor isn't present, append it verbatim before the P.S.

    Uses fuzzy detection — if any 5-word window of the CTA appears, we consider it present
    (the model may have paraphrased lightly; we don't want to double-stamp it).
    """
    cta_words = cta_text.split()
    # check every 5-word window of the CTA
    for i in range(len(cta_words) - 4):
        window = " ".join(cta_words[i:i+5])
        if window in body:
            return body, False
    # find P.S. block to insert before it
    ps_match = re.search(r"\n\s*P\.S\.", body)
    if ps_match:
        idx = ps_match.start()
        return body[:idx] + f"\n\n{cta_text}\n" + body[idx:], True
    return body.rstrip() + f"\n\n{cta_text}\n", True


def normalize_lfs_divider_spacing(body: str) -> tuple[str, int]:
    """Ensure every LFS divider has blank-line spacing around it."""
    changed = 0
    trailing_newline = body.endswith("\n")
    out: list[str] = []
    lines = body.splitlines()
    for line in lines:
        if line.strip() != "========":
            out.append(line.rstrip())
            continue
        if out and out[-1].strip():
            out.append("")
            changed += 1
        out.append("========")
        out.append("")
    text = "\n".join(out).strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    if trailing_newline:
        text += "\n"
    return text, changed


def _sentence_units(text: str) -> list[str]:
    """Split prose into display units while keeping punctuation attached."""
    protected = (
        text.replace("P.P.S.", "P_P_S_")
        .replace("P.S.", "P_S_")
        .replace("e.g.", "e_g_")
        .replace("i.e.", "i_e_")
    )
    spans: list[tuple[int, int]] = []
    start = 0
    for match in re.finditer(r"[.!?]+(?:\s+|$)", protected):
        end = match.end()
        spans.append((start, end))
        start = end
    if start < len(text):
        spans.append((start, len(text)))
    units = [text[a:b].strip() for a, b in spans if text[a:b].strip()]
    return units or [text.strip()]


def _split_long_unit(unit: str, max_words: int = 45) -> list[str]:
    words = unit.split()
    if len(words) <= max_words:
        return [unit]
    chunks = []
    for i in range(0, len(words), max_words):
        chunks.append(" ".join(words[i:i + max_words]))
    return chunks


def split_lfs_wall_paragraphs(body: str) -> tuple[str, int]:
    """Repair native LFS wall paragraphs by inserting blank lines only.

    This is deliberately dumb and boring: preserve every character sequence
    inside each display unit, preserve dated log lines, and change only vertical
    spacing. LLMs are bad at this because they rewrite. Newlines are enough.
    """
    trailing_newline = body.endswith("\n")
    paragraphs = re.split(r"\n\s*\n", body.strip())
    out: list[str] = []
    changed = 0
    dated_re = re.compile(r"^(?:[-*]\s*)?(?:Day|Week|Month)\s+\d+", re.IGNORECASE)

    for paragraph in paragraphs:
        stripped = paragraph.strip()
        if not stripped:
            continue
        if stripped == "========":
            out.append("========")
            continue

        units: list[str] = []
        for line in stripped.splitlines():
            line = line.strip()
            if not line:
                continue
            if dated_re.match(line):
                units.append(line)
                continue
            for sentence in _sentence_units(line):
                units.extend(_split_long_unit(sentence))

        if len(units) != 1 or units[0] != stripped:
            changed += 1
        out.extend(units)

    text = "\n\n".join(out).strip()
    if trailing_newline:
        text += "\n"
    return text, changed


def _word_count(text: str) -> int:
    return len(text.split())


def _normalize_paragraph(text: str) -> str:
    text = re.sub(r"[^a-z0-9\s]", "", text.lower())
    return re.sub(r"\s+", " ", text).strip()


def structured_trim_word_high(script_path: Path, cta_text: str, max_words: int = 2000) -> bool:
    """Trim overlong LFS copy without touching protected proof/offer regions."""
    body = script_path.read_text()
    if _word_count(body) <= max_words:
        return False

    paragraphs = re.split(r"\n\s*\n", body.strip())
    cta_anchor = " ".join(cta_text.split()[:8])
    dated_re = re.compile(r"^(?:[-*]\s*)?(?:Day|Week|Month)\s+\d+", re.IGNORECASE)
    protected: set[int] = set()
    prose_seen = 0
    for idx, paragraph in enumerate(paragraphs):
        stripped = paragraph.strip()
        if not stripped or stripped == "========":
            protected.add(idx)
            continue
        prose_seen += 1
        if prose_seen <= 3:
            protected.add(idx)
        if dated_re.match(stripped):
            protected.add(idx)
        if stripped.startswith(("P.S.", "P.P.S.")):
            protected.add(idx)
        if cta_anchor and cta_anchor in " ".join(stripped.split()):
            protected.add(idx)
        if "$" in stripped:
            protected.add(idx)

    keep = [True] * len(paragraphs)
    seen: set[str] = set()
    for idx, paragraph in enumerate(paragraphs):
        if idx in protected:
            continue
        key = _normalize_paragraph(paragraph)
        if len(key.split()) < 8:
            continue
        if key in seen:
            keep[idx] = False
        else:
            seen.add(key)

    def current_text() -> str:
        return "\n\n".join(p for i, p in enumerate(paragraphs) if keep[i]).strip() + "\n"

    text = current_text()
    if _word_count(text) > max_words:
        candidates = [
            idx for idx, paragraph in enumerate(paragraphs)
            if keep[idx]
            and idx not in protected
            and paragraph.strip()
            and paragraph.strip() != "========"
        ]
        candidates.sort(key=lambda idx: len(paragraphs[idx].split()), reverse=True)
        for idx in candidates:
            if _word_count(text) <= max_words:
                break
            keep[idx] = False
            text = current_text()

    if text != body and _word_count(text) <= _word_count(body):
        script_path.write_text(text)
        return True
    return False


# ---------- LLM patcher ----------

PATCH_SYSTEM = """You're the editor who gets the script after the writer is done — the one who fixes the holes the writer couldn't see in the flow. The voice is good. The structure is good. There are specific compliance gaps the QA tool flagged: the brand name is underused, a hallucinated price slipped through, a banned word landed, residual bold formatting. You patch those gaps with the lightest touch.

Preserve untouched, byte-for-byte: voice, persona, register, tone, paragraph order, beat sequence, section count, dated log entries (Day 1, Week 2, Month 3 lines), the opening hook (first 3 sentences), the CTA text. Output the full corrected script — no diff notes, no headers, no commentary.

Hard boundaries:
- Never introduce a new dollar amount. Use only the exact prices listed in the user instructions.
- Never add a professional-title workaround for a banned word. If a banned word is flagged, remove that idea or rewrite it as a generic human scene.
- Keep LFS native formatting: short scan-friendly paragraphs separated by blank lines, with `========` dividers preserved.
- If expanding for word count, land between the requested minimum and target. Do not balloon the script.

Contrastive pair — surgical vs drifted, for a brand-density violation:

VIOLATION: brand appears only 2x in second half; target is ≥4.

WINNER (4 insertions woven into existing rhythm, voice intact):
  The first morning the problem felt quieter, I sat with my coffee for ten minutes before I trusted it. The [BRAND] I had added to my routine was doing what nothing else had. By Sunday, [BRAND] had stopped being a thing I checked and started being the thing I trusted. My sister came over for the first time in four months. I told her about [BRAND]. She ordered her own [PRODUCT] that night.

DRIFTED (single paragraph rewrite, voice flattened — the failure to avoid):
  [BRAND] changed everything for me. [BRAND] is the first product that actually worked. I am so grateful for [BRAND]. [BRAND] saved me.

The winner inserts the brand name into the writer's existing rhythm — coffee, trust, sister, product. The drifted version pasted the brand on top of a generic testimonial paragraph and lost the voice in the process. Match the winner's shape: surgical, woven, voice-preserving.

Contrastive pair — dated-log preservation:

VIOLATION: brand appears only 2x in second half; target is ≥4. The script has dated log lines.

WINNER (dated log untouched, brand inserted around it):
  Day 21: I took a picture because I was tired of sounding dramatic.

  By the time I tried [BRAND], I had stopped expecting any product to work. Three mornings later, the part I had been checking looked different enough that I checked twice.

DRIFTED (dated log rewritten — the failure to avoid):
  Day 21: [BRAND] finally made the problem better and I took a picture because [BRAND] was working.

The winner leaves the Day/Week/Month line exactly as written and adds brand attribution in the surrounding prose. The drifted version edits the log itself. That patch will be rejected. Treat dated log lines as locked source evidence.

Contrastive pair — dated line already names the brand:

VIOLATION: brand appears only 2x in second half. Day 21 already says "Before [BRAND]..."

WINNER (line treated as saturated, new prose added after it):
  Day 21: I noticed the first change. Before [BRAND], I would check the same spot every morning and feel defeated.

  I still did not trust it yet. I kept using [BRAND] the same way and waited for the usual disappointment to come back.

DRIFTED (existing brand line expanded — the failure to avoid):
  Day 21: I noticed the first change because [BRAND] had finally fixed the problem and before [BRAND] I would check the same spot every morning and feel defeated.

If a dated line already contains the brand, it is saturated. Count it as locked evidence. Add new brand mentions only in adjacent non-dated prose, mechanism reveal, transformation prose, or close paragraphs.

Output the full corrected script. Plain markdown only."""


def patch_with_llm(body: str, violations: list[dict], cfg: dict, cta_text: str,
                   previous_failures: list[str] | None = None) -> str:
    """Send script + violations to Claude for surgical patching."""
    try:
        import anthropic
    except ImportError:
        raise RuntimeError("anthropic SDK not installed; run `pip install anthropic`")

    instructions = build_patch_instructions(violations, cfg, cta_text)
    if previous_failures:
        instructions += (
            "\n\nPREVIOUS PATCH ATTEMPTS WERE REJECTED BY THE TRIPWIRE:\n"
            + "\n".join(f"- {failure}" for failure in previous_failures[-3:])
            + "\n\nAdjust the next patch to avoid those exact failures. Preserve every frozen line and frozen paragraph."
        )

    client = anthropic.Anthropic()
    msg = client.messages.create(
        model=os.environ.get("LFS_FIXER_MODEL", "claude-sonnet-4-6"),
        max_tokens=8000,
        system=PATCH_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"VIOLATIONS TO FIX:\n{instructions}\n\nSCRIPT:\n\n{body}",
        }],
    )
    return msg.content[0].text


def _canonical_prices_from_config(cfg: dict) -> set[str]:
    """Mirror verifier price allowlist so fixer and verifier cannot disagree."""
    return canonical_prices(cfg)


def _product_noun_from_config(cfg: dict) -> str:
    """Return a generic package noun for examples without hardcoding a niche."""
    ingredients = cfg.get("ingredients", {})
    if isinstance(ingredients, dict):
        form = str(ingredients.get("form") or "").strip()
        if form:
            return form.lower()
    product_name = str(cfg.get("product_name") or "").lower()
    for noun in ("balm", "cream", "serum", "jar", "bottle", "capsule", "pouch", "device", "program"):
        if noun in product_name:
            return noun
    return "unit"


def build_patch_instructions(violations: list[dict], cfg: dict, cta_text: str) -> str:
    """Render the violation list into patch instructions with winner shapes per violation."""
    brand = cfg.get("brand") or cfg.get("product_name") or "the product"
    product_name = cfg.get("product_name") or brand
    product_noun = _product_noun_from_config(cfg)
    allowed_prices = sorted(_canonical_prices_from_config(cfg))
    forbidden = sorted({p.lower() for p in cfg.get("prompt_context", {}).get("forbidden_phrases", [])})
    lines: list[str] = []
    if allowed_prices:
        lines.append(
            "Global price rule for this patch: use only these exact dollar amounts if a dollar amount is needed: "
            f"{allowed_prices}. Do not invent replacement prices."
        )
    if forbidden:
        lines.append(
            "Global forbidden-phrase rule for this patch: these strings must not appear in the corrected script: "
            f"{forbidden}."
        )
    for v in violations:
        code = v["code"]
        det = v.get("detail", {})
        if code == "BRAND_MISSING_CTA":
            lines.append(
                f"Insert one mention of '{brand}' in the final paragraph that precedes the CTA. Attribute the result to the brand by name. "
                f"Winner shape: 'The {product_name} was the first thing that made the change feel believable.'"
            )
        elif code == "BRAND_MISSING_PS":
            lines.append(
                f"Insert one mention of '{brand}' in the P.S. block, naming the brand when describing what was used or recommended. "
                f"Winner shape: 'P.S. — my sister asked me for the name, and I sent her the {brand} article that night.'"
            )
        elif code == "BRAND_DENSITY_LOW":
            need = det.get("insert_count", 2)
            lines.append(
                f"Weave {need} more mentions of '{brand}' into the second half. Use the mechanism reveal, paragraphs between dated log entries, and close paragraphs. "
                f"Preserve every Day/Week/Month dated log line byte-for-byte; insert brand mentions before or after those lines, not inside them. "
                f"If a dated line already contains '{brand}', treat that line as saturated evidence and add new brand mentions in adjacent non-dated prose only. "
                f"Replace generic references ('the product', 'this brand', 'it', 'them') with the brand name where the sentence is already talking about the advertised product. "
                f"Winner shape: 'The {product_name} was doing what nothing else in my routine had done.' "
                f"Avoid the testimonial-paste shape — '{brand} changed everything for me. {brand} is the first thing that worked.' That flattens voice."
            )
        elif code == "PRICE_HALLUCINATION":
            bad = det.get("bad_prices", [])
            allowed = det.get("allowed", [])
            lines.append(
                f"These dollar amounts are not in the canonical price set and must be removed or rewritten: {bad}. "
                f"Allowed prices in this script: {allowed}. "
                "Do not replace them with a new dollar amount. Either remove the price entirely, replace it with a non-price phrase like 'another expensive option', or use one exact allowed price from the list above when the old sentence clearly refers to that canonical anchor. "
                f"Winner shape: 'I'd spent more than one {product_noun} of {brand} costs trying another expensive alternative.'"
            )
        elif code == "FORBIDDEN_PHRASES":
            phrases = det.get("phrases", [])
            lines.append(
                f"These words landed in the script and need to leave: {phrases}. "
                f"Restructure the sentence around the meaning instead of swapping in a synonym. "
                "Winner shape: 'It was a game-changer' becomes 'It was the first thing that made me check twice.' "
                "'Life-changing transformation' becomes 'the first morning I noticed the old panic did not show up.'"
            )
        elif code in {"WORD_COUNT_LOW", "WORD_COUNT_THIN"}:
            current = det.get("current", 0)
            target = det.get("target", 1400)
            minimum = det.get("min", 1200)
            need = max(target - current, 350)
            lines.append(
                f"Script is {current} words. Minimum is {minimum}; target is ~{target} (add ~{need} words). "
                f"Expand only inside the dated transformation log AND the failed-solutions ledger. "
                f"Add concrete sensory detail, named witnesses, specific timestamps, dollar amounts from the existing failed-solutions list. "
                f"Leave the hook, mechanism, and close at their current word counts. Section count stays the same. "
                f"Final script must be safely above the minimum: aim for {target - 50}-{target + 150} words, never under {minimum + 100}. "
                "For any script currently under 900 words, add at least two substantial paragraphs to the failed-solutions ledger and at least two substantial paragraphs around the dated transformation log. "
                "Do not add any new dollar amounts while expanding; reuse only already-allowed price anchors."
            )
        elif code == "WORD_COUNT_HIGH":
            current = det.get("current", 0)
            max_words = det.get("max", 2000)
            target = max_words - 100
            lines.append(
                f"Script is {current} words, above the {max_words}-word ceiling. Trim it to roughly {target}-{max_words} words. "
                f"Cut repetition, throat-clearing, duplicated proof, and any second explanation of a point already made. "
                f"Preserve the hook, CTA, P.S./P.P.S., dated log lines, mechanism claim, and all canonical prices. "
                f"Winner shape: remove the second sentence that repeats the first, not the concrete detail that makes the first believable."
            )
        elif code == "CTA_NOT_VERBATIM":
            lines.append(
                f"Insert this CTA verbatim immediately before the P.S. block:\n{cta_text}"
            )
        elif code == "PS_MISSING":
            lines.append(
                f"Append a P.S. block after the CTA — 2-3 sentences, peer-recommendation tone, naming '{brand}' once. "
                f"Winner shape: 'P.S. My sister asked what I was using, and I sent her the {brand} article. She texted me a week later saying she wished someone had explained the mechanism sooner.'"
            )
        elif code == "BULLET_DUMP":
            lines.append(
                "Convert any bulleted list into prose paragraphs, keeping the same content and order. LFS reads as a story, not a checklist."
            )
        elif code == "META_LANGUAGE":
            phrases = det.get("phrases", [])
            lines.append(
                f"These priming phrases broke the spell and need to leave: {phrases}. "
                f"Rewrite each sentence to state the thing directly. "
                f"Winner shape: 'Imagine if you woke up and the counter was clean' becomes 'The first morning I woke up and the counter was clean, I sat with my coffee for ten minutes before I trusted it.'"
            )
    return "\n\n".join(f"- {line}" for line in lines)


# ---------- orchestration ----------

def needs_llm_patch(violations: list) -> bool:
    """Return True if any violation requires LLM patching (vs deterministic)."""
    deterministic_codes = {"MARKDOWN_BOLD", "LFS_WALL_PARAGRAPH", "LFS_DIVIDER_SPACING"}
    # PS_MISSING goes to LLM if we want a real peer-voice P.S.; deterministic path skips
    return any(v.code not in deterministic_codes for v in violations)


def _build_fix_contract(violations: list, cfg: dict) -> PatchContract:
    """Declare what the LLM patch is allowed to do for these violations.

    The tripwire enforces this contract: the LLM must resolve the requested
    violations, leave declared frozen regions intact, and stay inside the
    length envelope.
    """
    requested = [v.code for v in violations]

    # Length envelope — wider when expansion was requested, lower when trimming was requested.
    expansion_target = None
    length_lo_pct = 0.85
    length_hi_pct = 1.40
    for v in violations:
        if v.code == "WORD_COUNT_THIN":
            expansion_target = v.detail.get("target", 1400)
            break
        if v.code == "WORD_COUNT_HIGH":
            length_lo_pct = 0.70
            length_hi_pct = 1.00

    # Frozen regions for surgical patches:
    # - First 3 sentences = the hook (system prompt forbids modifying them)
    # - Dated log lines (Day X / Week X / Month X) = the transformation log
    # - The CTA verbatim (lfs_verify enforces it; double-locked here)
    cta_text = ""  # filled by caller; we just pin shape

    return PatchContract(
        requested_fixes=requested,
        length_lo_pct=length_lo_pct,
        length_hi_pct=length_hi_pct,
        expansion_target=expansion_target,
        freeze_first_n_sentences=3,
        freeze_lines_matching=[
            r"^(?:\s*[-*]\s*)?(?:Day|Week|Month)\s+\d+",  # dated log entries
        ],
    )


def fix_one(script_path: Path, cfg: dict, cta_text: str,
            dry_run: bool = False, max_passes: int = 2,
            only_codes: set[str] | None = None) -> tuple[Result, Result, list[TripwireResult]]:
    """Fix a single script. Returns (before, after, tripwire_log).

    Each LLM patch attempt routes through the tripwire. Failed patches REVERT
    (the original stays on disk). The tripwire log records every commit and revert
    so the caller can surface failures.
    """
    tripwire_log: list[TripwireResult] = []
    before = check_script(script_path, cfg, cta_text)
    if before.passed:
        return before, before, tripwire_log

    body = script_path.read_text()
    original_body = body

    # Pass 1: deterministic patches (known-safe, no tripwire required)
    body, bold_count = strip_bold(body)
    body, italic_us_count = strip_italic_underscores(body)
    body, italic_ast_count = strip_single_asterisk_italics(body)
    body, cta_appended = append_cta_if_missing(body, cta_text)
    body, wall_paragraphs_split = split_lfs_wall_paragraphs(body)
    body, divider_spacing_fixed = normalize_lfs_divider_spacing(body)

    if not dry_run:
        script_path.write_text(body)
    mid = check_text(body, str(script_path), cfg, cta_text)

    # Audit-log the deterministic block IF it actually changed something. Without
    # this, the audit trail silently misses every CTA append / bold strip — the
    # cheapest and most common fixes — and the ledger underreports activity.
    deterministic_changed = body != original_body
    if deterministic_changed and not dry_run:
        append_history(
            script_path,
            tool="lfs_fix.deterministic",
            before=before,
            after=mid,
            requested_fixes=[],
            committed=True,
            reason="ok",
            issues=[],
            model=None,
            extra={
                "bold_stripped": bold_count,
                "italic_us_stripped": italic_us_count,
                "italic_ast_stripped": italic_ast_count,
                "cta_appended": cta_appended,
                "wall_paragraphs_split": wall_paragraphs_split,
                "divider_spacing_fixed": divider_spacing_fixed,
            },
        )

    if mid.passed:
        if dry_run:
            script_path.write_text(original_body)
        return before, mid, tripwire_log

    repair_body = body
    previous_failures: list[str] = []

    # Pass 2+: LLM surgical patches with tripwire gate
    for pass_num in range(max_passes):
        active_violations = [
            v for v in mid.violations
            if v.code not in {"MARKDOWN_BOLD", "LFS_WALL_PARAGRAPH", "LFS_DIVIDER_SPACING"}  # already deterministic
            and (only_codes is None or v.code in only_codes)
        ]
        if not active_violations:
            break

        violations_payload = [
            {"code": v.code, "severity": v.severity, "detail": v.detail}
            for v in active_violations
        ]
        try:
            candidate = patch_with_llm(repair_body, violations_payload, cfg, cta_text, previous_failures=previous_failures)
            candidate, _candidate_wall_splits = split_lfs_wall_paragraphs(candidate)
            candidate, _candidate_divider_spacing = normalize_lfs_divider_spacing(candidate)
        except Exception as e:
            print(f"   [LLM patch failed: {e}]", file=sys.stderr)
            if not dry_run:
                script_path.write_text(repair_body)
                mid = check_text(repair_body, str(script_path), cfg, cta_text)
            break

        contract = _build_fix_contract(active_violations, cfg)
        result = safe_apply(
            script_path, candidate, contract, cfg, cta_text,
            dry_run=dry_run,
            tool="lfs_fix",
            model=os.environ.get("LFS_FIXER_MODEL", "claude-sonnet-4-6"),
        )
        tripwire_log.append(result)

        if not result.committed:
            # Revert this candidate, record why, then try a fresh patch from the
            # last verified body. A rejected patch should not end the repair loop.
            print(f"   [tripwire pass {pass_num + 1}: {result.summary()}]", file=sys.stderr)
            previous_failures.append(f"{result.reason}: {'; '.join(result.issues)}")
            if not dry_run:
                script_path.write_text(repair_body)
                mid = check_text(repair_body, str(script_path), cfg, cta_text)
            continue

        repair_body = candidate
        mid = result.after or check_text(repair_body, str(script_path), cfg, cta_text)
        if mid.passed:
            break

    if dry_run:
        # Always restore on dry-run regardless of commit status
        script_path.write_text(original_body)
    return before, mid, tripwire_log


def write_temp(body: str, ref: Path) -> Path:
    """Write to a temp file matching ref's name for re-verification on dry-run."""
    tmp = ref.with_suffix(".tmpfix.md")
    tmp.write_text(body)
    return tmp


# ---------- CLI ----------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-passes", type=int, default=2)
    ap.add_argument("--only", help="comma-separated list of script basename substrings to fix")
    ap.add_argument("--output-subdir", default="output", help="Batch output subdir to fix (default: output)")
    ap.add_argument("--only-codes", help="comma-separated verifier codes eligible for LLM patching")
    args = ap.parse_args()

    cfg, cta = load_batch_context(args.batch)
    output_dir = resolve_batch_dir(args.batch, base_path=REPO) / args.output_subdir

    scripts = sorted(output_dir.glob("*.md"))
    if args.only:
        keys = [k.strip() for k in args.only.split(",") if k.strip()]
        scripts = [s for s in scripts if any(k in s.name for k in keys)]
    only_codes = {c.strip() for c in args.only_codes.split(",") if c.strip()} if args.only_codes else None

    print(f"Fixing {len(scripts)} scripts in {args.batch} (dry_run={args.dry_run})\n")

    befores: list[Result] = []
    afters: list[Result] = []
    reverts: list[tuple[str, TripwireResult]] = []
    for path in scripts:
        print(f"→ {path.name}")
        b, a, tw_log = fix_one(path, cfg, cta, dry_run=args.dry_run, max_passes=args.max_passes, only_codes=only_codes)
        befores.append(b); afters.append(a)
        for tw in tw_log:
            if not tw.committed:
                reverts.append((path.name, tw))
        delta = b.critical_count + b.high_count - a.critical_count - a.high_count
        status = "✓ clean" if a.passed else f"⚠ {a.critical_count} crit, {a.high_count} high remaining"
        print(f"   {status} ({delta} fixed)")

    if reverts:
        print(f"\n=== {len(reverts)} TRIPWIRE REVERTS (LLM output rejected, original preserved) ===")
        for name, tw in reverts:
            print(f"  {name}: [{tw.reason}] {'; '.join(tw.issues)}")

    print("\n=== AFTER ===")
    print_report(afters, compact=True)
    return 0 if all(r.passed for r in afters) else 1


if __name__ == "__main__":
    sys.exit(main())

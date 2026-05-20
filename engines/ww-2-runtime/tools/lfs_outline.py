#!/usr/bin/env python3
"""Generate LFS per-task outlines from saved swipe transcripts.

The outline file is the bridge between competitor transcript structure and
repo-native LFS generation. `context.py` loads `outlines/<TASK_ID>.md` as a
required blueprint; this command creates those files at batch scale.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from research_cards import load_card_or_section, resolve_product_dir
from ww_artifacts import write_artifact_manifest
from ww_paths import resolve_batch_dir


REPO = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = os.environ.get("LFS_OUTLINE_MODEL", "claude-sonnet-4-6")
DEFAULT_TASK_TIMEOUT_SECONDS = int(os.environ.get("LFS_OUTLINE_TASK_TIMEOUT_SECONDS", "600"))
DEFAULT_REQUEST_TIMEOUT_SECONDS = float(os.environ.get("LFS_OUTLINE_REQUEST_TIMEOUT_SECONDS", "300"))
OUTLINE_TITLE_PREFIX = "## LFS V4.1 Format-Merged Outline:"
LEGACY_OUTLINE_TITLE_PREFIX = "## LFS V" + "3 Format-Merged Outline:"
OUTLINE_TITLE_PREFIXES = ("## Transcript-Derived Outline:", OUTLINE_TITLE_PREFIX, LEGACY_OUTLINE_TITLE_PREFIX)
MECHANISM_CODE_RE = re.compile(r"(?:^|_)(M\d+(?:_[A-Z]+)?)(?=_|$)")


@dataclass
class OutlineResult:
    task_id: str
    source_path: str | None
    outline_path: str | None
    status: str
    error: str | None = None
    attempts: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "source_path": self.source_path,
            "outline_path": self.outline_path,
            "status": self.status,
            "error": self.error,
            "attempts": self.attempts,
        }


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def load_product_config(base_path: Path, product: str) -> dict[str, Any]:
    cfg_path = resolve_product_dir(base_path, product) / "config.json"
    if not cfg_path.exists():
        return {}
    return load_json(cfg_path)


def extract_source_swipe(prompt_text: str) -> str | None:
    """Read a source swipe path from a per-task prompt.

    Supported prompt shape:

        ## SOURCE SWIPE
        scanner/tyver/.../copies/14-example.md
    """
    lines = prompt_text.splitlines()
    for i, line in enumerate(lines):
        if line.strip().lower() == "## source swipe":
            for nxt in lines[i + 1 : i + 8]:
                val = nxt.strip().strip("`")
                if not val or val.startswith("#"):
                    continue
                if ".md" not in val and "/" not in val:
                    continue
                return val
    match = re.search(r"(?im)^\s*source[_ -]?swipe\s*:\s*(.+?)\s*$", prompt_text)
    if match:
        return match.group(1).strip().strip("`")
    return None


def resolve_source_path(raw: str, base_path: Path) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = base_path / path
    return path.resolve()


def task_prompt_path(batch_dir: Path, task_id: str) -> Path:
    return batch_dir / "prompts" / f"{task_id}.md"


def outline_path(batch_dir: Path, task_id: str) -> Path:
    return batch_dir / "outlines" / f"{task_id}.md"


def lfs_format_paths(spec: dict[str, Any]) -> list[str]:
    """Return LFS format context files selected by the batch spec."""
    return [
        str(path)
        for path in spec.get("context_files", []) or []
        if str(path).startswith("components/lfs-formats/") and str(path).endswith(".md")
    ]


def parse_prompt_manifest(body: str) -> tuple[dict[str, str], str]:
    """Parse prompt frontmatter without importing preflight.py."""
    if not body.startswith("---\n"):
        return {}, body
    end = body.find("\n---", 4)
    if end == -1:
        return {}, body
    raw = body[4:end]
    rest = body[end + 4:].lstrip("\n")
    manifest: dict[str, str] = {}
    for line in raw.splitlines():
        if not line.strip() or line.strip().startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        manifest[key.strip()] = value.strip().strip('"').strip("'")
    return manifest, rest


def _lfs_format_path_from_name(value: str | None) -> str:
    name = Path(str(value or "").strip()).stem
    if not name or name.lower() in {"lfs", "mixed"}:
        return ""
    return f"components/lfs-formats/{name}.md"


def extract_intent_format(prompt_text: str) -> str:
    match = re.search(r"<intent>\s*(\{.*?\})\s*</intent>", prompt_text, re.DOTALL)
    if not match:
        return ""
    try:
        intent = json.loads(match.group(1))
    except json.JSONDecodeError:
        return ""
    return str(intent.get("format") or "").strip()


def lfs_format_path_for_task(spec: dict[str, Any], task_id: str, prompt_text: str = "") -> str:
    """Resolve the LFS format template for one task.

    V4.1 can mix LFS messaging formats in one batch. The task prompt
    frontmatter is the strongest routing signal, with compiled spec metadata
    and legacy single-format context files as fallbacks.
    """
    candidates: list[str] = []
    task_map = spec.get("lfs_format_templates") or {}
    if isinstance(task_map, dict):
        candidates.append(str(task_map.get(task_id) or ""))

    manifest, _body = parse_prompt_manifest(prompt_text)
    candidates.append(str(manifest.get("lfs_format") or ""))
    candidates.append(extract_intent_format(prompt_text))

    batch_template = str(spec.get("lfs_format_template") or "")
    if batch_template and batch_template.lower() != "mixed":
        candidates.append(batch_template)

    paths = lfs_format_paths(spec)
    if len(paths) == 1:
        candidates.append(paths[0])

    for candidate in candidates:
        path = _lfs_format_path_from_name(candidate)
        if path:
            return path
    return ""


def read_optional_text(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text().strip()


SAFE_FORBIDDEN_REPLACEMENTS = {
    "anti-aging": "age-focused",
    "cure": "overpromise",
    "heal": "comfort",
    "medical": "clinical",
    "dermatologist": "skin expert",
    "prescription": "strong formula",
    "remove wrinkles": "promise too much",
    "removes wrinkles": "promises too much",
    "remove fine lines": "promise too much",
    "removes fine lines": "promises too much",
    "eliminate wrinkles": "promise too much",
    "eliminates wrinkles": "promises too much",
    "get rid of wrinkles": "promise too much",
    "erase wrinkles": "promise too much",
    "erases wrinkles": "promises too much",
    "auto-ship": "repeat purchase",
    "auto-shipping": "repeat purchase",
    "autoship": "repeat purchase",
    "auto-billing": "repeat billing",
    "auto-bill": "repeat billing",
    "subscription": "paid-content charge",
    "subscribe and save": "repeat purchase offer",
    "recurring order": "repeat order",
    "recurring shipment": "repeat shipment",
}


def sanitize_forbidden_outline_terms(text: str, cfg: dict[str, Any]) -> str:
    """Remove product-forbidden vocabulary from generated outline blueprints.

    Outlines are loaded into generation context, so even "do not say X" lines can
    poison scale. The product config owns the forbidden list; this sanitizer
    preserves outline intent while replacing banned tokens with safe role labels.
    """
    forbidden = cfg.get("prompt_context", {}).get("forbidden_phrases", [])
    sanitized = text
    for phrase in sorted({str(p).strip() for p in forbidden if str(p).strip()}, key=len, reverse=True):
        replacement = SAFE_FORBIDDEN_REPLACEMENTS.get(phrase.lower(), "product-safe framing")
        sanitized = re.sub(rf"\b{re.escape(phrase)}\b", replacement, sanitized, flags=re.IGNORECASE)
    return sanitized


def normalize_outline_title(text: str, expected_format_path: str, product: str) -> str:
    expected = Path(expected_format_path).stem.replace("-", " ").strip().title() if expected_format_path else "LFS"
    lines = text.strip().splitlines()
    if not lines:
        return text

    source_angle = f"{expected} Angle"
    first = lines[0].strip()
    for prefix in OUTLINE_TITLE_PREFIXES:
        if first.startswith(prefix):
            raw = first.split(":", 1)[1].strip()
            raw = raw.split("->", 1)[0].strip()
            raw = re.sub(rf"^{re.escape(expected)}\s*/\s*", "", raw, flags=re.IGNORECASE)
            if raw:
                source_angle = raw
            break
    lines[0] = f"{OUTLINE_TITLE_PREFIX} {expected} / {source_angle} -> {product}"
    return "\n".join(lines).strip() + "\n"


def sanitize_outline_meta(text: str) -> str:
    replacements = [
        (r"\bNinety-day\b", "90-day"),
        (r"\b90 day\b", "90-day"),
        (r"\$41\.40\b", "$41.4"),
    ]
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)

    meta_patterns = [
        r"\bThe writer should\b",
        r"\bthe writer writes\b",
        r"\bThis beat\b",
        r"\bThe outline should\b",
        r"\bDo not introduce\b",
        r"\bDo not use\b",
        r"\bOpen with\b",
        r"\bUse the .*? beat here\b",
    ]
    cleaned_lines: list[str] = []
    for line in text.splitlines():
        low = line.strip().lower()
        if low.startswith("do not ") or low.startswith("the writer should") or low.startswith("this beat ") or low.startswith("the outline should"):
            continue
        if any(re.search(pattern, line, re.IGNORECASE) for pattern in meta_patterns):
            continue
        cleaned_lines.append(line)
    text = "\n".join(cleaned_lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def build_mystic_outline_prompt(
    *,
    task_id: str,
    product: str,
    task_prompt: str,
    source_path: Path,
    source_copy: str,
    lfs_format_path: str = "",
    lfs_format_text: str = "",
    dr_system_text: str = "",
    lfs_engine_text: str = "",
    product_facts: str = "",
    mechanism_lock: str = "",
) -> str:
    """Build a compact, contrastive outline prompt.

    This follows the local llm-mystic guidance: specific persona first, data
    before instructions, contrastive near-misses, concrete sensory beats, and a
    final write command.
    """
    return f"""You are an LFS confession architect who still remembers the first ugly, raw Facebook post that beat the polished advertorial 4:1. You do not write strategy memos. You build Long Form Static outlines that a real writer can turn into native copy: friend-to-friend, emotionally causal, and structurally impossible to misunderstand.

Your job is to merge the selected LFS format, the source swipe's pressure curve, and the {product} mechanism into ONE short production blueprint. The outline is the final structural authority for the script: enough to make the order obvious, lean enough that the writer still writes.

DR SYSTEM
<dr_system>
{dr_system_text}
</dr_system>

LFS ENGINE
<lfs_engine>
{lfs_engine_text}
</lfs_engine>

SELECTED LFS FORMAT
Path: {lfs_format_path or "none"}
<lfs_format>
{lfs_format_text}
</lfs_format>

SOURCE SWIPE PATH
{source_path}

SOURCE SWIPE COPY
<source_swipe>
{source_copy}
</source_swipe>

{product} TASK PROMPT
<task_prompt>
{task_prompt}
</task_prompt>

{product} MECHANISM LOCK
<mechanism_lock>
{mechanism_lock}
</mechanism_lock>

{product} PRODUCT FACTS
<product_facts>
{product_facts}
</product_facts>

WHAT A STRONG OUTLINE DOES
It treats LFS as the media container, not a single format. A Long Form Static can be confession, listicle, rant, review, expose, warning, or another native structure.
It obeys the selected LFS format's narrator role, beat sequence, emotional register, and weight distribution.
It preserves the competitor's emotional sequence, pressure curve, reveal timing, failed-solution escalation, mechanism pivot, recovery proof, and offer-close role.
It translates every beat into the {product} mechanism lane from MECHANISM LOCK.
It writes the outline in friend-to-friend story direction, not strategist jargon.
It writes feed-native beat content as short spoken moves. Each beat gives exact story substance.
It keeps the original wound alive after the opener instead of turning the middle into generic education.
It makes the mechanism answer the emotional wound by preserving the locked mechanism name and causal explanation nearly verbatim.
It preserves causal order: pain and failed solutions create the need; discovery/product introduction starts the changed routine; dated recovery proof happens only after that.
It uses only the product price, guarantee, CTA, and failed-solution price anchors from the {product} task prompt or PRODUCT FACTS. Source-swipe prices become generic expensive-product labels unless the task prompt or PRODUCT FACTS explicitly approves them. If PRODUCT FACTS says no dollar amounts are allowed, do not use any $ amount anywhere.
It converts compliance constraints into safe positive language inside the outline. Use phrases like "buyer-facing surface comfort language," "non-clinical role," "appearance-support framing," and "soften the dry look" instead of repeating banned tokens from the task prompt or source swipe.
Forbidden words from the task prompt are forbidden inside the outline too, even inside warnings or "do not" sentences. Convert those constraints into safe positive role labels.
Every line is beat substance: scene, pressure, failed attempt, mechanism turn, proof receipt, or offer role. Process commentary is replaced by the actual story move.

HARD CONTRACT RULES
The task prompt may contain source-material labels such as VERBATIM HOOK, VERBATIM DATED LOG, VERBATIM P.S., DOGWHISTLES, or FAILED SOLUTIONS. Treat those labels as internal raw material only. Do not copy those labels into the outline and do not turn them into headings.
Do not write instructions to the next writer. Banned outline phrasing includes "open with", "use the", "mention", "introduce", "explain", "reveal", "show", "include", "this beat", "the writer should", and "in the final script".
Every beat must be concrete story content, e.g. "She sees the 1,200-calorie log and checks the waistband mark again," not "Open with the calorie hook."
Before any Day/Week/Month/result/proof/recovery/timeline beat, include a product/routine discovery beat that explicitly names {product} or the exact product routine from PRODUCT FACTS. Dated logs are receipts after the routine starts; they are never early structure.

CONTRASTIVE EXAMPLES

Near-miss outline:
Beat 1: She finds paid content on his phone.
Beat 2: She tries products.
Beat 3: Product mechanism helps the visible problem.
Why it fails: it summarizes events but loses the humiliation loop, comparison spiral, failed-solution shame, format shape, and mechanism timing.

Stronger outline:
Beat 1: Discovery creates evidence. The phone charges make her inspect the visible problem as if it explains why he looked elsewhere.
Beat 2: Failed solutions become failed attempts to stop feeling replaceable.
Beat 3: The product mechanism arrives as relief because it explains the visible problem without blaming age, desirability, or discipline.
Why it works: each product-lane beat answers the original wound.

Near-miss outline:
Beat 1: A public proof moment makes her panic.
Beat 2: She tries the familiar expensive fix.
Beat 3: Day 3 the result changes.
Beat 4: Product enters.
Why it fails: the result timeline appears before the reader knows what she found, ordered, started, or changed. The story breaks causality.

Stronger outline:
Beat 1: A public proof moment makes the old explanation feel reasonable.
Beat 2: The familiar expensive fix fails in the same specific way again.
Beat 3: She finds the new-cause idea and starts {product}.
Beat 4: Day 3 is the first tiny result after starting the product.
Why it works: the recovery log is a consequence, not a floating proof module.

Near-miss outline:
Beat 1: Use the competitor's story structure.
Beat 2: Mention the product ingredients.
Why it fails: it is too vague for scale. A writer could generate ten different ads from it.

Stronger outline:
Beat 1: The selected format controls the opening: a listicle promises three mistakes, a rant starts with shared anger, or a confession starts with the private wound.
Beat 2: The source-specific evidence carries the middle: statement, failed bill, hidden charges, phone screen, public scene, private object, comparison moment, receipt, review, or before/after proof.
Beat 3: The product earns its entrance only after the format has made the old explanation feel incomplete.
Why it works: it names the required scene mechanics without copying source wording.

LISTICLE STRUCTURE — NEAR-MISS VS CORRECT
The most common outline failure for listicle-adjacent formats: dated proof entries colonize the middle of the outline before the product exists in the narrator's life.

Near-miss outline:
Beat 1: Wound / pain scene.
Beat 2: Failed solutions.
Beat 3: Day 3, the visible problem starts changing.
Beat 4: Day 14, the proof gets bigger.
Beat 5: How {product} works.
Beat 6: Offer.
Why it fails: proof arrives before discovery, so the reader sees receipts for a routine that has not started yet.

Stronger outline:
Beat 1: Wound / pain scene.
Beat 2: Failed solutions, searched, tried, gave up.
Beat 3: Mechanism revealed: why nothing worked.
Beat 4: Discovery: found {product}, started the routine.
Beat 5: Day 3 to Day 14 to Week 6 proof receipts.
Beat 6: Offer.
Why it works: recovery proof serves as earned receipt, not early structure.

Recovery timeline entries are receipts. Receipts validate a purchase already made in the story. The reader must see the narrator commit before the receipts land.

PRE-MORTEM
Before writing, account for these likely failures:
The outline may flatten a scandal into a normal product problem.
The outline may ignore the selected LFS format and default to confession.
The outline may let the selected format and source swipe fight each other instead of merging them.
The outline may put a Day/Week/Month recovery log before the narrator has started the product or changed the routine.
The outline may create dense blocks that make the final script hard to skim in the feed.
The outline may copy competitor product terms, prices, names, or claims.
The outline may put mechanism too early.
The outline may produce generic "confidence" language instead of concrete objects, locations, receipts, photos, messages, sounds, smells, and witness moments.
The outline may forget the final offer truth from the {product} task prompt.

OUTPUT SHAPE
Write markdown only.
Title: `## LFS V4.1 Format-Merged Outline: <format> / <source angle> -> {product}`
Then 8 to 12 beat sections using this exact heading form: `## Beat N: Short Title`
Total length target: 650 to 1200 words. Dense source swipes can run to 1500 only when the extra detail removes ambiguity.
Each beat must include a short title and 1 to 2 tight paragraphs.
Every beat must name both the format role and the story content, for example: "List item #2: why the familiar fix keeps failing" or "Confession turn: the receipt became evidence."
Write beat content directly. Use story moves like "She finds the receipt and checks the charge on her phone." Do not use task-prompt labels or writer-instruction language.
Use product-safe role labels for competitor details: source brand, competitor supplement, expensive clinic, paid-content platform, younger women, failed products.
Use {product}'s actual product, price, guarantee, CTA, hook, P.S., and P.P.S. only when they appear in the task prompt or PRODUCT FACTS. Use the mechanism from MECHANISM LOCK.
End with a `## Scale Check` section containing these bullets:
- Selected LFS format is obeyed
- Format and source swipe are merged into one structure
- Recovery proof happens after product/routine discovery
- Final script can be read lazily: one thought per paragraph
- Emotional wound stays active beyond opener
- Failed solutions are tied to the wound
- Mechanism answers the wound
- Offer truth uses task prompt only
- Source wording is transformed, not copied

WRITE THE OUTLINE NOW for task `{task_id}`."""


def build_original_outline_prompt(
    *,
    task_id: str,
    product: str,
    task_prompt: str,
    lfs_format_path: str = "",
    lfs_format_text: str = "",
    dr_system_text: str = "",
    lfs_engine_text: str = "",
    product_facts: str = "",
    mechanism_lock: str = "",
) -> str:
    """Build an outline prompt for original concepts with no source swipe."""
    return f"""You are an LFS outline architect who turns a strategist's brief into a production blueprint. You are not writing the ad. You are deciding the order, scenes, pressure curve, product reveal timing, proof sequence, and close logic so the next model can write without drifting.

Your job is to merge the selected LFS format and the {product} task prompt into ONE short production blueprint. The outline is the final structural authority for the script: clear order, clear emotional logic, lean execution.

DR SYSTEM
<dr_system>
{dr_system_text}
</dr_system>

LFS ENGINE
<lfs_engine>
{lfs_engine_text}
</lfs_engine>

SELECTED LFS FORMAT
Path: {lfs_format_path or "none"}
<lfs_format>
{lfs_format_text}
</lfs_format>

{product} TASK PROMPT
<task_prompt>
{task_prompt}
</task_prompt>

{product} MECHANISM LOCK
<mechanism_lock>
{mechanism_lock}
</mechanism_lock>

{product} PRODUCT FACTS
<product_facts>
{product_facts}
</product_facts>

WHAT A STRONG ORIGINAL OUTLINE DOES
It obeys the selected LFS format's narrator role, beat sequence, emotional register, and weight distribution.
It turns every filled prompt slot into beat-level story substance.
It keeps the opener wound alive after the first section.
It ties failed solutions to the emotional wound instead of listing them as random purchases.
It preserves causal order: pain and failed solutions create the need; discovery/product introduction starts the changed routine; dated recovery proof happens only after that.
It introduces the locked mechanism only after the reader understands why the old explanation failed.
It uses concrete objects, locations, receipts, photos, messages, bathroom-light moments, mirror moments, witness lines, and private behaviors.
It uses only the product, price, guarantee, CTA, hook, P.S., and P.P.S. from the task prompt and PRODUCT FACTS. It uses the mechanism from MECHANISM LOCK.

HARD CONTRACT RULES
The task prompt may contain source-material labels such as VERBATIM HOOK, VERBATIM DATED LOG, VERBATIM P.S., DOGWHISTLES, or FAILED SOLUTIONS. Treat those labels as internal raw material only. Do not copy those labels into the outline and do not turn them into headings.
Do not write instructions to the next writer. Banned outline phrasing includes "open with", "use the", "mention", "introduce", "explain", "reveal", "show", "include", "this beat", "the writer should", and "in the final script".
Every beat must be concrete story content, e.g. "She sees the 1,200-calorie log and checks the waistband mark again," not "Open with the calorie hook."
Before any Day/Week/Month/result/proof/recovery/timeline beat, include a product/routine discovery beat that explicitly names {product} or the exact product routine from PRODUCT FACTS. Dated logs are receipts after the routine starts; they are never early structure.

CONTRASTIVE EXAMPLES

Near-miss outline:
Beat 1: She feels bad.
Beat 2: She tries products.
Beat 3: Product helps.
Why it fails: it is too thin for scale. A writer could produce ten different ads from it.

Stronger outline:
Beat 1: The exact wound appears in a believable private scene: object, timestamp, body area, and thought she would not say out loud.
Beat 2: Each failed solution becomes evidence that the old explanation was wrong.
Beat 3: The product enters only after the missing mechanism makes the failures make sense.
Why it works: the writer gets causal sequence, not generic strategy.

Near-miss outline:
Beat 1: Open with the hook.
Beat 2: Day 3 improvement.
Beat 3: Product reveal.
Why it fails: the result timeline appears before the reader knows what she found, ordered, started, or changed.

Stronger outline:
Beat 1: Hook names the wound and why it hurts.
Beat 2: Failed solutions deepen the need.
Beat 3: Discovery/reveal explains the new routine.
Beat 4: Day 3 is the first result after the routine starts.
Why it works: proof is a consequence, not a floating claim.

PRE-MORTEM
Before writing, account for these likely failures:
The outline may ignore the selected LFS format and default to confession.
The outline may put a Day/Week/Month recovery log before product discovery.
The outline may put mechanism too early.
The outline may flatten the emotional wound into generic confidence language.
The outline may create dense blocks that make the final script hard to skim in the feed.
The outline may forget final offer truth from the task prompt.

OUTPUT SHAPE
Write markdown only.
Title: `## LFS V4.1 Format-Merged Outline: <format> / <source angle> -> {product}`
Then 8 to 12 beat sections using this exact heading form: `## Beat N: Short Title`
Total length target: 600 to 1100 words.
Each beat must include a short title and 1 to 2 tight paragraphs.
Every beat must name both the format role and the story content.
Write beat content directly as story moves, not process commentary. Do not use task-prompt labels or writer-instruction language.
End with a `## Scale Check` section containing these bullets:
- Selected LFS format is obeyed
- Format and task prompt are merged into one structure
- Recovery proof happens after product/routine discovery
- Final script can be read lazily: one thought per paragraph
- Emotional wound stays active beyond opener
- Failed solutions are tied to the wound
- Mechanism answers the wound
- Offer truth uses task prompt only

WRITE THE OUTLINE NOW for task `{task_id}`."""


def build_outline_repair_prompt(
    *,
    task_id: str,
    product: str,
    task_prompt: str,
    lfs_format_path: str,
    lfs_format_text: str,
    candidate_outline: str,
    errors: list[str],
    product_facts: str = "",
    mechanism_lock: str = "",
) -> str:
    """Build a focused retry prompt from deterministic outline-contract errors."""
    return f"""You are repairing an LFS V4.1 outline that failed deterministic production checks.

The goal is not a new strategy. Preserve the source angle already present in the outline, keep the selected format, and return a complete corrected outline.

SELECTED LFS FORMAT
Path: {lfs_format_path or "none"}
<lfs_format>
{lfs_format_text}
</lfs_format>

{product} TASK PROMPT
<task_prompt>
{task_prompt}
</task_prompt>

{product} MECHANISM LOCK
<mechanism_lock>
{mechanism_lock}
</mechanism_lock>

{product} PRODUCT FACTS
<product_facts>
{product_facts}
</product_facts>

FAILED OUTLINE
<outline>
{candidate_outline}
</outline>

DETERMINISTIC FAILURES TO FIX
{chr(10).join(f"- {err}" for err in errors)}

TARGETED REPAIR MOVES
FAILURE: Mechanism appears before the wound scene or failed-solution sequence.
REPAIR: Move the mechanism block after the failed-solution sequence. The reader earns the explanation by first feeling the exhaustion of searching.

FAILURE: Dated log entries such as Day, Week, or Month appear before product discovery.
REPAIR: Locate the product-discovery beat. If it is missing, create one before the first dated/proof/timeline beat. The discovery beat must explicitly name {product} or the exact product routine from PRODUCT FACTS. Move all dated entries to a block immediately following it. Name that block Recovery Proof.

FAILURE: The outline contains self-referential writer instructions instead of beat content.
REPAIR: Rewrite every instruction as concrete story substance. "Open with the calorie hook" becomes the actual calorie scene. "Mention the product" becomes the actual discovery/routine scene. "Explain the mechanism" becomes the buyer-facing mechanism turn inside the story.

FAILURE: P.S. copy or price details appear in the wound or mechanism zone.
REPAIR: Strip price and offer language from early zones. Consolidate it into one offer block at the end of the outline.

FAILURE: The outline opens with a positive result before establishing the wound.
REPAIR: Replace the opening with the wound scene. The positive result becomes the closing proof receipt.

REPAIR PRINCIPLES
- Write beat content directly as story substance.
- Preserve causal order: pain/search first, product discovery before dated proof, proof after routine change.
- Keep the selected format's role visible in the title and beats.
- Use the product's actual brand, price, guarantee, CTA, P.S., and P.P.S. only from the task prompt or PRODUCT FACTS.
- Use the mechanism from MECHANISM LOCK. Preserve its name and causal explanation nearly verbatim.
- Convert compliance constraints into product-safe positive role labels.
- Make every beat specific enough that two writers would produce the same ad structure.
- Remove all writer-facing instruction language. No "open with", "use the", "mention", "introduce", "explain", "reveal", "show", "include", "do not", "this beat", "the writer should", or "in the final script" phrasing.
- Do not copy task-prompt labels such as VERBATIM HOOK, VERBATIM DATED LOG, VERBATIM P.S., DOGWHISTLES, or FAILED SOLUTIONS into the outline.
- Use the exact guarantee term from PRODUCT FACTS. Do not substitute another duration.
- The title must start with `## LFS V4.1 Format-Merged Outline:`.

OUTPUT SHAPE
Write markdown only.
Title: `## LFS V4.1 Format-Merged Outline: <format> / <source angle> -> {product}`
Use 8 to 12 beat sections with headings like `## Beat N: Short Title`.
End with `## Scale Check`.

RETURN ONLY THE CORRECTED OUTLINE for task `{task_id}`."""


def call_claude(prompt: str, model: str, *, max_tokens: int = 8000) -> str:
    try:
        import anthropic
    except ImportError as exc:
        raise RuntimeError("anthropic SDK not installed; run `pip install anthropic`") from exc

    client = anthropic.Anthropic(timeout=DEFAULT_REQUEST_TIMEOUT_SECONDS, max_retries=0)
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        temperature=0.2,
        messages=[{"role": "user", "content": prompt}],
    )
    return "\n".join(
        block.text for block in response.content
        if getattr(block, "type", None) == "text" and getattr(block, "text", None)
    ).strip()


def validate_outline_text(text: str) -> list[str]:
    return validate_outline_contract(text)


def _format_name_from_path(path: str | None) -> str:
    if not path:
        return ""
    return Path(path).stem.replace("-", " ").strip().lower()


def _price_strings_from_config(cfg: dict[str, Any] | None) -> list[str]:
    if not cfg:
        return []
    pricing = cfg.get("pricing_rules", {}) or {}
    prices = []
    for phrase in pricing.get("canonical_phrasings", []) or []:
        prices.extend(re.findall(r"\$[\d,]+(?:\.\d{1,2})?", str(phrase)))
    single = pricing.get("single_bag_price_usd")
    if single is not None:
        try:
            prices.append(f"${float(single):.2f}".rstrip("0").rstrip("."))
            prices.append(f"${float(single):.2f}")
        except (TypeError, ValueError):
            pass
    return sorted(set(prices), key=len, reverse=True)


def _guarantee_terms_from_config(cfg: dict[str, Any] | None) -> list[str]:
    if not cfg:
        return []
    terms = []
    pricing = cfg.get("pricing_rules", {}) or {}
    offer = cfg.get("offer_architecture", {}) or {}
    for value in [
        cfg.get("guarantee"),
        pricing.get("guarantee"),
        offer.get("guarantee_framing"),
        *(offer.get("what_you_get", []) or []),
    ]:
        if value:
            terms.append(str(value).lower())
    compact = []
    for term in terms:
        compact.append(term)
        m = re.search(r"\b\d{2,3}-day\b", term)
        if m:
            compact.append(m.group(0))
    return sorted(set(compact), key=len, reverse=True)


def _mechanism_terms_from_config(cfg: dict[str, Any] | None) -> list[str]:
    if not cfg:
        return ["mechanism"]
    terms = ["mechanism"]
    mechanisms = cfg.get("mechanisms", {}) or {}
    for code, mech in mechanisms.items():
        values = [code]
        if isinstance(mech, dict):
            values.extend([
                mech.get("name"),
                mech.get("nickname"),
                mech.get("core_line"),
                mech.get("aha_statement"),
            ])
        for value in values:
            if not value:
                continue
            term = str(value).strip().lower()
            if len(term) < 2:
                continue
            terms.append(term)
    return sorted(set(terms), key=len, reverse=True)


def _product_discovery_terms_from_config(cfg: dict[str, Any] | None) -> list[str]:
    terms = [
        "product enters",
        "product introduction",
        "starts the product",
        "starts the jar",
        "starts the bottle",
        "starts the pan",
        "starts the routine",
        "found the product",
        "finds the product",
        "ordered the product",
        "orders the product",
        "changed the routine",
        "new routine",
    ]
    if not cfg:
        return terms
    product_terms = [
        str(cfg.get("brand") or "").strip().lower(),
        str(cfg.get("product_name") or "").strip().lower(),
    ]
    product_terms.extend(
        str(item.get("name") or "").strip().lower()
        for item in (cfg.get("ingredients", {}) or {}).get("primary", []) or []
        if isinstance(item, dict)
    )
    form = str(cfg.get("form") or "").strip().lower()
    if form:
        product_terms.append(form)
        terms.extend([
            f"starts the {form}",
            f"started the {form}",
            f"uses the {form}",
            f"tries the {form}",
            f"{form} routine",
        ])
        if "dropper" in form:
            terms.extend([
                "the dropper",
                "dropper routine",
                "daily dropper",
                "morning dropper",
                "starts the dropper",
                "started the dropper",
                "uses the dropper",
                "tries the dropper",
            ])
    for product_term in product_terms:
        if not product_term:
            continue
        terms.append(product_term)
        terms.extend([
            f"starts {product_term}",
            f"started {product_term}",
            f"found {product_term}",
            f"finds {product_term}",
            f"ordered {product_term}",
            f"orders {product_term}",
            f"uses {product_term}",
            f"tries {product_term}",
        ])
    return sorted(set(terms), key=len, reverse=True)


def product_facts_block(cfg: dict[str, Any] | None) -> str:
    if not cfg:
        return "No product facts loaded."
    pricing = cfg.get("pricing_rules", {}) or {}
    offer = cfg.get("offer_architecture", {}) or {}
    facts = [
        f"Brand: {cfg.get('brand') or ''}",
        f"Product name: {cfg.get('product_name') or ''}",
    ]
    if pricing.get("single_bag_price_usd"):
        facts.append(f"Price rule: {pricing.get('single_bag_price_usd')}")
    prices = _price_strings_from_config(cfg)
    if prices:
        facts.append(f"Allowed price tokens: {', '.join(prices)}")
    else:
        facts.append("Dollar amount rule: no $ amounts are allowed anywhere in the outline or final script.")
    guarantees = _guarantee_terms_from_config(cfg)
    if guarantees:
        facts.append(f"Guarantee / offer truth: {guarantees[0]}")
    if offer.get("guarantee_framing"):
        facts.append(f"Guarantee framing: {offer.get('guarantee_framing')}")
    canonical = pricing.get("canonical_phrasings") or []
    if canonical:
        facts.append("Canonical offer phrases: " + "; ".join(str(x) for x in canonical))
    return "\n".join(fact for fact in facts if fact.strip())


def mechanism_lock_for_task(base_path: Path, product: str, task_id: str) -> str:
    """Load the exact selected mechanism card for one task."""
    match = MECHANISM_CODE_RE.search(task_id)
    if not match:
        return ""
    mechanism_code = match.group(1)
    research_dir = resolve_product_dir(base_path, product) / "research"
    result = load_card_or_section(
        research_dir,
        group="mechanisms",
        code=mechanism_code,
        source_path=research_dir / "mechanisms.md",
    )
    return result.text.strip()


def _contains_term(text: str, term: str) -> bool:
    if not term:
        return False
    return re.search(rf"(?<!\w){re.escape(term.lower())}(?!\w)", text) is not None


def validate_outline_contract(
    text: str,
    *,
    expected_format_path: str | None = None,
    product_config: dict[str, Any] | None = None,
    max_words: int = 3000,
) -> list[str]:
    errors: list[str] = []
    if not any(prefix in text for prefix in OUTLINE_TITLE_PREFIXES):
        errors.append("missing transcript-derived or v4.1 format-merged title")
    if "## Scale Check" not in text:
        errors.append("missing Scale Check section")
    beat_count = len(re.findall(r"(?m)^## Beat\s+\d+:", text))
    numbered_count = len(re.findall(r"(?m)^##\s+\d+\.", text))
    if max(beat_count, numbered_count) < 8:
        errors.append("fewer than 8 beat sections")
    word_count = len(text.split())
    if word_count < 450:
        errors.append("outline too thin (<450 words)")
    if word_count > max_words:
        errors.append(f"outline too long ({word_count} words > {max_words}; keep it as a production blueprint, not a strategy essay)")

    expected_format = _format_name_from_path(expected_format_path)
    if expected_format:
        title_line = next((ln.strip().lower() for ln in text.splitlines() if ln.startswith(OUTLINE_TITLE_PREFIX)), "")
        if expected_format not in title_line and expected_format not in text[:500].lower():
            errors.append(f"selected format mismatch: expected {expected_format!r} from {expected_format_path}")

    low = text.lower()
    product_terms = []
    if product_config:
        product_terms = [
            str(product_config.get("brand") or "").lower(),
            str(product_config.get("product_name") or "").lower(),
        ]
        product_terms = [term for term in product_terms if term]
        if product_terms and not any(term in low for term in product_terms):
            errors.append("outline missing product reveal/brand truth")
        prices = _price_strings_from_config(product_config)
        if prices and not any(price.lower() in low for price in prices):
            errors.append("outline missing product price truth")
        guarantees = _guarantee_terms_from_config(product_config)
        if guarantees and not any(term in low for term in guarantees):
            errors.append("outline missing guarantee/offer truth")

    meta_patterns = [
        r"\bplan short lines\b",
        r"\buse (?:the )?verbatim\b",
        r"\buse (?:the )?(?:selected )?format\b",
        r"\bopen with\b",
        r"\bmention (?:the|that|how)\b",
        r"\bintroduce (?:the )?(?:product|mechanism|offer)\b",
        r"\bexplain (?:the )?(?:mechanism|product|offer)\b",
        r"\breveal (?:the )?(?:product|mechanism|offer)\b",
        r"\binclude (?:the )?(?:price|guarantee|cta|p\.s\.|hook)\b",
        r"\bin the final script\b",
        r"\bfinal script should\b",
        r"\bkeep this section\b",
        r"\bscript writer\b",
        r"\bthe writer should\b",
    ]
    meta_hits = sorted({pat for pat in meta_patterns if re.search(pat, low)})
    if meta_hits:
        errors.append("outline contains self-referential writer instructions instead of beat content")

    title_re = rf"^(?:{re.escape(OUTLINE_TITLE_PREFIX)}|{re.escape(LEGACY_OUTLINE_TITLE_PREFIX)})[^\n]*"
    body_after_title = re.sub(title_re, "", text, count=1, flags=re.IGNORECASE).lower()
    beat3 = re.search(r"(?mi)^## beat\s+3:", body_after_title)
    early_zone = body_after_title[:beat3.start()] if beat3 else body_after_title[:900]
    mechanism_terms = _mechanism_terms_from_config(product_config)
    if any(_contains_term(early_zone, term) for term in mechanism_terms):
        errors.append("mechanism appears too early; emotional wound/search must earn it before Beat 3")

    recovery_pos = re.search(r"(?mi)^## Beat\s+\d+:.*(?:log|timeline|recovery|result|proof|what changed|transformation)", text)
    if recovery_pos:
        before_recovery = text[:recovery_pos.start()].lower()
        discovery_terms = _product_discovery_terms_from_config(product_config)
        if not any(_contains_term(before_recovery, term) for term in discovery_terms):
            errors.append("recovery/timeline beat appears before product or changed-routine discovery")
    return errors


def generate_outline_for_task(
    *,
    batch_dir: Path,
    base_path: Path,
    task_id: str,
    product: str,
    model: str,
    force: bool,
    dry_run: bool,
    max_attempts: int = 3,
    cancel_event: threading.Event | None = None,
) -> OutlineResult:
    prompt_file = task_prompt_path(batch_dir, task_id)
    out_file = outline_path(batch_dir, task_id)

    if not prompt_file.exists():
        return OutlineResult(task_id, None, str(out_file), "failed", f"missing prompt: {prompt_file}")
    if out_file.exists() and not force and not dry_run:
        return OutlineResult(task_id, None, str(out_file), "skipped", "outline exists; use --force to replace")

    task_prompt = prompt_file.read_text()
    raw_source = extract_source_swipe(task_prompt)
    source_file: Path | None = None
    source_copy = ""
    if raw_source:
        source_file = resolve_source_path(raw_source, base_path)
        if not source_file.exists():
            return OutlineResult(task_id, str(source_file), str(out_file), "failed", "source swipe file not found")
        source_copy = source_file.read_text()

    spec = load_json(batch_dir / "spec.json") if (batch_dir / "spec.json").exists() else {}
    lfs_format_path = lfs_format_path_for_task(spec, task_id, task_prompt)
    if not lfs_format_path:
        return OutlineResult(task_id, str(source_file) if source_file else None, str(out_file), "failed", "missing per-task LFS format routing")
    if not (base_path / lfs_format_path).exists():
        return OutlineResult(
            task_id,
            str(source_file) if source_file else None,
            str(out_file),
            "failed",
            f"LFS format template not found: {lfs_format_path}",
        )
    lfs_format_text = read_optional_text(base_path / lfs_format_path)
    dr_system_text = read_optional_text(base_path / "components" / "dr-system.md")
    lfs_engine_text = read_optional_text(base_path / "components" / "lfs-prompt-engine.md")
    product_config = load_product_config(base_path, product)
    product_facts = product_facts_block(product_config)
    mechanism_lock = mechanism_lock_for_task(base_path, product, task_id)
    if source_file:
        outline_prompt = build_mystic_outline_prompt(
            task_id=task_id,
            product=product,
            task_prompt=task_prompt,
            source_path=source_file,
            source_copy=source_copy,
            lfs_format_path=lfs_format_path,
            lfs_format_text=lfs_format_text,
            dr_system_text=dr_system_text,
            lfs_engine_text=lfs_engine_text,
            product_facts=product_facts,
            mechanism_lock=mechanism_lock,
        )
    else:
        outline_prompt = build_original_outline_prompt(
            task_id=task_id,
            product=product,
            task_prompt=task_prompt,
            lfs_format_path=lfs_format_path,
            lfs_format_text=lfs_format_text,
            dr_system_text=dr_system_text,
            lfs_engine_text=lfs_engine_text,
            product_facts=product_facts,
            mechanism_lock=mechanism_lock,
        )

    if dry_run:
        return OutlineResult(task_id, str(source_file) if source_file else None, str(out_file), "dry_run")

    attempts = max(max_attempts, 1)
    text = ""
    errors: list[str] = []
    for attempt in range(1, attempts + 1):
        if cancel_event is not None and cancel_event.is_set():
            return OutlineResult(
                task_id,
                str(source_file) if source_file else None,
                str(out_file),
                "failed",
                "outline task cancelled after timeout",
                attempts=attempt - 1,
            )
        if attempt == 1:
            text = call_claude(outline_prompt, model)
        else:
            repair_prompt = build_outline_repair_prompt(
                task_id=task_id,
                product=product,
                task_prompt=task_prompt,
                lfs_format_path=lfs_format_path,
                lfs_format_text=lfs_format_text,
                candidate_outline=text,
                errors=errors,
                product_facts=product_facts,
                mechanism_lock=mechanism_lock,
            )
            text = call_claude(repair_prompt, model)
        if cancel_event is not None and cancel_event.is_set():
            return OutlineResult(
                task_id,
                str(source_file) if source_file else None,
                str(out_file),
                "failed",
                "outline task cancelled after timeout",
                attempts=attempt,
            )
        text = normalize_outline_title(text, lfs_format_path, product)
        text = sanitize_forbidden_outline_terms(text, product_config)
        text = sanitize_outline_meta(text)
        errors = validate_outline_contract(
            text,
            expected_format_path=lfs_format_path,
            product_config=product_config,
        )
        if not errors:
            if cancel_event is not None and cancel_event.is_set():
                return OutlineResult(
                    task_id,
                    str(source_file) if source_file else None,
                    str(out_file),
                    "failed",
                    "outline task cancelled after timeout",
                    attempts=attempt,
                )
            out_file.parent.mkdir(parents=True, exist_ok=True)
            out_file.write_text(text.rstrip() + "\n")
            return OutlineResult(
                task_id,
                str(source_file) if source_file else None,
                str(out_file),
                "generated" if attempt == 1 else "repaired",
                attempts=attempt,
            )

    return OutlineResult(
        task_id,
        str(source_file) if source_file else None,
        str(out_file),
        "failed",
        "; ".join(errors),
        attempts=attempts,
    )


def build_outline_report(
    *,
    batch_id: str,
    model: str,
    total_tasks: int,
    results: list[OutlineResult],
    status: str,
    task_timeout_seconds: int,
    timed_out: bool = False,
) -> dict[str, Any]:
    generated = sum(1 for r in results if r.status in {"generated", "repaired"})
    repaired = sum(1 for r in results if r.status == "repaired")
    skipped = sum(1 for r in results if r.status == "skipped")
    dry = sum(1 for r in results if r.status == "dry_run")
    failed = sum(1 for r in results if r.status == "failed")
    return {
        "schema": "lfs-outline-report/v1",
        "batch_id": batch_id,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "model": model,
        "status": status,
        "timed_out": timed_out,
        "task_timeout_seconds": task_timeout_seconds,
        "total_tasks": total_tasks,
        "completed_tasks": len(results),
        "pending_tasks": max(total_tasks - len(results), 0),
        "generated": generated,
        "repaired": repaired,
        "skipped": skipped,
        "dry_run": dry,
        "failed": failed,
        "results": [r.as_dict() for r in sorted(results, key=lambda x: x.task_id)],
    }


def write_outline_report(batch_dir: Path, report: dict[str, Any]) -> None:
    report_file = batch_dir / "lfs-outline-report.json"
    report_file.write_text(json.dumps(report, indent=2) + "\n")


def run_outline_batch(
    batch_id: str,
    *,
    base_path: Path,
    model: str,
    workers: int,
    force: bool,
    dry_run: bool,
    max_attempts: int = 3,
    task_timeout_seconds: int = DEFAULT_TASK_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    batch_dir = resolve_batch_dir(batch_id, base_path=base_path)
    spec_file = batch_dir / "spec.json"
    if not spec_file.exists():
        raise FileNotFoundError(f"missing spec.json: {spec_file}")

    spec = load_json(spec_file)
    task_ids = spec.get("task_ids") or []
    product = str(spec.get("product") or "")
    if not task_ids:
        raise ValueError(f"No task_ids found in {spec_file}")
    if not product:
        raise ValueError(f"No product found in {spec_file}")

    print(f"Generating LFS outlines for '{batch_id}' ({len(task_ids)} tasks, {workers} workers)")
    print(f"Model: {model}")
    if not dry_run:
        print(f"Outline contract attempts: {max(max_attempts, 1)}")

    results: list[OutlineResult] = []
    kwargs = {
        "batch_dir": batch_dir,
        "base_path": base_path,
        "product": product,
        "model": model,
        "force": force,
        "dry_run": dry_run,
        "max_attempts": max_attempts,
    }
    task_timeout_seconds = max(int(task_timeout_seconds), 1)
    report = build_outline_report(
        batch_id=batch_id,
        model=model,
        total_tasks=len(task_ids),
        results=results,
        status="running",
        task_timeout_seconds=task_timeout_seconds,
    )
    write_outline_report(batch_dir, report)
    if workers == 1:
        for task_id in task_ids:
            result = generate_outline_for_task(task_id=task_id, **kwargs)
            results.append(result)
            print_result(result)
            report = build_outline_report(
                batch_id=batch_id,
                model=model,
                total_tasks=len(task_ids),
                results=results,
                status="running",
                task_timeout_seconds=task_timeout_seconds,
            )
            write_outline_report(batch_dir, report)
    else:
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
        cancel_events: dict[concurrent.futures.Future, threading.Event] = {}
        futs: dict[concurrent.futures.Future, str] = {}
        try:
            for task_id in task_ids:
                cancel_event = threading.Event()
                fut = pool.submit(generate_outline_for_task, task_id=task_id, cancel_event=cancel_event, **kwargs)
                futs[fut] = task_id
                cancel_events[fut] = cancel_event

            pending = set(futs)
            last_progress = time.monotonic()
            timed_out = False
            while pending:
                done, pending = concurrent.futures.wait(
                    pending,
                    timeout=1,
                    return_when=concurrent.futures.FIRST_COMPLETED,
                )
                if not done:
                    if time.monotonic() - last_progress >= task_timeout_seconds:
                        timed_out = True
                        for fut in list(pending):
                            cancel_events[fut].set()
                            fut.cancel()
                            result = OutlineResult(
                                futs[fut],
                                None,
                                str(outline_path(batch_dir, futs[fut])),
                                "failed",
                                f"outline task timed out after {task_timeout_seconds}s without batch progress",
                            )
                            results.append(result)
                            print_result(result)
                        pending.clear()
                        report = build_outline_report(
                            batch_id=batch_id,
                            model=model,
                            total_tasks=len(task_ids),
                            results=results,
                            status="failed",
                            task_timeout_seconds=task_timeout_seconds,
                            timed_out=True,
                        )
                        write_outline_report(batch_dir, report)
                        break
                    continue

                last_progress = time.monotonic()
                for fut in done:
                    try:
                        result = fut.result()
                    except Exception as exc:
                        result = OutlineResult(futs[fut], None, str(outline_path(batch_dir, futs[fut])), "failed", str(exc))
                    results.append(result)
                    print_result(result)
                report = build_outline_report(
                    batch_id=batch_id,
                    model=model,
                    total_tasks=len(task_ids),
                    results=results,
                    status="running",
                    task_timeout_seconds=task_timeout_seconds,
                )
                write_outline_report(batch_dir, report)
        except KeyboardInterrupt:
            for fut, cancel_event in cancel_events.items():
                if not fut.done():
                    cancel_event.set()
                    fut.cancel()
                    if fut in futs:
                        results.append(OutlineResult(
                            futs[fut],
                            None,
                            str(outline_path(batch_dir, futs[fut])),
                            "failed",
                            "outline task interrupted before completion",
                        ))
            report = build_outline_report(
                batch_id=batch_id,
                model=model,
                total_tasks=len(task_ids),
                results=results,
                status="interrupted",
                task_timeout_seconds=task_timeout_seconds,
            )
            write_outline_report(batch_dir, report)
            pool.shutdown(wait=False, cancel_futures=True)
            raise
        else:
            pool.shutdown(wait=not timed_out, cancel_futures=True)

    status = "failed" if any(r.status == "failed" for r in results) else "complete"
    timed_out = any(r.error and "timed out" in r.error for r in results)
    report = build_outline_report(
        batch_id=batch_id,
        model=model,
        total_tasks=len(task_ids),
        results=results,
        status=status,
        task_timeout_seconds=task_timeout_seconds,
        timed_out=timed_out,
    )
    report_file = batch_dir / "lfs-outline-report.json"
    write_outline_report(batch_dir, report)
    if not dry_run:
        write_artifact_manifest(batch_dir, batch_id=batch_id, product=product)
    print(f"\nReport saved to: {report_file}")
    print(
        f"Outline complete: {report['generated']} generated ({report['repaired']} repaired), "
        f"{report['skipped']} skipped, {report['dry_run']} dry-run, {report['failed']} failed"
    )
    return report


def print_result(result: OutlineResult) -> None:
    marker = "✓" if result.status in {"generated", "repaired", "dry_run"} else "↷" if result.status == "skipped" else "✗"
    attempt_note = f" attempts={result.attempts}" if result.attempts else ""
    print(f"  {marker} {result.task_id} [{result.status}{attempt_note}]")
    if result.error:
        print(f"    {result.error}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate LFS transcript-derived outlines for a batch")
    parser.add_argument("batch_id", help="Batch identifier under batches/")
    parser.add_argument("--base-path", type=Path, default=REPO, help="Base project path")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Claude model (default: {DEFAULT_MODEL})")
    parser.add_argument("--workers", "-w", type=int, default=4, help="Parallel outline calls (default: 4)")
    parser.add_argument("--force", action="store_true", help="Replace existing outline files")
    parser.add_argument("--dry-run", action="store_true", help="Validate source mapping without calling Claude or writing outlines")
    parser.add_argument("--max-attempts", type=int, default=3, help="Generation + deterministic repair attempts per outline (default: 3)")
    parser.add_argument("--task-timeout-seconds", type=int, default=DEFAULT_TASK_TIMEOUT_SECONDS,
                        help=f"Fail pending outline tasks after this many seconds without progress (default: {DEFAULT_TASK_TIMEOUT_SECONDS})")
    args = parser.parse_args()

    try:
        report = run_outline_batch(
            args.batch_id,
            base_path=args.base_path,
            model=args.model,
            workers=max(args.workers, 1),
            force=args.force,
            dry_run=args.dry_run,
            max_attempts=max(args.max_attempts, 1),
            task_timeout_seconds=max(args.task_timeout_seconds, 1),
        )
    except (FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    if report["failed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()

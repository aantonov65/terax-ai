#!/usr/bin/env python3
"""Generate LFS V4.1 per-task writing prompts from strategist briefs.

This is the stage before `ww lfs-outline` and `ww batch`. Strategists provide
angle data in JSON. Claude turns that data plus product context into the
canonical `components/lfs-briefing-template.md` shape. Preflight then verifies
the saved prompts before any script generation can run.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from compile_spec import compile_spec, load_strategy, task_ids_from_strategy  # noqa: E402
from context import PRODUCT_FOLDERS, extract_section, parse_task_id  # noqa: E402
from lfs_outline import call_claude  # noqa: E402
from preflight import extract_slot, has_slot, parse_prompt_manifest  # noqa: E402
from research_cards import load_card_or_section, load_hotword_card_or_section  # noqa: E402
from strategy_contract import (  # noqa: E402
    blocked_strategy_terms,
    public_batch_context,
    public_task_intent,
    strategy_items,
    task_lfs_format,
    validate_intent_ads,
)
from ww_artifacts import write_artifact_manifest  # noqa: E402
from ww_paths import batch_dir_for_write  # noqa: E402


DEFAULT_MODEL = os.environ.get("LFS_BRIEF_MODEL", "claude-sonnet-4-6")

REQUIRED_SLOTS = [
    "## ANGLE",
    "## OPENER PATTERN",
    "## INTENSITY",
    "## PERSONA",
    "## VERBATIM HOOK",
    "## VERBATIM BRIDGE PHRASE",
    "## VERBATIM DATED LOG",
    "## VERBATIM P.S.",
    "## VERBATIM P.P.S.",
    "## DOGWHISTLES",
    "## FAILED SOLUTIONS",
    "## MECHANISM LOCK",
    "## PATTERN-INTERRUPT SCENE",
    "## INDUSTRY-SUPPRESSION BEAT",
    "## PERMISSION BEAT",
    "## FORBIDDEN FOR THIS ANGLE",
    "## CROSS-REFERENCES",
]


def strip_code_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9_-]*\n", "", text)
        text = re.sub(r"\n```$", "", text)
    return text.strip()


def normalize_generated_prompt(
    text: str,
    *,
    task_id: str,
    product: str,
    concept: str,
    strategist: str,
    lfs_format: str = "",
) -> str:
    """Force the saved prompt into the repo's strict frontmatter contract."""
    text = strip_code_fences(text)
    manifest, body = parse_prompt_manifest(text)
    if not body:
        body = text
    concept_value = str(manifest.get("concept") or concept or task_id.lower())
    strategist_value = str(manifest.get("strategist") or strategist or "codex")
    lfs_format_value = str(manifest.get("lfs_format") or lfs_format or "").strip()
    lfs_format_line = f"lfs_format: {lfs_format_value}\n" if lfs_format_value else ""
    return (
        "---\n"
        f"task_id: {task_id}\n"
        f"concept: {concept_value}\n"
        f"strategist: {strategist_value}\n"
        f"product: {product}\n"
        "format: lfs\n"
        f"{lfs_format_line}"
        "---\n\n"
        f"{body.strip()}\n"
    )


def load_product_config(base_path: Path, product: str) -> dict[str, Any]:
    path = base_path / "products" / PRODUCT_FOLDERS.get(product, product) / "config.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return {}


def _allowed_price_tokens(cfg: dict[str, Any]) -> set[str]:
    prices: set[str] = set()
    pricing = cfg.get("pricing_rules", {}) or {}
    for phrase in pricing.get("canonical_phrasings", []) or []:
        prices.update(re.findall(r"\$[\d,]+(?:\.\d{1,2})?", str(phrase)))
    single = pricing.get("single_bag_price_usd")
    if single is not None:
        try:
            value = float(single)
            prices.add(f"${value:.2f}")
            prices.add(f"${value:.2f}".rstrip("0").rstrip("."))
        except (TypeError, ValueError):
            pass
    return prices


def _canonical_price_token(cfg: dict[str, Any], token: str) -> str | None:
    pricing = cfg.get("pricing_rules", {}) or {}
    canonical_prices: list[str] = []
    for phrase in pricing.get("canonical_phrasings", []) or []:
        canonical_prices.extend(re.findall(r"\$[\d,]+(?:\.\d{1,2})?", str(phrase)))
    single = pricing.get("single_bag_price_usd")
    if single is None:
        return canonical_prices[0] if canonical_prices else None
    try:
        configured = float(single)
        seen = float(token.replace("$", "").replace(",", ""))
    except (TypeError, ValueError):
        return canonical_prices[0] if token in canonical_prices else None
    if abs(configured - seen) > 0.0001:
        return None
    if canonical_prices:
        return canonical_prices[0]
    return f"${configured:.2f}".rstrip("0").rstrip(".")


def sanitize_generated_prompt(text: str, product_config: dict[str, Any]) -> str:
    manifest, body = parse_prompt_manifest(text)
    if not body:
        return text

    forbidden_phrases = [
        str(p).strip()
        for p in ((product_config.get("prompt_context", {}) or {}).get("forbidden_phrases", []) or [])
        if str(p).strip()
    ]
    for phrase in sorted(set(forbidden_phrases), key=len, reverse=True):
        body = re.sub(rf"\b{re.escape(phrase)}\b", "restricted ingredient", body, flags=re.IGNORECASE)

    allowed_prices = _allowed_price_tokens(product_config)

    def replace_price(match: re.Match[str]) -> str:
        token = match.group(0)
        canonical = _canonical_price_token(product_config, token)
        if canonical:
            return canonical
        return token if token in allowed_prices else "premium spend"

    body = re.sub(r"\$[\d,]+(?:\.\d{1,2})?", replace_price, body)
    body = re.sub(r"\bNinety-day\b", "90-day", body, flags=re.IGNORECASE)

    return (
        "---\n"
        + "\n".join(f"{k}: {v}" for k, v in manifest.items())
        + "\n---\n\n"
        + body.strip()
        + "\n"
    )


def force_mechanism_lock(text: str, mechanism: str) -> str:
    """Make the saved prompt carry the exact selected mechanism card."""
    mechanism = mechanism.strip()
    if not mechanism:
        return text
    manifest, body = parse_prompt_manifest(text)
    if not body:
        return text

    replacement = f"## MECHANISM LOCK\n{mechanism}\n"
    slot_re = re.compile(
        rf"^{re.escape('## MECHANISM LOCK')}[^\n]*\n.*?(?=\n## PATTERN-INTERRUPT SCENE(?:\s|\(|$)|\Z)",
        re.DOTALL | re.MULTILINE,
    )
    if slot_re.search(body):
        body = slot_re.sub(replacement.rstrip(), body)
    else:
        anchor = re.search(r"^## PATTERN-INTERRUPT SCENE(?:\s|\(|$)", body, re.MULTILINE)
        if anchor:
            body = body[:anchor.start()].rstrip() + "\n\n" + replacement + "\n" + body[anchor.start():].lstrip()
        else:
            body = body.rstrip() + "\n\n" + replacement

    return (
        "---\n"
        + "\n".join(f"{k}: {v}" for k, v in manifest.items())
        + "\n---\n\n"
        + body.strip()
        + "\n"
    )


@dataclass
class BriefResult:
    task_id: str
    prompt_path: str
    status: str
    error: str | None = None
    attempts: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "prompt_path": self.prompt_path,
            "status": self.status,
            "error": self.error,
            "attempts": self.attempts,
        }


def product_dir(base_path: Path, product: str) -> Path:
    return base_path / "products" / PRODUCT_FOLDERS.get(product, product)


def read_optional(path: Path) -> str:
    return path.read_text().strip() if path.exists() else ""


def load_product_context(base_path: Path, product: str, task_id: str) -> dict[str, str]:
    parsed = parse_task_id(task_id)
    pdir = product_dir(base_path, product)
    cfg = read_optional(pdir / "config.json")
    research_dir = pdir / "research"
    archetypes = read_optional(research_dir / "archetypes.md")
    hotwords = read_optional(research_dir / "hotwords.md")
    mechanisms = read_optional(research_dir / "mechanisms.md")

    archetype = load_card_or_section(
        research_dir,
        group="archetypes",
        code=parsed.archetype_code,
        source_path=research_dir / "archetypes.md",
    ).text or extract_section(archetypes, parsed.archetype_code)
    hotword_a = load_hotword_card_or_section(
        research_dir,
        code=parsed.a_point,
        mechanism_code=parsed.mechanism_code,
        archetype_code=parsed.archetype_code,
        source_path=research_dir / "hotwords.md",
    ).text or extract_section(hotwords, parsed.a_point)
    hotword_b = load_hotword_card_or_section(
        research_dir,
        code=parsed.b_point,
        mechanism_code=parsed.mechanism_code,
        archetype_code=parsed.archetype_code,
        source_path=research_dir / "hotwords.md",
    ).text or extract_section(hotwords, parsed.b_point)
    mechanism = load_card_or_section(
        research_dir,
        group="mechanisms",
        code=parsed.mechanism_code,
        source_path=research_dir / "mechanisms.md",
    ).text or extract_section(mechanisms, parsed.mechanism_code)

    return {
        "config_json": cfg,
        "archetype": archetype,
        "hotword_a": hotword_a,
        "hotword_b": hotword_b,
        "mechanism": mechanism,
    }


def angle_for_task(strategy: dict[str, Any], task_id: str) -> dict[str, Any]:
    for item in strategy_items(strategy):
        if item.get("task_id") == task_id:
            return item
    return {"task_id": task_id}


def validate_strategy_mechanisms_available(strategy: dict[str, Any], base_path: Path, product: str) -> list[str]:
    """Ensure explicit strategy mechanism choices resolve to product research."""
    errors: list[str] = []
    research_dir = product_dir(base_path, product) / "research"
    for item in strategy_items(strategy):
        mechanism = str(item.get("mechanism") or "").strip()
        task_id = str(item.get("task_id") or "").strip()
        if not mechanism:
            continue
        result = load_card_or_section(
            research_dir,
            group="mechanisms",
            code=mechanism,
            source_path=research_dir / "mechanisms.md",
        )
        legacy_text = extract_section(read_optional(research_dir / "mechanisms.md"), mechanism)
        if not result.text and not legacy_text:
            label = task_id or "<unknown task>"
            errors.append(f"{label}: mechanism {mechanism!r} is not available in product mechanism cards/research")
    return errors


def build_lfs_brief_prompt(
    *,
    strategy: dict[str, Any],
    task_id: str,
    angle: dict[str, Any],
    spec: dict[str, Any],
    product_context: dict[str, str],
    briefing_template: str,
    sop: str,
    lfs_format: str,
    format_text: str,
) -> str:
    product = spec["product"]
    batch_context = public_batch_context(strategy, spec)
    task_intent = public_task_intent(strategy, angle, spec)
    return f"""You are the LFS prompt-writer.

You write the per-task generation prompt that will be saved at `batches/{{BATCH}}/prompts/{{TASK_ID}}.md`.

Your job is to translate a strategist's intent card into concrete prompt slots for a later script writer.

The strategist gives WHAT to write: angle, format, mechanism, source, and edge.
You write HOW the later model should open, bridge, prove, and close.

PRODUCT CONTEXT
<config_json>
{product_context.get("config_json", "")}
</config_json>

RELEVANT ARCHETYPE
<archetype>
{product_context.get("archetype", "")}
</archetype>

RELEVANT HOTWORDS
<hotword_a>
{product_context.get("hotword_a", "")}
</hotword_a>
<hotword_b>
{product_context.get("hotword_b", "")}
</hotword_b>

RELEVANT MECHANISM
<mechanism>
{product_context.get("mechanism", "")}
</mechanism>

SELECTED LFS FORMAT
Name: {lfs_format}
<format>
{format_text}
</format>

CANONICAL BRIEFING TEMPLATE
<briefing_template>
{briefing_template}
</briefing_template>

LFS V4.1 SOP EXCERPT
<sop>
{sop}
</sop>

BATCH CONTEXT
<batch>
{json.dumps(batch_context, indent=2)}
</batch>

CREATIVE INTENT CARD
<intent>
{json.dumps(task_intent, indent=2)}
</intent>

WHAT COULD GO WRONG
Near-miss: you write a final ad instead of a generation prompt.
Correct: you write the prompt slots that force the later writer to open, bridge, prove, and close correctly.

Near-miss: you preserve the template headings but fill them with vague labels like "emotional moment" or "mention mechanism."
Correct: every slot contains concrete task-specific material: the wound noun, scene, failed solutions, mechanism lock, dogwhistles, and offer truth.

Near-miss: you summarize the selected mechanism into a new metaphor, payoff line, or ingredient list.
Correct: the `## MECHANISM LOCK` slot pastes the selected mechanism card itself. This is the fixed product mechanism for the ad. The later writer may make the surrounding story fit the angle, but the mechanism name and causal explanation stay nearly verbatim.

Near-miss: you copy a product-specific example from docs or a previous product.
Correct: you use only this product's config, research, strategist brief, and selected format.

Near-miss: you include universal writing philosophy in the prompt.
Correct: universal philosophy stays in context files. This file contains only task-specific commitments.

Near-miss: you paste a planner label into buyer-facing slots, like "Clinical claim ceiling."
Correct: you translate the intent into a human line, like "the day I realized all the study-backed hair products were still leaving my drain full."

Near-miss: the `## VERBATIM HOOK`, `## VERBATIM DATED LOG`, or `## VERBATIM P.S.` sounds like a concept title.
Correct: each verbatim slot sounds like a real person talking from inside the scene.

STRUCTURAL GRAVITY OF SOURCE FIELDS
VERBATIM DATED LOG entries belong in the recovery proof zone, after the reader has witnessed the narrator discover the product and commit to the routine. The dated log is the evidence that the commitment paid off, not the story's opening structure.

VERBATIM P.S. copy carries the price and offer. Place it in the offer section of the outline, not in the wound or mechanism zones.

When writing the OUTLINE INTENT section of the brief, assign each source field to its structural home:

| Field | Structural home |
| --- | --- |
| VERBATIM HOOK | Opening scene |
| VERBATIM DATED LOG | Recovery proof after product reveal |
| VERBATIM P.S. | Offer / CTA block |
| MECHANISM LOCK | Explanation phase after failed search |

OUTPUT CONTRACT
Return markdown only.
Start with strict frontmatter:
---
task_id: {task_id}
concept: <stable_concept_slug>
strategist: <name_from_strategy_or_brief>
product: {product}
format: lfs
lfs_format: {lfs_format}
---

Then write every required slot from the canonical briefing template in the same order:
{chr(10).join(REQUIRED_SLOTS)}

If the task has a source swipe path, include it as:
## SOURCE SWIPE
<path>

Use the selected format, angle, and mechanism to fill the slots. The angle is intent, not copy to paste. Planner labels stay in analysis; buyer-facing slots use scene language a real customer would say.

OUTPUT GUARDRAILS
- Keep every forbidden phrase confined to the dedicated `## FORBIDDEN FOR THIS ANGLE` slot.
- Keep product-disallowed ingredient debates or comparisons out of mechanism, cross-reference, example, and warning slots.
- Use only the product's canonical price as a dollar amount.
- For historical failed-solution spend, use `premium spend`, `hundreds spent`, or `expensive stack`.
- Cross-references summarize research lanes with safe buyer-facing labels and canonical offer truth.

WRITE THE COMPLETE PER-TASK LFS V4.1 PROMPT NOW for `{task_id}`."""


def validate_generated_prompt(
    text: str,
    task_id: str,
    product: str,
    blocked_terms: list[str] | None = None,
    expected_lfs_format: str | None = None,
) -> list[str]:
    errors: list[str] = []
    manifest, body = parse_prompt_manifest(text)
    if manifest.get("task_id") != task_id:
        errors.append(f"frontmatter task_id must be {task_id}")
    if manifest.get("product") != product:
        errors.append(f"frontmatter product must be {product}")
    if str(manifest.get("format", "")).lower() != "lfs":
        errors.append("frontmatter format must be lfs")
    if expected_lfs_format is not None and manifest.get("lfs_format") != expected_lfs_format:
        errors.append(f"frontmatter lfs_format must be {expected_lfs_format}")
    missing = [slot for slot in REQUIRED_SLOTS if not has_slot(body, slot)]
    if missing:
        errors.append("missing slots: " + ", ".join(slot.replace("## ", "") for slot in missing))
    empty = [slot for slot in REQUIRED_SLOTS if has_slot(body, slot) and not extract_slot(body, slot)]
    if empty:
        errors.append("empty slots: " + ", ".join(slot.replace("## ", "") for slot in empty))
    positions = []
    for slot in REQUIRED_SLOTS:
        match = re.search(rf"^{re.escape(slot)}(?:\s|\(|$)", body, re.MULTILINE)
        positions.append(match.start() if match else -1)
    if positions != sorted(positions):
        errors.append("required slots are out of order")
    if re.search(r"\bTODO|TBD|TK|FIXME|LOREM IPSUM\b", body, re.IGNORECASE):
        errors.append("unfinished marker found")
    if blocked_terms:
        buyer_slots = [
            "## VERBATIM HOOK",
            "## VERBATIM BRIDGE PHRASE",
            "## VERBATIM DATED LOG",
            "## VERBATIM P.S.",
            "## VERBATIM P.P.S.",
            "## PATTERN-INTERRUPT SCENE",
        ]
        buyer_text = "\n\n".join(extract_slot(body, slot) for slot in buyer_slots if has_slot(body, slot))
        for term in blocked_terms:
            if re.search(rf"\b{re.escape(term)}\b", buyer_text, re.IGNORECASE):
                errors.append(f"internal strategist label leaked into buyer-facing slots: {term}")
    return errors


def build_repair_prompt(candidate: str, errors: list[str], original_prompt: str, task_id: str) -> str:
    return f"""Repair this LFS V4.1 per-task prompt. Preserve the task strategy and concrete details. Fix only the deterministic failures.

DETERMINISTIC FAILURES
{chr(10).join(f"- {err}" for err in errors)}

ORIGINAL PROMPT-WRITER CONTEXT
<original_prompt>
{original_prompt}
</original_prompt>

FAILED CANDIDATE
<candidate>
{candidate}
</candidate>

OUTPUT GUARDRAILS
- Keep every forbidden phrase confined to `## FORBIDDEN FOR THIS ANGLE`.
- Use only the product's canonical price as a dollar amount.
- Replace stray competitor or research prices with `premium spend` or `hundreds spent`.

Return the complete corrected markdown prompt only for `{task_id}`."""


def generate_brief_for_task(
    *,
    strategy: dict[str, Any],
    spec: dict[str, Any],
    task_id: str,
    batch_dir: Path,
    base_path: Path,
    model: str,
    force: bool,
    dry_run: bool,
    max_attempts: int,
) -> BriefResult:
    out_path = batch_dir / "prompts" / f"{task_id}.md"
    if out_path.exists() and not force and not dry_run:
        return BriefResult(task_id, str(out_path), "skipped", "prompt exists; use --force to replace")

    product = spec["product"]
    angle = angle_for_task(strategy, task_id)
    blocked_terms = blocked_strategy_terms(strategy, angle)
    product_config = load_product_config(base_path, product)
    briefing_template = read_optional(base_path / "components" / "lfs-briefing-template.md")
    sop = read_optional(base_path / "components" / "briefings" / "lfs-v4.1-sop.md")
    selected_lfs_format = task_lfs_format(strategy, angle)
    format_path = f"components/lfs-formats/{selected_lfs_format}.md"
    if not (base_path / format_path).exists():
        format_path = next(
            (
                str(p)
                for p in spec.get("context_files", [])
                if str(p).startswith("components/lfs-formats/")
                and Path(str(p)).stem == selected_lfs_format
            ),
            "",
        )
    if not format_path or not (base_path / format_path).exists():
        return BriefResult(
            task_id,
            str(out_path),
            "failed",
            f"missing LFS format template for {selected_lfs_format!r}",
        )
    format_text = read_optional(base_path / format_path)
    product_context = load_product_context(base_path, product, task_id)
    prompt = build_lfs_brief_prompt(
        strategy=strategy,
        task_id=task_id,
        angle=angle,
        spec=spec,
        product_context=product_context,
        briefing_template=briefing_template,
        sop=sop,
        lfs_format=selected_lfs_format,
        format_text=format_text,
    )

    if dry_run:
        return BriefResult(task_id, str(out_path), "dry_run")

    attempts = max(max_attempts, 1)
    text = ""
    errors: list[str] = []
    for attempt in range(1, attempts + 1):
        text = call_claude(
            prompt if attempt == 1 else build_repair_prompt(text, errors, prompt, task_id),
            model,
            max_tokens=6000,
            stage="lfs_brief",
        )
        text = normalize_generated_prompt(
            text,
            task_id=task_id,
            product=product,
            concept=str(angle.get("concept") or task_id.lower()),
            strategist=str(angle.get("strategist") or strategy.get("strategist") or "codex"),
            lfs_format=selected_lfs_format,
        )
        text = sanitize_generated_prompt(text, product_config)
        text = force_mechanism_lock(text, product_context.get("mechanism", ""))
        text = sanitize_generated_prompt(text, product_config)
        errors = validate_generated_prompt(
            text,
            task_id,
            product,
            blocked_terms,
            expected_lfs_format=selected_lfs_format,
        )
        if not errors:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(text.rstrip() + "\n")
            return BriefResult(task_id, str(out_path), "generated", attempts=attempt)
    return BriefResult(task_id, str(out_path), "failed", "; ".join(errors), attempts=attempts)


def run_lfs_brief(
    strategy_path: Path,
    *,
    base_path: Path,
    batch_id: str | None = None,
    model: str = DEFAULT_MODEL,
    workers: int = 4,
    force: bool = False,
    dry_run: bool = False,
    max_attempts: int = 3,
    write_spec: bool = True,
    task_filter: list[str] | None = None,
) -> dict[str, Any]:
    strategy = load_strategy(strategy_path)
    contract_errors = validate_intent_ads(strategy)
    if contract_errors:
        raise ValueError("Invalid strategy ads contract: " + "; ".join(contract_errors))
    spec = compile_spec(strategy, batch_id)
    mechanism_errors = validate_strategy_mechanisms_available(strategy, base_path, spec["product"])
    if mechanism_errors:
        raise ValueError("Invalid strategy mechanism selection: " + "; ".join(mechanism_errors))
    batch_dir = batch_dir_for_write(
        base_path=base_path,
        batch_id=spec["batch_id"],
        product=spec["product"],
        source_path=strategy_path,
    )
    if write_spec and not dry_run:
        batch_dir.mkdir(parents=True, exist_ok=True)
        spec_path = batch_dir / "spec.json"
        if spec_path.exists() and not force:
            existing = json.loads(spec_path.read_text())
            if existing != spec:
                raise ValueError(f"refusing to overwrite different spec.json: {spec_path}; use --force")
        else:
            spec_path.write_text(json.dumps(spec, indent=2) + "\n")

    task_ids = filter_task_ids(task_ids_from_strategy(strategy), task_filter)
    print(f"Generating LFS V4.1 prompts for '{spec['batch_id']}' ({len(task_ids)} tasks, {workers} workers)")
    print(f"Model: {model}")

    results: list[BriefResult] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(workers, 1)) as pool:
        futures = [
            pool.submit(
                generate_brief_for_task,
                strategy=strategy,
                spec=spec,
                task_id=task_id,
                batch_dir=batch_dir,
                base_path=base_path,
                model=model,
                force=force,
                dry_run=dry_run,
                max_attempts=max_attempts,
            )
            for task_id in task_ids
        ]
        for fut in concurrent.futures.as_completed(futures):
            result = fut.result()
            results.append(result)
            icon = "✓" if result.status in {"generated", "dry_run", "skipped"} else "✗"
            detail = f" [{result.status}]"
            if result.attempts:
                detail += f" attempts={result.attempts}"
            if result.error:
                detail += f" — {result.error}"
            print(f"  {icon} {result.task_id}{detail}")

    report = {
        "schema": "lfs-brief-report/v1",
        "batch_id": spec["batch_id"],
        "model": model,
        "dry_run": dry_run,
        "task_filter": task_filter or [],
        "generated": sum(1 for r in results if r.status == "generated"),
        "skipped": sum(1 for r in results if r.status == "skipped"),
        "failed": sum(1 for r in results if r.status == "failed"),
        "results": [r.as_dict() for r in sorted(results, key=lambda r: r.task_id)],
    }
    if not dry_run:
        batch_dir.mkdir(parents=True, exist_ok=True)
        (batch_dir / "lfs-brief-report.json").write_text(json.dumps(report, indent=2) + "\n")
        write_artifact_manifest(batch_dir, batch_id=spec["batch_id"], product=spec["product"])
    return report


def filter_task_ids(task_ids: list[str], task_filter: list[str] | None) -> list[str]:
    if not task_filter:
        return list(task_ids)
    allowed = {item.strip() for item in task_filter if item and item.strip()}
    missing = sorted(allowed.difference(task_ids))
    if missing:
        raise ValueError(f"Unknown task_id(s) for strategy: {', '.join(missing)}")
    return [task_id for task_id in task_ids if task_id in allowed]


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate LFS V4.1 per-task prompts from a strategist JSON")
    parser.add_argument("strategy", type=Path, help="Strategist JSON with batch metadata and ads[] intent cards")
    parser.add_argument("--batch-id", help="Override batch_id from strategy")
    parser.add_argument("--base-path", "-b", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Claude model (default: {DEFAULT_MODEL})")
    parser.add_argument("--workers", "-w", type=int, default=4)
    parser.add_argument("--force", action="store_true", help="Replace existing prompts/spec")
    parser.add_argument("--dry-run", action="store_true", help="Validate strategy and print planned work without API calls")
    parser.add_argument("--max-attempts", type=int, default=3, help="Generation + repair attempts per prompt")
    parser.add_argument("--task-id", dest="task_ids", action="append",
                        help="Only generate this task id. May be passed more than once.")
    args = parser.parse_args()
    try:
        report = run_lfs_brief(
            args.strategy,
            base_path=args.base_path,
            batch_id=args.batch_id,
            model=args.model,
            workers=args.workers,
            force=args.force,
            dry_run=args.dry_run,
            max_attempts=args.max_attempts,
            task_filter=args.task_ids,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0 if report["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

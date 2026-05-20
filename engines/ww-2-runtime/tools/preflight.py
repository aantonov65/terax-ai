#!/usr/bin/env python3
"""
WW-2 Pre-flight Checklist — aviation-grade verification before generation or upload.

Checks EVERYTHING that could fail at runtime, catches it BEFORE you waste time.

Usage:
    python preflight.py <batch_id>
    python preflight.py <batch_id> --upload     # Also check upload readiness
    python preflight.py <batch_id> --meta       # Also check META upload readiness
    ww preflight <batch_id>
"""

import json
import re
import sys
import argparse
import requests
from pathlib import Path

# Import shared mappings
sys.path.insert(0, str(Path(__file__).parent))
from context import PRODUCT_FOLDERS, VIDMOD_FRAMEWORKS, parse_task_id
from format_contracts import LFS_NATIVE
from lfs_outline import lfs_format_path_for_task, validate_outline_contract
from research_cards import load_card_or_section, load_hotword_card_or_section
from ww_paths import resolve_batch_dir


class CheckResult:
    """Result of a single check."""
    def __init__(self, status: str, label: str, detail: str = ""):
        self.status = status  # "ok", "warn", "fail"
        self.label = label
        self.detail = detail

    def __str__(self):
        icons = {"ok": "\033[32m✓\033[0m", "warn": "\033[33m⚠\033[0m", "fail": "\033[31m✗\033[0m"}
        icon = icons.get(self.status, "?")
        line = f"  {icon} {self.label}"
        if self.detail:
            line += f"\n      {self.detail}"
        return line


def parse_prompt_manifest(body: str) -> tuple[dict[str, str], str]:
    """Parse strict key/value frontmatter from a per-task LFS prompt."""
    if not body.startswith("---\n"):
        return {}, body
    end = body.find("\n---", 4)
    if end == -1:
        return {}, body
    raw = body[4:end]
    rest = body[end + 4:].lstrip("\n")
    manifest: dict[str, str] = {}
    for line in raw.splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        manifest[key.strip()] = value.strip().strip('"').strip("'")
    return manifest, rest


def canonical_prices_from_config(config: dict) -> set[str]:
    prices = set()
    for phrasing in config.get("pricing_rules", {}).get("canonical_phrasings", []):
        prices.update(re.findall(r"\$[\d,]+(?:\.\d{1,2})?", str(phrasing)))
    for anchor in config.get("offer_architecture", {}).get("price_anchor_stack", []):
        prices.update(re.findall(r"\$[\d,]+(?:\.\d{1,2})?", str(anchor)))
    return prices


def normalize_slot_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def extract_slot(body: str, header: str) -> str:
    match = re.search(rf"^{re.escape(header)}[^\n]*\n(.+?)(?=\n## |\Z)", body, re.DOTALL | re.MULTILINE)
    return match.group(1).strip() if match else ""


def has_slot(body: str, header: str) -> bool:
    return re.search(rf"^{re.escape(header)}(?:\s|\(|$)", body, re.MULTILINE) is not None


def remove_slot(body: str, header: str) -> str:
    """Remove one markdown slot from a prompt body before linting surrounding instructions."""
    return re.sub(rf"^{re.escape(header)}[^\n]*\n.+?(?=\n## |\Z)", "", body, flags=re.DOTALL | re.MULTILINE)


def check_spec(batch_dir: Path) -> tuple[dict | None, list[CheckResult]]:
    """Check batch spec.json exists and is valid."""
    results = []
    spec_file = batch_dir / "spec.json"

    if not spec_file.exists():
        results.append(CheckResult("fail", "spec.json", f"Not found: {spec_file}"))
        return None, results

    try:
        spec = json.loads(spec_file.read_text())
    except json.JSONDecodeError as e:
        results.append(CheckResult("fail", "spec.json", f"Invalid JSON: {e}"))
        return None, results

    results.append(CheckResult("ok", "spec.json", f"Found"))

    # Check task_ids
    task_ids = spec.get("task_ids", [])
    if not task_ids:
        results.append(CheckResult("fail", "task_ids", "Empty — no tasks to generate"))
    else:
        results.append(CheckResult("ok", "task_ids", f"{len(task_ids)} tasks"))

    # Validate each task_id using the canonical parser (single source of truth)
    bad_ids = []
    for tid in task_ids:
        try:
            parse_task_id(tid)
        except ValueError as e:
            bad_ids.append((tid, str(e)))

    if bad_ids:
        for tid, err in bad_ids[:3]:
            results.append(CheckResult("fail", f"task_id: {tid}", err))
        if len(bad_ids) > 3:
            results.append(CheckResult("fail", f"...and {len(bad_ids)-3} more invalid task IDs"))
    else:
        results.append(CheckResult("ok", "task_id format", "All valid"))

    # Check cta_text
    if spec.get("cta_text"):
        results.append(CheckResult("ok", "cta_text", f"{len(spec['cta_text'])} chars"))
    else:
        results.append(CheckResult("warn", "cta_text", "Missing — will use generic CTA template"))

    # Check headline (needed for meta-upload)
    if spec.get("headline"):
        results.append(CheckResult("ok", "headline", f"'{spec['headline'][:50]}...'"))
    else:
        results.append(CheckResult("warn", "headline", "Missing — required for meta-upload"))

    return spec, results


def check_context_references(spec: dict, task_ids: list[str], base_path: Path) -> list[CheckResult]:
    """
    Validate the context_files reference graph.

    Fails loud when a file loaded into context references another `components/*.md`
    file (in backticks) that is NOT loaded. Catches the silent-failure mode where
    the engine says "see components/hook-modular.md" but spec.json forgets to list it.

    Auto-loaded files (from FORMAT_CANONICAL_FILES in context.py) are treated as listed.
    """
    results = []

    # Determine what WILL be loaded (spec context_files + format-driven auto-loads)
    FORMAT_CANONICAL_FILES = {
        "lfs": [
            "components/dr-opener-primal-recognition.md",
        ],
        "modv": [
            "components/hook-modular.md",
        ],
    }

    listed = list(spec.get("context_files", []) or [])

    # Add auto-loads for each format appearing in the batch
    formats_in_batch = set()
    for tid in task_ids:
        try:
            formats_in_batch.add(parse_task_id(tid).format)
        except ValueError:
            continue
    for fmt in formats_in_batch:
        for f in FORMAT_CANONICAL_FILES.get(fmt, []):
            if f not in listed:
                listed.append(f)

    if not listed:
        return results  # nothing to validate

    # Scan loaded files for backtick-wrapped `components/*.md` references.
    # Backtick scoping avoids prose mentions — only canonical refs count.
    ref_pattern = re.compile(r"`(components/[\w\-/]+\.md)`")
    all_refs: dict[str, list[str]] = {}  # ref_path → [files that reference it]

    for cf in listed:
        fp = base_path / cf
        if not fp.exists():
            results.append(CheckResult("fail", f"context_file: {cf}", "Listed but not on disk"))
            continue
        text = fp.read_text()
        for ref in set(ref_pattern.findall(text)):
            if ref == cf:
                continue  # self-reference, skip
            all_refs.setdefault(ref, []).append(cf)

    # Any ref not in listed = broken reference graph
    missing = {r: srcs for r, srcs in all_refs.items() if r not in listed}

    if missing:
        for ref, sources in sorted(missing.items()):
            # Only fail for files that actually exist on disk (otherwise it's a typo, separate issue)
            if (base_path / ref).exists():
                src_list = ", ".join(sources)
                results.append(CheckResult(
                    "fail",
                    f"reference graph: {ref}",
                    f"Referenced by [{src_list}] but not in context_files or format auto-load"
                ))
            else:
                results.append(CheckResult(
                    "warn",
                    f"reference graph: {ref}",
                    f"Referenced by [{', '.join(sources)}] but file does not exist on disk"
                ))
    else:
        results.append(CheckResult(
            "ok",
            "reference graph",
            f"{len(listed)} context file(s) loaded, all cross-references resolved"
        ))

    return results


def check_product(product_code: str, base_path: Path) -> list[CheckResult]:
    """Check product files exist and are valid."""
    results = []

    product_folder = PRODUCT_FOLDERS.get(product_code, product_code)
    product_path = base_path / "products" / product_folder

    if not product_path.exists():
        results.append(CheckResult("fail", f"Product folder: {product_folder}/",
                                   f"Not found. Code '{product_code}' maps to folder '{product_folder}'"))
        return results

    results.append(CheckResult("ok", f"Product folder: {product_folder}/"))

    # config.json
    config_file = product_path / "config.json"
    if config_file.exists():
        try:
            config = json.loads(config_file.read_text())
            name = config.get("product_name", "?")
            demo = config.get("target_demographic", {})
            gender = demo.get("gender", "?")
            age = demo.get("age_range", "?")
            results.append(CheckResult("ok", "config.json", f"{name} ({gender}, {age})"))

            # Check forbidden phrases
            forbidden = config.get("prompt_context", {}).get("forbidden_phrases", [])
            if forbidden:
                results.append(CheckResult("ok", "forbidden_phrases", f"{len(forbidden)} rules"))
            else:
                results.append(CheckResult("warn", "forbidden_phrases", "None set — risky for compliance"))

            # Product contract — required for the auto-appended invariants footer to inject
            # price + offer discipline into per-task prompts. When these are missing the
            # substitution returns "" silently and the model hallucinates prices.
            pricing = config.get("pricing_rules") or {}
            if pricing.get("single_bag_price_usd") is not None and pricing.get("canonical_phrasings"):
                price_value = pricing["single_bag_price_usd"]
                price_label = f"${price_value}" if isinstance(price_value, (int, float)) else str(price_value)
                results.append(CheckResult("ok", "pricing_rules", f"{price_label}, {len(pricing.get('canonical_phrasings', []))} canonical phrasings"))
            else:
                results.append(CheckResult("fail", "pricing_rules", "Missing or incomplete — model will hallucinate prices. Required keys: single_bag_price_usd, canonical_phrasings, pricing_rules_positive."))

            offer = config.get("offer_architecture") or {}
            if offer.get("what_you_get") and offer.get("price_anchor_stack"):
                results.append(CheckResult("ok", "offer_architecture", f"{len(offer['what_you_get'])} value-stack items, {len(offer['price_anchor_stack'])} anchors"))
            else:
                results.append(CheckResult("fail", "offer_architecture", "Missing or incomplete — close section will be weak. Required keys: what_you_get, price_anchor_stack, guarantee_framing."))

            if not config.get("product_name"):
                results.append(CheckResult("fail", "product_name", "Missing — brand name will not be force-injected into the invariants footer."))

        except json.JSONDecodeError:
            results.append(CheckResult("fail", "config.json", "Invalid JSON"))
    else:
        results.append(CheckResult("fail", "config.json", "Not found"))

    # Research files
    research_path = product_path / "research"
    for filename in ["archetypes.md", "hotwords.md", "mechanisms.md"]:
        filepath = research_path / filename
        if filepath.exists():
            content = filepath.read_text()
            # Count sections (## ID: format)
            sections = re.findall(r"^## [A-Z]\w+:", content, re.MULTILINE)
            results.append(CheckResult("ok", filename, f"{len(sections)} sections"))
        else:
            results.append(CheckResult("fail", filename, f"Not found: {filepath}"))

    # Winners
    winners_path = product_path / "winners"
    if winners_path.exists():
        winner_files = list(winners_path.rglob("*.md"))
        results.append(CheckResult("ok", "winners/", f"{len(winner_files)} winner scripts"))
    else:
        results.append(CheckResult("warn", "winners/", "No winner scripts — output quality may suffer"))

    return results


def check_research_sections(task_ids: list[str], product_code: str, base_path: Path, spec: dict | None = None) -> list[CheckResult]:
    """Check that every archetype, hotword, and mechanism referenced in task_ids exists."""
    results = []

    product_folder = PRODUCT_FOLDERS.get(product_code, product_code)
    research_path = base_path / "products" / product_folder / "research"

    if not research_path.exists():
        return results  # Already flagged in product check

    # Collect all referenced codes
    archetypes_needed = set()
    hotwords_needed = set()
    scoped_hotwords_needed = set()
    mechanisms_needed = set()

    for tid in task_ids:
        try:
            ctx = parse_task_id(tid)
            archetypes_needed.add(ctx.archetype_code)
            hotwords_needed.add(ctx.a_point)
            hotwords_needed.add(ctx.b_point)
            scoped_hotwords_needed.add((ctx.mechanism_code, ctx.archetype_code, ctx.a_point))
            scoped_hotwords_needed.add((ctx.mechanism_code, ctx.archetype_code, ctx.b_point))
            mechanisms_needed.add(ctx.mechanism_code)
        except ValueError:
            pass  # Already flagged in task_id format check

    # Language-aware lookup — mirrors context.py logic
    spec_lang = (spec.get("language", "en") if spec else "en").lower()
    section_suffix = f"_{spec_lang.upper()}" if spec_lang != "en" else ""

    def _research_file(canonical: str):
        if spec_lang != "en":
            sidecar = research_path / f"{canonical}-{spec_lang}.md"
            if sidecar.exists():
                return sidecar
        return research_path / f"{canonical}.md"

    def _check_slice(group: str, code: str, source_file: Path, label: str) -> None:
        try:
            loaded = load_card_or_section(research_path, group=group, code=code, source_path=source_file)
        except ValueError as exc:
            results.append(CheckResult("fail", f"{label} {code}", f"Research section error in {source_file.name}: {exc}"))
            return
        if loaded.text:
            if loaded.status == "card":
                results.append(CheckResult("ok", f"{label} {code}", f"card loaded: {Path(loaded.source).name}"))
            else:
                results.append(CheckResult("ok", f"{label} {code}", f"legacy section loaded: {source_file.name}"))
        else:
            results.append(CheckResult("fail", f"{label} {code}", f"Missing card and legacy section for {code}"))

    # Check archetypes
    arc_file = _research_file("archetypes")
    for code in sorted(archetypes_needed):
        _check_slice("archetypes", f"{code}{section_suffix}", arc_file, "Archetype")

    # Check hotwords
    hw_file = _research_file("hotwords")
    for mechanism_code, archetype_code, code in sorted(scoped_hotwords_needed):
        lookup_code = f"{code}{section_suffix}"
        try:
            loaded = load_hotword_card_or_section(
                research_path,
                code=lookup_code,
                mechanism_code=mechanism_code,
                archetype_code=archetype_code,
                source_path=hw_file,
            )
        except ValueError as exc:
            results.append(CheckResult("fail", f"Hotword {mechanism_code}_{lookup_code}", f"Research section error in {hw_file.name}: {exc}"))
            continue
        if loaded.text:
            scoped_label = Path(loaded.source).stem if loaded.status == "card" else lookup_code
            label = f"Hotword {scoped_label}"
            detail = f"card loaded: {Path(loaded.source).name}" if loaded.status == "card" else f"legacy section loaded: {hw_file.name}"
            results.append(CheckResult("ok", label, detail))
        else:
            results.append(CheckResult("fail", f"Hotword {mechanism_code}_{lookup_code}", f"Missing scoped card and legacy section for {lookup_code}"))

    # Check mechanisms
    mech_file = _research_file("mechanisms")
    for code in sorted(mechanisms_needed):
        _check_slice("mechanisms", f"{code}{section_suffix}", mech_file, "Mechanism")

    return results


def is_lfs_batch(task_ids: list[str], spec: dict | None) -> bool:
    """LFS batch heuristic: format slot is 'lfs' OR context_files include an lfs-format template."""
    for tid in task_ids:
        parts = tid.split("_")
        if len(parts) >= 2 and parts[1].lower() == "lfs":
            return True
    if spec:
        ctx_files = spec.get("context_files") or []
        for cf in ctx_files:
            if "lfs-format" in cf or "lfs-prompt-engine" in cf or "lfs-briefing" in cf:
                return True
    return False


def check_lfs_v41_prompts(
    spec: dict,
    task_ids: list[str],
    batch_dir: Path,
    product_code: str | None = None,
    product_config: dict | None = None,
    lfs_policy: str = "strict",
) -> list[CheckResult]:
    """Validate LFS V4.1 per-task prompt files.

    Required slots: VERBATIM HOOK, VERBATIM BRIDGE PHRASE, VERBATIM DATED LOG,
    VERBATIM P.S., PERMISSION BEAT. VERBATIM HOOK body must be ≥2 sentences.
    Failures block batch generation."""
    results = []
    if not is_lfs_batch(task_ids, spec):
        return results
    strict_lfs = lfs_policy != "v41"
    soft_status = "fail" if strict_lfs else "warn"

    if spec.get("briefings") or spec.get("briefing"):
        results.append(CheckResult(
            "fail", "LFS V4.1 prompt source",
            "spec.json contains briefing/briefings. LFS V4.1 requires one markdown file per task under prompts/{TASK_ID}.md."
        ))

    batch_prompt = batch_dir / "prompt.md"
    if batch_prompt.exists():
        results.append(CheckResult(
            "fail", "LFS V4.1 prompt source",
            "Shared prompt.md is not supported for LFS V4.1 batches. Move script-specific data into prompts/{TASK_ID}.md."
        ))

    REQUIRED = [
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
    REQUIRED_MANIFEST = ["task_id", "concept", "strategist", "product", "format"]

    template_link = "components/lfs-briefing-template.md"
    allowed_prices = canonical_prices_from_config(product_config or {})
    forbidden_phrases = [
        str(p).lower()
        for p in (product_config or {}).get("prompt_context", {}).get("forbidden_phrases", [])
        if str(p).strip()
    ]
    seen_concepts: dict[str, str] = {}
    seen_hooks: dict[str, str] = {}
    seen_logs: dict[str, str] = {}
    strategist_counts: dict[str, int] = {}
    for tid in task_ids:
        legacy_prompt = batch_dir / f"prompt_{tid}.md"
        if legacy_prompt.exists():
            results.append(CheckResult(
                "fail", f"LFS prompt {tid[-12:]}",
                f"Legacy flat prompt found: {legacy_prompt.name}. Move it to prompts/{tid}.md."
            ))
            continue

        prompt_file = batch_dir / "prompts" / f"{tid}.md"
        if not prompt_file.exists():
            results.append(CheckResult(
                "fail", f"LFS prompt {tid[-12:]}",
                f"Missing required per-task prompt: {prompt_file}"
            ))
            continue

        prompt_failed = False
        raw_body = prompt_file.read_text()
        manifest, body = parse_prompt_manifest(raw_body)
        expected_format_path = lfs_format_path_for_task(spec, tid, raw_body)

        missing_manifest = [key for key in REQUIRED_MANIFEST if not manifest.get(key)]
        if missing_manifest:
            prompt_failed = True
            results.append(CheckResult(
                "fail", f"LFS manifest {tid[-12:]}",
                f"Missing frontmatter keys: {', '.join(missing_manifest)}. Required: task_id, concept, strategist, product, format."
            ))

        if manifest.get("task_id") and manifest["task_id"] != tid:
            prompt_failed = True
            results.append(CheckResult(
                "fail", f"LFS manifest {tid[-12:]}",
                f"task_id mismatch: manifest has {manifest['task_id']!r}, spec has {tid!r}"
            ))
        if manifest.get("format") and manifest["format"].lower() != "lfs":
            prompt_failed = True
            results.append(CheckResult(
                "fail", f"LFS manifest {tid[-12:]}",
                f"format must be lfs, got {manifest['format']!r}"
            ))
        if not expected_format_path:
            prompt_failed = True
            results.append(CheckResult(
                "fail", f"LFS manifest {tid[-12:]}",
                "missing per-task lfs_format routing in prompt/spec"
            ))
        if product_code and manifest.get("product") and manifest["product"] != product_code:
            prompt_failed = True
            results.append(CheckResult(
                "fail", f"LFS manifest {tid[-12:]}",
                f"product mismatch: manifest has {manifest['product']!r}, batch product is {product_code!r}"
            ))

        concept = manifest.get("concept", "")
        if concept:
            prev = seen_concepts.get(concept)
            if prev and prev != tid:
                prompt_failed = prompt_failed or strict_lfs
                results.append(CheckResult(
                    soft_status, f"LFS concept {concept}",
                    f"Duplicate concept in {prev} and {tid}. Concept must identify one strategy lane."
                ))
            seen_concepts[concept] = tid

        strategist = manifest.get("strategist", "")
        if strategist:
            strategist_counts[strategist] = strategist_counts.get(strategist, 0) + 1

        placeholder_hits = sorted(set(re.findall(r"\[[A-Za-z][^\]\n]{1,80}\]", body)))
        todo_hits = sorted(set(re.findall(r"\b(?:TODO|TBD|TK|FIXME|LOREM IPSUM)\b", body, re.IGNORECASE)))
        if placeholder_hits or todo_hits:
            prompt_failed = True
            bits = []
            if placeholder_hits:
                bits.append("placeholders: " + ", ".join(placeholder_hits[:5]))
            if todo_hits:
                bits.append("unfinished markers: " + ", ".join(todo_hits[:5]))
            results.append(CheckResult(
                "fail", f"LFS prompt {tid[-12:]}",
                "; ".join(bits)
            ))

        price_hits = sorted(set(re.findall(r"\$[\d,]+(?:\.\d{1,2})?", body)))
        bad_prices = [p for p in price_hits if p not in allowed_prices]
        if bad_prices:
            prompt_failed = True
            results.append(CheckResult(
                "fail", f"LFS prompt {tid[-12:]}",
                f"Non-canonical prices in prompt: {', '.join(bad_prices)}. Put pricing in product config or approved price anchors."
            ))

        body_for_forbidden = remove_slot(remove_slot(body, "## FORBIDDEN"), "## SOURCE SWIPE")
        body_low = body_for_forbidden.lower()
        forbidden_hits = sorted({p for p in forbidden_phrases if re.search(rf"\b{re.escape(p)}\b", body_low)})
        if forbidden_hits:
            prompt_failed = True
            results.append(CheckResult(
                "fail", f"LFS prompt {tid[-12:]}",
                f"Forbidden phrases in prompt: {', '.join(forbidden_hits)}"
            ))

        missing = [slot for slot in REQUIRED if not has_slot(body, slot)]

        if missing:
            prompt_failed = prompt_failed or strict_lfs
            results.append(CheckResult(
                soft_status, f"LFS prompt {tid[-12:]}",
                f"Missing briefing-template slots: {', '.join(s.replace('## ', '') for s in missing)} — see {template_link}"
            ))
            if strict_lfs:
                continue

        out_of_order = []
        previous_pos = -1
        for slot in REQUIRED:
            match = re.search(rf"^{re.escape(slot)}(?:\s|\(|$)", body, re.MULTILINE)
            pos = match.start() if match else -1
            if pos < previous_pos:
                out_of_order.append(slot.replace("## ", ""))
            previous_pos = pos
        if out_of_order:
            prompt_failed = prompt_failed or strict_lfs
            results.append(CheckResult(
                soft_status, f"LFS prompt {tid[-12:]}",
                f"Briefing-template slots out of order: {', '.join(out_of_order)} — follow {template_link}"
            ))

        empty_slots = [slot for slot in REQUIRED if not extract_slot(body, slot)]
        if empty_slots:
            prompt_failed = prompt_failed or strict_lfs
            results.append(CheckResult(
                soft_status, f"LFS prompt {tid[-12:]}",
                f"Empty briefing-template slots: {', '.join(s.replace('## ', '') for s in empty_slots)}"
            ))

        hook_body = extract_slot(body, "## VERBATIM HOOK")
        sentences = re.split(r"[.!?]\s+", hook_body)
        non_empty = [s for s in sentences if len(s.strip()) > 15]
        if len(non_empty) < 2:
            prompt_failed = prompt_failed or strict_lfs
            results.append(CheckResult(
                soft_status, f"LFS prompt {tid[-12:]}",
                f"VERBATIM HOOK has <2 sentences ({len(non_empty)}) — must commit actual opener lines, not a description"
            ))
            if strict_lfs:
                continue

        hook_key = normalize_slot_text(hook_body)
        if hook_key:
            prev = seen_hooks.get(hook_key)
            if prev and prev != tid:
                prompt_failed = prompt_failed or strict_lfs
                results.append(CheckResult(
                    soft_status, f"LFS duplicate hook",
                    f"Same VERBATIM HOOK in {prev} and {tid}"
                ))
            seen_hooks[hook_key] = tid

        log_key = normalize_slot_text(extract_slot(body, "## VERBATIM DATED LOG"))
        if log_key:
            prev = seen_logs.get(log_key)
            if prev and prev != tid:
                prompt_failed = prompt_failed or strict_lfs
                results.append(CheckResult(
                    soft_status, f"LFS duplicate log",
                    f"Same VERBATIM DATED LOG in {prev} and {tid}"
                ))
            seen_logs[log_key] = tid

        if not prompt_failed:
            results.append(CheckResult("ok", f"LFS prompt {tid[-12:]}", "Manifest, per-task prompt, and required slots present"))

        outline_file = batch_dir / "outlines" / f"{tid}.md"
        if outline_file.exists():
            outline_body = outline_file.read_text().strip()
            placeholder_hits = sorted(set(re.findall(r"\[[A-Za-z][^\]\n]{1,80}\]", outline_body)))
            todo_hits = sorted(set(re.findall(r"\b(?:TODO|TBD|TK|FIXME|LOREM IPSUM)\b", outline_body, re.IGNORECASE)))
            if not outline_body:
                results.append(CheckResult(
                    "fail", f"LFS outline {tid[-12:]}",
                    f"Outline file is empty: {outline_file}"
                ))
            elif placeholder_hits or todo_hits:
                bits = []
                if placeholder_hits:
                    bits.append("placeholders: " + ", ".join(placeholder_hits[:5]))
                if todo_hits:
                    bits.append("unfinished markers: " + ", ".join(todo_hits[:5]))
                results.append(CheckResult(
                    "fail", f"LFS outline {tid[-12:]}",
                    "; ".join(bits)
                ))
            elif forbidden_phrases:
                outline_low = outline_body.lower()
                forbidden_hits = sorted({p for p in forbidden_phrases if re.search(rf"\b{re.escape(p)}\b", outline_low)})
                if forbidden_hits:
                    results.append(CheckResult(
                        "fail", f"LFS outline {tid[-12:]}",
                        f"Forbidden phrases in outline: {', '.join(forbidden_hits)}"
                    ))
                else:
                    results.append(CheckResult(
                        "ok", f"LFS outline {tid[-12:]}",
                        f"Blueprint loaded from outlines/{tid}.md"
                    ))
            else:
                results.append(CheckResult(
                    "ok", f"LFS outline {tid[-12:]}",
                    f"Blueprint loaded from outlines/{tid}.md"
                ))
            if strict_lfs:
                outline_errors = validate_outline_contract(
                    outline_body,
                    expected_format_path=expected_format_path,
                    product_config=product_config,
                )
                for err in outline_errors:
                    results.append(CheckResult(
                        "fail", f"LFS outline contract {tid[-12:]}",
                        err
                    ))
            else:
                results.append(CheckResult(
                    "ok", f"LFS outline semantic gate {tid[-12:]}",
                    "V4.1 defers outline quality to semantic QA"
                ))
        else:
            results.append(CheckResult(
                "fail", f"LFS outline {tid[-12:]}",
                f"Missing required V4.1 outline: {outline_file}. Run `ww lfs-outline {batch_dir.name}` before generation."
            ))

    if strategist_counts:
        summary = ", ".join(f"{name}:{count}" for name, count in sorted(strategist_counts.items()))
        results.append(CheckResult("ok", "LFS strategist manifest", summary))

    return results


def check_lfs_format_contract(spec: dict, task_ids: list[str]) -> list[CheckResult]:
    """Confirm native LFS batches are bound to the canonical presentation contract."""
    if not is_lfs_batch(task_ids, spec):
        return []
    variant = spec.get("variant") or spec.get("format_variant") or "native"
    if str(variant).lower() != "native":
        return [CheckResult(
            "fail",
            "LFS format contract",
            f"Unsupported LFS variant {variant!r}. Supported variant: native."
        )]
    return [CheckResult(
        "ok",
        "LFS format contract",
        f"{LFS_NATIVE.name}: ≥{LFS_NATIVE.min_dividers} '{LFS_NATIVE.divider}' dividers, short paragraphs, plain text"
    )]


def check_prompt_md_lint(batch_dir: Path) -> list[CheckResult]:
    """Lint batch prompt.md for opener-LAW patterns that override per-task prompts.

    These declarations broke FIX7 — universal opener mandates compete with per-task
    VERBATIM HOOK content. Move opener control to the per-task prompt."""
    results = []
    prompt_md = batch_dir / "prompt.md"
    if not prompt_md.exists():
        return results

    body = prompt_md.read_text()
    import re as _re

    # Patterns that broke FIX7 — universal opener mandates
    BAD_PATTERNS = [
        (r"FIRST\s+\d+\s+LINES?\s+(?:ARE|IS)\s+LAW", "FIRST X LINES ARE LAW"),
        (r"\d+\s+LINES?\s+(?:ARE|IS)\s+LAW", "N LINES ARE LAW"),
        (r"CUT\s+THESE\s+OPENERS", "CUT THESE OPENERS ban list"),
        (r"PRINCIPLE\s+\d+[^\n]{0,80}OPENER\s*\(.*LAW", "Principle X OPENER LAW"),
        (r"OPENER[^\n]{0,40}MUST\s+CONTAIN", "OPENER MUST CONTAIN universal mandate"),
    ]

    found = []
    for pattern, label in BAD_PATTERNS:
        m = _re.search(pattern, body, _re.IGNORECASE)
        if m:
            line_no = body[:m.start()].count("\n") + 1
            found.append((label, line_no, m.group(0)[:60]))

    if found:
        for label, line_no, snippet in found:
            results.append(CheckResult(
                "fail", f"prompt.md lint",
                f"L{line_no}: '{label}' detected — '{snippet}…' — universal opener mandates override per-task prompts. Move opener control to the prompt's VERBATIM HOOK slot."
            ))
    else:
        results.append(CheckResult("ok", "prompt.md lint", "No opener-mandate conflicts detected"))

    return results


def check_format(task_ids: list[str], base_path: Path, batch_dir: Path) -> list[CheckResult]:
    """Check format prompt files exist."""
    results = []

    # Collect unique formats
    formats_needed = set()
    for tid in task_ids:
        parts = tid.split("_")
        if len(parts) >= 2:
            fmt = parts[1].lower()
            if fmt in VIDMOD_FRAMEWORKS:
                formats_needed.add("vidmod")
            else:
                formats_needed.add(fmt)

    lfs_batch = is_lfs_batch(task_ids, None)

    # Check freeform prompt. LFS V4.1 treats shared prompt.md as an error in
    # check_lfs_v41_prompts, so do not let it short-circuit the format check here.
    batch_prompt = batch_dir / "prompt.md"
    if batch_prompt.exists() and not lfs_batch:
        results.append(CheckResult("ok", "Freeform prompt", "batch prompt.md found — overrides format template"))
        return results

    for fmt in sorted(formats_needed):
        prompt_file = base_path / "formats" / fmt / "prompt.md"
        if prompt_file.exists():
            results.append(CheckResult("ok", f"Format: {fmt}", f"prompt.md found"))
        else:
            results.append(CheckResult("fail", f"Format: {fmt}", f"prompt.md not found: {prompt_file}"))

        constants_file = base_path / "formats" / fmt / "constants.json"
        if not constants_file.exists() and fmt not in ("freeform", "drpov"):
            results.append(CheckResult("warn", f"Format: {fmt}", f"constants.json missing — validation may skip"))

    return results


def check_upload(product_code: str, base_path: Path, test_connection: bool = False) -> list[CheckResult]:
    """Check upload configuration."""
    results = []

    product_folder = PRODUCT_FOLDERS.get(product_code, product_code)
    config_file = base_path / "products" / product_folder / "upload-config.json"

    if not config_file.exists():
        results.append(CheckResult("fail", "upload-config.json", f"Not found — cannot upload"))
        return results

    try:
        config = json.loads(config_file.read_text())
    except json.JSONDecodeError:
        results.append(CheckResult("fail", "upload-config.json", "Invalid JSON"))
        return results

    # Google Drive
    google = config.get("google", {})
    if google.get("folder_id"):
        results.append(CheckResult("ok", "Google Drive folder_id", google["folder_id"][:20] + "..."))
    else:
        results.append(CheckResult("fail", "Google Drive folder_id", "Missing"))

    if google.get("credentials_file"):
        creds_path = Path(google["credentials_file"])
        if creds_path.exists():
            results.append(CheckResult("ok", "Google credentials", str(creds_path.name)))
        else:
            results.append(CheckResult("fail", "Google credentials", f"File not found: {creds_path}"))
    else:
        results.append(CheckResult("fail", "Google credentials", "credentials_file not set"))

    token_path = Path(google.get("token_file", "token.json"))
    if token_path.exists():
        results.append(CheckResult("ok", "Google token", "Token file exists"))
    else:
        results.append(CheckResult("warn", "Google token", "Token file missing — browser auth will be required"))

    # ClickUp
    clickup = config.get("clickup", {})
    if clickup.get("api_key") and clickup.get("list_id"):
        results.append(CheckResult("ok", "ClickUp", f"list_id: {clickup['list_id']}"))

        # Test connection if requested
        if test_connection:
            try:
                resp = requests.get(
                    f"https://api.clickup.com/api/v2/list/{clickup['list_id']}",
                    headers={"Authorization": clickup["api_key"]},
                    timeout=10,
                )
                if resp.status_code == 200:
                    list_name = resp.json().get("name", "Unknown")
                    results.append(CheckResult("ok", "ClickUp connection", f"List: {list_name}"))
                else:
                    results.append(CheckResult("fail", "ClickUp connection", f"HTTP {resp.status_code}"))
            except Exception as e:
                results.append(CheckResult("fail", "ClickUp connection", str(e)))
    elif not clickup:
        results.append(CheckResult("warn", "ClickUp", "Not configured — tasks won't be created"))
    else:
        results.append(CheckResult("fail", "ClickUp", "Missing api_key or list_id"))

    # Assignees
    assignees = clickup.get("assignees", {})
    single = clickup.get("assignee_id")
    if assignees:
        results.append(CheckResult("ok", "Assignees", ", ".join(assignees.keys())))
    elif single:
        results.append(CheckResult("ok", "Assignee", f"Single: {single}"))
    else:
        results.append(CheckResult("warn", "Assignees", "None configured — tasks will be unassigned"))

    return results


def check_meta(product_code: str, base_path: Path, batch_dir: Path) -> list[CheckResult]:
    """Check META upload readiness."""
    results = []

    product_folder = PRODUCT_FOLDERS.get(product_code, product_code)
    config_file = base_path / "products" / product_folder / "upload-config.json"

    if not config_file.exists():
        results.append(CheckResult("fail", "upload-config.json", "Not found"))
        return results

    config = json.loads(config_file.read_text())
    meta = config.get("meta", {})

    if not meta:
        results.append(CheckResult("fail", "META config", "No 'meta' section in upload-config.json"))
        return results

    # Check required fields
    for field in ["access_token", "ad_account_id", "page_id"]:
        if meta.get(field):
            val = meta[field]
            display = val[:15] + "..." if len(val) > 15 else val
            results.append(CheckResult("ok", f"META {field}", display))
        else:
            results.append(CheckResult("fail", f"META {field}", "Missing"))

    # Check images
    images_dir = batch_dir / "images"
    if images_dir.exists():
        images = list(images_dir.glob("*.jpg")) + list(images_dir.glob("*.png"))
        if images:
            results.append(CheckResult("ok", "Images", f"{len(images)} images in batch"))
        else:
            results.append(CheckResult("fail", "Images", "images/ folder exists but empty"))
    else:
        results.append(CheckResult("fail", "Images", "No images/ folder — required for meta-upload"))

    # Check headline in spec
    spec_file = batch_dir / "spec.json"
    if spec_file.exists():
        spec = json.loads(spec_file.read_text())
        if spec.get("headline"):
            results.append(CheckResult("ok", "Headline", f"'{spec['headline'][:40]}...'"))
        else:
            results.append(CheckResult("fail", "Headline", "Missing from spec.json — required for meta-upload"))

    return results


def check_existing_output(batch_dir: Path, *, fail: bool = True) -> list[CheckResult]:
    """Check for existing output files that block deterministic batch generation."""
    results = []
    output_dir = batch_dir / "output"

    if output_dir.exists():
        files = list(output_dir.iterdir())
        if files:
            status = "fail" if fail else "warn"
            label = "Existing output" if fail else "Existing output (V4.1 advisory)"
            detail = (
                f"{len(files)} files in output/ — run `ww batch <id> --clean-output`, "
                "`--resume-missing`, or `--append-version` explicitly"
            )
            if not fail:
                detail += "; V4.1 manual preflight treats this as advisory because policy/outline checks are independent of output/"
            results.append(CheckResult(status, label, detail))
    return results


def run_preflight(batch_id: str, base_path: Path, check_upload_flag: bool = False,
                  check_meta_flag: bool = False, test_connections: bool = False,
                  check_output_flag: bool = True, lfs_policy: str = "strict") -> bool:
    """Run all pre-flight checks. Returns True if ready to proceed."""

    batch_dir = resolve_batch_dir(batch_id, base_path=base_path)

    print(f"\n{'='*60}")
    print(f"  PRE-FLIGHT: {batch_id}")
    print(f"{'='*60}")

    all_results = []
    has_fail = False

    # 1. Spec check
    print(f"\n  SPEC")
    spec, spec_results = check_spec(batch_dir)
    all_results.extend(spec_results)
    for r in spec_results:
        print(r)

    if not spec:
        print(f"\n\033[31m  ABORT: Cannot proceed without valid spec.json\033[0m\n")
        return False

    # Extract product from first task_id
    task_ids = spec.get("task_ids", [])
    product_code = task_ids[0].split("_")[0] if task_ids else None

    if not product_code:
        print(f"\n\033[31m  ABORT: No task_ids to extract product from\033[0m\n")
        return False

    # 2. Product check
    print(f"\n  PRODUCT ({product_code})")
    product_results = check_product(product_code, base_path)
    all_results.extend(product_results)
    for r in product_results:
        print(r)
    product_config = {}
    product_folder = PRODUCT_FOLDERS.get(product_code, product_code)
    product_config_path = base_path / "products" / product_folder / "config.json"
    if product_config_path.exists():
        try:
            product_config = json.loads(product_config_path.read_text())
        except json.JSONDecodeError:
            product_config = {}

    # 3. Research sections check
    print(f"\n  RESEARCH SECTIONS")
    research_results = check_research_sections(task_ids, product_code, base_path, spec)
    all_results.extend(research_results)
    for r in research_results:
        print(r)

    # 4. Format check
    print(f"\n  FORMAT")
    format_results = check_format(task_ids, base_path, batch_dir)
    all_results.extend(format_results)
    for r in format_results:
        print(r)

    # 4a. prompt.md lint — block opener-LAW patterns that override per-task prompts
    prompt_lint_results = check_prompt_md_lint(batch_dir)
    if prompt_lint_results:
        print(f"\n  PROMPT.MD LINT")
        all_results.extend(prompt_lint_results)
        for r in prompt_lint_results:
            print(r)

    # 4b. LFS V4.1 prompt validation — require per-task prompts with VERBATIM slots
    lfs_prompt_results = check_lfs_v41_prompts(spec, task_ids, batch_dir, product_code, product_config, lfs_policy=lfs_policy)
    if lfs_prompt_results:
        print(f"\n  LFS V4.1 PROMPTS")
        all_results.extend(lfs_prompt_results)
        for r in lfs_prompt_results:
            print(r)

    # 4c. LFS native presentation contract — auto-injected at render time and
    # rechecked by lfs_verify, but preflight should make it visible.
    lfs_contract_results = check_lfs_format_contract(spec, task_ids)
    if lfs_contract_results:
        print(f"\n  LFS FORMAT CONTRACT")
        all_results.extend(lfs_contract_results)
        for r in lfs_contract_results:
            print(r)

    # 4d. Context reference graph — fail loud on missing canonical files
    print(f"\n  CONTEXT REFERENCES")
    ref_results = check_context_references(spec, task_ids, base_path)
    all_results.extend(ref_results)
    for r in ref_results:
        print(r)

    # 5. Existing output check
    output_results = check_existing_output(batch_dir, fail=lfs_policy != "v41") if check_output_flag else []
    if output_results:
        print(f"\n  OUTPUT")
        all_results.extend(output_results)
        for r in output_results:
            print(r)

    # 6. Upload check (optional)
    if check_upload_flag:
        print(f"\n  UPLOAD")
        upload_results = check_upload(product_code, base_path, test_connection=test_connections)
        all_results.extend(upload_results)
        for r in upload_results:
            print(r)

    # 7. META check (optional)
    if check_meta_flag:
        print(f"\n  META")
        meta_results = check_meta(product_code, base_path, batch_dir)
        all_results.extend(meta_results)
        for r in meta_results:
            print(r)

    # Summary
    ok_count = sum(1 for r in all_results if r.status == "ok")
    warn_count = sum(1 for r in all_results if r.status == "warn")
    fail_count = sum(1 for r in all_results if r.status == "fail")

    print(f"\n{'='*60}")
    print(f"  RESULT: {ok_count} passed, {warn_count} warnings, {fail_count} failed")

    if fail_count == 0:
        print(f"\033[32m  READY TO GENERATE\033[0m", end="")
        if check_upload_flag:
            print(f" \033[32m+ UPLOAD\033[0m", end="")
        if check_meta_flag:
            print(f" \033[32m+ META\033[0m", end="")
        print()
    else:
        print(f"\033[31m  NOT READY — fix {fail_count} issue{'s' if fail_count > 1 else ''} above\033[0m")

    print(f"{'='*60}\n")

    return fail_count == 0


def main():
    parser = argparse.ArgumentParser(description="WW-2 Pre-flight Checklist")
    parser.add_argument("batch_id", help="Batch identifier")
    parser.add_argument("--upload", action="store_true", help="Also check upload readiness (Google Drive + ClickUp)")
    parser.add_argument("--meta", action="store_true", help="Also check META upload readiness")
    parser.add_argument("--test", action="store_true", help="Test live connections (ClickUp API, etc.)")
    parser.add_argument("--all", action="store_true", help="Check everything (generate + upload + META)")
    parser.add_argument("--base-path", "-b", type=Path, help="Base project path")
    parser.add_argument("--lfs-policy", choices=["strict", "v41"], default="strict", help="LFS preflight policy")

    args = parser.parse_args()
    base_path = args.base_path or Path(__file__).parent.parent

    check_upload_flag = args.upload or args.all
    check_meta_flag = args.meta or args.all

    ready = run_preflight(
        batch_id=args.batch_id,
        base_path=base_path,
        check_upload_flag=check_upload_flag,
        check_meta_flag=check_meta_flag,
        test_connections=args.test,
        lfs_policy=args.lfs_policy,
    )

    sys.exit(0 if ready else 1)


if __name__ == "__main__":
    main()

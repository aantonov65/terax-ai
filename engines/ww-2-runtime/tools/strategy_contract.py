#!/usr/bin/env python3
"""Strategy JSON contract helpers for scale-safe LFS generation."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from context import parse_task_id


BUYER_COPY_FIELDS = {
    "angle_name",
    "concept",
    "hook",
    "verbatim_hook",
    "verbatim_bridge_phrase",
    "verbatim_dated_log",
    "verbatim_ps",
    "verbatim_pps",
    "pattern_interrupt_scene",
}

CREATIVE_FORMAT_KEYS = ("lfs_format_template", "lfs_format", "format_template", "format")


def strategy_items(strategy: dict[str, Any]) -> list[dict[str, Any]]:
    """Return per-ad items from the preferred or legacy strategy shape."""
    if "ads" in strategy:
        ads = strategy.get("ads")
        if not isinstance(ads, list):
            raise ValueError("`ads` must be a list")
        return [ad for ad in ads if isinstance(ad, dict)]

    if "angles" in strategy:
        angles = strategy.get("angles")
        if not isinstance(angles, list):
            raise ValueError("`angles` must be a list")
        return [angle for angle in angles if isinstance(angle, dict)]

    return [{"task_id": tid} for tid in strategy.get("task_ids") or []]


def uses_intent_ads(strategy: dict[str, Any]) -> bool:
    return "ads" in strategy


def item_format(item: dict[str, Any]) -> str:
    for key in CREATIVE_FORMAT_KEYS:
        value = str(item.get(key) or "").strip()
        if value and value.lower() != "lfs":
            return Path(value).stem
    return ""


def _strategy_default_format_template(strategy: dict[str, Any]) -> str:
    top = (
        str(strategy.get("lfs_format_template") or strategy.get("lfs_format") or "").strip()
    )
    return Path(top).stem if top else ""


def task_lfs_format(strategy: dict[str, Any], item: dict[str, Any]) -> str:
    """Return the LFS messaging format selected for one task."""
    return item_format(item) or _strategy_default_format_template(strategy) or "confession"


def strategy_format_templates(strategy: dict[str, Any]) -> list[str]:
    """Return all LFS messaging formats used by this strategy in task order."""
    seen: set[str] = set()
    formats: list[str] = []
    items = strategy_items(strategy)
    if not items:
        items = [{}]
    for item in items:
        fmt = task_lfs_format(strategy, item)
        if fmt and fmt not in seen:
            seen.add(fmt)
            formats.append(fmt)
    return formats or ["confession"]


def strategy_format_template(strategy: dict[str, Any]) -> str:
    """Return the batch default LFS format, or 'mixed' when routed per task."""
    formats = strategy_format_templates(strategy)
    return formats[0] if len(formats) == 1 else "mixed"


def task_ids_from_strategy_contract(strategy: dict[str, Any]) -> list[str]:
    task_ids = strategy.get("task_ids")
    if task_ids:
        if not isinstance(task_ids, list) or not all(isinstance(t, str) for t in task_ids):
            raise ValueError("`task_ids` must be a list of strings")
        return task_ids

    ids: list[str] = []
    for i, item in enumerate(strategy_items(strategy), 1):
        task_id = item.get("task_id")
        if not isinstance(task_id, str) or not task_id.strip():
            key = "ads" if uses_intent_ads(strategy) else "angles"
            raise ValueError(f"{key}[{i}] must be an object with task_id")
        ids.append(task_id)
    return ids


def validate_intent_ads(strategy: dict[str, Any]) -> list[str]:
    """Validate the new V4 strategy shape without blocking legacy angles."""
    if not uses_intent_ads(strategy):
        return []

    errors: list[str] = []
    ads = strategy.get("ads")
    if not isinstance(ads, list) or not ads:
        return ["`ads` must be a non-empty list"]

    top_format = _strategy_default_format_template(strategy)
    for idx, ad in enumerate(ads, 1):
        if not isinstance(ad, dict):
            errors.append(f"ads[{idx}] must be an object")
            continue
        label = f"ads[{idx}]"
        task_id = str(ad.get("task_id") or "").strip()
        angle = str(ad.get("angle") or "").strip()
        mechanism = str(ad.get("mechanism") or "").strip()
        creative_format = item_format(ad) or top_format

        if not task_id:
            errors.append(f"{label}.task_id is required")
        if not angle:
            errors.append(f"{label}.angle is required")
        if not mechanism:
            errors.append(f"{label}.mechanism is required")
        if not creative_format:
            errors.append(f"{label}.format is required; use an LFS format such as listicle")

        forbidden = sorted(BUYER_COPY_FIELDS.intersection(ad))
        if forbidden:
            errors.append(
                f"{label} contains buyer-copy fields ({', '.join(forbidden)}). "
                "Use angle/edge/source only; lfs-brief writes verbatim slots."
            )

        if task_id and mechanism:
            try:
                parsed = parse_task_id(task_id)
            except Exception as exc:
                errors.append(f"{label}.task_id could not be parsed: {exc}")
            else:
                if parsed.mechanism_code != mechanism:
                    errors.append(
                        f"{label}.mechanism {mechanism!r} does not match task ID mechanism {parsed.mechanism_code!r}"
                    )
    return errors


def public_batch_context(strategy: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    """Return batch metadata safe to show the prompt-writing model."""
    formats = strategy_format_templates(strategy)
    return {
        "batch_id": spec.get("batch_id") or strategy.get("batch_id"),
        "product": spec.get("product") or strategy.get("product"),
        "format": spec.get("format") or strategy.get("format"),
        "variant": spec.get("variant") or strategy.get("variant"),
        "lfs_format_template": strategy_format_template(strategy),
        "lfs_format_templates": formats,
        "lfs_format_routing": "per-task" if len(formats) > 1 else "batch-default",
        "description": strategy.get("description", ""),
        "cta_text": spec.get("cta_text") or strategy.get("cta_text"),
    }


def public_task_intent(strategy: dict[str, Any], item: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    """Return only the task intent fields safe for briefing generation."""
    parsed = parse_task_id(str(item.get("task_id")))
    intent = {
        "task_id": item.get("task_id"),
        "angle": item.get("angle") or item.get("reader_facing_premise") or item.get("premise") or "",
        "format": task_lfs_format(strategy, item),
        "mechanism": item.get("mechanism") or parsed.mechanism_code,
        "source_swipe": item.get("source_swipe") or item.get("source") or "",
        "edge_to_preserve": item.get("edge_to_preserve") or item.get("edge") or "",
        "failed_solutions": item.get("failed_solutions") or [],
        "proof_focus": item.get("proof_focus") or item.get("mechanism_focus") or "",
        "must_not_say": item.get("must_not_say") or [],
        "extra_notes": item.get("notes") or item.get("script_specific_direction") or "",
    }

    if not uses_intent_ads(strategy):
        # Legacy strategy support. Keep enough old data for compatibility, but
        # mark planner labels as blocked so they cannot leak into verbatim slots.
        intent["angle"] = intent["angle"] or item.get("angle_name") or item.get("concept") or ""
        for key in (
            "dogwhistles",
            "mechanism_emphasis",
            "industry_suppression_beat",
            "permission_beat",
            "claim_discipline",
            "cross_references",
        ):
            if key in item:
                intent[key] = item[key]
    return intent


def blocked_strategy_terms(strategy: dict[str, Any], item: dict[str, Any]) -> list[str]:
    """Planner labels that should never appear in generated buyer-facing slots."""
    terms: list[str] = []
    for key in ("concept", "angle_name"):
        value = str(item.get(key) or "").strip()
        if value:
            terms.append(value)
            terms.append(value.replace("_", " "))
    for value in item.get("must_not_say") or []:
        value = str(value).strip()
        if value:
            terms.append(value)

    seen: set[str] = set()
    clean: list[str] = []
    for term in terms:
        normalized = re.sub(r"\s+", " ", term).strip()
        if len(normalized) < 4:
            continue
        key = normalized.lower()
        if key not in seen:
            seen.add(key)
            clean.append(normalized)
    return clean

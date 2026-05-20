#!/usr/bin/env python3
"""LFS V4.1 policy: deterministic truth, semantic craft."""
from __future__ import annotations

from collections import Counter
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any


# Objective failures code can judge safely across every product.
# These protect product truth, claim boundaries, and deployable presentation.
V41_HARD_CODES = {
    "BRAND_MISSING_CTA",
    "BRAND_MISSING_PS",
    "CTA_NOT_VERBATIM",
    "FORBIDDEN_PHRASES",
    "PRICE_HALLUCINATION",
    "LFS_DIVIDERS_LOW",
    "LFS_DIVIDER_SPACING",
    "LFS_WALL_PARAGRAPH",
    "MARKDOWN_BOLD",
    "WORD_COUNT_HIGH",
}


def is_v41_hard_violation(violation: Any) -> bool:
    """Return true for objective V4.1 hard-fail violations."""
    return getattr(violation, "code", "") in V41_HARD_CODES


def split_v41_violations(result: Any) -> tuple[list[Any], list[Any]]:
    hard: list[Any] = []
    advisory: list[Any] = []
    for violation in getattr(result, "violations", []) or []:
        if is_v41_hard_violation(violation):
            hard.append(violation)
        else:
            advisory.append(violation)
    return hard, advisory


def violation_dict(violation: Any) -> dict[str, Any]:
    if is_dataclass(violation):
        return asdict(violation)
    return {
        "severity": getattr(violation, "severity", ""),
        "code": getattr(violation, "code", ""),
        "message": getattr(violation, "message", ""),
        "detail": getattr(violation, "detail", {}),
    }


def v41_objective_clean(results: list[Any]) -> bool:
    return all(not split_v41_violations(result)[0] for result in results)


def build_v41_objective_report(results: list[Any]) -> dict[str, Any]:
    """Summarize deterministic results under V4.1's hard/advisory split."""
    hard_counts: Counter[str] = Counter()
    advisory_counts: Counter[str] = Counter()
    scripts: list[dict[str, Any]] = []

    for result in results:
        hard, advisory = split_v41_violations(result)
        hard_counts.update(getattr(v, "code", "") for v in hard)
        advisory_counts.update(getattr(v, "code", "") for v in advisory)
        scripts.append({
            "script_path": getattr(result, "script_path", ""),
            "script": Path(getattr(result, "script_path", "")).name,
            "word_count": getattr(result, "word_count", 0),
            "hard_clean": not hard,
            "hard_violations": [violation_dict(v) for v in hard],
            "advisory_violations": [violation_dict(v) for v in advisory],
        })

    return {
        "policy": "v4.1",
        "hard_clean": not hard_counts,
        "hard_violation_counts": dict(sorted(hard_counts.items())),
        "advisory_violation_counts": dict(sorted(advisory_counts.items())),
        "scripts": scripts,
    }

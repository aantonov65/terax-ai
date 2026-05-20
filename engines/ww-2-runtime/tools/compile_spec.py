#!/usr/bin/env python3
"""Compile a strategist-authored plan into a canonical WW batch spec.

Strategists should choose product, format, variant, CTA, and task IDs. The
system owns canonical context wiring and format contracts.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from context import parse_task_id
from strategy_contract import (
    strategy_format_templates,
    strategy_items,
    task_lfs_format,
    task_ids_from_strategy_contract,
    validate_intent_ads,
)
from ww_paths import batch_dir_for_write


CANONICAL_CONTEXT = {
    ("lfs", "native"): [
        "components/dr-opener-primal-recognition.md",
        "components/lfs-prompt-engine.md",
    ],
}

LFS_FORMAT_TEMPLATES = {
    p.stem: f"components/lfs-formats/{p.name}"
    for p in (Path(__file__).parent.parent / "components" / "lfs-formats").glob("*.md")
}


def load_strategy(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as e:
        raise ValueError(f"Strategy file must be JSON: {e}") from e


def task_ids_from_strategy(strategy: dict) -> list[str]:
    return task_ids_from_strategy_contract(strategy)


def compile_spec(strategy: dict, batch_id_override: str | None = None) -> dict:
    contract_errors = validate_intent_ads(strategy)
    if contract_errors:
        raise ValueError("Invalid strategy ads contract: " + "; ".join(contract_errors))

    batch_id = batch_id_override or strategy.get("batch_id")
    product = strategy.get("product")
    fmt = str(strategy.get("format") or "").lower()
    variant = str(strategy.get("variant") or strategy.get("format_variant") or "native").lower()
    cta_text = strategy.get("cta_text")
    task_ids = task_ids_from_strategy(strategy)

    missing = [name for name, value in [
        ("batch_id", batch_id),
        ("product", product),
        ("format", fmt),
        ("cta_text", cta_text),
    ] if not value]
    if missing:
        raise ValueError(f"Missing required strategy keys: {', '.join(missing)}")

    key = (fmt, variant)
    if key not in CANONICAL_CONTEXT:
        supported = ", ".join(".".join(k) for k in sorted(CANONICAL_CONTEXT))
        raise ValueError(f"Unsupported format variant {fmt}.{variant}. Supported: {supported}")

    for tid in task_ids:
        parsed = parse_task_id(tid)
        if parsed.product != product:
            raise ValueError(f"Task {tid} product {parsed.product!r} does not match strategy product {product!r}")
        if parsed.format != fmt:
            raise ValueError(f"Task {tid} format {parsed.format!r} does not match strategy format {fmt!r}")

    context_files = list(CANONICAL_CONTEXT[key])
    if fmt == "lfs":
        lfs_format_templates = strategy_format_templates(strategy)
        missing_templates = [fmt_name for fmt_name in lfs_format_templates if fmt_name not in LFS_FORMAT_TEMPLATES]
        if missing_templates:
            supported_templates = ", ".join(sorted(LFS_FORMAT_TEMPLATES))
            raise ValueError(
                f"Unsupported LFS format template(s) {', '.join(repr(x) for x in missing_templates)}. "
                f"Supported: {supported_templates}"
            )
        for fmt_name in lfs_format_templates:
            template_path = LFS_FORMAT_TEMPLATES[fmt_name]
            if template_path not in context_files:
                context_files.append(template_path)

    spec = {
        "batch_id": batch_id,
        "product": product,
        "format": fmt,
        "variant": variant,
        "description": strategy.get("description", ""),
        "cta_text": cta_text,
        "context_files": context_files,
        "task_ids": task_ids,
    }
    if strategy.get("headline"):
        spec["headline"] = strategy["headline"]
    if fmt == "lfs":
        task_format_map = {
            str(item.get("task_id")): task_lfs_format(strategy, item)
            for item in strategy_items(strategy)
            if item.get("task_id")
        }
        if len(set(task_format_map.values())) > 1:
            spec["lfs_format_templates"] = task_format_map
    return spec


def main() -> int:
    ap = argparse.ArgumentParser(description="Compile a strategist JSON file into canonical spec.json")
    ap.add_argument("strategy", type=Path, help="JSON strategy file")
    ap.add_argument("--batch-id", help="Override batch_id from strategy")
    ap.add_argument("--base-path", "-b", type=Path, default=Path(__file__).parent.parent)
    ap.add_argument("--dry-run", action="store_true", help="Print spec without writing")
    args = ap.parse_args()

    try:
        spec = compile_spec(load_strategy(args.strategy), args.batch_id)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    if args.dry_run:
        print(json.dumps(spec, indent=2))
        return 0

    batch_dir = batch_dir_for_write(
        base_path=args.base_path,
        batch_id=spec["batch_id"],
        product=spec["product"],
        source_path=args.strategy,
    )
    batch_dir.mkdir(parents=True, exist_ok=True)
    spec_path = batch_dir / "spec.json"
    if spec_path.exists():
        print(f"Error: refusing to overwrite existing {spec_path}", file=sys.stderr)
        return 1
    spec_path.write_text(json.dumps(spec, indent=2) + "\n")
    print(f"Wrote {spec_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

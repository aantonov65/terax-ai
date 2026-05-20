#!/usr/bin/env python3
"""Build V4.1 strategy.json from a strategy-plan YAML/JSON file.

The plan is the editable strategist/agent handoff. This tool validates product
research-card references and emits only the downstream-safe strategy contract.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from compile_spec import compile_spec
from context import parse_task_id
from research_cards import card_path_for, resolve_product_dir
from strategy_contract import BUYER_COPY_FIELDS, validate_intent_ads
from ww_paths import batch_dir_for_write

REPO = Path(__file__).resolve().parents[1]
ALLOWED_AD_FIELDS = {
    "task_id",
    "archetype",
    "arc",
    "identity",
    "a_point",
    "b_point",
    "mechanism",
    "format",
    "angle",
    "tag",
    "date",
    "source_swipe",
    "edge_to_preserve",
    "edge",
    "failed_solutions",
    "proof_focus",
    "mechanism_focus",
    "must_not_say",
    "notes",
    "script_specific_direction",
}
OPTIONAL_OUTPUT_FIELDS = {
    "source_swipe",
    "edge_to_preserve",
    "failed_solutions",
    "proof_focus",
    "must_not_say",
    "notes",
    "script_specific_direction",
}


def strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def parse_scalar(value: str) -> Any:
    value = strip_quotes(value.strip())
    if value == "":
        return ""
    if value in {"true", "True"}:
        return True
    if value in {"false", "False"}:
        return False
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [parse_scalar(part.strip()) for part in inner.split(",")]
    return value


def parse_simple_yaml(text: str) -> dict[str, Any]:
    """Parse the small YAML subset used by strategy-plan examples.

    Supported shape: top-level scalars plus `ads:` list of maps. Nested arrays
    can be inline (`[a, b]`) or block lists under an ad key.
    """
    data: dict[str, Any] = {}
    ads: list[dict[str, Any]] = []
    current_ad: dict[str, Any] | None = None
    pending_list_key: str | None = None
    in_ads = False

    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()

        if indent == 0 and stripped == "ads:":
            data["ads"] = ads
            in_ads = True
            current_ad = None
            pending_list_key = None
            continue

        if not in_ads and indent == 0:
            if ":" not in stripped:
                raise ValueError(f"invalid YAML line: {raw}")
            key, value = stripped.split(":", 1)
            data[key.strip()] = parse_scalar(value)
            continue

        if in_ads:
            if stripped.startswith("- "):
                rest = stripped[2:].strip()
                if indent <= 2:
                    current_ad = {}
                    ads.append(current_ad)
                    pending_list_key = None
                    if rest:
                        if ":" not in rest:
                            raise ValueError(f"invalid ad line: {raw}")
                        key, value = rest.split(":", 1)
                        current_ad[key.strip()] = parse_scalar(value)
                    continue
                if current_ad is not None and pending_list_key:
                    current_ad.setdefault(pending_list_key, []).append(parse_scalar(rest))
                    continue
            if current_ad is None:
                raise ValueError(f"ad field before list item: {raw}")
            if ":" not in stripped:
                raise ValueError(f"invalid YAML line: {raw}")
            key, value = stripped.split(":", 1)
            key = key.strip()
            if value.strip() == "":
                current_ad[key] = []
                pending_list_key = key
            else:
                current_ad[key] = parse_scalar(value)
                pending_list_key = None
            continue

        raise ValueError(f"invalid YAML line: {raw}")

    return data


def load_plan(path: Path) -> dict[str, Any]:
    text = path.read_text()
    if path.suffix.lower() == ".json":
        data = json.loads(text)
    else:
        try:
            import yaml  # type: ignore

            data = yaml.safe_load(text)
        except ModuleNotFoundError:
            data = parse_simple_yaml(text)
    if not isinstance(data, dict):
        raise ValueError("strategy plan must be a mapping/object")
    return data


def load_config(product_dir: Path) -> dict[str, Any]:
    cfg = product_dir / "config.json"
    if not cfg.exists():
        raise FileNotFoundError(f"product config not found: {cfg}")
    return json.loads(cfg.read_text())


def product_code_for(product: str, config: dict[str, Any]) -> str:
    return str(config.get("product_code") or config.get("product") or product).strip()


def available_format_templates(base_path: Path) -> set[str]:
    return {p.stem for p in (base_path / "components" / "lfs-formats").glob("*.md")}


def require_card(research_dir: Path, group: str, code: str, errors: list[str], label: str) -> None:
    if not code:
        errors.append(f"{label} is required")
        return
    if not card_path_for(research_dir, group, code).exists():
        errors.append(f"{label} card not found: {group}/{code}.md")


def clean_tag(value: str, angle: str, index: int) -> str:
    raw = value or angle or f"AD{index}"
    tag = re.sub(r"[^A-Za-z0-9]+", "", raw.upper())[:14]
    return tag or f"AD{index}"


def normalize_point(value: str, prefix: str, label: str) -> str:
    value = str(value or "").strip().upper()
    if not re.fullmatch(rf"{prefix}\d+", value):
        raise ValueError(f"{label} must be {prefix}n, got {value!r}")
    return value


def build_task_id(product_code: str, ad: dict[str, Any], index: int, batch_date: str) -> str:
    identity = str(ad.get("archetype") or ad.get("arc") or ad.get("identity") or "").strip().upper()
    if not re.fullmatch(r"ARC\d+", identity):
        raise ValueError(f"ads[{index}].archetype must be ARCn")
    a_point = normalize_point(str(ad.get("a_point") or ""), "A", f"ads[{index}].a_point")
    b_point = normalize_point(str(ad.get("b_point") or ""), "B", f"ads[{index}].b_point")
    mechanism = normalize_point(str(ad.get("mechanism") or ""), "M", f"ads[{index}].mechanism")
    tag = clean_tag(str(ad.get("tag") or ""), str(ad.get("angle") or ""), index)
    date = str(ad.get("date") or batch_date or "V001").strip()
    return f"{product_code}_LFS_{identity}_{a_point}{b_point}_{mechanism}_{tag}_{date}"


def build_strategy(plan: dict[str, Any], *, product: str, batch_id: str, base_path: Path) -> dict[str, Any]:
    product_dir = resolve_product_dir(base_path, product)
    config = load_config(product_dir)
    product_code = product_code_for(product, config)
    research_dir = product_dir / "research"
    formats = available_format_templates(base_path)
    batch_date = str(plan.get("date") or "").strip()
    ads_in = plan.get("ads")
    if not isinstance(ads_in, list) or not ads_in:
        raise ValueError("strategy plan requires non-empty ads list")

    errors: list[str] = []
    ads_out: list[dict[str, Any]] = []
    seen_task_ids: set[str] = set()

    for index, raw_ad in enumerate(ads_in, 1):
        if not isinstance(raw_ad, dict):
            errors.append(f"ads[{index}] must be an object")
            continue
        forbidden = sorted(BUYER_COPY_FIELDS.intersection(raw_ad))
        if forbidden:
            errors.append(f"ads[{index}] contains rejected buyer-copy fields: {', '.join(forbidden)}")
        unknown = sorted(set(raw_ad) - ALLOWED_AD_FIELDS)
        if unknown:
            errors.append(f"ads[{index}] contains unsupported fields: {', '.join(unknown)}")

        fmt = str(raw_ad.get("format") or "").strip()
        mechanism = str(raw_ad.get("mechanism") or "").strip().upper()
        identity = str(raw_ad.get("archetype") or raw_ad.get("arc") or raw_ad.get("identity") or "").strip().upper()
        a_point = str(raw_ad.get("a_point") or "").strip().upper()
        b_point = str(raw_ad.get("b_point") or "").strip().upper()
        angle = str(raw_ad.get("angle") or "").strip()

        if fmt not in formats:
            errors.append(f"ads[{index}].format {fmt!r} has no components/lfs-formats/{fmt}.md")
        require_card(research_dir, "archetypes", identity, errors, f"ads[{index}].archetype")
        require_card(research_dir, "hotwords", a_point, errors, f"ads[{index}].a_point")
        require_card(research_dir, "hotwords", b_point, errors, f"ads[{index}].b_point")
        require_card(research_dir, "mechanisms", mechanism, errors, f"ads[{index}].mechanism")
        if not angle:
            errors.append(f"ads[{index}].angle is required")

        try:
            task_id = str(raw_ad.get("task_id") or "").strip() or build_task_id(product_code, raw_ad, index, batch_date)
            parsed = parse_task_id(task_id)
            if parsed.product != product_code:
                errors.append(f"ads[{index}].task_id product {parsed.product!r} must be {product_code!r}")
            if parsed.format != "lfs":
                errors.append(f"ads[{index}].task_id format must be LFS")
            if parsed.archetype_code != identity:
                errors.append(f"ads[{index}].task_id archetype {parsed.archetype_code!r} must match {identity!r}")
            if parsed.a_point != a_point or parsed.b_point != b_point:
                errors.append(f"ads[{index}].task_id A/B {parsed.a_point}{parsed.b_point} must match {a_point}{b_point}")
            if parsed.mechanism_code != mechanism:
                errors.append(f"ads[{index}].task_id mechanism {parsed.mechanism_code!r} must match {mechanism!r}")
        except Exception as exc:
            errors.append(f"ads[{index}].task_id invalid: {exc}")
            task_id = str(raw_ad.get("task_id") or f"INVALID_{index}")

        if task_id in seen_task_ids:
            errors.append(f"duplicate task_id: {task_id}")
        seen_task_ids.add(task_id)

        out: dict[str, Any] = {
            "task_id": task_id,
            "angle": angle,
            "format": fmt,
            "mechanism": mechanism,
        }
        for key in OPTIONAL_OUTPUT_FIELDS:
            value = raw_ad.get(key)
            if value not in (None, "", []):
                out[key] = value
        if raw_ad.get("edge") and "edge_to_preserve" not in out:
            out["edge_to_preserve"] = raw_ad["edge"]
        if raw_ad.get("mechanism_focus") and "proof_focus" not in out:
            out["proof_focus"] = raw_ad["mechanism_focus"]
        ads_out.append(out)

    if errors:
        raise ValueError("Invalid strategy plan:\n- " + "\n- ".join(errors))

    strategy = {
        "batch_id": batch_id,
        "product": product_code,
        "format": "lfs",
        "variant": str(plan.get("variant") or "native"),
        "description": str(plan.get("description") or f"{product_code} LFS V4.1 batch built from strategy plan."),
        "cta_text": str(plan.get("cta_text") or config.get("cta_text") or config.get("cta") or ""),
        "ads": ads_out,
    }
    contract_errors = validate_intent_ads(strategy)
    if contract_errors:
        raise ValueError("Invalid generated strategy contract:\n- " + "\n- ".join(contract_errors))
    compile_spec(strategy)  # validates downstream spec contract without writing
    return strategy


def main() -> int:
    ap = argparse.ArgumentParser(description="Build V4.1 strategy.json from strategy-plan YAML/JSON")
    ap.add_argument("build", nargs="?", help=argparse.SUPPRESS)
    ap.add_argument("--product", required=True, help="Product code or folder")
    ap.add_argument("--batch-id", required=True)
    ap.add_argument("--plan", required=True, type=Path)
    ap.add_argument("--base-path", type=Path, default=REPO)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    try:
        plan = load_plan(args.plan)
        strategy = build_strategy(plan, product=args.product, batch_id=args.batch_id, base_path=args.base_path.resolve())
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    batch_dir = batch_dir_for_write(
        base_path=args.base_path.resolve(),
        batch_id=args.batch_id,
        product=strategy["product"],
        source_path=None,
    )
    strategy_path = batch_dir / "strategy.json"
    if args.dry_run:
        print(json.dumps(strategy, indent=2))
        print(f"\n[dry-run] would write {strategy_path}", file=sys.stderr)
        return 0
    if strategy_path.exists() and not args.force:
        print(f"Error: refusing to overwrite existing {strategy_path} without --force", file=sys.stderr)
        return 1
    batch_dir.mkdir(parents=True, exist_ok=True)
    strategy_path.write_text(json.dumps(strategy, indent=2) + "\n")
    print(f"Wrote {strategy_path}")
    print(f"Next: ww lfs-v41 {strategy_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

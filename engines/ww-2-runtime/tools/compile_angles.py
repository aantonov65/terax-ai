#!/usr/bin/env python3
"""Compile strategist-authored angles.md into a product-scoped WWX batch."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

from compile_spec import compile_spec
from context import PRODUCT_FOLDERS, parse_task_id
from ww_artifacts import write_artifact_manifest
from ww_paths import batch_dir_for_write, product_dir


FENCED_JSON_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)
HEADING_RE = re.compile(r"^(#{2,3})\s+(.+?)\s*$", re.MULTILINE)
RAW_META_RE = re.compile(r"^\*\*(?P<key>[^:*]+):\*\*\s*(?P<value>.+?)\s*$", re.MULTILINE)
SOURCE_NUMBER_RE = re.compile(r"^S(?P<num>\d+)", re.IGNORECASE)


def slugify(value: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9]+", "_", value.strip()).strip("_")
    return clean.upper() or "ANGLE"


def parse_scalar(value: str) -> Any:
    value = value.strip()
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    if value.startswith("[") or value.startswith("{"):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def parse_fields(text: str) -> dict[str, Any]:
    """Parse a small YAML-like key/value block without external deps."""
    fields: dict[str, Any] = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        if not raw.strip() or raw.lstrip().startswith("#"):
            i += 1
            continue
        match = re.match(r"^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$", raw)
        if not match:
            i += 1
            continue
        key, value = match.group(1), match.group(2)
        if value.strip() == "|":
            block: list[str] = []
            i += 1
            while i < len(lines):
                nxt = lines[i]
                if re.match(r"^[A-Za-z][A-Za-z0-9_-]*:\s*", nxt):
                    break
                block.append(nxt[2:] if nxt.startswith("  ") else nxt)
                i += 1
            fields[key] = "\n".join(block).strip()
            continue
        fields[key] = parse_scalar(value)
        i += 1
    return fields


def split_frontmatter(markdown: str) -> tuple[dict[str, Any], str]:
    if not markdown.startswith("---\n"):
        return {}, markdown
    end = markdown.find("\n---", 4)
    if end == -1:
        return {}, markdown
    front = markdown[4:end]
    rest = markdown[end + len("\n---") :].lstrip("\n")
    return parse_fields(front), rest


def section_blocks(markdown: str) -> list[tuple[int, str, str]]:
    matches = list(HEADING_RE.finditer(markdown))
    blocks: list[tuple[int, str, str]] = []
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(markdown)
        blocks.append((len(match.group(1)), match.group(2).strip(), markdown[start:end].strip()))
    return blocks


def parse_markdown_angles(markdown: str) -> dict[str, Any]:
    front, body = split_frontmatter(markdown)
    strategy: dict[str, Any] = {
        "format": "lfs",
        "variant": "native",
        **front,
    }

    ads: list[dict[str, Any]] = []
    images: list[dict[str, Any]] = []
    mode = "ads"

    for level, title, content in section_blocks(body):
        title_key = title.strip().lower()
        if level == 2 and title_key in {"ads", "angles"}:
            mode = "ads"
            continue
        if level == 2 and title_key in {"images", "image specs", "image-specs"}:
            mode = "images"
            continue
        if level != 3:
            continue

        fields = parse_fields(content)
        if mode == "images":
            fields.setdefault("id", title)
            images.append(fields)
            continue

        fields.setdefault("task_id", title)
        ads.append(fields)

    if ads:
        strategy["ads"] = ads
    if images:
        strategy["images"] = images
    return strategy


def load_angles(path: Path) -> dict[str, Any]:
    markdown = path.read_text()
    fenced = FENCED_JSON_RE.search(markdown)
    if fenced:
        return json.loads(fenced.group(1))
    return parse_markdown_angles(markdown)


def infer_product_from_path(path: Path, base_path: Path, context_product: str | None = None) -> str:
    if str(context_product or "").strip():
        return str(context_product).strip()
    try:
        rel = path.resolve().relative_to(base_path.resolve())
    except ValueError:
        rel = path.resolve()
    parts = list(rel.parts)
    if "products" not in parts:
        raise ValueError("raw angle.md is missing product; place it under products/<PRODUCT>/... or add frontmatter")
    idx = parts.index("products")
    if idx + 1 >= len(parts):
        raise ValueError("raw angle.md path does not include a product folder")
    folder = parts[idx + 1]
    inverse = {folder_name: code for code, folder_name in PRODUCT_FOLDERS.items()}
    if folder in inverse:
        return inverse[folder]
    cfg_path = base_path / "products" / folder / "config.json"
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text())
        except Exception:
            cfg = {}
        for key in ("product", "product_code", "code"):
            value = str(cfg.get(key) or "").strip()
            if value:
                return value
    return folder


def raw_meta(markdown: str) -> dict[str, str]:
    return {
        match.group("key").strip().lower(): match.group("value").strip()
        for match in RAW_META_RE.finditer(markdown)
    }


def first_heading(markdown: str) -> str:
    match = re.search(r"^#\s+(.+?)\s*$", markdown, re.MULTILINE)
    return match.group(1).strip() if match else ""


def source_number(path: Path, title: str) -> str:
    for value in (path.stem, title):
        match = SOURCE_NUMBER_RE.search(value.strip())
        if match:
            return f"S{int(match.group('num')):02d}"
    return "S01"


def format_from_framework(framework: str, title: str) -> str:
    value = f"{framework} {title}".lower()
    if "q&a" in value or "questions" in value or "listicle" in value:
        return "listicle"
    if "diary" in value:
        return "transformation-log"
    if "cancelled consultation" in value or "cardiologist" in value or "nephrologist" in value or "endocrinologist" in value:
        return "authority"
    if "insider" in value or "legal drug dealer" in value or "herbalist" in value:
        return "secret-insider"
    if "family story" in value:
        return "confession-other-side"
    if "direct mechanism" in value:
        return "versus"
    if "direct advice" in value or "direct address" in value or "urgency" in value:
        return "warning"
    if "personal confessional" in value or "confessional" in value:
        return "confession"
    return "confession"


def archetype_from_target(target: str, title: str) -> str:
    value = f"{target} {title}".lower()
    if any(token in value for token in ("doctor", "medical", "kidney", "liver", "thyroid", "diabetic", "cholesterol", "consultation", "ckd")):
        return "ARC4"
    if any(token in value for token in ("hormone", "hrt", "menopause", "levothyroxine", "hashimoto")):
        return "ARC2"
    if any(token in value for token in ("diet", "food", "immune", "sick")):
        return "ARC3"
    if any(token in value for token in ("social", "shame", "family")):
        return "ARC5"
    return "ARC1"


def mechanism_from_config(product: str, base_path: Path) -> str:
    cfg_path = product_dir(product, base_path) / "config.json"
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text())
        except Exception:
            cfg = {}
        mechanisms = cfg.get("mechanisms")
        if isinstance(mechanisms, dict) and mechanisms:
            for key in sorted(mechanisms):
                if re.match(r"^M\d+$", str(key)):
                    return str(key)
    return "M1"


def cta_from_config(product: str, base_path: Path) -> str:
    cfg_path = product_dir(product, base_path) / "config.json"
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text())
        except Exception:
            cfg = {}
        cta = str(cfg.get("cta_text") or "").strip()
        if cta:
            return cta
    return "Click \"LEARN MORE\" below to read the article."


def source_path_for_strategy(path: Path, base_path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(base_path.resolve()))
    except ValueError:
        return str(resolved)


def expand_raw_rip_angle(
    path: Path,
    base_path: Path,
    strategy: dict[str, Any],
    *,
    context_product: str | None = None,
    context_batch_id: str | None = None,
) -> dict[str, Any]:
    """Turn a copied swipe/rip markdown file into a one-ad LFS strategy.

    Strategists often start from a raw angle rip whose only structure is the
    title, framework, target condition, and full ad copy. The guided desktop
    workflow still needs the canonical V4.1 strategy/spec contract, so this
    builds the minimal deterministic intent card and keeps the original file as
    the source swipe for the outline stage.
    """
    markdown = path.read_text()
    title = first_heading(markdown) or path.stem
    meta = raw_meta(markdown)
    product = str(strategy.get("product") or infer_product_from_path(path, base_path, context_product))
    number = source_number(path, title)
    title_slug = slugify(re.sub(r"^S\d+\s*[-–—:]*\s*", "", path.stem, flags=re.IGNORECASE))
    batch_id = str(strategy.get("batch_id") or context_batch_id or f"{product}_LFS_{number}_{title_slug}")
    framework = str(strategy.get("framework") or meta.get("framework") or title)
    target = str(strategy.get("target_condition") or meta.get("target condition") or meta.get("target") or "")
    opening = str(strategy.get("opening") or meta.get("opening") or "")
    lfs_format = str(strategy.get("lfs_format_template") or format_from_framework(framework, title))
    mechanism = str(strategy.get("mechanism") or mechanism_from_config(product, base_path))
    archetype = str(strategy.get("archetype") or archetype_from_target(target, title))
    task_id = str(strategy.get("task_id") or f"{product}_LFS_{archetype}_A1B1_{mechanism}_V001")

    angle_bits = [title]
    if target:
        angle_bits.append(f"Target condition: {target}")
    if opening:
        angle_bits.append(f"Opening pressure: {opening}")

    expanded = {
        "product": product,
        "batch_id": batch_id,
        "format": "lfs",
        "variant": "native",
        "lfs_format_template": lfs_format,
        "cta_text": str(strategy.get("cta_text") or cta_from_config(product, base_path)),
        "description": str(strategy.get("description") or f"Raw rip angle compiled from {path.name}."),
        "ads": [
            {
                "task_id": task_id,
                "angle": " | ".join(bit for bit in angle_bits if bit),
                "format": lfs_format,
                "mechanism": mechanism,
                "source_swipe": source_path_for_strategy(path, base_path),
                "edge_to_preserve": f"Preserve the {framework} pressure curve and the opening: {opening}".strip(),
                "notes": "Auto-compiled from raw angle markdown; use the source swipe as emotional and structural reference, not as product truth.",
            }
        ],
    }
    return {**strategy, **expanded}


def needs_raw_rip_expansion(strategy: dict[str, Any]) -> bool:
    if str(strategy.get("product") or "").strip() and strategy.get("ads"):
        return False
    return True


def image_keys_from_angles(strategy: dict[str, Any]) -> dict[str, Any]:
    image_spec: dict[str, Any] = {}
    for key in (
        "model",
        "fal_model",
        "aspect_ratio",
        "image_size",
        "overlay_style",
        "composite_prompt",
        "product_image",
        "reference_images",
        "scene_file",
        "fal_key",
    ):
        if key in strategy:
            image_spec[key] = strategy[key]
    if strategy.get("images"):
        image_spec["images"] = strategy["images"]
    return image_spec


def validate_angles_strategy(strategy: dict[str, Any]) -> None:
    missing = [
        key for key in ("product", "batch_id", "cta_text")
        if not str(strategy.get(key) or "").strip()
    ]
    if missing:
        raise ValueError(f"angles.md missing required field(s): {', '.join(missing)}")
    ads = strategy.get("ads")
    if not isinstance(ads, list) or not ads:
        raise ValueError("angles.md must define at least one ad under ## Ads")
    for idx, ad in enumerate(ads, 1):
        if not isinstance(ad, dict):
            raise ValueError(f"ads[{idx}] must be an object")
        task_id = str(ad.get("task_id") or "").strip()
        angle = str(ad.get("angle") or "").strip()
        fmt = str(ad.get("format") or strategy.get("lfs_format_template") or strategy.get("format") or "").strip()
        mechanism = str(ad.get("mechanism") or "").strip()
        if not task_id:
            raise ValueError(f"ads[{idx}].task_id is required")
        parsed = parse_task_id(task_id)
        if not angle:
            raise ValueError(f"ads[{idx}].angle is required")
        if not fmt:
            raise ValueError(f"ads[{idx}].format is required")
        if not mechanism:
            raise ValueError(f"ads[{idx}].mechanism is required")
        if parsed.mechanism_code != mechanism:
            raise ValueError(
                f"ads[{idx}].mechanism {mechanism!r} does not match task ID mechanism {parsed.mechanism_code!r}"
            )


def compiled_strategy(strategy: dict[str, Any]) -> dict[str, Any]:
    clean = dict(strategy)
    clean.pop("images", None)
    for key in (
        "model",
        "fal_model",
        "aspect_ratio",
        "image_size",
        "overlay_style",
        "composite_prompt",
        "product_image",
        "reference_images",
        "scene_file",
        "fal_key",
    ):
        clean.pop(key, None)
    return clean


def compile_angles(
    path: Path,
    *,
    base_path: Path,
    dry_run: bool = False,
    force: bool = False,
    context_product: str | None = None,
    context_batch_id: str | None = None,
) -> dict[str, Any]:
    strategy_with_images = load_angles(path)
    if needs_raw_rip_expansion(strategy_with_images):
        strategy_with_images = expand_raw_rip_angle(
            path,
            base_path,
            strategy_with_images,
            context_product=context_product,
            context_batch_id=context_batch_id,
        )
    validate_angles_strategy(strategy_with_images)
    strategy = compiled_strategy(strategy_with_images)
    spec = compile_spec(strategy)
    spec.update(image_keys_from_angles(strategy_with_images))

    batch_dir = batch_dir_for_write(
        base_path=base_path,
        batch_id=spec["batch_id"],
        product=spec["product"],
        source_path=path,
    )

    result = {
        "schema": "wwx-angles-compile/v1",
        "batch_id": spec["batch_id"],
        "product": spec["product"],
        "batch_dir": str(batch_dir),
        "strategy": strategy,
        "spec": spec,
    }
    if dry_run:
        return result

    batch_dir.mkdir(parents=True, exist_ok=True)
    canonical_angles = batch_dir / "angles.md"
    if path.resolve() != canonical_angles.resolve():
        if canonical_angles.exists() and not force:
            raise FileExistsError(f"refusing to overwrite existing {canonical_angles}; use --force")
        shutil.copyfile(path, canonical_angles)

    for filename, payload in (("strategy.json", strategy), ("spec.json", spec)):
        out = batch_dir / filename
        if out.exists() and not force:
            try:
                existing = json.loads(out.read_text())
            except Exception:
                existing = None
            if existing != payload:
                raise FileExistsError(f"refusing to overwrite different {out}; use --force")
        out.write_text(json.dumps(payload, indent=2) + "\n")

    write_artifact_manifest(batch_dir, batch_id=spec["batch_id"], product=spec["product"])
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile product-scoped angles.md into WWX strategy/spec artifacts")
    parser.add_argument("angles", type=Path)
    parser.add_argument("--base-path", "-b", type=Path, default=Path(__file__).parent.parent)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    try:
        result = compile_angles(args.angles, base_path=args.base_path, dry_run=args.dry_run, force=args.force)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps({k: v for k, v in result.items() if k not in {"strategy", "spec"}}, indent=2))
    if args.dry_run:
        print(json.dumps({"strategy": result["strategy"], "spec": result["spec"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

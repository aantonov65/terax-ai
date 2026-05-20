#!/usr/bin/env python3
"""Shared filesystem path resolution for WW-2 workspaces.

Canonical batch storage is product-scoped:

    products/{PRODUCT_FOLDER}/batches/{BATCH_ID}

Legacy top-level batches are still readable for migration and old artifacts:

    batches/{BATCH_ID}
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _product_folders() -> dict[str, str]:
    try:
        from context import PRODUCT_FOLDERS
    except Exception:
        return {}
    return dict(PRODUCT_FOLDERS)


def product_folder(product_code: str, base_path: Path) -> str:
    """Return the product folder name for a product code."""
    product_code = str(product_code or "").strip()
    if not product_code:
        raise ValueError("product code is required")

    mapped = _product_folders().get(product_code)
    if mapped:
        return mapped

    direct = base_path / "products" / product_code
    if direct.exists():
        return product_code

    for cfg_path in (base_path / "products").glob("*/config.json"):
        try:
            cfg = json.loads(cfg_path.read_text())
        except Exception:
            continue
        candidates = {
            str(cfg.get("product") or "").strip(),
            str(cfg.get("product_code") or "").strip(),
            str(cfg.get("code") or "").strip(),
            cfg_path.parent.name,
        }
        if product_code in candidates:
            return cfg_path.parent.name

    return product_code


def product_dir(product_code: str, base_path: Path) -> Path:
    return base_path / "products" / product_folder(product_code, base_path)


def nested_batch_dir(product_code: str, batch_id: str, base_path: Path) -> Path:
    return product_dir(product_code, base_path) / "batches" / batch_id


def legacy_batch_dir(batch_id: str, base_path: Path) -> Path:
    return base_path / "batches" / batch_id


def _path_is_batch_dir(path: Path) -> bool:
    return path.is_dir() and any(
        (path / name).exists()
        for name in (
            "angles.md",
            "strategy.json",
            "spec.json",
            "lfs-v41-report.json",
            "lfs-v41-manifest.json",
            "report.json",
        )
    )


def _find_nested_batch_dirs(batch_id: str, base_path: Path) -> list[Path]:
    products = base_path / "products"
    if not products.exists():
        return []
    found: dict[Path, Path] = {}
    for path in sorted(products.glob(f"*/batches/{batch_id}")):
        if not path.is_dir():
            continue
        resolved = path.resolve()
        found.setdefault(resolved, path)
    return list(found.values())


def batch_dir_for_write(
    *,
    base_path: Path,
    batch_id: str,
    product: str | None = None,
    source_path: Path | None = None,
) -> Path:
    """Choose where new batch artifacts should be written.

    If the source file already lives inside a batch folder, write beside it.
    Otherwise, new product-scoped batches are canonical when product is known.
    """
    if source_path is not None:
        source = source_path.resolve()
        parent = source.parent if source.is_file() else source
        if parent.name == batch_id or parent.parent.name == "batches":
            return parent

    if product:
        return nested_batch_dir(product, batch_id, base_path)

    nested = _find_nested_batch_dirs(batch_id, base_path)
    if len(nested) == 1:
        return nested[0]
    if len(nested) > 1:
        joined = "\n".join(str(path) for path in nested)
        raise ValueError(f"ambiguous nested batch_id {batch_id!r}; candidates:\n{joined}")

    return legacy_batch_dir(batch_id, base_path)


def resolve_batch_dir(
    batch_ref: str | Path,
    *,
    base_path: Path,
    product: str | None = None,
    must_exist: bool = True,
) -> Path:
    """Resolve a batch id, batch directory, or artifact path to a batch dir."""
    raw = Path(batch_ref)
    if raw.is_absolute() or any(sep in str(batch_ref) for sep in ("/", "\\")):
        candidate = raw if raw.is_absolute() else base_path / raw
        if candidate.is_file():
            candidate = candidate.parent
        if not must_exist or candidate.exists():
            return candidate
        raise FileNotFoundError(f"batch path not found: {candidate}")

    batch_id = str(batch_ref)
    if product:
        nested = nested_batch_dir(product, batch_id, base_path)
        if nested.exists() or not must_exist:
            return nested

    nested_matches = _find_nested_batch_dirs(batch_id, base_path)
    legacy = legacy_batch_dir(batch_id, base_path)
    existing = [path for path in nested_matches if path.exists()]
    if legacy.exists():
        existing.append(legacy)

    if len(existing) == 1:
        return existing[0]
    if len(existing) > 1:
        joined = "\n".join(str(path) for path in existing)
        raise ValueError(f"ambiguous batch_id {batch_id!r}; candidates:\n{joined}")

    if not must_exist:
        return nested_batch_dir(product, batch_id, base_path) if product else legacy
    raise FileNotFoundError(f"batch not found: {batch_id}")


def batch_id_for_dir(batch_dir: Path) -> str:
    return batch_dir.name


def load_batch_spec(batch_ref: str | Path, *, base_path: Path, product: str | None = None) -> tuple[Path, dict[str, Any]]:
    batch_dir = resolve_batch_dir(batch_ref, base_path=base_path, product=product)
    spec_path = batch_dir / "spec.json"
    if not spec_path.exists():
        raise FileNotFoundError(f"Spec file not found: {spec_path}")
    return batch_dir, json.loads(spec_path.read_text())

#!/usr/bin/env python3
"""Mechanical research-card compiler and loader for LFS V4.

Cards are product-scoped slices of existing research files. The compiler does
not summarize, rewrite, or improve source text. It cuts markdown sections into
`products/{PRODUCT}/research/cards/...` and verifies byte-equivalence after
normalizing outer whitespace.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


REPO = Path(__file__).resolve().parents[1]

CARD_GROUPS = {
    "archetypes": {
        "source": "archetypes.md",
        "prefixes": ("ARC",),
    },
    "hotwords": {
        "source": "hotwords.md",
        "prefixes": ("A", "B"),
    },
    "mechanisms": {
        "source": "mechanisms.md",
        "prefixes": ("M",),
    },
}


@dataclass
class CardRecord:
    group: str
    code: str
    source_path: str
    card_path: str
    status: str
    error: str = ""

    def as_dict(self) -> dict[str, str]:
        return {
            "group": self.group,
            "code": self.code,
            "source_path": self.source_path,
            "card_path": self.card_path,
            "status": self.status,
            "error": self.error,
        }


@dataclass
class SliceResult:
    text: str
    source: str
    status: str


@dataclass
class SectionRecord:
    code: str
    text: str
    scope: str = ""
    scope_title: str = ""


def resolve_product_dir(base_path: Path, product: str) -> Path:
    """Resolve a product folder.

    Prefer an exact folder match. If absent, scan configs for product_code or
    brand matches so product aliases still work.
    """
    direct = base_path / "products" / product
    if direct.exists():
        return direct

    try:
        from context import PRODUCT_FOLDERS
    except Exception:
        PRODUCT_FOLDERS = {}
    mapped = PRODUCT_FOLDERS.get(product)
    if mapped:
        mapped_path = base_path / "products" / mapped
        if mapped_path.exists():
            return mapped_path

    products_dir = base_path / "products"
    for cfg_path in products_dir.glob("*/config.json"):
        try:
            cfg = json.loads(cfg_path.read_text())
        except Exception:
            continue
        if (
            str(cfg.get("product_code") or "") == product
            or str(cfg.get("brand") or "").lower() == product.lower()
            or cfg_path.parent.name == product
        ):
            return cfg_path.parent
    return direct


def parse_section_records(markdown: str, prefixes: Iterable[str]) -> list[SectionRecord]:
    """Return ordered markdown `## CODE:` or `### CODE:` sections with their nearest `#` scope."""
    prefix_alt = "|".join(re.escape(p) for p in prefixes)
    header_re = re.compile(rf"(?m)^###?\s+(({prefix_alt})\d+(?:_[A-Z]+)?)(?=[:\s])")
    matches = list(header_re.finditer(markdown))
    scope_headers = list(re.finditer(r"(?m)^#\s+(.+?)\s*$", markdown))
    records: list[SectionRecord] = []
    for idx, match in enumerate(matches):
        code = match.group(1)
        start = match.start()
        next_section = matches[idx + 1].start() if idx + 1 < len(matches) else len(markdown)
        scope_title = ""
        next_scope = len(markdown)
        for header in scope_headers:
            if header.start() < start:
                scope_title = header.group(1).strip()
                continue
            next_scope = header.start()
            break
        end = min(next_section, next_scope)
        records.append(SectionRecord(code=code, text=markdown[start:end].strip(), scope_title=scope_title))
    return records


def parse_sections(markdown: str, prefixes: Iterable[str]) -> dict[str, str]:
    """Return `{code: full_section_text}` for markdown `## CODE:` sections."""
    sections: dict[str, str] = {}
    for record in parse_section_records(markdown, prefixes):
        if record.code in sections:
            raise ValueError(f"duplicate section code {record.code}")
        sections[record.code] = record.text
    return sections


def hotword_scopes_for_title(title: str) -> list[str]:
    """Extract explicit deterministic scope prefixes from a parent heading.

    Duplicate hotword codes are allowed only when the source heading names the
    scope directly, for example `# ARC2 M1 Plantar lane` above `## A1`.
    Never infer scopes from condition words; that would make the compiler
    product-specific.
    """
    arc_codes = re.findall(r"(?<![A-Za-z0-9_])(ARC\d+)(?![A-Za-z0-9_])", title)
    mechanism_codes = re.findall(r"(?<![A-Za-z0-9_])(M\d+)(?![A-Za-z0-9_])", title)

    scopes: list[str] = []
    for mechanism in mechanism_codes:
        for arc in arc_codes:
            scopes.append(f"{mechanism}_{arc}")
    for arc in arc_codes:
        scopes.append(arc)
    if not arc_codes:
        for mechanism in mechanism_codes:
            scopes.append(mechanism)

    seen: set[str] = set()
    return [scope for scope in scopes if not (scope in seen or seen.add(scope))]


def parse_scoped_hotword_sections(markdown: str, prefixes: Iterable[str]) -> dict[str, str]:
    records = parse_section_records(markdown, prefixes)
    scoped: dict[str, str] = {}
    unscoped: dict[str, str] = {}
    seen: set[str] = set()
    duplicates = {record.code for record in records if record.code in seen or seen.add(record.code)}

    if not duplicates:
        return {record.code: record.text for record in records}

    for record in records:
        if record.code not in duplicates:
            unscoped[record.code] = record.text
            continue
        scopes = hotword_scopes_for_title(record.scope_title)
        if not scopes:
            raise ValueError(
                f"duplicate section code {record.code} must be under an explicit scope heading like '# ARC1 M1 ...'"
            )
        for scope in scopes:
            scoped_code = f"{scope}_{record.code}"
            if scoped_code in scoped:
                raise ValueError(f"duplicate scoped section code {scoped_code}")
            scoped[scoped_code] = record.text

    return {**unscoped, **scoped}


def parse_group_sections(markdown: str, group: str, prefixes: Iterable[str]) -> dict[str, str]:
    if group == "hotwords":
        return parse_scoped_hotword_sections(markdown, prefixes)
    return parse_sections(markdown, prefixes)


def load_hotword_card_or_section(
    research_dir: Path,
    *,
    code: str,
    mechanism_code: str = "",
    archetype_code: str = "",
    source_path: Path | None = None,
) -> SliceResult:
    """Load a mechanism-scoped hotword card first, then the normal hotword code."""
    scoped_codes: list[str] = []
    if mechanism_code and archetype_code:
        scoped_codes.append(f"{mechanism_code}_{archetype_code}_{code}")
    if archetype_code:
        scoped_codes.append(f"{archetype_code}_{code}")
    if mechanism_code and not archetype_code:
        scoped_codes.append(f"{mechanism_code}_{code}")
    for scoped_code in scoped_codes:
        scoped = load_card_or_section(
            research_dir,
            group="hotwords",
            code=scoped_code,
            source_path=source_path,
        )
        if scoped.text:
            return scoped
    fallback = load_card_or_section(
        research_dir,
        group="hotwords",
        code=code,
        source_path=source_path,
    )
    if fallback.text:
        return fallback
    tried = scoped_codes + [code]
    return SliceResult("", f"{fallback.source}; tried hotword codes: {', '.join(tried)}", "missing")


def card_path_for(research_dir: Path, group: str, code: str) -> Path:
    return research_dir / "cards" / group / f"{code}.md"


def source_path_for(research_dir: Path, group: str) -> Path:
    return research_dir / str(CARD_GROUPS[group]["source"])


def load_card_or_section(
    research_dir: Path,
    *,
    group: str,
    code: str,
    source_path: Path | None = None,
) -> SliceResult:
    """Prefer a card, then fall back to a legacy research section."""
    card = card_path_for(research_dir, group, code)
    if card.exists():
        return SliceResult(card.read_text().strip(), str(card), "card")

    source = source_path or source_path_for(research_dir, group)
    if not source.exists():
        return SliceResult("", str(source), "missing")
    sections = parse_group_sections(source.read_text(), group, CARD_GROUPS[group]["prefixes"])
    text = sections.get(code, "")
    if text:
        return SliceResult(text, str(source), "legacy")
    return SliceResult("", str(source), "missing")


def compile_group(
    research_dir: Path,
    group: str,
    *,
    verify: bool,
    dry_run: bool,
    force: bool,
) -> list[CardRecord]:
    meta = CARD_GROUPS[group]
    source = source_path_for(research_dir, group)
    if not source.exists():
        return [CardRecord(group, "", str(source), "", "failed", f"missing source file: {source}")]

    try:
        sections = parse_group_sections(source.read_text(), group, meta["prefixes"])
    except ValueError as exc:
        return [CardRecord(group, "", str(source), "", "failed", str(exc))]

    records: list[CardRecord] = []
    if not sections:
        return [CardRecord(group, "", str(source), "", "failed", f"no sections found in {source.name}")]

    for code, section in sorted(sections.items()):
        card = card_path_for(research_dir, group, code)
        if not section.strip():
            records.append(CardRecord(group, code, str(source), str(card), "failed", "empty source section"))
            continue

        if card.exists():
            existing = card.read_text().strip()
            if existing == section.strip():
                records.append(CardRecord(group, code, str(source), str(card), "verified"))
            elif force and not verify:
                if not dry_run:
                    card.write_text(section.strip() + "\n")
                records.append(CardRecord(group, code, str(source), str(card), "rewritten"))
            else:
                records.append(CardRecord(group, code, str(source), str(card), "failed", "card differs from source section"))
            continue

        if verify:
            records.append(CardRecord(group, code, str(source), str(card), "failed", "card missing"))
            continue

        if not dry_run:
            card.parent.mkdir(parents=True, exist_ok=True)
            card.write_text(section.strip() + "\n")
        records.append(CardRecord(group, code, str(source), str(card), "created" if not dry_run else "would_create"))

    return records


def run_research_cards(
    product: str,
    *,
    base_path: Path = REPO,
    verify: bool = False,
    dry_run: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    product_dir = resolve_product_dir(base_path, product)
    research_dir = product_dir / "research"
    if not research_dir.exists():
        raise FileNotFoundError(f"research folder not found: {research_dir}")

    records: list[CardRecord] = []
    for group in CARD_GROUPS:
        records.extend(compile_group(research_dir, group, verify=verify, dry_run=dry_run, force=force))

    failed = [r for r in records if r.status == "failed"]
    report = {
        "schema": "research-cards-report/v1",
        "product": product,
        "product_dir": str(product_dir),
        "verify": verify,
        "dry_run": dry_run,
        "force": force,
        "created": sum(1 for r in records if r.status == "created"),
        "rewritten": sum(1 for r in records if r.status == "rewritten"),
        "verified": sum(1 for r in records if r.status == "verified"),
        "would_create": sum(1 for r in records if r.status == "would_create"),
        "failed": len(failed),
        "records": [r.as_dict() for r in records],
    }
    if not dry_run:
        (research_dir / "cards-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def print_report(report: dict[str, Any]) -> None:
    print(f"Research cards for {report['product']} ({report['product_dir']})")
    print(
        f"  created={report['created']} rewritten={report['rewritten']} "
        f"verified={report['verified']} failed={report['failed']}"
    )
    for rec in report["records"]:
        marker = "✓" if rec["status"] in {"created", "rewritten", "verified", "would_create"} else "✗"
        code = rec["code"] or rec["group"]
        detail = f" — {rec['error']}" if rec["error"] else ""
        print(f"  {marker} {rec['group']}/{code} [{rec['status']}]{detail}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Compile or verify product research cards")
    ap.add_argument("product", help="Product code or product folder")
    ap.add_argument("--base-path", type=Path, default=REPO)
    ap.add_argument("--verify", action="store_true", help="Verify existing cards instead of writing missing cards")
    ap.add_argument("--dry-run", action="store_true", help="Preview without writing files")
    ap.add_argument("--force", action="store_true", help="Rewrite differing cards from source sections")
    ap.add_argument("--json", action="store_true", help="Print JSON report")
    args = ap.parse_args()

    try:
        report = run_research_cards(
            args.product,
            base_path=args.base_path,
            verify=args.verify,
            dry_run=args.dry_run,
            force=args.force,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report)
    return 0 if report["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

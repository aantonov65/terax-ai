#!/usr/bin/env python3
"""LFS deterministic verifier.

Runs the docs/lfs-qa-checklist.md CRITICAL + HIGH checks against generated LFS scripts.
No LLM. Pure regex + config lookup. Returns structured violations the fixer can act on.

Usage:
    python tools/lfs_verify.py --batch BATCH_ID                    # report only
    python tools/lfs_verify.py --batch BATCH_ID --json              # machine-readable
    python tools/lfs_verify.py --script path/to/script.md \\
        --product PRODUCT --cta "..."                                # single script

Exit codes:
    0 — all scripts pass
    1 — at least one script has violations
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from format_contracts import LFS_NATIVE
from context import PRODUCT_FOLDERS
from lfs_policy import build_v41_objective_report, split_v41_violations
from ww_paths import resolve_batch_dir

REPO = Path(__file__).resolve().parent.parent
LFS_WORD_COUNT_MAX = 2000


# ---------- data model ----------

@dataclass
class Violation:
    """One specific failure with enough context for the fixer to patch it."""
    severity: str          # CRITICAL | HIGH | MEDIUM
    code: str              # short stable identifier
    message: str           # human-readable description
    detail: dict = field(default_factory=dict)  # patch hints


@dataclass
class Result:
    script_path: str
    word_count: int
    brand_count_total: int
    brand_count_second_half: int
    violations: list[Violation]

    @property
    def passed(self) -> bool:
        return self.critical_count == 0 and self.high_count == 0

    @property
    def critical_count(self) -> int:
        return sum(1 for v in self.violations if v.severity == "CRITICAL")

    @property
    def high_count(self) -> int:
        return sum(1 for v in self.violations if v.severity == "HIGH")


# ---------- config loading ----------

def load_product_config(product_code: str) -> dict:
    """Find products/<dir>/config.json by matching the product field."""
    products_dir = REPO / "products"
    direct = products_dir / product_code / "config.json"
    if direct.exists():
        return json.loads(direct.read_text())
    mapped = PRODUCT_FOLDERS.get(product_code)
    if mapped:
        mapped_path = products_dir / mapped / "config.json"
        if mapped_path.exists():
            return json.loads(mapped_path.read_text())
    # fallback: scan
    for cfg_path in products_dir.glob("*/config.json"):
        try:
            cfg = json.loads(cfg_path.read_text())
        except Exception:
            continue
        if (
            cfg.get("product_code") == product_code
            or cfg_path.parent.name == product_code
            or str(cfg.get("brand", "")).lower() == product_code.lower()
        ):
            return cfg
    raise FileNotFoundError(f"No config.json for product {product_code!r}")


def load_batch_spec(batch_id: str) -> dict:
    spec_path = resolve_batch_dir(batch_id, base_path=REPO) / "spec.json"
    return json.loads(spec_path.read_text())


def infer_product_from_spec(spec: dict) -> str | None:
    """Resolve product code across old and new batch spec shapes."""
    product = spec.get("product") or spec.get("product_code")
    if product:
        return product
    task_ids = spec.get("task_ids") or []
    if task_ids:
        first = str(task_ids[0])
        if "_LFS" in first:
            return first.split("_LFS", 1)[0]
        return first.split("_", 1)[0]
    return None


def load_batch_context(batch_id: str) -> tuple[dict, str]:
    """Load (product config, CTA text) for a batch."""
    spec = load_batch_spec(batch_id)
    product = infer_product_from_spec(spec)
    if not product:
        raise KeyError(f"Batch {batch_id} spec has no product/product_code/task_ids product hint")
    cta = spec.get("cta_text") or spec.get("cta")
    if not cta:
        raise KeyError(f"Batch {batch_id} spec has no cta_text/cta")
    return load_product_config(product), cta


# ---------- check helpers ----------

def brand_patterns(cfg: dict) -> list[re.Pattern]:
    brand = cfg.get("brand", "")
    code = cfg.get("product_code", "")
    product_name = cfg.get("product_name", "")
    pats = set()
    if brand:
        pats.add(rf"\b{re.escape(brand)}\b")
    if code and code.isalpha() and code.lower() != brand.lower():
        pats.add(rf"\b{re.escape(code)}\b")
    if product_name:
        pats.add(rf"\b{re.escape(product_name)}\b")
    return [re.compile(p, re.IGNORECASE) for p in pats]


def canonical_prices(cfg: dict) -> set[str]:
    """All dollar amounts that are explicitly allowed in copy.

    Includes canonical product prices + failed-solution price anchors from offer_architecture.
    """
    allowed = set()
    pr = cfg.get("pricing_rules", {})
    price_re = r"\$[\d,]+(?:\.\d{1,2})?"
    for phrasing in pr.get("canonical_phrasings", []):
        for m in re.findall(price_re, phrasing):
            allowed.add(normalize_price_hit(m))
    # failed-solution comparators are explicitly cited in the briefing
    for anchor in cfg.get("offer_architecture", {}).get("price_anchor_stack", []):
        for m in re.findall(price_re, anchor):
            allowed.add(normalize_price_hit(m))
    return allowed


def normalize_price_hit(price: str) -> str:
    """Normalize verifier price hits without changing the displayed copy.

    The regex intentionally allows commas inside prices, but that can also catch
    a sentence comma after an allowed value like "$3,000,". Compare canonical
    prices after trimming only trailing punctuation.
    """
    return price.rstrip(".,;:!?")


def paragraph_sentence_count(paragraph: str) -> int:
    """Approximate sentence count for format hygiene checks."""
    paragraph = (
        paragraph
        .replace("P.S.", "PS")
        .replace("P.P.S.", "PPS")
        .replace("e.g.", "eg")
        .replace("i.e.", "ie")
    )
    return len([s for s in re.split(r"[.!?]+(?:\s+|$)", paragraph.strip()) if s.strip()])


def formatting_violations(body: str) -> list[Violation]:
    """Presentation checks for deployable native LFS copy."""
    violations: list[Violation] = []
    divider_count = sum(1 for ln in body.splitlines() if ln.strip() == LFS_NATIVE.divider)
    if divider_count < LFS_NATIVE.min_dividers:
        violations.append(Violation(
            "HIGH", "LFS_DIVIDERS_LOW",
            f"Found {divider_count} section dividers; native LFS requires at least {LFS_NATIVE.min_dividers}",
            detail={
                "current": divider_count,
                "target": LFS_NATIVE.min_dividers,
                "divider": LFS_NATIVE.divider,
            },
        ))

    bad_spacing = []
    lines = body.splitlines()
    for idx, line in enumerate(lines):
        if line.strip() != LFS_NATIVE.divider:
            continue
        before_blank = idx == 0 or not lines[idx - 1].strip()
        after_blank = idx == len(lines) - 1 or not lines[idx + 1].strip()
        if not before_blank or not after_blank:
            bad_spacing.append(idx + 1)
    if bad_spacing:
        violations.append(Violation(
            "HIGH", "LFS_DIVIDER_SPACING",
            f"{len(bad_spacing)} section dividers missing blank-line spacing",
            detail={"lines": bad_spacing[:10], "divider": LFS_NATIVE.divider},
        ))

    wall_paragraphs = []
    dated_log_re = re.compile(r"^(?:[-*]\s*)?(?:Day|Week|Month)\s+\d+", re.IGNORECASE)
    for idx, paragraph in enumerate(re.split(r"\n\s*\n", body.strip()), 1):
        stripped = paragraph.strip()
        if not stripped or stripped == LFS_NATIVE.divider:
            continue
        if dated_log_re.match(stripped):
            continue
        words = stripped.split()
        sentence_count = paragraph_sentence_count(stripped)
        too_many_words = len(words) > LFS_NATIVE.max_paragraph_words
        too_many_sentences = sentence_count > LFS_NATIVE.max_paragraph_sentences
        if too_many_words or too_many_sentences:
            wall_paragraphs.append({
                "paragraph": idx,
                "words": len(words),
                "sentences": sentence_count,
            })
    if wall_paragraphs:
        violations.append(Violation(
            "HIGH", "LFS_WALL_PARAGRAPH",
            f"{len(wall_paragraphs)} wall-text paragraph(s); native LFS requires short scan-friendly paragraphs",
            detail={
                "max_words": LFS_NATIVE.max_paragraph_words,
                "max_sentences": LFS_NATIVE.max_paragraph_sentences,
                "paragraphs": wall_paragraphs[:10],
            },
        ))

    return violations


# ---------- the checks ----------

def check_text(body: str, label: str, cfg: dict, cta_text: str) -> Result:
    """Run the verifier on a body of text directly (no file I/O).

    Returns the same Result shape as check_script. Used by the tripwire to verify
    candidate LLM output before committing it to disk.
    """
    words = body.split()
    wc = len(words)
    midpoint = len(body) // 2
    second_half = body[midpoint:]
    last_300_words = " ".join(words[-300:]) if wc > 300 else body

    pats = brand_patterns(cfg)
    brand_total = sum(len(p.findall(body)) for p in pats)
    brand_2h = sum(len(p.findall(second_half)) for p in pats)
    brand_in_cta = any(p.search(last_300_words) for p in pats)

    violations: list[Violation] = []

    # --- CRITICAL ---

    if not brand_in_cta:
        violations.append(Violation(
            "CRITICAL", "BRAND_MISSING_CTA",
            "Brand absent in CTA paragraph (last 300 words)",
            detail={"insert_count": 1, "location": "last_paragraph_before_cta"},
        ))

    ps_match = re.search(r"P\.S\.[\s\S]+?(?=P\.P\.S\.|\Z)", body, re.IGNORECASE)
    if ps_match:
        ps_block = ps_match.group(0)
        if not any(p.search(ps_block) for p in pats):
            violations.append(Violation(
                "CRITICAL", "BRAND_MISSING_PS",
                "Brand absent in P.S. block",
                detail={"insert_count": 1, "location": "ps_block"},
            ))
    else:
        violations.append(Violation(
            "HIGH", "PS_MISSING",
            "No P.S. block found",
            detail={"location": "after_cta"},
        ))

    # CTA verbatim — first 8 words must appear contiguously
    cta_anchor = " ".join(cta_text.split()[:8])
    normalized_body = " ".join(body.split())
    if cta_anchor and cta_anchor not in normalized_body:
        violations.append(Violation(
            "CRITICAL", "CTA_NOT_VERBATIM",
            f"CTA verbatim missing (anchor: {cta_anchor!r})",
            detail={"cta_text": cta_text},
        ))

    forbidden = [p.lower() for p in cfg.get("prompt_context", {}).get("forbidden_phrases", [])]
    body_low = body.lower()
    forb_hits = sorted({p for p in forbidden if re.search(rf"\b{re.escape(p)}\b", body_low)})
    if forb_hits:
        violations.append(Violation(
            "CRITICAL", "FORBIDDEN_PHRASES",
            f"Forbidden phrases present: {forb_hits}",
            detail={"phrases": forb_hits},
        ))

    allowed_prices = canonical_prices(cfg)
    price_hits = [normalize_price_hit(p) for p in re.findall(r"\$[\d,]+(?:\.\d{1,2})?", body)]
    bad_prices = sorted({p for p in price_hits if p not in allowed_prices})
    if bad_prices:
        violations.append(Violation(
            "CRITICAL", "PRICE_HALLUCINATION",
            f"Prices outside canonical set: {bad_prices}",
            detail={"bad_prices": bad_prices, "allowed": sorted(allowed_prices)},
        ))

    # --- HIGH ---

    violations.extend(formatting_violations(body))

    if brand_2h < 4:
        violations.append(Violation(
            "HIGH", "BRAND_DENSITY_LOW",
            f"Brand appears {brand_2h}x in second half (target ≥4)",
            detail={"current": brand_2h, "target": 4, "insert_count": 4 - brand_2h},
        ))

    if wc < 1050:
        violations.append(Violation(
            "HIGH", "WORD_COUNT_THIN",
            f"Word count {wc} < 1050 (LFS likely underdeveloped)",
            detail={"current": wc, "target": 1300, "min": 1050},
        ))
    elif wc < 1200:
        violations.append(Violation(
            "MEDIUM", "WORD_COUNT_LOW",
            f"Word count {wc} < 1200 (advisory only; do not pad strong scripts)",
            detail={"current": wc, "target": 1200, "min": 1050},
        ))
    elif wc > LFS_WORD_COUNT_MAX:
        violations.append(Violation(
            "HIGH", "WORD_COUNT_HIGH",
            f"Word count {wc} > {LFS_WORD_COUNT_MAX} (LFS ceiling)",
            detail={"current": wc, "max": LFS_WORD_COUNT_MAX},
        ))

    bolds = body.count("**")
    if bolds > 0:
        violations.append(Violation(
            "HIGH", "MARKDOWN_BOLD",
            f"{bolds} bold markers found (LFS = plain prose)",
            detail={"count": bolds, "patch": "strip_regex"},
        ))

    bullet_lines = sum(1 for ln in body.split("\n") if re.match(r"^\s*[-*]\s+\S", ln))
    if bullet_lines > 6:
        violations.append(Violation(
            "HIGH", "BULLET_DUMP",
            f"{bullet_lines} bullet lines (LFS prefers prose)",
            detail={"count": bullet_lines},
        ))

    meta_phrases = ["imagine if", "picture this", "what if i told you"]
    meta_hits = [p for p in meta_phrases if p in body_low]
    if meta_hits:
        violations.append(Violation(
            "HIGH", "META_LANGUAGE",
            f"Copywriter meta-language: {meta_hits}",
            detail={"phrases": meta_hits},
        ))

    return Result(
        script_path=label,
        word_count=wc,
        brand_count_total=brand_total,
        brand_count_second_half=brand_2h,
        violations=violations,
    )


def check_script(script_path: Path, cfg: dict, cta_text: str) -> Result:
    """Verify a script on disk. Thin wrapper around check_text."""
    return check_text(script_path.read_text(), str(script_path), cfg, cta_text)


# ---------- runner ----------

def run_batch(batch_id: str, output_subdir: str = "output") -> list[Result]:
    cfg, cta = load_batch_context(batch_id)
    output_dir = resolve_batch_dir(batch_id, base_path=REPO) / output_subdir
    scripts = [
        p for p in sorted(output_dir.glob("*.md"))
        if "_OUTLINE" not in p.name and "_VISUALS" not in p.name
    ]
    return [check_script(p, cfg, cta) for p in scripts]


def result_passed(result: Result, policy: str = "strict") -> bool:
    if policy == "v41":
        hard, _advisory = split_v41_violations(result)
        return not hard
    return result.passed


def print_report(results: list[Result], compact: bool = False, policy: str = "strict") -> None:
    pass_ct = sum(1 for r in results if result_passed(r, policy))
    print(f"{'script':<58} {'wc':>5} {'brnd':>5} {'2h':>4}  C/H/M")
    print("=" * 90)
    for r in results:
        name = Path(r.script_path).stem[:57]
        crit = r.critical_count
        high = r.high_count
        med = sum(1 for v in r.violations if v.severity == "MEDIUM")
        flag = "✓" if result_passed(r, policy) else ("✗" if crit else "⚠")
        print(f"{flag} {name:<56} {r.word_count:>5} {r.brand_count_total:>5} {r.brand_count_second_half:>4}  {crit}/{high}/{med}")
        if not compact:
            hard_codes = set()
            if policy == "v41":
                hard, _advisory = split_v41_violations(r)
                hard_codes = {v.code for v in hard}
            for v in r.violations:
                label = v.severity
                if policy == "v41":
                    label = "HARD" if v.code in hard_codes else "ADVISORY"
                print(f"     [{label}] {v.code}: {v.message}")
    print("=" * 90)
    if policy == "v41":
        objective = build_v41_objective_report(results)
        print(f"  {pass_ct}/{len(results)} hard-clean under V4.1 policy")
        if objective["hard_violation_counts"]:
            print(f"  hard: {objective['hard_violation_counts']}")
        if objective["advisory_violation_counts"]:
            print(f"  advisory: {objective['advisory_violation_counts']}")
    else:
        print(f"  {pass_ct}/{len(results)} clean pass")


def print_history(results: list[Result]) -> None:
    """Render the QA history sidecar for each script."""
    from lfs_tripwire import read_history
    for r in results:
        path = Path(r.script_path)
        history = read_history(path)
        name = path.stem
        if not history:
            print(f"  {name}: (no QA history)")
            continue
        print(f"\n{name} — {len(history)} entry/entries")
        for i, entry in enumerate(history, 1):
            ts = entry.get("ts", "?")
            tool = entry.get("tool", "?")
            committed = "✓" if entry.get("committed") else "↺"
            reason = entry.get("reason", "?")
            resolved = entry.get("fixes_resolved", [])
            introduced = entry.get("fixes_introduced", [])
            wc_before = entry.get("word_count_before", 0)
            wc_after = entry.get("word_count_after", 0)
            print(f"  [{i}] {ts}  {committed} {tool} ({reason})")
            if resolved:
                print(f"      resolved: {resolved}")
            if introduced:
                print(f"      introduced: {introduced}")
            if wc_before != wc_after:
                print(f"      wc: {wc_before} → {wc_after}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch")
    ap.add_argument("--script", type=Path, help="single script to check")
    ap.add_argument("--product", help="product code (required with --script)")
    ap.add_argument("--cta", help="CTA text (required with --script)")
    ap.add_argument("--json", action="store_true", help="JSON output")
    ap.add_argument("--compact", action="store_true", help="one line per script")
    ap.add_argument("--output-subdir", default="output", help="Batch output subdir to verify (default: output)")
    ap.add_argument("--policy", choices=["strict", "v41"], default="strict",
                    help="Verification policy: strict fails CRITICAL/HIGH; v41 fails objective hard facts only")
    ap.add_argument("--show-history", action="store_true",
                    help="print the QA history sidecar for each script (audit trail)")
    args = ap.parse_args()

    if args.batch:
        results = run_batch(args.batch, output_subdir=args.output_subdir)
    elif args.script and args.product and args.cta:
        cfg = load_product_config(args.product)
        results = [check_script(args.script, cfg, args.cta)]
    else:
        ap.error("Provide --batch OR (--script + --product + --cta)")

    if args.json:
        result_payload = [
            {**asdict(r), "violations": [asdict(v) for v in r.violations]}
            for r in results
        ]
        if args.policy == "v41":
            print(json.dumps({
                "policy": "v41",
                "objective": build_v41_objective_report(results),
                "results": result_payload,
            }, indent=2))
        else:
            print(json.dumps(result_payload, indent=2))
    else:
        print_report(results, compact=args.compact, policy=args.policy)
        if args.show_history:
            print("\n=== QA HISTORY ===")
            print_history(results)

    return 0 if all(result_passed(r, args.policy) for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())

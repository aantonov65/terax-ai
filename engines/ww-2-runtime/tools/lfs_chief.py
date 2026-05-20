#!/usr/bin/env python3
"""LFS V4 copy-chief pass.

Reads generated scripts from a batch output directory, asks Claude to strengthen
the copy using the configured chiefing docs, validates basic preservation, and
writes accepted candidates to `output-chiefed/`. Raw generation remains
untouched.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import zipfile
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

THIS = Path(__file__).resolve()
REPO = THIS.parent.parent
sys.path.insert(0, str(THIS.parent))

try:
    from dotenv import load_dotenv
    load_dotenv(REPO / ".env")
except ImportError:
    pass

from lfs_fix import normalize_lfs_divider_spacing, split_lfs_wall_paragraphs  # noqa: E402
from lfs_policy import split_v41_violations  # noqa: E402
from lfs_verify import check_text  # noqa: E402
from research_cards import resolve_product_dir  # noqa: E402


DEFAULT_MODEL = os.environ.get("LFS_CHIEF_MODEL", "claude-sonnet-4-6")
DEFAULT_REQUEST_TIMEOUT_SECONDS = float(os.environ.get("LFS_CHIEF_REQUEST_TIMEOUT_SECONDS", "300"))
DEFAULT_DOC_CANDIDATES = [
    REPO / "components" / "lfs-copy-chief",
    REPO / "reports" / "lfs-v4-copy-chief" / "docs-extracted",
]


@dataclass
class ChiefResult:
    script_path: str
    output_path: str
    status: str
    error: str = ""
    model: str = DEFAULT_MODEL
    before_words: int = 0
    after_words: int = 0

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def strip_code_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9_-]*\n", "", text)
        text = re.sub(r"\n```$", "", text)
    return text.strip()


def extract_master_script(raw: str) -> str:
    text = strip_code_fences(raw)
    match = re.search(r"(?im)^##\s+Master Script\s*$", text)
    if match:
        return text[match.end():].strip()
    return text.strip()


def first_sentence(text: str) -> str:
    body = text.strip()
    match = re.search(r"[.!?](?:\s+|$)", body)
    if match:
        return body[:match.end()].strip()
    return body.splitlines()[0].strip() if body.splitlines() else ""


def normalize_sentence(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def docx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as zf:
        xml = zf.read("word/document.xml")
    root = ElementTree.fromstring(xml)
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs = []
    for p in root.findall(".//w:p", ns):
        texts = [node.text or "" for node in p.findall(".//w:t", ns)]
        line = "".join(texts).strip()
        if line:
            paragraphs.append(line)
    return "\n\n".join(paragraphs)


def read_doc(path: Path) -> str:
    if path.suffix.lower() == ".docx":
        return docx_text(path)
    return path.read_text(errors="ignore")


def expand_doc_paths(paths: list[Path] | None) -> list[Path]:
    if not paths:
        paths = [p for p in DEFAULT_DOC_CANDIDATES if p.exists()]
    found: list[Path] = []
    for path in paths:
        if path.is_dir():
            found.extend(sorted(p for p in path.iterdir() if p.suffix.lower() in {".md", ".txt", ".docx"}))
        elif path.exists():
            found.append(path)
    return found


def load_chief_docs(paths: list[Path] | None = None, max_chars: int = 120_000) -> str:
    parts: list[str] = []
    total = 0
    for path in expand_doc_paths(paths):
        text = read_doc(path).strip()
        if not text:
            continue
        remaining = max_chars - total
        if remaining <= 0:
            break
        clipped = text[:remaining]
        total += len(clipped)
        parts.append(f"### DOC: {path.name}\n\n{clipped}")
    if parts:
        return "\n\n---\n\n".join(parts)
    return """### BUILT-IN COPY CHIEF PRINCIPLES

Strengthen concrete problem tokens, dismiss reader constraints before the CTA, calibrate promises to the edge of believability, remove AI-like symmetry, and keep the script easier to read."""


def build_chief_prompt(script: str, outline: str, docs: str, cfg: dict, cta: str, *, preserve_opener: bool = True) -> str:
    brand = cfg.get("brand") or cfg.get("product_name") or "the product"
    opener_instruction = (
        "- Keep the first sentence unchanged."
        if preserve_opener
        else "- You may rewrite the opener when it becomes stronger: clearer wound, stronger emotional voltage, same product truth, same narrator POV."
    )
    return f"""You are the senior DR copy chief on a long-form static ad desk.

You sharpen already-written scripts. You push the emotional argument harder, make the buyer's constraint feel answered, and keep every product claim anchored to the supplied truth.

COPY-CHIEF DOCS
<docs>
{docs}
</docs>

OUTLINE TO PRESERVE
<outline>
{outline}
</outline>

PRODUCT TRUTH
- Brand/product: {brand}
- CTA copied exactly: {cta}
- Product truth source: use the product price, guarantee, claims, and ingredients already present in the script or product truth.

SCRIPT
<script>
{script}
</script>

CHIEFING BRIEF
Silently find the places where this script is 80 percent right but still weak: abstract problem tokens, timid emotional stakes, unanswered "this will not work for me" objections, too-neat AI symmetry, and promises that are either soft or ungrounded.

Rewrite the full script with these priorities:
- Make problem tokens more concrete and bodily.
- Answer reader constraints before the CTA in the narrator's natural voice.
- Push the promise to the edge of believability while staying anchored to product truth.
- Keep one thought per paragraph.
{opener_instruction}
- Keep narrator POV unchanged.
- Keep outline order unchanged.
- Keep CTA text unchanged.
- Keep all dollar amounts and product facts true.
- Keep claims within the facts already present in the script or product truth.

Return exactly the final chiefed script text."""


def call_claude(prompt: str, model: str, max_tokens: int = 12_000) -> str:
    try:
        import anthropic
    except ImportError as exc:
        raise RuntimeError("anthropic SDK not installed; run `pip install anthropic`") from exc
    client = anthropic.Anthropic(timeout=DEFAULT_REQUEST_TIMEOUT_SECONDS, max_retries=0)
    msg = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        temperature=0.2,
        messages=[{"role": "user", "content": prompt}],
    )
    return msg.content[0].text


def validate_candidate(
    original: str,
    candidate: str,
    cfg: dict,
    cta: str,
    label: str,
    *,
    preserve_opener: bool = True,
    objective_only: bool = False,
) -> tuple[bool, str, str]:
    candidate = extract_master_script(candidate)
    candidate, _ = split_lfs_wall_paragraphs(candidate)
    candidate, _ = normalize_lfs_divider_spacing(candidate)

    if preserve_opener and normalize_sentence(first_sentence(original)) != normalize_sentence(first_sentence(candidate)):
        return False, "first sentence changed", candidate

    result = check_text(candidate, label, cfg, cta)
    if objective_only:
        hard, _advisory = split_v41_violations(result)
        if hard:
            codes = ", ".join(v.code for v in hard)
            return False, f"candidate failed objective verifier: {codes}", candidate
    elif not result.passed:
        codes = ", ".join(v.code for v in result.violations if v.severity in {"CRITICAL", "HIGH"})
        return False, f"candidate failed verifier: {codes}", candidate
    return True, "", candidate


def chief_one(
    script_path: Path,
    *,
    batch_dir: Path,
    output_dir: Path,
    docs: str,
    cfg: dict,
    cta: str,
    model: str,
    dry_run: bool,
    preserve_opener: bool = True,
    objective_only: bool = False,
) -> ChiefResult:
    out_path = output_dir / script_path.name
    original = script_path.read_text()
    outline_path = batch_dir / "outlines" / f"{task_id_from_script(script_path)}.md"
    outline = outline_path.read_text() if outline_path.exists() else ""
    before_words = len(original.split())

    try:
        prompt = build_chief_prompt(original, outline, docs, cfg, cta, preserve_opener=preserve_opener)
        raw = call_claude(prompt, model)
        ok, error, candidate = validate_candidate(
            original,
            raw,
            cfg,
            cta,
            str(out_path),
            preserve_opener=preserve_opener,
            objective_only=objective_only,
        )
    except Exception as exc:
        candidate = original
        ok = False
        error = str(exc)

    if not dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)
        out_path.write_text(candidate if ok else original)

    status = "accepted" if ok else "rejected_original_copied"
    return ChiefResult(
        script_path=str(script_path),
        output_path=str(out_path),
        status=status,
        error=error,
        model=model,
        before_words=before_words,
        after_words=len((candidate if ok else original).split()),
    )


def task_id_from_script(path: Path) -> str:
    return re.sub(r"_\d{8}_\d{6}$", "", path.stem)


def load_batch_cfg_cta(base_path: Path, batch_id: str) -> tuple[dict[str, Any], str]:
    from ww_paths import resolve_batch_dir
    spec_path = resolve_batch_dir(batch_id, base_path=base_path) / "spec.json"
    spec = json.loads(spec_path.read_text())
    product = spec.get("product") or spec.get("product_code")
    if not product:
        task_ids = spec.get("task_ids") or []
        product = str(task_ids[0]).split("_", 1)[0] if task_ids else ""
    if not product:
        raise KeyError(f"Batch {batch_id} has no product/product_code/task_ids product hint")
    cta = spec.get("cta_text") or spec.get("cta")
    if not cta:
        raise KeyError(f"Batch {batch_id} spec has no cta_text/cta")
    cfg_path = resolve_product_dir(base_path, str(product)) / "config.json"
    return json.loads(cfg_path.read_text()), str(cta)


def run_chief_batch(
    batch_id: str,
    *,
    base_path: Path = REPO,
    input_subdir: str = "output",
    output_subdir: str = "output-chiefed",
    docs_paths: list[Path] | None = None,
    model: str = DEFAULT_MODEL,
    workers: int = 4,
    dry_run: bool = False,
    preserve_opener: bool = True,
    objective_only: bool = False,
) -> dict[str, Any]:
    from ww_paths import resolve_batch_dir
    batch_dir = resolve_batch_dir(batch_id, base_path=base_path)
    input_dir = batch_dir / input_subdir
    output_dir = batch_dir / output_subdir
    if not input_dir.exists():
        raise FileNotFoundError(f"input directory not found: {input_dir}")

    cfg, cta = load_batch_cfg_cta(base_path, batch_id)
    docs = load_chief_docs(docs_paths)
    scripts = [
        p for p in sorted(input_dir.glob("*.md"))
        if "_OUTLINE" not in p.name and "_VISUALS" not in p.name
    ]
    if not scripts:
        raise ValueError(f"no scripts found in {input_dir}")

    print(f"Copy-chiefing {len(scripts)} scripts from {input_subdir} -> {output_subdir}")
    print(f"Model: {model}")

    results: list[ChiefResult] = []
    kwargs = {
        "batch_dir": batch_dir,
        "output_dir": output_dir,
        "docs": docs,
        "cfg": cfg,
        "cta": cta,
        "model": model,
        "dry_run": dry_run,
        "preserve_opener": preserve_opener,
        "objective_only": objective_only,
    }
    if workers == 1:
        for script in scripts:
            result = chief_one(script, **kwargs)
            results.append(result)
            print_result(result)
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(chief_one, script, **kwargs): script for script in scripts}
            for fut in concurrent.futures.as_completed(futs):
                try:
                    result = fut.result()
                except Exception as exc:
                    script = futs[fut]
                    result = ChiefResult(str(script), str(output_dir / script.name), "failed", str(exc), model)
                results.append(result)
                print_result(result)

    report = {
        "schema": "lfs-chief-report/v1",
        "batch_id": batch_id,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "model": model,
        "input_subdir": input_subdir,
        "output_subdir": output_subdir,
        "preserve_opener": preserve_opener,
        "objective_only": objective_only,
        "total_scripts": len(results),
        "accepted": sum(1 for r in results if r.status == "accepted"),
        "rejected": sum(1 for r in results if r.status == "rejected_original_copied"),
        "failed": sum(1 for r in results if r.status == "failed"),
        "results": [r.as_dict() for r in sorted(results, key=lambda r: r.script_path)],
    }
    if not dry_run:
        (batch_dir / "lfs-chief-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def print_result(result: ChiefResult) -> None:
    marker = "✓" if result.status == "accepted" else "↷" if result.status == "rejected_original_copied" else "✗"
    print(f"  {marker} {Path(result.script_path).name} [{result.status}]")
    if result.error:
        print(f"    {result.error}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Run bounded LFS copy-chief pass")
    ap.add_argument("batch_id")
    ap.add_argument("--base-path", type=Path, default=REPO)
    ap.add_argument("--input-subdir", default="output")
    ap.add_argument("--output-subdir", default="output-chiefed")
    ap.add_argument("--docs", action="append", type=Path, help="Chiefing doc file or directory; may be repeated")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--workers", "-w", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-opener-change", action="store_true", help="Allow chiefing to improve weak openers")
    ap.add_argument("--objective-only", action="store_true", help="Accept chiefed scripts when V4.1 objective hard checks pass")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    try:
        report = run_chief_batch(
            args.batch_id,
            base_path=args.base_path,
            input_subdir=args.input_subdir,
            output_subdir=args.output_subdir,
            docs_paths=args.docs,
            model=args.model,
            workers=max(args.workers, 1),
            dry_run=args.dry_run,
            preserve_opener=not args.allow_opener_change,
            objective_only=args.objective_only,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, indent=2))
    return 0 if report["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

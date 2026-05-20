#!/usr/bin/env python3
"""Drive-aligned research pipeline for WW-2.

Stage 02:
    ww research PRODUCT --topic "..."

    Writes a drive-style run folder under:
        products/{PRODUCT}/research/ww-research-{YYYY-MM-DD}-{slug}/

Stage 03:
    ww research synthesize PRODUCT --from products/{PRODUCT}/research/ww-research-...

    Reads opus-analysis.md + filtered-corpus.md + config.json, asks Claude for a
    structured JSON synthesis, validates it, then renders canonical markdown:
        archetypes.md, hotwords.md, mechanisms.md
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import requests
try:
    from dotenv import load_dotenv
except ModuleNotFoundError:  # Allow help/errors in minimal environments.
    def load_dotenv(*_args: Any, **_kwargs: Any) -> bool:
        return False

load_dotenv(Path(__file__).parent.parent / ".env")

try:
    import anthropic
except ModuleNotFoundError:  # Live research/synthesis will fail loudly via anthropic_client().
    anthropic = None  # type: ignore[assignment]

try:
    from context import PRODUCT_FOLDERS
except Exception:  # pragma: no cover - import safety for standalone use
    PRODUCT_FOLDERS = {}


REPO = Path(__file__).resolve().parents[1]
USER_AGENT = "WW2-Research/1.0 (ad research pipeline; contact: operator)"
REDDIT_SEARCH_URL = "https://www.reddit.com/search.json"
RATE_LIMIT_SECONDS = float(os.environ.get("WW_RESEARCH_RATE_LIMIT_SECONDS", "3"))
QUERY_MODEL = os.environ.get("WW_RESEARCH_QUERY_MODEL", "claude-sonnet-4-6")
FILTER_MODEL = os.environ.get("WW_RESEARCH_FILTER_MODEL", "claude-sonnet-4-6")
ANALYSIS_MODEL = os.environ.get("WW_RESEARCH_ANALYSIS_MODEL", "claude-sonnet-4-6")
SYNTHESIS_MODEL = os.environ.get("WW_RESEARCH_SYNTHESIS_MODEL", "claude-sonnet-4-6")


# ----------------------------- shared helpers -----------------------------


def slugify(value: str, *, max_len: int = 48) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.lower()).strip("-")
    return (slug[:max_len].strip("-") or "research")


def strip_json_fence(raw: str) -> str:
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def extract_json(raw: str) -> Any:
    text = strip_json_fence(raw)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start_obj = text.find("{")
        start_arr = text.find("[")
        starts = [x for x in (start_obj, start_arr) if x >= 0]
        if not starts:
            raise
        start = min(starts)
        end = max(text.rfind("}"), text.rfind("]"))
        if end <= start:
            raise
        return json.loads(text[start : end + 1])


def response_text(message: Any) -> str:
    parts: list[str] = []
    for block in getattr(message, "content", []) or []:
        text = getattr(block, "text", None)
        if text:
            parts.append(text)
    return "\n".join(parts).strip()


def usage_text(message: Any, model: str) -> str:
    usage = getattr(message, "usage", None)
    rows = [f"model: {model}"]
    if usage:
        for name in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
            value = getattr(usage, name, None)
            if value is not None:
                rows.append(f"{name}: {value}")
    return "\n".join(rows) + "\n"


def anthropic_client() -> Any:
    if anthropic is None:
        raise RuntimeError("anthropic package is required for real research; install requirements.txt")
    return anthropic.Anthropic()


def claude_message(
    client: Any,
    *,
    model: str,
    max_tokens: int,
    temperature: float | int | None,
    messages: list[dict[str, str]],
) -> Any:
    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
    }
    if temperature is not None:
        kwargs["temperature"] = temperature
    try:
        return client.messages.create(**kwargs)
    except Exception as exc:
        message = str(exc).lower()
        if "temperature" in message and "deprecated" in message and "temperature" in kwargs:
            kwargs.pop("temperature", None)
            return client.messages.create(**kwargs)
        raise


def resolve_product_dir(base_path: Path, product: str) -> Path:
    direct = base_path / "products" / product
    if direct.exists():
        return direct
    mapped = PRODUCT_FOLDERS.get(product)
    if mapped and (base_path / "products" / mapped).exists():
        return base_path / "products" / mapped
    for cfg_path in (base_path / "products").glob("*/config.json"):
        try:
            cfg = json.loads(cfg_path.read_text())
        except Exception:
            continue
        candidates = {
            cfg_path.parent.name,
            str(cfg.get("product_code") or ""),
            str(cfg.get("product") or ""),
            str(cfg.get("brand") or ""),
        }
        if product in candidates:
            return cfg_path.parent
    return direct


def load_product_config(base_path: Path, product: str) -> dict[str, Any]:
    product_dir = resolve_product_dir(base_path, product)
    cfg_path = product_dir / "config.json"
    if not cfg_path.exists():
        raise FileNotFoundError(f"product config not found: {cfg_path}")
    return json.loads(cfg_path.read_text())


# ----------------------------- Stage 02 scrape -----------------------------


def generate_queries(topic: str, client: anthropic.Anthropic) -> list[str]:
    """Claude call: generate Reddit queries targeting emotional first-person threads."""
    prompt = f"""Generate exactly 40 Reddit search queries to find FIRST-PERSON SUFFERING STORIES about: {topic}

The topic above is the ONLY thing that matters. Search for threads about EXACTLY that topic.

Rules:
- SHORT queries, usually 3-8 words.
- Every query MUST contain at least one pain/suffering word or direct condition word.
- At least 20 queries MUST use subreddit: prefixes where relevant.
- Every query MUST contain a keyword from the topic, a close synonym, or a common patient phrase for it.
- Maximize variety across symptoms, shame, failed fixes, doctor dismissal, daily-life impact, and identity pain.
- Do NOT include the word "reddit".

Return ONLY 40 queries, one per line, no numbering, no quotes, no explanation."""
    message = claude_message(
        client,
        model=QUERY_MODEL,
        max_tokens=1200,
        temperature=0,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response_text(message)
    queries = [re.sub(r"^\s*[-*\d.)]+\s*", "", q).strip() for q in raw.splitlines() if q.strip()]
    deduped: list[str] = []
    seen: set[str] = set()
    for query in queries:
        key = query.lower()
        if key not in seen:
            seen.add(key)
            deduped.append(query)
    return deduped[:40]


def search_reddit(query: str) -> list[dict[str, Any]]:
    headers = {"User-Agent": USER_AGENT}
    params = {"q": query, "sort": "relevance", "limit": 100, "type": "link"}
    try:
        resp = requests.get(REDDIT_SEARCH_URL, headers=headers, params=params, timeout=20)
        resp.raise_for_status()
        data = resp.json()
    except (requests.RequestException, json.JSONDecodeError) as exc:
        print(f"  [WARN] Search failed for {query[:60]!r}: {exc}")
        return []

    threads: list[dict[str, Any]] = []
    for child in data.get("data", {}).get("children", []):
        post = child.get("data", {})
        if not post.get("is_self", False):
            continue
        permalink = post.get("permalink", "")
        threads.append(
            {
                "url": f"https://www.reddit.com{permalink}",
                "title": post.get("title", ""),
                "selftext": post.get("selftext", ""),
                "subreddit": post.get("subreddit", ""),
                "score": post.get("score", 0),
                "num_comments": post.get("num_comments", 0),
                "created_utc": post.get("created_utc"),
                "permalink": permalink,
                "query": query,
            }
        )
    return threads


def fetch_all_threads(queries: list[str], max_threads: int = 500) -> list[dict[str, Any]]:
    seen_urls: set[str] = set()
    all_threads: list[dict[str, Any]] = []
    print(f"\nSearching Reddit with {len(queries)} queries...")
    for i, query in enumerate(queries, 1):
        print(f"  [{i}/{len(queries)}] {query[:80]}")
        results = search_reddit(query)
        time.sleep(RATE_LIMIT_SECONDS)
        for thread in results:
            url = thread["url"]
            if url in seen_urls:
                continue
            seen_urls.add(url)
            all_threads.append(thread)
        print(f"    Found {len(results)} threads ({len(all_threads)} unique)")
        if len(all_threads) >= max_threads:
            break
    all_threads.sort(key=lambda t: int(t.get("score") or 0) + int(t.get("num_comments") or 0), reverse=True)
    return all_threads[:max_threads]


def filter_threads(threads: list[dict[str, Any]], topic: str, client: anthropic.Anthropic) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    batch_size = 20
    print(f"\nFiltering {len(threads)} threads for relevance to: {topic}")
    for i in range(0, len(threads), batch_size):
        batch = threads[i : i + batch_size]
        print(f"  Scoring batch {i // batch_size + 1}/{(len(threads) + batch_size - 1) // batch_size}")
        thread_block = ""
        for j, t in enumerate(batch):
            preview = str(t.get("selftext") or "")[:900].replace("\n", " ")
            thread_block += f"""THREAD_{j}:
subreddit: r/{t.get('subreddit', '?')}
title: {t.get('title', '')}
text: {preview}
---
"""
        prompt = f"""You are a strict relevance filter for ad research.

TOPIC: {topic}

For each thread, answer whether it passes ALL THREE:
1. FIRST_PERSON: poster describes their own experience.
2. ON_TOPIC: thread discusses the core topic or close patient-language synonym.
3. SUFFERING: poster expresses distress, shame, fear, frustration, pain, or failed fixes.

Return ONLY a JSON array like:
[{{"id":"THREAD_0","pass":true,"reason":"short reason"}}]

THREADS:
{thread_block}"""
        try:
            message = claude_message(
                client,
                model=FILTER_MODEL,
                max_tokens=2500,
                temperature=0,
                messages=[{"role": "user", "content": prompt}],
            )
            scores = extract_json(response_text(message))
        except Exception as exc:
            print(f"    [WARN] Failed to parse filter response: {exc}. Dropping batch.")
            continue
        passed = 0
        for score in scores if isinstance(scores, list) else []:
            try:
                idx = int(str(score.get("id", "")).replace("THREAD_", ""))
            except ValueError:
                continue
            if 0 <= idx < len(batch) and score.get("pass") is True:
                enriched = dict(batch[idx])
                enriched["filter_reason"] = score.get("reason", "")
                kept.append(enriched)
                passed += 1
        print(f"    {passed}/{len(batch)} passed")
    return kept


def render_filtered_corpus(threads: list[dict[str, Any]], topic: str) -> str:
    lines = [f"# Filtered Reddit Corpus", "", f"Topic: {topic}", f"Threads: {len(threads)}", ""]
    for i, t in enumerate(threads, 1):
        lines.extend(
            [
                f"## THREAD {i}: {t.get('title', '').strip()}",
                "",
                f"- subreddit: r/{t.get('subreddit', '')}",
                f"- score: {t.get('score', 0)}",
                f"- comments: {t.get('num_comments', 0)}",
                f"- url: {t.get('url', '')}",
                f"- filter_reason: {t.get('filter_reason', '')}",
                "",
                str(t.get("selftext") or "").strip(),
                "",
                "---",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def build_analysis_prompt(topic: str, product: str, config: dict[str, Any], corpus: str) -> str:
    demographic = config.get("target_demographic") or {}
    return f"""You are creating upstream LFS4.1 ad research from real Reddit suffering stories.

Product: {product}
Product config JSON:
{json.dumps(config, indent=2)[:8000]}

Topic: {topic}
Audience constraints:
- gender: {demographic.get('gender', '')}
- age_range: {demographic.get('age_range', '')}
- description: {demographic.get('description', '')}

Your job is to synthesize the corpus into the same kind of raw Opus analysis shown in the drive-instructions Stage 02 examples.

Focus on:
- emotionally distinct audience archetypes
- verbatim pain language and desire language
- failed solutions and why they leave residue
- mechanisms/reframes that can become M-cards later
- compliance-safe product truth from config only
- source-backed observations; do not invent medical facts

Return markdown. Use dense headings. Preserve direct customer language where available.

CORPUS:
{corpus[:160000]}
"""


def run_opus_analysis(topic: str, product: str, config: dict[str, Any], corpus: str, client: anthropic.Anthropic) -> tuple[str, str, str]:
    prompt = build_analysis_prompt(topic, product, config, corpus)
    message = claude_message(
        client,
        model=ANALYSIS_MODEL,
        max_tokens=16000,
        temperature=0.2,
        messages=[{"role": "user", "content": prompt}],
    )
    return response_text(message), usage_text(message, ANALYSIS_MODEL), prompt


def write_research_run(
    *,
    base_path: Path,
    product: str,
    topic: str,
    label: str,
    queries: list[str],
    all_threads: list[dict[str, Any]],
    filtered_threads: list[dict[str, Any]],
    opus_analysis: str,
    opus_usage: str,
    analysis_prompt: str,
) -> Path:
    product_dir = resolve_product_dir(base_path, product)
    research_dir = product_dir / "research"
    date = datetime.now().strftime("%Y-%m-%d")
    run_slug = slugify(label or topic)
    run_dir = research_dir / f"ww-research-{date}-{run_slug}"
    suffix = 2
    original = run_dir
    while run_dir.exists():
        run_dir = original.with_name(f"{original.name}-{suffix}")
        suffix += 1
    run_dir.mkdir(parents=True)

    corpus = render_filtered_corpus(filtered_threads, topic)
    (run_dir / "queries.json").write_text(json.dumps(queries, indent=2) + "\n")
    (run_dir / "all_threads.json").write_text(json.dumps(all_threads, indent=2) + "\n")
    (run_dir / "filtered_threads.json").write_text(json.dumps(filtered_threads, indent=2) + "\n")
    (run_dir / "filtered-corpus.md").write_text(corpus)
    (run_dir / "analysis-prompt.md").write_text(analysis_prompt)
    (run_dir / "opus-analysis.md").write_text(opus_analysis.rstrip() + "\n")
    (run_dir / "opus-usage.txt").write_text(opus_usage)
    summary = {
        "product": product,
        "label": label,
        "topic": topic,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "query_count": len(queries),
        "raw_unique_threads": len(all_threads),
        "filtered_relevant_threads": len(filtered_threads),
        "analysis_model": ANALYSIS_MODEL,
        "filter_model": FILTER_MODEL,
        "query_model": QUERY_MODEL,
        "notebooklm_required": False,
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (run_dir / "README.md").write_text(
        f"# WW Research — {topic}\n\n"
        f"Product: `{product}`\n"
        f"Label: `{label}`\n"
        f"Raw unique threads: `{len(all_threads)}`\n"
        f"Filtered relevant threads: `{len(filtered_threads)}`\n\n"
        "## Files\n\n"
        "- `queries.json` — generated Reddit search queries.\n"
        "- `all_threads.json` — deduped Reddit self-post search results.\n"
        "- `filtered_threads.json` — relevance-filtered first-person suffering threads.\n"
        "- `filtered-corpus.md` — readable corpus passed to Opus.\n"
        "- `analysis-prompt.md` — prompt used for direct Opus synthesis.\n"
        "- `opus-analysis.md` — direct model synthesis output, key input to Stage 03.\n"
        "- `opus-usage.txt` — model and token usage.\n"
        "- `summary.json` — machine-readable run metadata.\n"
    )
    return run_dir


def run_research(args: argparse.Namespace) -> int:
    base_path = args.base_path.resolve()
    product = args.product
    topic = args.topic
    if not topic:
        print("Error: --topic is required", file=sys.stderr)
        return 2
    config = load_product_config(base_path, product)
    try:
        client = anthropic_client()
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    print("=== WW-2 Drive Research Pipeline ===")
    print(f"Product: {product}")
    print(f"Topic: {topic}")
    print(f"Max threads: {args.max_threads}")

    print("\nSTAGE 1: Generating search queries...")
    queries = generate_queries(topic, client)
    for query in queries:
        print(f"  - {query}")

    if args.queries_only:
        print(json.dumps(queries, indent=2))
        return 0

    print("\nSTAGE 2: Searching Reddit...")
    all_threads = fetch_all_threads(queries, max_threads=args.max_threads)
    if not all_threads:
        print("ERROR: No Reddit threads found.", file=sys.stderr)
        return 1

    print("\nSTAGE 3: Filtering threads...")
    filtered_threads = filter_threads(all_threads, topic, client)
    if not filtered_threads:
        print("ERROR: No threads passed relevance filter.", file=sys.stderr)
        return 1

    corpus = render_filtered_corpus(filtered_threads, topic)
    prompt = build_analysis_prompt(topic, product, config, corpus)
    if args.dry_run:
        run_dir = write_research_run(
            base_path=base_path,
            product=product,
            topic=topic,
            label=args.label or topic,
            queries=queries,
            all_threads=all_threads,
            filtered_threads=filtered_threads,
            opus_analysis="# Skipped analysis\n\nDry run created scrape artifacts only.",
            opus_usage="analysis skipped by --dry-run\n",
            analysis_prompt=prompt,
        )
        print(f"\n[DRY RUN] Wrote scrape artifacts without Opus analysis: {run_dir}")
        return 0

    print(f"\nSTAGE 4: Running direct model analysis ({ANALYSIS_MODEL})...")
    opus_analysis, opus_usage, analysis_prompt = run_opus_analysis(topic, product, config, corpus, client)
    run_dir = write_research_run(
        base_path=base_path,
        product=product,
        topic=topic,
        label=args.label or topic,
        queries=queries,
        all_threads=all_threads,
        filtered_threads=filtered_threads,
        opus_analysis=opus_analysis,
        opus_usage=opus_usage,
        analysis_prompt=analysis_prompt,
    )
    print("\n=== Research complete ===")
    print(f"Run folder: {run_dir}")
    print("Next: ww research synthesize {product} --from {run_folder}".format(product=product, run_folder=run_dir))
    return 0


# -------------------------- Stage 03 synthesis --------------------------


def synthesis_prompt(product: str, config: dict[str, Any], opus: str, corpus: str) -> str:
    return f"""You are converting raw Opus/corpus research into canonical WW LFS4.1 research files.

You MUST return only valid JSON matching this contract:
{{
  "archetypes": [
    {{
      "code": "ARC1",
      "name": "short name",
      "core_description": "dense description",
      "awareness_points": [{{"code":"A1","category":"Physical","details":"..."}}, {{"code":"B1","category":"Mechanism","details":"..."}}],
      "failed_solutions": [{{"tried":"...","why_failed":"..."}}],
      "direct_voice": ["verbatim or close-to-verbatim line"]
    }}
  ],
  "hotword_groups": [
    {{
      "title": "Brand/Product Hotwords",
      "entries": [{{"code":"A1","label":"Physical","phrases":["phrase", "phrase"]}}, {{"code":"B1","label":"Mechanism","phrases":["phrase"]}}]
    }}
  ],
  "mechanisms": [
    {{
      "code":"M1",
      "title":"Mechanism title",
      "condition_angle":"condition / angle",
      "ump_name":"villain / old model name",
      "ums_name":"solution mechanism name",
      "core_thought":"Oh. ...",
      "script_ready_spine":"multi-paragraph script-ready explanation",
      "sticky_line":"memorable line",
      "failed_solution_ceilings":[{{"name":"Compression","ceiling":"..."}}],
      "applies_to":["...", "..."]
    }}
  ]
}}

Rules:
- Use codes ARC1.., A1.., B1.., M1.. exactly.
- A-points are pain/current-state language. B-points are mechanism/desire/system-reframe language.
- Prefer source-backed customer language from the corpus.
- Do not invent product claims outside config/product truth.
- Match the drive gold examples' approach, not just their file syntax:
  - For broad product research like PRVN-Weight, hotwords are GLOBAL A/B cards under one product-level title, like "PureVeen Hotwords".
  - Do NOT create scoped duplicate hotword groups such as "ARC1 M1 ..." or "M1_ARC1_A1" unless the source is explicitly a narrow single-lane product example like the Senzio varicose sample.
  - A gold-style broad hotword file should usually contain a compact reusable set, not many micro-scoped duplicates.
  - Mechanisms are a product/mechanism-truth library, not a Reddit sentiment list. Use config.mechanisms, ingredients, mechanism_summary, PDP/ad/source truth, and the source analysis.
  - Do NOT invent a 20-mechanism library from a thin Reddit corpus. If product truth only supports M1 and M4, emit only M1 and M4.
  - If the input is too thin to match PRVN-style depth, produce fewer high-confidence artifacts rather than fake breadth.
- Make the output dense enough to become cards for ad generation only where the input evidence supports that density.

PRODUCT: {product}
CONFIG JSON:
{json.dumps(config, indent=2)[:12000]}

OPUS ANALYSIS:
{opus[:90000]}

FILTERED CORPUS EXCERPT:
{corpus[:70000]}
"""


def validate_synthesis(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("synthesis JSON must be an object")
    for key in ("archetypes", "hotword_groups", "mechanisms"):
        if not isinstance(data.get(key), list) or not data[key]:
            raise ValueError(f"synthesis JSON must include non-empty {key}")
    for i, arc in enumerate(data["archetypes"], 1):
        if not re.fullmatch(r"ARC\d+", str(arc.get("code", ""))):
            raise ValueError(f"archetypes[{i}].code must be ARCn")
        if not arc.get("name") or not arc.get("core_description"):
            raise ValueError(f"archetypes[{i}] requires name and core_description")
    for i, group in enumerate(data["hotword_groups"], 1):
        if not isinstance(group.get("entries"), list) or not group["entries"]:
            raise ValueError(f"hotword_groups[{i}] requires entries")
        for entry in group["entries"]:
            if not re.fullmatch(r"[AB]\d+", str(entry.get("code", ""))):
                raise ValueError(f"hotword_groups[{i}] entry code must be An or Bn")
    for i, mech in enumerate(data["mechanisms"], 1):
        if not re.fullmatch(r"M\d+", str(mech.get("code", ""))):
            raise ValueError(f"mechanisms[{i}].code must be Mn")
        if not mech.get("title") or not mech.get("script_ready_spine"):
            raise ValueError(f"mechanisms[{i}] requires title and script_ready_spine")
    return data


def render_archetypes(archetypes: list[dict[str, Any]]) -> str:
    out: list[str] = []
    for arc in archetypes:
        out.append(f"## {arc['code']}: {arc['name']}")
        out.append("")
        out.append(f"**Core Description:** {arc['core_description']}")
        out.append("")
        points = arc.get("awareness_points") or []
        if points:
            out.extend(["### Awareness Points", "", "| Category | Details |", "| ----- | ----- |"])
            for p in points:
                out.append(f"| **{p.get('code', '')}: {p.get('category', '')}** | {p.get('details', '')} |")
            out.append("")
        failed = arc.get("failed_solutions") or []
        if failed:
            out.extend(["### Failed Solutions", "", "| What They Tried | Why It Failed |", "|-----------------|---------------|"])
            for item in failed:
                out.append(f"| {item.get('tried', '')} | {item.get('why_failed', '')} |")
            out.append("")
        voices = arc.get("direct_voice") or []
        if voices:
            out.extend(["### Direct Voice", ""])
            for voice in voices:
                out.append(f"> {voice}")
                out.append("")
        out.append("---")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def render_hotwords(groups: list[dict[str, Any]]) -> str:
    out: list[str] = []
    for group in groups:
        title = group.get("title") or "Hotwords"
        out.append(f"# {title}")
        out.append("")
        for entry in group.get("entries") or []:
            out.append(f"## {entry.get('code')}: {entry.get('label', '')}")
            for phrase in entry.get("phrases") or []:
                out.append(f"- {phrase}")
            out.append("")
    return "\n".join(out).rstrip() + "\n"


def render_mechanisms(mechanisms: list[dict[str, Any]]) -> str:
    out: list[str] = []
    for mech in mechanisms:
        out.append(f"## {mech['code']}: {mech['title']}")
        out.append("")
        out.append(f"**Condition/Angle:** {mech.get('condition_angle', '')}")
        out.append(f"**UMP Name:** {mech.get('ump_name', '')}")
        out.append(f"**UMS Name:** {mech.get('ums_name', '')}")
        out.append(f"**Core thought:** \"{mech.get('core_thought', '')}\"")
        out.append("")
        out.append("**Script-ready spine:**")
        out.append("")
        out.append("```text")
        out.append(str(mech.get("script_ready_spine") or "").strip())
        sticky = str(mech.get("sticky_line") or "").strip()
        if sticky:
            out.append("")
            out.append(f"Sticky line:\n\"{sticky}\"")
        out.append("```")
        out.append("")
        ceilings = mech.get("failed_solution_ceilings") or []
        if ceilings:
            out.append("**Failed-solution ceilings:**")
            out.append("")
            for item in ceilings:
                out.append(f"- **{item.get('name', '')}:** {item.get('ceiling', '')}")
            out.append("")
        applies = mech.get("applies_to") or []
        if applies:
            out.append(f"**Applies to:** {', '.join(map(str, applies))}.")
            out.append("")
        out.append("---")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def run_synthesize(args: argparse.Namespace) -> int:
    base_path = args.base_path.resolve()
    product = args.product
    run_dir = args.from_dir.resolve()
    if not run_dir.exists():
        print(f"Error: research run folder not found: {run_dir}", file=sys.stderr)
        return 2
    opus_path = run_dir / "opus-analysis.md"
    corpus_path = run_dir / "filtered-corpus.md"
    missing = [str(p) for p in (opus_path, corpus_path) if not p.exists()]
    if missing:
        print(f"Error: missing required Stage 02 files: {', '.join(missing)}", file=sys.stderr)
        return 2
    config = load_product_config(base_path, product)
    prompt = synthesis_prompt(product, config, opus_path.read_text(), corpus_path.read_text())
    try:
        client = anthropic_client()
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    message = claude_message(
        client,
        model=SYNTHESIS_MODEL,
        max_tokens=20000,
        temperature=0.1,
        messages=[{"role": "user", "content": prompt}],
    )
    data = validate_synthesis(extract_json(response_text(message)))
    product_dir = resolve_product_dir(base_path, product)
    research_dir = product_dir / "research"
    research_dir.mkdir(parents=True, exist_ok=True)
    if not args.force:
        existing = [p for p in (research_dir / "archetypes.md", research_dir / "hotwords.md", research_dir / "mechanisms.md") if p.exists()]
        if existing:
            print("Error: refusing to overwrite existing canonical research without --force:", file=sys.stderr)
            for p in existing:
                print(f"  {p}", file=sys.stderr)
            return 1
    (research_dir / "archetypes.md").write_text(render_archetypes(data["archetypes"]))
    (research_dir / "hotwords.md").write_text(render_hotwords(data["hotword_groups"]))
    (research_dir / "mechanisms.md").write_text(render_mechanisms(data["mechanisms"]))
    (research_dir / "canonical-synthesis.json").write_text(json.dumps(data, indent=2) + "\n")
    (research_dir / "canonical-synthesis-usage.txt").write_text(usage_text(message, SYNTHESIS_MODEL))
    print(f"Wrote canonical research to {research_dir}")
    print(f"Next: ww research-cards {product} --verify")
    return 0


# ---------------------------------- CLI ----------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Drive-aligned Reddit research pipeline for WW-2")
    parser.add_argument("product", nargs="?", help="Product code or product folder")
    parser.add_argument("--topic", help="Search topic")
    parser.add_argument("--label", default=None, help="Optional run label")
    parser.add_argument("--max-threads", type=int, default=500)
    parser.add_argument("--dry-run", action="store_true", help="Write scrape artifacts but skip Opus analysis")
    parser.add_argument("--queries-only", action="store_true")
    parser.add_argument("--base-path", type=Path, default=REPO)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "synthesize":
        # argparse subparsers after an optional positional are ambiguous. Parse
        # this form explicitly so the public command is `ww research synthesize PRODUCT`.
        sp = argparse.ArgumentParser(
            prog="research.py synthesize",
            description="Synthesize canonical research from a Stage 02 run",
        )
        sp.add_argument("product")
        sp.add_argument("--from", dest="from_dir", type=Path, required=True)
        sp.add_argument("--force", action="store_true")
        sp.add_argument("--base-path", type=Path, default=REPO)
        return run_synthesize(sp.parse_args(argv[1:]))

    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.product:
        parser.error("product is required")
    return run_research(args)


if __name__ == "__main__":
    raise SystemExit(main())

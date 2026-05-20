#!/usr/bin/env python3
"""
Surgical context loader for WW-2 ad generation.

Parses task_id, extracts ONLY needed sections from research files.
Returns ~800 tokens of targeting per ad, not 4000.

Task ID Format (simplified):
NOOR_LFS_ARC1_A1B2_M1_V001           (6 parts - standard)
NOOR_LFS_ARC1_A1B2_M1_RBPUB_V001     (7 parts - with rock bottom)
NOOR_LFS_ARC1_A1B2_M1_RAGE_RBPUB_V001 (8 parts - legacy with hooks)
"""

import re
import sys
import json
from pathlib import Path
from dataclasses import dataclass
from typing import Optional
from format_contracts import LFS_NATIVE
from research_cards import load_card_or_section, load_hotword_card_or_section

# Product code to folder name mapping
PRODUCT_FOLDERS = {
    "NOOR": "NOOR",
    "ORGJNT": "org-joints",
    "ORGBLT": "org-bloat",
    "ORGWGT": "org-weight",
    "NRJNT": "NR-Joints",
    "NRTHYRO": "NR-Thyro",
    "KTOD": "Kitty-Odor",
    "PCVAG": "PC-Vag",
    "MENOEN": "MenoEnergy",
    "TERA": "TERA",
    "SOLISCREPEY": "SOLIS-Crepey",
    "SOLISWRINKLES": "SOLIS-Wrinkles",
    "CMHAIR": "CM-Hair",
    "SOFYRE": "Sofyre",
    "SOFYRERM": "SoFyre-Res-Mouse",
    "SOFYRERAT": "SoFyre-Rat",
    "SOFYREMOSQ": "SoFyre-Mosquito",
    "SOFYREMOLE": "Sofyre-Mole",
    "FOF": "FatOnFire",
    "ALPHA": "AlphaBoost",
    "PRIMALTRT": "PrimalTRT",
    "PRVNW": "PRVN-Weight",
    "PRVNH": "PRVN-Hair",
    "PRVNM": "PRVN-Hashimoto",
}

# All vidmod framework codes — these map to format="vidmod" with ctx.framework set
VIDMOD_FRAMEWORKS = {
    'ugc1', 'ugc2', 'ugc3', 'ugc4', 'ugc5', 'ugc6', 'ugc7',
    'ugc8', 'ugc9', 'ugc10', 'ugc11', 'ugc12', 'ugc13',
    'nar1', 'nar2', 'nar3', 'nar4', 'nar5',
    'mash1', 'mash2', 'mash3', 'mash4', 'mash5',
    'ifvsl1', 'ifvsl2', 'ifvsl3',
    'vslop1', 'vslop2', 'vslop3',
}


@dataclass
class TaskContext:
    """Parsed context from a task_id."""
    task_id: str
    product: str
    format: str
    archetype_code: str
    a_point: str
    b_point: str
    mechanism_code: str
    hook_type: str
    rock_bottom_type: str
    version: str

    # Loaded content
    archetype_content: str = ""
    archetype_name: str = ""
    a_hotwords: str = ""
    b_hotwords: str = ""
    mechanism_content: str = ""
    mechanism_name: str = ""
    hook_type_content: str = ""
    rock_bottom_content: str = ""

    # Product config (loaded from config.json)
    product_config: dict = None
    demographic_gender: str = "person"
    demographic_age_range: str = "40-65"
    demographic_description: str = ""
    product_name: str = ""
    product_guarantee: str = "60-day"
    product_price: str = ""
    ingredients_text: str = ""
    forbidden_phrases: str = ""
    pricing_discipline: str = ""
    offer_architecture: str = ""

    # Vidmod framework (e.g. "ugc3", "ifvsl1")
    framework: str = ""

    # Batch overrides (from spec.json)
    briefing_override: str = ""
    cta_text: str = ""

    # Context files (loaded from spec.json context_files)
    context_files_content: str = ""


def _is_date_part(part: str) -> bool:
    """Check if a task_id part is a date like Mar6, May24, Jan15."""
    return bool(re.match(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\d{1,2}$", part))


def _is_version_part(part: str) -> bool:
    """Check if a task_id part is a version like V001."""
    return bool(re.match(r"^V\d+$", part))


def _is_mechanism_part(part: str) -> bool:
    """Check if a task_id part is a mechanism like M1, M2."""
    return bool(re.match(r"^M\d+$", part))


def _is_rock_bottom_part(part: str) -> bool:
    """Check if a task_id part is a rock bottom like RBPUB, RBREL."""
    return bool(re.match(r"^RB[A-Z]+$", part))


def parse_task_id(task_id: str) -> TaskContext:
    """
    Parse task_id into its components.

    New format (5-7 parts):
    - Minimal:          TERA_UGC4_ARC3_A6B5_Mar6
    - With mechanism:   TERA_UGC4_ARC3_A6B5_M2_Mar6
    - With rock bottom: NOOR_LFS_ARC1_A3B2_RBPUB_Mar6
    - With both:        NOOR_LFS_ARC1_A3B2_M2_RBPUB_Mar6
    - Arc-agnostic:     TERA_UGC4_SCAM-GUY_A6B5_Mar6

    Legacy format (6-8 parts, still supported):
    - Standard:         NOOR_LFS_ARC1_A1B2_M1_V001
    - With rock bottom: NOOR_LFS_ARC1_A1B2_M1_RBPUB_V001
    - With hooks:       NOOR_LFS_ARC1_A1B2_M1_RAGE_RBPUB_V001
    """
    parts = task_id.split("_")

    # First 4 parts are always: product, format, identity, angle
    if len(parts) < 5:
        raise ValueError(f"Invalid task_id format: {task_id}. Need at least 5 parts, got {len(parts)}")

    product = parts[0]
    format_code = parts[1]
    archetype = parts[2]
    angle = parts[3]

    # Classify remaining parts (index 4+)
    tail = parts[4:]
    mechanism = ""
    hook_type = ""
    rock_bottom = ""
    version = ""

    for part in tail:
        if _is_mechanism_part(part):
            mechanism = part
        elif _is_rock_bottom_part(part):
            rock_bottom = part
        elif _is_version_part(part):
            version = part
        elif _is_date_part(part):
            version = part  # date goes into version field for compatibility
        elif not mechanism and not rock_bottom:
            # Legacy hook type (RAGE, THIRD, etc.) — only if nothing else matched yet
            hook_type = part

    # Default mechanism to M1 if not specified
    if not mechanism:
        mechanism = "M1"

    # Parse angle: A1B2 -> a_point=A1, b_point=B2 (supports A+B, B+B, A+A combos)
    angle_match = re.match(r"([AB]\d+)([AB]\d+)", angle)
    if not angle_match:
        raise ValueError(f"Invalid angle format: {angle}. Expected format like A1B2, B1B2, or A1A3")

    a_point, b_point = angle_match.groups()

    # Check if format is a vidmod framework code
    format_lower = format_code.lower()
    if format_lower in VIDMOD_FRAMEWORKS:
        resolved_format = 'vidmod'
        framework = format_lower
    else:
        resolved_format = format_lower
        framework = ''

    return TaskContext(
        task_id=task_id,
        product=product,
        format=resolved_format,
        archetype_code=archetype,
        a_point=a_point,
        b_point=b_point,
        mechanism_code=mechanism,
        hook_type=hook_type,
        rock_bottom_type=rock_bottom,
        version=version,
        framework=framework,
    )


def extract_section(content: str, section_id: str) -> str:
    """
    Extract a section from markdown content.

    Sections start with "## SECTION_ID:" and end at the next "## " or "---" or end of file.
    """
    # Pattern: ## SECTION_ID: (anything) followed by content until next section
    pattern = rf"## {re.escape(section_id)}:([^\n]*)\n(.*?)(?=\n## |\n---|\Z)"
    match = re.search(pattern, content, re.DOTALL)

    if not match:
        return ""

    section_title = match.group(1).strip()
    section_body = match.group(2).strip()

    return f"## {section_id}: {section_title}\n\n{section_body}"


def extract_section_name(content: str, section_id: str) -> str:
    """Extract just the name/title from a section header."""
    pattern = rf"## {re.escape(section_id)}:\s*(.+)"
    match = re.search(pattern, content)
    return match.group(1).strip() if match else section_id


def load_product_config(product_code: str, base_path: Path) -> dict:
    """
    Load product configuration from config.json.

    Args:
        product_code: Product code (e.g., NRJNT)
        base_path: Base project path

    Returns:
        Product config dict, or empty dict if not found
    """
    product_folder = PRODUCT_FOLDERS.get(product_code, product_code)
    config_file = base_path / "products" / product_folder / "config.json"

    if config_file.exists():
        return json.loads(config_file.read_text())
    return {}


def load_context(task_id: str, base_path: Optional[Path] = None, spec: Optional[dict] = None) -> TaskContext:
    """
    Load surgical context for a task_id.

    Only loads the sections needed for THIS specific task.

    Args:
        task_id: Task identifier
        base_path: Base project path
        spec: Optional batch spec dict (for briefing/CTA overrides)
    """
    if base_path is None:
        base_path = Path(__file__).parent.parent

    ctx = parse_task_id(task_id)

    # Load product config
    ctx.product_config = load_product_config(ctx.product, base_path)

    # Extract demographic from product config
    if ctx.product_config:
        demo = ctx.product_config.get("target_demographic", {})
        ctx.demographic_gender = demo.get("gender", "person")
        ctx.demographic_age_range = demo.get("age_range", "40-65")
        ctx.product_name = ctx.product_config.get("product_name", "")
        ctx.product_guarantee = ctx.product_config.get("guarantee", "60-day")
        ctx.product_price = str(ctx.product_config.get("price", ""))

        # Build ingredients text from product config (with emojis and line breaks for readability)
        # Prefer "all" ingredients list over "primary" for full formula context
        ingredients = ctx.product_config.get("ingredients", {})
        all_ingredients = ingredients.get("all", []) or ingredients.get("primary", [])
        if all_ingredients:
            ing_lines = []
            for ing in all_ingredients:
                name = ing.get("name", "")
                benefit = ing.get("benefit", "")
                if name and benefit:
                    ing_lines.append(f"🌿 {name}: {benefit}")
                elif name:
                    ing_lines.append(f"🌿 {name}")
            ctx.ingredients_text = "\n\n".join(ing_lines)  # Double line break between ingredients

        # Build demographic description
        conditions = demo.get("primary_conditions", [])
        conditions_str = ", ".join(conditions[:3]) if conditions else "health issues"
        ctx.demographic_description = f"Target: {ctx.demographic_gender}s aged {ctx.demographic_age_range} dealing with {conditions_str}."

        # Load forbidden phrases from product config
        prompt_context = ctx.product_config.get("prompt_context", {})
        forbidden_list = prompt_context.get("forbidden_phrases", [])
        if forbidden_list:
            ctx.forbidden_phrases = "FORBIDDEN: " + ", ".join(f'"{p}"' for p in forbidden_list)
        else:
            ctx.forbidden_phrases = ""

        # Load pricing discipline from product config (positive framing)
        pricing_rules = ctx.product_config.get("pricing_rules", {})
        if pricing_rules:
            lines = ["PRICING DISCIPLINE (canonical facts — use only these when pricing the advertised product):"]
            single_price = pricing_rules.get("single_bag_price_usd")
            single_covers = pricing_rules.get("single_bag_covers")
            if single_price is not None:
                if isinstance(single_price, (int, float)):
                    lines.append(f"- The product price in copy is ${single_price}.")
                else:
                    lines.append(f"- Product pricing rule: {single_price}.")
            if single_covers:
                lines.append(f"- One unit of the product covers: {single_covers}")
            guarantee = pricing_rules.get("guarantee")
            if guarantee:
                lines.append(f"- Guarantee: {guarantee}")
            positives = pricing_rules.get("pricing_rules_positive", [])
            for rule in positives:
                lines.append(f"- {rule}")
            phrasings = pricing_rules.get("canonical_phrasings", [])
            if phrasings:
                lines.append("Canonical phrasings — use verbatim or close variants:")
                for phrase in phrasings:
                    lines.append(f'  "{phrase}"')
            ctx.pricing_discipline = "\n".join(lines)
        else:
            ctx.pricing_discipline = ""

        # Load offer architecture from product config (close-section scaffolding)
        offer = ctx.product_config.get("offer_architecture", {})
        if offer:
            lines = ["OFFER ARCHITECTURE (build the close from these — the body of the script is strong, the close is what converts):"]
            wyg = offer.get("what_you_get", [])
            if wyg:
                lines.append("\nWhat the reader gets from one advertised unit (use as value stack):")
                for item in wyg:
                    lines.append(f"  - {item}")
            framing = offer.get("value_stack_framing")
            if framing:
                lines.append(f"\nValue-stack framing: {framing}")
            anchors = offer.get("price_anchor_stack", [])
            if anchors:
                lines.append("\nPrice anchors (compare the product price against these — name them out loud):")
                for a in anchors:
                    lines.append(f"  - {a}")
            guarantee_framing = offer.get("guarantee_framing")
            if guarantee_framing:
                lines.append(f"\nGuarantee framing: {guarantee_framing}")
            urgency = offer.get("urgency_lever")
            if urgency:
                lines.append(f"\nUrgency lever: {urgency}")
            urgency_phrasings = offer.get("urgency_phrasings", [])
            if urgency_phrasings:
                lines.append("Urgency phrasings — use verbatim or close variants:")
                for p in urgency_phrasings:
                    lines.append(f'  "{p}"')
            close_arc = offer.get("close_arc")
            if close_arc:
                lines.append(f"\nClose arc (3 beats, in this order): {close_arc}")
            ctx.offer_architecture = "\n".join(lines)
        else:
            ctx.offer_architecture = ""

    # Load batch overrides from spec if provided
    if spec:
        briefing = spec.get("briefing", "") or spec.get("briefings", "")
        # CTA: check for zone/angle variants first, fall back to cta_text
        cta_variants = spec.get("cta_variants", {})
        if cta_variants:
            batch_id = spec.get("batch_id", "")
            matched_cta = None
            for key, cta_val in cta_variants.items():
                if key in batch_id or key in task_id:
                    matched_cta = cta_val
                    break
            ctx.cta_text = matched_cta or spec.get("cta_text", "")
        else:
            ctx.cta_text = spec.get("cta_text", "")

        # Handle briefing as either string or dict
        if isinstance(briefing, dict):
            # Check if any key matches this task_id (per-task briefing)
            if task_id in briefing:
                briefing = briefing[task_id]
            else:
                # Convert dict to formatted string (legacy behavior)
                briefing_parts = []
                for key, value in briefing.items():
                    if isinstance(value, dict):
                        briefing_parts.append(f"### {key.replace('_', ' ').title()}")
                        for k, v in value.items():
                            if isinstance(v, list):
                                briefing_parts.append(f"**{k.replace('_', ' ').title()}:**")
                                for item in v:
                                    briefing_parts.append(f"- {item}")
                            else:
                                briefing_parts.append(f"**{k.replace('_', ' ').title()}:** {v}")
                    elif isinstance(value, list):
                        briefing_parts.append(f"### {key.replace('_', ' ').title()}")
                        for item in value:
                            briefing_parts.append(f"- {item}")
                    else:
                        briefing_parts.append(f"**{key.replace('_', ' ').title()}:** {value}")
                briefing = "\n".join(briefing_parts)

        ctx.briefing_override = briefing

        # Prepend CRITICAL OVERRIDE if briefing exists
        if ctx.briefing_override:
            ctx.briefing_override = f"""---

## CRITICAL OVERRIDE FROM BATCH SPEC (This takes precedence over defaults)

{ctx.briefing_override}

---
"""

    # Paths - use product folder mapping
    product_folder = PRODUCT_FOLDERS.get(ctx.product, ctx.product)
    product_path = base_path / "products" / product_folder / "research"
    components_path = base_path / "components"

    # Fail loudly if product folder doesn't exist
    if not product_path.exists():
        raise FileNotFoundError(
            f"Product research folder not found: {product_path}\n"
            f"Product code '{ctx.product}' maps to folder '{product_folder}'.\n"
            f"Either add the folder or update PRODUCT_FOLDERS in context.py."
        )

    # Language-aware research file resolution.
    # When spec has `language: "bg"` (or other non-default), look for sidecar -{lang}.md
    # files first (e.g. archetypes-bg.md) and resolve sections with `_{LANG_UPPER}` suffix
    # (e.g. ## ARC6_BG: instead of ## ARC6:). Falls back to canonical files if sidecars absent.
    spec_lang = (spec.get("language", "en") if spec else "en").lower()
    section_suffix = f"_{spec_lang.upper()}" if spec_lang != "en" else ""

    def _research_file(canonical_name: str):
        """Return the language-appropriate research file, falling back to canonical."""
        if spec_lang != "en":
            sidecar = product_path / f"{canonical_name}-{spec_lang}.md"
            if sidecar.exists():
                return sidecar
        return product_path / f"{canonical_name}.md"

    # Load archetype section. V4 prefers product-scoped cards and falls back to
    # legacy section extraction so existing products keep working.
    # Arc-agnostic scripts use persona names (SCAM-GUY, MARCUS) instead of ARC codes.
    # These won't match a section in archetypes.md — that's OK if the batch has a briefing override.
    archetypes_file = _research_file("archetypes")
    archetype_lookup_code = f"{ctx.archetype_code}{section_suffix}"
    arc_slice = load_card_or_section(
        product_path,
        group="archetypes",
        code=archetype_lookup_code,
        source_path=archetypes_file,
    )
    if arc_slice.text:
        ctx.archetype_content = arc_slice.text
        ctx.archetype_name = extract_section_name(ctx.archetype_content, archetype_lookup_code)
    if not ctx.archetype_content:
        # Check if this is an arc-agnostic identity (not ARC + number)
        if re.match(r"^ARC\d+$", ctx.archetype_code):
            raise ValueError(
                f"Archetype '{archetype_lookup_code}' not found in {archetypes_file}.\n"
                f"Section must start with '## {archetype_lookup_code}:'"
            )
        else:
            # Arc-agnostic — persona name as identity. Use identity as archetype_name.
            ctx.archetype_name = ctx.archetype_code
            print(f"NOTE: '{ctx.archetype_code}' is not an archetype code — using as persona identity (arc-agnostic mode)", file=sys.stderr)

    # Load hotwords (A-point and B-point) — language-aware
    hotwords_file = _research_file("hotwords")
    a_lookup = f"{ctx.a_point}{section_suffix}"
    b_lookup = f"{ctx.b_point}{section_suffix}"
    a_slice = load_hotword_card_or_section(
        product_path,
        code=a_lookup,
        mechanism_code=ctx.mechanism_code,
        archetype_code=ctx.archetype_code,
        source_path=hotwords_file,
    )
    b_slice = load_hotword_card_or_section(
        product_path,
        code=b_lookup,
        mechanism_code=ctx.mechanism_code,
        archetype_code=ctx.archetype_code,
        source_path=hotwords_file,
    )
    ctx.a_hotwords = a_slice.text
    ctx.b_hotwords = b_slice.text
    if not ctx.a_hotwords:
        raise ValueError(f"A-point '{a_lookup}' not found. {a_slice.source}")
    if not ctx.b_hotwords:
        raise ValueError(f"B-point '{b_lookup}' not found. {b_slice.source}")

    # Load mechanism — language-aware
    mechanisms_file = _research_file("mechanisms")
    mech_lookup = f"{ctx.mechanism_code}{section_suffix}"
    mech_slice = load_card_or_section(product_path, group="mechanisms", code=mech_lookup, source_path=mechanisms_file)
    ctx.mechanism_content = mech_slice.text
    if ctx.mechanism_content:
        ctx.mechanism_name = extract_section_name(ctx.mechanism_content, mech_lookup)
    if not ctx.mechanism_content:
        raise ValueError(f"Mechanism '{mech_lookup}' not found in {mechanisms_file}.")

    # Load hook type (shared component) - only for formats that use it
    if ctx.hook_type:
        hook_types_file = components_path / "hook-types.md"
        if hook_types_file.exists():
            hook_types_content = hook_types_file.read_text()
            ctx.hook_type_content = extract_section(hook_types_content, ctx.hook_type)
        if not ctx.hook_type_content:
            raise ValueError(f"Hook type '{ctx.hook_type}' not found in {hook_types_file}.")

    # RB task-id parts are legacy labels. They remain parseable for old batch IDs,
    # but generation no longer loads shared rock-bottom templates from them.
    ctx.rock_bottom_content = ""

    # Format → canonical context files (auto-loaded, deduped against spec).
    # Mirrors LFS pattern: format code alone drives the reference graph — operators
    # cannot forget to list the canonical files because the format code is the contract.
    FORMAT_CANONICAL_FILES = {
        "lfs": [
            "components/dr-opener-primal-recognition.md",
        ],
        "modv": [
            "components/hook-modular.md",
        ],
    }

    listed_files = list(spec.get("context_files", []) if spec else [])
    auto_files = FORMAT_CANONICAL_FILES.get(ctx.format, [])
    # Auto-load canonical files FIRST, then operator-specified files (dedup preserves order)
    seen = set()
    merged_files: list[str] = []
    for f in list(auto_files) + listed_files:
        if f not in seen:
            seen.add(f)
            merged_files.append(f)

    if merged_files:
        context_parts = []
        for file_path_str in merged_files:
            file_path = base_path / file_path_str
            if file_path.exists():
                file_text = file_path.read_text().strip()
                context_parts.append(f"### FILE: {file_path_str}\n\n{file_text}")
            else:
                print(f"WARNING: context_file not found: {file_path}", file=sys.stderr)
        if context_parts:
            ctx.context_files_content = "\n\n---\n\n".join(context_parts)

    return ctx


# Module driver mapping: which sections are pain-driven (A-point) vs solution-driven (B-point)
# A-point modules use A-point hotwords (pain, problems, failures)
# B-point modules use B-point hotwords (solution, mechanism, transformation)
# Modules not in either set are neutral (no annotation)
A_POINT_MODULES = {
    "Hook", "Problem", "Twist the Knife", "Bad Alternative / Failed Solution",
    "Depositioning", "Relatable Story", "Personal Sob Story",
    "How It Got Bad (Physical Pain)", "Tried Everything",
    "It Got Worse (Emotional Pain)", "Old Way", "Scary Consequences",
    "Green Screen Studies (Old Way)", "Old Solution", "Why It Won't Help",
    "Everything You Know Is Wrong",
    "Big Pharma Wouldn't Profit If You Had a Solution",
    "Lead", "This Is the Secret", "It Keeps Getting Banned",
    "Guru's Story (I Was Like You)", "Alternatives Don't Work",
    "Old Way vs New Way",
}

B_POINT_MODULES = {
    "Product Intro", "Product Demo", "Feature", "Benefit", "Feature / Benefit",
    "Social Proof", "CTA", "Education", "Edutainment", "Special Details",
    "Results", "Desired End Result", "Unique Mechanism P", "Unique Mechanism S",
    "Discovery", "New Way (Product Reveal)", "Summary of Solutions",
    "Guarantee", "How-To", "Use Case", "Testimonial",
    "Green Screen Studies (UM Works)", "Ingredient / Benefit",
    "But There's Hope", "No More Old Solutions", "Throw Away Old Way",
    "AOV Close", "Moneyback Guarantee", "FAQ",
    "I Have a Solution (Tease)", "I Made It Even Better",
    "Ingredients Are Rare", "I Created a Test Batch",
    "My Close Circle Loved It", "Word of Mouth Spread", "The Product Is Born",
    "We Added XYZ", "Ingredients Aren't Available to the Public",
    "Its UM Gets You All the Benefits", "There's a New Way",
    "New Way Benefits", "I Created My Own", "Small Batches First",
    "Hundreds of Testimonials", "Features (Dosage, Convenience, Taste)",
    "5 Testimonials", "CTA (Take the Challenge)", "Price Reveal",
    "Results Testimonials", "CTA (Take Action Now)", "3 Testimonials",
    "Celebrities' Secret", "Special Presentation", "Watch It Now",
    "I Have the Link", "I Urge You to Watch Now", "Thanks to This Secret",
    "I Tried It (Before & After)", "It's For Folks Like...",
    "Status Delta", "Guru Discovery", "He Helps Others Fix My Problem",
    "Results From Scientific Studies", "My Altruistic Mission",
    "Guru's Transformation Teaser", "Credibility Clip",
    "I Started Researching", "Secret Discovery (Tease UMS)",
    "Unique Mechanism P (Pt.1) + Testimonial",
    "Unique Mechanism P (Pt.2) + Testimonial",
    "Unique Mechanism P (Pt.3) + Testimonial",
    "UMS Component (Pt.1)", "UMS Component (Pt.2)", "UMS Component (Pt.3)",
    "When I Combined All 3", "My Circle Tried It", "UMS Reveal",
    "5 Raving Testimonials", "Scarcity / Urgency",
    "Summary of Solutions", "New Way (Product Reveal)",
}


def _build_vidmod_replacements(ctx: TaskContext, base_path: Path) -> dict:
    """
    Build vidmod-specific template replacements.

    Loads frameworks.json and modules.md, builds framework_sections
    and outline_template from the framework definition.
    Annotates sections with A-POINT DRIVEN / B-POINT DRIVEN markers.
    """
    vidmod_path = base_path / "formats" / "vidmod"

    # Load framework definitions
    frameworks_file = vidmod_path / "frameworks.json"
    with open(frameworks_file) as f:
        frameworks = json.load(f)

    framework = frameworks.get(ctx.framework)
    if not framework:
        raise ValueError(f"Unknown vidmod framework '{ctx.framework}'. Check frameworks.json.")

    # Load module definitions
    modules_file = vidmod_path / "modules.md"
    modules_text = modules_file.read_text()

    # Parse modules.md into a dict of module_name -> definition
    modules = {}
    current_module = None
    current_lines = []
    for line in modules_text.split('\n'):
        if line.startswith('## ') and not line.startswith('## #'):
            if current_module:
                modules[current_module] = '\n'.join(current_lines).strip()
            current_module = line[3:].strip()
            current_lines = []
        elif current_module:
            current_lines.append(line)
    if current_module:
        modules[current_module] = '\n'.join(current_lines).strip()

    # Build framework_sections — numbered section list with module definitions
    # Annotate each section with A-POINT or B-POINT driver
    sections_parts = []
    outline_parts = []
    for i, section in enumerate(framework["sections"], 1):
        module_name = section["module"]
        section_id = section["id"]
        section_label = module_name.upper()

        # Look up module definition
        module_def = modules.get(module_name, "")

        # Determine A/B point driver
        if module_name in A_POINT_MODULES:
            annotation = " ← A-POINT DRIVEN"
            outline_hint = (
                f"[A-POINT ({ctx.a_point}) angle: what specific pain/scene/detail? "
                f"Archetype voice ({ctx.archetype_name}): how does this person express this?]"
            )
        elif module_name in B_POINT_MODULES:
            annotation = " ← B-POINT DRIVEN"
            outline_hint = (
                f"[B-POINT ({ctx.b_point}) lens: how do you frame this through {ctx.b_point}? "
                f"Archetype voice ({ctx.archetype_name}): what emotion carries into the solution?]"
            )
        else:
            annotation = ""
            outline_hint = f"[Specific detail/scene. Stay in {ctx.archetype_name} voice.]"

        sections_parts.append(f"### Section {i}: {section_label}{annotation}\n{module_def}")
        outline_parts.append(f"Section {i} ({section_label}){annotation}: {outline_hint}")

    # Category display name
    category_names = {
        "ugc": "UGC",
        "nar": "Non-Narrated",
        "mash": "Mashup",
        "ifvsl": "In-Feed VSL",
        "vslop": "VSL Opener",
    }

    # Load hook templates (default to wellness)
    hooks_file = base_path / "components" / "hooks" / "wellness.md"
    hook_templates = ""
    if hooks_file.exists():
        hook_templates = hooks_file.read_text().strip()

    return {
        "framework_name": framework["name"],
        "framework_voice": framework["voice"],
        "framework_word_min": str(framework["word_count"]["min"]),
        "framework_word_max": str(framework["word_count"]["max"]),
        "framework_category": category_names.get(framework["category"], framework["category"]),
        "framework_sections": "\n\n".join(sections_parts),
        "outline_template": "\n".join(outline_parts),
        "hook_templates": hook_templates,
    }


def render_prompt(ctx: TaskContext, base_path: Optional[Path] = None, batch_dir: Optional[Path] = None, spec: Optional[dict] = None) -> str:
    """
    Render the prompt template with loaded context.

    If batch_dir contains a prompt.md, uses that (freeform mode).
    Otherwise falls back to the format-level prompt template.
    Supports prompt_version in spec.json (e.g., "v2" loads prompt-v2.md).
    """
    if base_path is None:
        base_path = Path(__file__).parent.parent

    if ctx.format == "lfs" and "dr-opener-primal-recognition.md" not in (ctx.context_files_content or ""):
        opener_principle = base_path / "components" / "dr-opener-primal-recognition.md"
        if opener_principle.exists():
            opener_context = f"### FILE: components/dr-opener-primal-recognition.md\n\n{opener_principle.read_text().strip()}"
            ctx.context_files_content = (
                opener_context
                if not ctx.context_files_content
                else opener_context + "\n\n---\n\n" + ctx.context_files_content
            )

    # Freeform: per-task prompt overrides shared prompt.md.
    # LFS V4.1 is stricter: batch generation must use prompts/{task_id}.md so
    # concept data stays isolated and the invariants footer is always injected.
    # Legacy fallbacks remain available to non-LFS formats only.
    prompts_dir_task = batch_dir / "prompts" / f"{ctx.task_id}.md" if batch_dir else None
    outline_dir_task = batch_dir / "outlines" / f"{ctx.task_id}.md" if batch_dir else None
    task_prompt = batch_dir / f"prompt_{ctx.task_id}.md" if batch_dir else None
    batch_prompt = batch_dir / "prompt.md" if batch_dir else None
    if ctx.format == "lfs" and batch_dir and (not prompts_dir_task or not prompts_dir_task.exists()):
        legacy_found = []
        if task_prompt and task_prompt.exists():
            legacy_found.append(str(task_prompt))
        if batch_prompt and batch_prompt.exists():
            legacy_found.append(str(batch_prompt))
        legacy_note = f"\nLegacy prompt files found but ignored for LFS V4.1: {', '.join(legacy_found)}" if legacy_found else ""
        raise FileNotFoundError(
            f"LFS V4.1 requires a per-task prompt file: {prompts_dir_task}\n"
            f"Create batches/{{BATCH}}/prompts/{{TASK_ID}}.md for every task. "
            f"Do not use spec briefings, prompt_{{TASK_ID}}.md, or shared prompt.md for LFS batches."
            f"{legacy_note}"
        )

    if prompts_dir_task and prompts_dir_task.exists():
        template = prompts_dir_task.read_text()
        if ctx.format == "lfs" and outline_dir_task and outline_dir_task.exists():
            outline_text = outline_dir_task.read_text().strip()
            if outline_text:
                # LFS V4.1: the outline is format-merged, so standalone
                # components/lfs-formats/*.md files must not compete with it as
                # a second beat-order authority during generation.
                ctx.context_files_content = _strip_lfs_format_context(ctx.context_files_content)
                template += f"""

---

SCRIPT OUTLINE — REQUIRED BLUEPRINT

The outline below is not an observability artifact. It is the plan for this exact script.
Follow its beat order, emotional escalation, recurring scene anchors, and section-level promises.
Preserve every charged beat while expressing it in product-safe buyer language.
Convert outline directions into the narrator voice from the per-task brief.
If the VERBATIM HOOK is first person, the full ad stays first person.
The outline may use "she" or "the narrator" as shorthand; the finished copy uses the actual speaker.

{outline_text}
"""
        # Auto-append invariants footer — per-task prompts don't carry
        # placeholder blocks for price/CTA/compliance, so force-inject them
        # at the tail. Substitution happens in the replacements pass below.
        template += """

---

PRODUCTION FACTS — highest priority product truth for this exact script.

MECHANISM LOCK — selected product mechanism card for this exact task.

Use this as the only mechanism. Keep the mechanism name and causal explanation nearly verbatim in the mechanism reveal. Make the angle, scene, wound, and failed solutions orbit this mechanism.

<mechanism_lock>
{mechanism_content}
</mechanism_lock>

{lfs_native_format_contract}

{product_name_lock}

{pricing_discipline}

{offer_architecture}

CLOSE QUALITY — the close is where this audience converts or scrolls. Write a real close with three concrete beats in order: (1) value stack from the product config, (2) price anchor against the failed alternatives named in the task prompt or product config, (3) urgency from the product's own mechanism and audience problem. Keep the close specific to this product and this angle. Each beat gets its own short paragraph.

CTA — copy this exact CTA text as one standalone close line:

{cta_instructions}

PRODUCT-SAFE LANGUAGE BOUNDARIES — final copy uses buyer-safe alternatives for these blocked phrases:

{forbidden_phrases}

INGREDIENTS — use only the ingredient names and roles listed below. Leave out doses, percentages, clinical-trial numbers, and technical claims unless they appear in this list:

{ingredients_text}

WRITE COMMAND — begin writing the script now.

Final pass before returning:
- Keep the narrator POV from the VERBATIM HOOK through the whole ad.
- Split every multi-sentence paragraph into one sentence per paragraph.
- Keep every paragraph scan-friendly.

Return the ad copy only. The first word of your output is the first word of the ad.
"""
    elif task_prompt and task_prompt.exists():
        template = task_prompt.read_text()
    elif batch_prompt and batch_prompt.exists():
        template = batch_prompt.read_text()
        # Auto-inject product reveal component if not already present
        product_reveal_file = base_path / "components" / "product-reveal-prompt.md"
        if product_reveal_file.exists() and "product reveal" not in template.lower():
            template += "\n\n" + product_reveal_file.read_text()
    else:
        # Check for prompt version override in spec
        prompt_version = spec.get("prompt_version", "") if spec else ""
        if prompt_version:
            prompt_file = base_path / "formats" / ctx.format / f"prompt-{prompt_version}.md"
            if not prompt_file.exists():
                raise FileNotFoundError(
                    f"Prompt version '{prompt_version}' not found: {prompt_file}\n"
                    f"Available: prompt.md (default)"
                )
        else:
            prompt_file = base_path / "formats" / ctx.format / "prompt.md"
        if not prompt_file.exists():
            raise FileNotFoundError(f"Prompt file not found: {prompt_file}")
        template = prompt_file.read_text()

    # Build CTA instructions - use spec CTA if provided, otherwise default
    if ctx.cta_text:
        cta_instructions = f"""Copy this exact CTA text:

{ctx.cta_text}"""
    else:
        # Default CTA template
        cta_instructions = f"""Use this exact emoji bullet format:

(emoji) Click "LEARN MORE" below to read an article about {ctx.product_name or '[Product Name]'}

(emoji) {ctx.product_guarantee} Money-Back Guarantee

(emoji) Clinical Doses - [Key Ingredients]

(emoji) Made in USA, FDA-Registered Facility

(emoji) Trusted by thousands of {ctx.demographic_gender}s over {ctx.demographic_age_range.split('-')[0] if '-' in ctx.demographic_age_range else '40'}"""

    # Build replacement dict with all possible placeholders
    replacements = {
        "task_id": ctx.task_id,
        "product": ctx.product,
        "hotword": ctx.product_config.get("hotword", "") if ctx.product_config else "",
        "archetype_code": ctx.archetype_code,
        "archetype_name": ctx.archetype_name,
        "a_point": ctx.a_point,
        "b_point": ctx.b_point,
        "mechanism_code": ctx.mechanism_code,
        "mechanism_name": ctx.mechanism_name,
        "hook_type": ctx.hook_type or "",
        "rock_bottom_type": ctx.rock_bottom_type or "",
        "archetype_content": ctx.archetype_content,
        "a_hotwords": ctx.a_hotwords,
        "b_hotwords": ctx.b_hotwords,
        "mechanism_content": ctx.mechanism_content,
        "hook_type_content": ctx.hook_type_content or "",
        "rock_bottom_content": ctx.rock_bottom_content or "",
        # Demographic placeholders
        "demographic_gender": ctx.demographic_gender,
        "demographic_age_range": ctx.demographic_age_range,
        "demographic_description": ctx.demographic_description,
        "forbidden_phrases": ctx.forbidden_phrases or "",
        "pricing_discipline": ctx.pricing_discipline or "",
        "offer_architecture": ctx.offer_architecture or "",
        "lfs_native_format_contract": LFS_NATIVE.prompt_block() if ctx.format == "lfs" else "",
        "product_name_lock": (
            f"PRODUCT NAME LOCK — the brand is \"{ctx.product_name}\". "
            f"Use the full brand name on first reveal. After reveal, refer to the product by brand at least 4 times in the second half of the script. "
            f"The CTA names the brand again. The P.S. names the brand again. "
            f"Generic references like \"this company\", \"the item\", \"this product\" without the brand name are forbidden after the first reveal."
        ) if ctx.product_name else "",
        # Product info
        "product_name": ctx.product_name or "[Product Name]",
        "product_price": ctx.product_price or "",
        "product_guarantee": ctx.product_guarantee or "60-day",
        "ingredients_text": ctx.ingredients_text or "",
        # Batch overrides
        "briefing_override": ctx.briefing_override or "",
        "cta_instructions": cta_instructions,
        # Context files (from spec.json context_files)
        "context_files": ctx.context_files_content or "",
    }

    # Add vidmod-specific replacements if this is a vidmod framework
    if ctx.framework:
        vidmod_replacements = _build_vidmod_replacements(ctx, base_path)
        replacements.update(vidmod_replacements)

    # Replace placeholders
    rendered = template.format(**replacements)

    # LFS: put the specific writer persona first, then reusable principles,
    # then task data/outline, then the final write command at the tail.
    if ctx.format == "lfs":
        rendered = _lfs_generation_header(ctx) + "\n\n---\n\n" + (
            ctx.context_files_content + "\n\n---\n\n" if ctx.context_files_content else ""
        ) + rendered
        return rendered

    # Prepend context_files BEFORE the rendered template for legacy formats.
    if ctx.context_files_content:
        rendered = ctx.context_files_content + "\n\n---\n\n" + rendered

    return rendered


def _lfs_generation_header(ctx: TaskContext) -> str:
    audience = ", ".join(
        part for part in [
            ctx.demographic_gender,
            ctx.demographic_age_range,
            ctx.archetype_name,
        ]
        if part
    )
    return f"""LFS WRITER PERSONA

You are writing one Long Form Static ad for {ctx.product_name or ctx.product}.

Write like the person in this exact brief finally saying the private thing out loud to one trusted friend. The copy is plainspoken, emotionally causal, feed-native, and easy to skim.

Audience signal: {audience or "use the audience in the task brief"}.
Mechanism lane: {ctx.mechanism_name or ctx.mechanism_code}.

Use this prompt in order:
1. Universal LFS principles calibrate the writing.
2. The per-task brief defines the angle, opener, proof, and commitments.
3. The required outline defines the beat order.
4. Production facts define product truth, close, CTA, pricing, and language boundaries.

The final output is the finished ad copy."""


def _strip_lfs_format_context(context_text: str) -> str:
    if not context_text:
        return context_text
    parts = re.split(r"\n\n---\n\n", context_text)
    kept = [
        part
        for part in parts
        if not re.match(r"^### FILE: components/lfs-formats/[^/\n]+\.md\b", part.strip())
    ]
    return "\n\n---\n\n".join(kept)


def main():
    """CLI interface for testing context loading."""
    import sys

    if len(sys.argv) < 2:
        print("Usage: python context.py <task_id>")
        print("Examples:")
        print("  python context.py NOOR_LFS_ARC1_A1B2_M1_V001           # 6 parts (standard)")
        print("  python context.py NOOR_LFS_ARC1_A1B2_M1_RBPUB_V001     # 7 parts (with rock bottom)")
        print("  python context.py NOOR_LFS_ARC1_A1B2_M1_RAGE_RBPUB_V001 # 8 parts (legacy)")
        sys.exit(1)

    task_id = sys.argv[1]

    try:
        ctx = load_context(task_id)

        print(f"Task ID: {ctx.task_id}")
        print(f"Product: {ctx.product}")
        print(f"Format: {ctx.format}")
        print(f"Archetype: {ctx.archetype_code} - {ctx.archetype_name}")
        print(f"Angle: A-point={ctx.a_point}, B-point={ctx.b_point}")
        print(f"Mechanism: {ctx.mechanism_code} - {ctx.mechanism_name}")
        print(f"Hook Type: {ctx.hook_type}")
        print(f"Rock Bottom: {ctx.rock_bottom_type}")
        print()
        print("=" * 60)
        print("ARCHETYPE CONTENT:")
        print("=" * 60)
        print(ctx.archetype_content[:500] + "..." if len(ctx.archetype_content) > 500 else ctx.archetype_content)
        print()
        print("=" * 60)
        print("A-POINT HOTWORDS:")
        print("=" * 60)
        print(ctx.a_hotwords)
        print()
        print("=" * 60)
        print("B-POINT HOTWORDS:")
        print("=" * 60)
        print(ctx.b_hotwords)
        print()
        print("=" * 60)
        print("MECHANISM CONTENT:")
        print("=" * 60)
        print(ctx.mechanism_content[:500] + "..." if len(ctx.mechanism_content) > 500 else ctx.mechanism_content)
        print()
        print("=" * 60)
        print("HOOK TYPE:")
        print("=" * 60)
        print(ctx.hook_type_content)
        print()
        print("=" * 60)
        print("ROCK BOTTOM TYPE:")
        print("=" * 60)
        print(ctx.rock_bottom_content)

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
LFS Format Validator - Deterministic validation for Long Form Static ads.
Reads thresholds from constants.json. Returns errors (blocks) and warnings (review).
"""

import json
import re
import sys
from pathlib import Path


def load_constants():
    """Load format constants from constants.json."""
    constants_path = Path(__file__).parent / "constants.json"
    with open(constants_path) as f:
        return json.load(f)


def count_words(text: str) -> int:
    """Count words in text using whitespace split."""
    return len(text.split())


def count_dividers(text: str, divider: str) -> int:
    """Count section dividers in text."""
    return text.count(divider)


def check_forbidden_phrases(text: str, phrases: list) -> list:
    """Check for forbidden phrases. Returns list of found phrases."""
    found = []
    text_lower = text.lower()
    for phrase in phrases:
        if phrase.lower() in text_lower:
            found.append(phrase)
    return found


def check_cta_format(text: str, constants: dict) -> bool:
    """Check if CTA section has required text."""
    required = constants["cta"]["required_text"]
    return required.lower() in text.lower()


def check_ps_close(text: str) -> bool:
    """Check if P.S. close exists."""
    return "p.s." in text.lower() or "ps." in text.lower() or "p.s -" in text.lower()


def validate(script_path: str, task_id: str = None) -> dict:
    """
    Validate an LFS script.

    Args:
        script_path: Path to the script file
        task_id: Optional task ID for context

    Returns:
        dict with: passed, error_count, warning_count, errors, warnings
    """
    constants = load_constants()

    with open(script_path) as f:
        content = f.read()

    errors = []
    warnings = []

    # Character count check (ERROR - hard platform limit)
    char_count = len(content)
    max_chars = constants.get("character_count", {}).get("max", 9999)

    if char_count > max_chars:
        errors.append(f"Character count too high: {char_count} (maximum {max_chars})")

    # Word count check (ERROR/WARNING)
    word_count = count_words(content)
    min_words = constants["word_count"]["min"]
    max_words = constants["word_count"]["max"]

    if word_count < min_words:
        errors.append(f"Word count too low: {word_count} (minimum {min_words})")
    elif word_count > max_words:
        warnings.append(f"Word count high: {word_count} (target max {max_words})")

    # Section dividers check (WARNING)
    divider_count = count_dividers(content, constants["section_divider"])
    min_dividers = constants["min_dividers"]

    if divider_count < min_dividers:
        warnings.append(f"Section dividers: {divider_count} (expected at least {min_dividers})")

    # Forbidden phrases check (ERROR)
    forbidden = check_forbidden_phrases(content, constants["forbidden_phrases"])
    for phrase in forbidden:
        errors.append(f"Forbidden phrase found: '{phrase}'")

    # CTA format check (WARNING)
    if not check_cta_format(content, constants):
        warnings.append(f"CTA missing required text: '{constants['cta']['required_text']}'")

    # P.S. close check (WARNING)
    if not check_ps_close(content):
        warnings.append("Missing P.S. close section")

    # Markdown check (WARNING)
    if re.search(r'^#{1,3}\s', content, re.MULTILINE):
        warnings.append("Found markdown headers (# or ##) - use plain CAPS text instead")

    if re.search(r'\*\*[^*]+\*\*', content):
        # Allow ** only in CTA section (emoji lines)
        cta_match = re.search(r'PRODUCT CTA.*?(?=\n========|\Z)', content, re.DOTALL | re.IGNORECASE)
        non_cta_content = content
        if cta_match:
            non_cta_content = content[:cta_match.start()] + content[cta_match.end():]
        if re.search(r'\*\*[^*]+\*\*', non_cta_content):
            warnings.append("Found bold markdown (**text**) outside CTA section")

    return {
        "passed": len(errors) == 0,
        "error_count": len(errors),
        "warning_count": len(warnings),
        "errors": errors,
        "warnings": warnings,
        "word_count": word_count,
        "char_count": char_count,
        "divider_count": divider_count
    }


class ValidationReport:
    """Validation report wrapper for compatibility with validate.py."""
    def __init__(self, data: dict):
        self._data = data

    def to_dict(self) -> dict:
        return self._data


def validate_file(script_path, task_id: str = None) -> ValidationReport:
    """
    Validate an LFS script file.
    Wrapper for validate() that returns ValidationReport object.
    """
    result = validate(str(script_path), task_id)
    return ValidationReport(result)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python validator.py <script_path> [task_id]")
        sys.exit(1)

    script_path = sys.argv[1]
    task_id = sys.argv[2] if len(sys.argv) > 2 else None

    result = validate(script_path, task_id)

    print(json.dumps(result, indent=2))
    sys.exit(0 if result["passed"] else 1)

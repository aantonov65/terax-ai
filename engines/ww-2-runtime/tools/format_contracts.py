"""Canonical format contracts used across generation, preflight, and QA."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LfsFormattingContract:
    name: str = "lfs.native"
    divider: str = "========"
    min_dividers: int = 6
    max_paragraph_words: int = 45
    max_paragraph_sentences: int = 1

    def prompt_block(self) -> str:
        return f"""LFS NATIVE FORMAT CONTRACT.

This output goes directly into Meta as a long-form static ad.

- Plain text only.
- Use {self.divider} between major sections.
- Use at least {self.min_dividers} section dividers.
- Put a blank line before and after every {self.divider}.
- Write like a real person texts when they want to be understood: one thought per paragraph.
- Put a blank line after every sentence.
- Hard max: {self.max_paragraph_sentences} sentence or {self.max_paragraph_words} words per paragraph.
- Split two-sentence thoughts into two paragraphs with an empty line between them.
- Use plain sentences instead of markdown headings, bold, italics, or commentary labels.
- Keep the CTA and P.S. close visually separated by section dividers.
"""


LFS_NATIVE = LfsFormattingContract()

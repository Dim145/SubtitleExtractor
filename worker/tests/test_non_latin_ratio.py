"""Unit tests for dedup.non_latin_ratio (script classification, pure)."""
from __future__ import annotations

import unicodedata

from subextractor.dedup import non_latin_ratio


def test_pure_latin_is_zero():
    assert non_latin_ratio("Bonjour le monde") == 0.0
    assert non_latin_ratio("Hello, World!") == 0.0


def test_accented_latin_is_zero():
    # Accented French letters are Latin script and must not be flagged.
    assert non_latin_ratio("Où êtes-vous ?") == 0.0
    assert non_latin_ratio("château garçon élève") == 0.0


def test_latin_ligature_is_zero():
    # 'œ' is LATIN SMALL LIGATURE OE — still Latin.
    assert non_latin_ratio("cœur et sœur") == 0.0


def test_combining_marks_are_neutral():
    # Decomposed 'é' = 'e' + combining acute (U+0301, category Mn). The combining
    # mark must be ignored, so the ratio stays 0 (all letters are Latin 'e').
    decomposed = unicodedata.normalize("NFD", "été")
    assert any(unicodedata.category(ch) == "Mn" for ch in decomposed)
    assert non_latin_ratio(decomposed) == 0.0


def test_pure_cjk_is_one():
    assert non_latin_ratio("世界经济论坛") == 1.0


def test_mixed_script_ratio():
    # 3 Latin letters ("abc") + 1 CJK letter -> 1/4.
    assert abs(non_latin_ratio("abc世") - 0.25) < 1e-9


def test_no_letters_is_zero():
    assert non_latin_ratio("123 :: !!") == 0.0
    assert non_latin_ratio("") == 0.0

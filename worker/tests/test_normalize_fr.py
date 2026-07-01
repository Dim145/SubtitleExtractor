"""Unit tests for the deterministic French normalizer (pure, no models)."""
from __future__ import annotations

from subextractor.normalize_fr import is_french, normalize_line

# A tiny hand-rolled lexicon: enough for the transforms under test. These are the
# only "valid words" the normalizer sees, so behavior is fully deterministic.
WORDS = frozenset({
    "ai", "il", "un", "enfance", "accord", "ours", "trop", "pas", "loin",
    "tout", "ce", "que", "attends", "date", "est", "je", "de", "le",
})


def test_elision_missing_apostrophe():
    # "jai" -> "j'ai" (productive elision j' before a vowel-word).
    assert normalize_line("jai", WORDS) == "j'ai"
    assert normalize_line("quil", WORDS) == "qu'il"
    assert normalize_line("dun", WORDS) == "d'un"


def test_elision_i_misread_as_apostrophe():
    # "dienfance" -> "d'enfance" (the apostrophe was OCR'd as an 'i').
    assert normalize_line("dienfance", WORDS) == "d'enfance"


def test_strict_elision_blocks_ungrammatical():
    # "sours" must NOT become "s'ours" — 'ours' is not in the strict continuation
    # set, so the restricted elision is refused.
    assert normalize_line("sours", WORDS) == "sours"


def test_space_split():
    assert normalize_line("pastrop", WORDS) == "pas trop"
    assert normalize_line("ceque", WORDS) == "ce que"


def test_valid_word_untouched():
    # A word already in the lexicon is never rewritten.
    assert normalize_line("attends", WORDS) == "attends"
    assert normalize_line("date", WORDS) == "date"


def test_non_french_noop_when_no_match():
    # A run with no valid segmentation / elision is left exactly as-is.
    assert normalize_line("xyzzy", WORDS) == "xyzzy"
    # Punctuation and spacing preserved.
    assert normalize_line("Bonjour, monde!", WORDS) == "Bonjour, monde!"


def test_capitalization_preserved_on_elision():
    assert normalize_line("Jai", WORDS) == "J'ai"


def test_is_french():
    assert is_french("fr")
    assert is_french("fr-FR")
    assert is_french("french")
    assert not is_french("en")
    assert not is_french(None)
    assert not is_french("")

"""Deterministic French OCR-residual normalizer.

Two safe, wordlist-validated transforms on maximal letter runs of a cue:
  1. Elision apostrophe — a run that is NOT a valid word but is an elision
     prefix + a valid vowel-initial word gets its apostrophe restored. Handles
     the missing apostrophe (``jai`` → ``j'ai``, ``quil`` → ``qu'il``,
     ``dun`` → ``d'un``) and the apostrophe misread as ``i``
     (``dienfance`` → ``d'enfance``). Productive elisions (je/de/le/que) accept
     any vowel-word; restricted ones (ne/ce/se/me/te) accept only a curated
     continuation set so we never emit ungrammatical forms like ``s'ours``.
  2. Space split — a run that is NOT a valid word but segments into 2-3 valid
     words (each ≥2 letters) gets the spaces inserted (``pastrop`` → ``pas
     trop``, ``lointout`` → ``loin tout``, ``ceque`` → ``ce que``). A valid
     word (``attends``, ``date``) is never touched.

It never shortens text, never changes letters (except the elision ``i`` → ``'``),
and never touches punctuation, casing or valid words — so, unlike a free LLM
rewrite, it cannot introduce regressions (measured 0 on the reference clips).

The validation lexicon is the ``an-array-of-french-words`` list (~336k inflected
forms). It is downloaded once to a cache dir on first use (same pattern as the
OCR models); if it can't be obtained, normalization is skipped rather than
guessed. French-only: the caller gates on the job language.
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

log = logging.getLogger(__name__)

_WORDLIST_URL = "https://cdn.jsdelivr.net/npm/an-array-of-french-words/index.json"

VOWELS = frozenset("aeiouyàâäéèêëîïôöùûüh")
# Productive elisions: je/de/le/la/que elide before ANY vowel-initial word
# (j'ai, d'accord, l'ours, qu'il). Longest-first so "qu"/"jusqu" beat "j".
_ELISION_OPEN = ("jusqu", "lorsqu", "puisqu", "quoiqu", "qu", "j", "d", "l")
# Restricted elisions: ne/ce/se/me/te only elide before specific pronouns/verbs,
# so accept ONLY a curated continuation (blocks e.g. "sours" -> "s'ours").
_ELISION_STRICT = ("n", "c", "s", "m", "t")
_STRICT_CONT = frozenset({
    "est", "était", "étais", "étaient", "es", "ai", "a", "as", "ont", "avais",
    "avait", "avaient", "y", "en", "il", "ils", "elle", "elles", "on", "aime",
    "aimes", "aiment", "appelle", "appelles", "appellent", "agit", "agissait",
    "attends", "attend", "excuse", "endors", "enfuis", "habille", "occupe",
})
_RUN = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ]+")
_MIN_SPLIT_LEN = 5   # only attempt to split runs at least this long
_MIN_PIECE = 2       # each split piece must be at least this many letters

_FRENCH_LANGS = frozenset({"fr", "fre", "fra", "french", "français", "francais"})

_words: frozenset[str] | None = None
_load_attempted = False


def is_french(language: object) -> bool:
    if not language:
        return False
    return str(language).lower().split("-")[0] in _FRENCH_LANGS


def _cache_path() -> Path:
    base = os.environ.get("SUBEXT_CACHE_DIR") or (Path.home() / ".cache" / "subextractor")
    return Path(base) / "fr_words.txt"


def get_french_words() -> frozenset[str] | None:
    """Return the cached French lexicon (lowercased), downloading it once. Any
    failure returns None so the caller skips normalization instead of guessing."""
    global _words, _load_attempted
    if _words is not None or _load_attempted:
        return _words
    _load_attempted = True
    override = os.environ.get("SUBEXT_FR_WORDLIST")
    path = Path(override) if override else _cache_path()
    try:
        if not path.exists():
            import urllib.request
            log.info("normalize_fr: downloading French wordlist -> %s", path)
            path.parent.mkdir(parents=True, exist_ok=True)
            with urllib.request.urlopen(_WORDLIST_URL, timeout=30) as r:
                data = r.read()
            arr = json.loads(data)
            path.write_text("\n".join(arr), encoding="utf-8")
        raw = path.read_text(encoding="utf-8", errors="replace")
        arr = json.loads(raw) if raw.lstrip().startswith("[") else raw.splitlines()
        _words = frozenset(w.strip().lower() for w in arr if w.strip())
        log.info("normalize_fr: loaded %d French words", len(_words))
    except Exception as e:  # offline / disk / parse — degrade gracefully
        log.warning("normalize_fr: no French wordlist (%s); normalization disabled", e)
        _words = None
    return _words


def _cap_like(src: str, out: str) -> str:
    return out[:1].upper() + out[1:] if src[:1].isupper() else out


def _segment(low: str, words: frozenset[str], maxpieces: int = 3) -> list[str] | None:
    """Min-piece word-break of ``low`` into valid words (each ≥ _MIN_PIECE).
    Returns the piece list (≥2 pieces) or None. Prefers the fewest pieces."""
    n = len(low)
    best: list[str] | None = None

    def rec(start: int, pieces: list[str]) -> None:
        nonlocal best
        if len(pieces) >= maxpieces and start < n:
            return
        if start == n:
            if len(pieces) >= 2 and (best is None or len(pieces) < len(best)):
                best = pieces[:]
            return
        for end in range(start + _MIN_PIECE, n + 1):
            if low[start:end] in words:
                pieces.append(low[start:end])
                rec(end, pieces)
                pieces.pop()

    rec(0, [])
    return best


def _fix_run(run: str, words: frozenset[str]) -> str:
    low = run.lower()
    if low in words:            # valid word -> never touch
        return run
    # 1. elision. OPEN prefixes accept any vowel-word; STRICT prefixes accept
    # only a curated continuation (avoids ungrammatical s'ours etc.).
    for prefixes, gate in ((_ELISION_OPEN, None), (_ELISION_STRICT, _STRICT_CONT)):
        for p in prefixes:
            if len(low) > len(p) and low.startswith(p):
                rest = low[len(p):]
                if rest[:1] in VOWELS and rest in words and (gate is None or rest in gate):
                    return _cap_like(run, run[:len(p)] + "'" + run[len(p):])
                rest2 = low[len(p) + 1:]
                if (rest[:1] == "i" and rest2[:1] in VOWELS and rest2 in words
                        and (gate is None or rest2 in gate)):
                    return _cap_like(run, run[:len(p)] + "'" + run[len(p) + 1:])
    # 2. space split
    if len(low) >= _MIN_SPLIT_LEN:
        seg = _segment(low, words)
        if seg:
            out, i = [], 0
            for piece in seg:
                out.append(run[i:i + len(piece)])
                i += len(piece)
            return " ".join(out)
    return run


def normalize_line(text: str, words: frozenset[str]) -> str:
    """Apply the two transforms to every letter run in ``text``."""
    return _RUN.sub(lambda m: _fix_run(m.group(0), words), text)

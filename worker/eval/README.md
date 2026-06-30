# Subtitle-OCR evaluation harness

A small CLI for comparing and scoring the SubtitleExtractor worker's OCR
pipeline across config **presets**. It calls the real
`subextractor.pipeline.extract_cues`, so what you measure is what the worker
produces.

This is a purely technical OCR tool: it only handles extracted subtitle **text**
and numeric metrics — never video frames or imagery.

## Setup

Always run from the `worker/` directory with the project venv so
`import subextractor` resolves:

```bash
cd worker
PY=.venv/bin/python
```

Clips are written **outside** the repo (default: the scratchpad dir, override
with `--clips-dir`) so large / adult media is never staged. `eval/.gitignore`
also blocks media just in case.

## Presets

Defined in `harness.py` (`PRESETS`); each is a dict of overrides merged over the
resolved defaults:

- `current` — `{}` (the new defaults).
- `fast` — `{"best_frame": False, "det_limit_side_len": 736}` (faster, lower res).
- `v4` — `{"ocr_version": "PP-OCRv4"}` (previous model family).

## Workflow

### (a) Scan a source for subtitle-dense windows

Samples at ~1 fps, measures bottom-band text presence, prints the densest
windows so you know where to cut clips:

```bash
$PY eval/harness.py scan --source "/path/to/source.mkv" --scan-window 45 --scan-top 8
```

### (b) Cut a clip

Either cut on the fly while running a mode (`--source --start --dur`), or just
cut by running any mode — the clip is reused. The cut uses stream copy:

```bash
$PY eval/harness.py differential \
    --source "/path/to/source.mkv" --start 120 --dur 45 \
    --presets current
```

### (c) Run differential (compare presets)

```bash
$PY eval/harness.py differential \
    --clip /path/clip_a.mkv \
    --presets current,fast,v4
```

Prints, per clip and per preset: #cues, wall-time, and every cue as
`start->end | conf | text`. Also writes `eval/report.md`.

### (d) Bootstrap ground truth

Runs the `current` preset and writes a candidate transcript you then review:

```bash
$PY eval/harness.py differential --clip /path/clip_a.mkv --make-gt
```

This writes `eval/groundtruth/<clip-stem>.candidate.txt`. Open it, fix any OCR
errors against the actual subtitles, then rename it to
`eval/groundtruth/<clip-stem>.txt` (the `.txt` form is the tracked reference).

### (e) Score against ground truth (CER / WER)

```bash
$PY eval/harness.py score \
    --clip /path/clip_a.mkv \
    --presets current,fast,v4
```

For each clip with a `eval/groundtruth/<clip-stem>.txt` reference, prints CER and
WER per preset and the mean per preset (lower is better). Clips without a
reference are skipped. Results are also written to `eval/report.md`.

#### Metric definitions

Both sides are normalized (strip, lowercase, collapse internal whitespace, drop
empty lines, join with `\n`).

- **CER** = `Levenshtein.distance(ref_chars, hyp_chars) / len(ref_chars)`
- **WER** = `Levenshtein.distance(ref_tokens, hyp_tokens) / len(ref_tokens)`
  (whitespace tokenization)

## Options

Run `$PY eval/harness.py --help` for the full list. Common ones:

- `--clip PATH` (repeatable) — test clip(s).
- `--source/--start/--dur` — cut a clip from a source.
- `--clips-dir DIR` — where cut clips go (default: scratchpad, outside repo).
- `--presets a,b,c` — which presets to run.
- `--language fr` — selects the OCR recognition model family.
- `--make-gt` — write candidate ground-truth files and exit.
```

> OCR is ~1–2 min per 45s clip per preset. Keep clips short and preset lists
> small; avoid sweeping all sources at once.

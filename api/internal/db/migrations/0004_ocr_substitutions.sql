-- Global, inter-worker OCR post-processing substitution rules. Workers receive
-- them via the heartbeat and apply them to cue text after merging.
-- Stored as a JSON array of { find, replace, isRegex, applyTo } objects.
ALTER TABLE app_settings
    ADD COLUMN IF NOT EXISTS ocr_substitution_rules jsonb NOT NULL DEFAULT '[]'::jsonb;

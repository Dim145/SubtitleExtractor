-- Store fps / confidence as double precision so they don't show float32 noise
-- (e.g. 0.6000000238) in the admin UI.
ALTER TABLE app_settings
    ALTER COLUMN default_fps TYPE double precision,
    ALTER COLUMN default_min_confidence TYPE double precision;

-- Clean any noise inherited from the old real columns.
UPDATE app_settings SET
    default_fps = round(default_fps::numeric, 3),
    default_min_confidence = round(default_min_confidence::numeric, 3);

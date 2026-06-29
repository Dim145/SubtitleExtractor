-- Video retention: admin-configurable automatic cleanup of source videos, and
-- per-job tracking of whether the source video has been removed (manually or by
-- the cleanup job). Subtitles and job rows are never touched by this feature.

ALTER TABLE app_settings
    ADD COLUMN video_cleanup_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN video_retention_days  int     NOT NULL DEFAULT 7,
    ADD COLUMN video_cleanup_cron    text    NOT NULL DEFAULT '0 3 * * *';

ALTER TABLE jobs
    ADD COLUMN video_deleted_at timestamptz;

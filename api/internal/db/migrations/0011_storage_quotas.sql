-- Optional per-user storage quotas (disabled by default).
--
-- "Storage used" by a user = currently-stored bytes = non-deleted source videos
-- (jobs.input_size_bytes where video_deleted_at IS NULL) + generated result
-- files (job_results.byte_size, reused as the result-size source of truth).
--
-- Effective limit = per-user override (users.storage_quota_bytes) if set, else
-- the admin default (app_settings.storage_quota_default_bytes). 0 or NULL means
-- UNLIMITED. Enforcement only happens when storage_quota_enabled is true.

ALTER TABLE users
    ADD COLUMN storage_quota_bytes bigint;              -- NULL = inherit default

ALTER TABLE jobs
    ADD COLUMN input_size_bytes bigint NOT NULL DEFAULT 0;

ALTER TABLE app_settings
    ADD COLUMN storage_quota_enabled       boolean NOT NULL DEFAULT false,
    ADD COLUMN storage_quota_default_bytes  bigint  NOT NULL DEFAULT 0;  -- 0 = unlimited

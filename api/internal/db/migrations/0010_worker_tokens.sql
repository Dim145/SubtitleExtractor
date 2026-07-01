-- Per-worker credentials. The shared INTERNAL_API_TOKEN becomes an
-- enrollment-only bootstrap secret; each worker enrolls once and receives its
-- own random token. We store only the SHA-256 hash, and derive worker identity
-- from the presented token instead of trusting a client-set X-Worker-Id header.
-- Nullable so existing worker rows keep working until they re-enroll.

ALTER TABLE workers
    ADD COLUMN token_hash       text,
    ADD COLUMN token_created_at timestamptz;

-- token_hash is looked up on every /internal call; a unique index keeps it fast
-- and enforces that one token maps to at most one worker.
CREATE UNIQUE INDEX workers_token_hash_idx ON workers (token_hash)
    WHERE token_hash IS NOT NULL;

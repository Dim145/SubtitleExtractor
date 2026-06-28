-- Initial schema: users, jobs, job_results, job_logs.
-- (River manages its own tables via its own migrator, added in M2.)

CREATE TYPE auth_provider AS ENUM ('local', 'oidc');

CREATE TYPE job_status AS ENUM (
    'queued', 'claimed', 'running', 'succeeded', 'failed', 'canceled'
);

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE,
    display_name  text,
    provider      auth_provider NOT NULL,
    password_hash text,                       -- argon2id encoded string; NULL for oidc
    oidc_issuer   text,
    oidc_subject  text,
    is_admin      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          job_status NOT NULL DEFAULT 'queued',
    worker_class    text NOT NULL DEFAULT 'any',  -- 'gpu-nvidia' | 'macos' | 'any'
    source_filename text NOT NULL,
    input_key       text NOT NULL,                -- storage key of uploaded video
    params          jsonb NOT NULL DEFAULT '{}',  -- language, crop box, fps, ocr_backend, formats...
    progress_pct    smallint NOT NULL DEFAULT 0,
    progress_stage  text,
    claimed_by      text,
    claimed_at      timestamptz,
    last_heartbeat  timestamptz,
    attempt         int NOT NULL DEFAULT 0,
    error_message   text,
    river_job_id    bigint,
    created_at      timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    finished_at     timestamptz
);
CREATE INDEX jobs_status_class_idx ON jobs (status, worker_class);
CREATE INDEX jobs_user_created_idx ON jobs (user_id, created_at DESC);

CREATE TABLE job_results (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    kind        text NOT NULL,                   -- 'ass' | 'srt' | 'vtt' | 'json' | 'preview'
    storage_key text NOT NULL,
    language    text,
    byte_size   bigint,
    sha256      text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_results_job_idx ON job_results (job_id);

CREATE TABLE job_logs (
    id        bigserial PRIMARY KEY,
    job_id    uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    ts        timestamptz NOT NULL DEFAULT now(),
    level     text NOT NULL DEFAULT 'info',      -- info | warn | error | debug
    message   text NOT NULL
);
CREATE INDEX job_logs_job_id_idx ON job_logs (job_id, id);

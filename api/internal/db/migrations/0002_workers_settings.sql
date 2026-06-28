-- Dynamic, DB-backed site settings and worker registry.

CREATE TABLE app_settings (
    id                    int PRIMARY KEY DEFAULT 1,
    registration_enabled  boolean NOT NULL DEFAULT true,
    default_ocr_backend   text NOT NULL DEFAULT '',
    default_fps           real NOT NULL DEFAULT 4,
    default_min_confidence real NOT NULL DEFAULT 0.6,
    -- Global worker config defaults, overlaid by each worker's own config.
    worker_defaults       jsonb NOT NULL DEFAULT '{}',
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT app_settings_singleton CHECK (id = 1)
);
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE workers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL UNIQUE,        -- self-reported stable id (X-Worker-Id)
    worker_class    text NOT NULL DEFAULT 'any', -- 'macos' | 'gpu-nvidia' | 'any'
    enabled         boolean NOT NULL DEFAULT true,
    last_heartbeat  timestamptz,
    current_job_id  uuid REFERENCES jobs(id) ON DELETE SET NULL,
    capabilities    jsonb NOT NULL DEFAULT '{}', -- e.g. {"backends":["rapidocr"]}
    config          jsonb NOT NULL DEFAULT '{}', -- per-worker overrides
    config_version  int NOT NULL DEFAULT 1,      -- bumped on every config edit
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workers_current_job_idx ON workers (current_job_id);

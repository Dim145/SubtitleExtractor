-- History of video-retention cleanup runs (scheduled + manual), surfaced in the
-- admin UI. `checked` is how many source videos were present on finished jobs at
-- run time; `deleted` is how many past the retention window were removed. The
-- per-file detail (source filename + freed bytes) is kept in `files`.

CREATE TABLE video_cleanup_runs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz NOT NULL DEFAULT now(),
    trigger     text    NOT NULL,                 -- 'scheduled' | 'manual'
    status      text    NOT NULL,                 -- 'success' | 'partial' | 'error'
    checked     int     NOT NULL DEFAULT 0,
    deleted     int     NOT NULL DEFAULT 0,
    bytes_freed bigint  NOT NULL DEFAULT 0,
    error       text,
    files       jsonb   NOT NULL DEFAULT '[]'     -- [{jobId, filename, size}]
);
CREATE INDEX video_cleanup_runs_started_idx ON video_cleanup_runs (started_at DESC);

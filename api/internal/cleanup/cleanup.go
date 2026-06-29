// Package cleanup persists the history of video-retention cleanup runs so the
// admin UI can show recent runs and the files each one removed.
package cleanup

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxFiles bounds how many per-file entries are stored on a single run, so a
// huge first sweep can't bloat the row. The `deleted` count stays exact.
const MaxFiles = 1000

// FileRef is one deleted source video recorded on a run.
type FileRef struct {
	JobID    string `json:"jobId"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
}

// Run is one cleanup execution (scheduled or manual).
type Run struct {
	ID         string    `json:"id"`
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt"`
	Trigger    string    `json:"trigger"`
	Status     string    `json:"status"`
	Checked    int       `json:"checked"`
	Deleted    int       `json:"deleted"`
	BytesFreed int64     `json:"bytesFreed"`
	Error      *string   `json:"error"`
	Files      []FileRef `json:"files"`
}

// Repo is the cleanup-runs data-access layer.
type Repo struct {
	pool *pgxpool.Pool
}

// NewRepo wires the repository to the pool.
func NewRepo(pool *pgxpool.Pool) *Repo { return &Repo{pool: pool} }

// Insert records a finished run and fills in its generated id.
func (r *Repo) Insert(ctx context.Context, run *Run) error {
	files := run.Files
	if files == nil {
		files = []FileRef{}
	}
	if len(files) > MaxFiles {
		files = files[:MaxFiles]
	}
	raw, err := json.Marshal(files)
	if err != nil {
		return err
	}
	return r.pool.QueryRow(ctx, `
		INSERT INTO video_cleanup_runs
			(started_at, finished_at, trigger, status, checked, deleted, bytes_freed, error, files)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING id`,
		run.StartedAt, run.FinishedAt, run.Trigger, run.Status,
		run.Checked, run.Deleted, run.BytesFreed, run.Error, raw,
	).Scan(&run.ID)
}

// ListRecent returns the newest runs, most recent first.
func (r *Repo) ListRecent(ctx context.Context, limit int) ([]*Run, error) {
	if limit <= 0 || limit > 100 {
		limit = 7
	}
	rows, err := r.pool.Query(ctx, `
		SELECT id, started_at, finished_at, trigger, status, checked, deleted, bytes_freed, error, files
		FROM video_cleanup_runs ORDER BY started_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Run
	for rows.Next() {
		var run Run
		var raw []byte
		if err := rows.Scan(&run.ID, &run.StartedAt, &run.FinishedAt, &run.Trigger, &run.Status,
			&run.Checked, &run.Deleted, &run.BytesFreed, &run.Error, &raw); err != nil {
			return nil, err
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &run.Files)
		}
		if run.Files == nil {
			run.Files = []FileRef{}
		}
		out = append(out, &run)
	}
	return out, rows.Err()
}

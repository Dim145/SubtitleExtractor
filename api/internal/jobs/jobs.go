// Package jobs owns the extraction-job lifecycle. The jobs table itself acts
// as the work queue: workers claim rows with FOR UPDATE SKIP LOCKED via the
// /internal claim protocol, so no separate broker is needed.
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when no job matches.
var ErrNotFound = errors.New("job not found")

// Job mirrors a row in the jobs table.
type Job struct {
	ID             string          `json:"id"`
	UserID         string          `json:"userId"`
	Status         string          `json:"status"`
	WorkerClass    string          `json:"workerClass"`
	SourceFilename string          `json:"sourceFilename"`
	InputKey       string          `json:"-"`
	Params         json.RawMessage `json:"params"`
	ProgressPct    int             `json:"progressPct"`
	ProgressStage  *string         `json:"progressStage"`
	ClaimedBy      *string         `json:"claimedBy"`
	Attempt        int             `json:"attempt"`
	ErrorMessage   *string         `json:"errorMessage"`
	CreatedAt      time.Time       `json:"createdAt"`
	StartedAt      *time.Time      `json:"startedAt"`
	FinishedAt     *time.Time      `json:"finishedAt"`
}

// Result is a produced subtitle artifact.
type Result struct {
	ID        string    `json:"id"`
	JobID     string    `json:"jobId"`
	Kind      string    `json:"kind"`
	StorageKey string   `json:"-"`
	Language  *string   `json:"language"`
	ByteSize  *int64    `json:"byteSize"`
	SHA256    *string   `json:"sha256"`
	CreatedAt time.Time `json:"createdAt"`
}

// LogEntry is one job log line.
type LogEntry struct {
	ID      int64     `json:"id"`
	JobID   string    `json:"jobId"`
	TS      time.Time `json:"ts"`
	Level   string    `json:"level"`
	Message string    `json:"message"`
}

// Repo is the jobs data-access layer.
type Repo struct {
	pool *pgxpool.Pool
}

// NewRepo wires the repository to the pool.
func NewRepo(pool *pgxpool.Pool) *Repo { return &Repo{pool: pool} }

const jobColumns = `id, user_id, status, worker_class, source_filename, input_key, params,
	progress_pct, progress_stage, claimed_by, attempt, error_message,
	created_at, started_at, finished_at`

func scanJob(row pgx.Row) (*Job, error) {
	var j Job
	err := row.Scan(&j.ID, &j.UserID, &j.Status, &j.WorkerClass, &j.SourceFilename, &j.InputKey,
		&j.Params, &j.ProgressPct, &j.ProgressStage, &j.ClaimedBy, &j.Attempt, &j.ErrorMessage,
		&j.CreatedAt, &j.StartedAt, &j.FinishedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &j, nil
}

// Create inserts a new queued job.
func (r *Repo) Create(ctx context.Context, userID, workerClass, sourceFilename, inputKey string, params json.RawMessage) (*Job, error) {
	if len(params) == 0 {
		params = json.RawMessage(`{}`)
	}
	return scanJob(r.pool.QueryRow(ctx, `
		INSERT INTO jobs (user_id, worker_class, source_filename, input_key, params)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING `+jobColumns, userID, workerClass, sourceFilename, inputKey, params))
}

// Get fetches a job by id.
func (r *Repo) Get(ctx context.Context, id string) (*Job, error) {
	return scanJob(r.pool.QueryRow(ctx, `SELECT `+jobColumns+` FROM jobs WHERE id=$1`, id))
}

// ListForUser returns a user's jobs, newest first.
func (r *Repo) ListForUser(ctx context.Context, userID string, limit int) ([]*Job, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := r.pool.Query(ctx, `SELECT `+jobColumns+` FROM jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// Claim atomically takes the oldest queued job matching one of the worker's
// classes, marking it running. Returns ErrNotFound when nothing is available.
func (r *Repo) Claim(ctx context.Context, workerID string, classes []string) (*Job, error) {
	return scanJob(r.pool.QueryRow(ctx, `
		UPDATE jobs SET
			status = 'running',
			claimed_by = $1,
			claimed_at = now(),
			last_heartbeat = now(),
			started_at = COALESCE(started_at, now()),
			attempt = attempt + 1
		WHERE id = (
			SELECT id FROM jobs
			WHERE status = 'queued' AND worker_class = ANY($2)
			ORDER BY created_at
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		RETURNING `+jobColumns, workerID, classes))
}

// UpdateProgress sets progress percent and stage.
func (r *Repo) UpdateProgress(ctx context.Context, id string, pct int, stage string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE jobs SET progress_pct=$2, progress_stage=$3, last_heartbeat=now() WHERE id=$1`,
		id, pct, stage)
	return err
}

// Heartbeat refreshes the liveness timestamp.
func (r *Repo) Heartbeat(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx, `UPDATE jobs SET last_heartbeat=now() WHERE id=$1`, id)
	return err
}

// AppendLog adds a log line.
func (r *Repo) AppendLog(ctx context.Context, id, level, message string) error {
	if level == "" {
		level = "info"
	}
	_, err := r.pool.Exec(ctx, `INSERT INTO job_logs (job_id, level, message) VALUES ($1,$2,$3)`, id, level, message)
	return err
}

// Logs returns log lines after the given cursor id (0 for all).
func (r *Repo) Logs(ctx context.Context, id string, afterID int64, limit int) ([]*LogEntry, error) {
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	rows, err := r.pool.Query(ctx,
		`SELECT id, job_id, ts, level, message FROM job_logs WHERE job_id=$1 AND id>$2 ORDER BY id LIMIT $3`,
		id, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*LogEntry
	for rows.Next() {
		var l LogEntry
		if err := rows.Scan(&l.ID, &l.JobID, &l.TS, &l.Level, &l.Message); err != nil {
			return nil, err
		}
		out = append(out, &l)
	}
	return out, rows.Err()
}

// AddResult records a produced artifact.
func (r *Repo) AddResult(ctx context.Context, jobID, kind, storageKey, language string, byteSize int64, sha256 string) (*Result, error) {
	var langPtr, shaPtr *string
	if language != "" {
		langPtr = &language
	}
	if sha256 != "" {
		shaPtr = &sha256
	}
	var res Result
	err := r.pool.QueryRow(ctx, `
		INSERT INTO job_results (job_id, kind, storage_key, language, byte_size, sha256)
		VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING id, job_id, kind, storage_key, language, byte_size, sha256, created_at`,
		jobID, kind, storageKey, langPtr, byteSize, shaPtr).
		Scan(&res.ID, &res.JobID, &res.Kind, &res.StorageKey, &res.Language, &res.ByteSize, &res.SHA256, &res.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// Results lists a job's artifacts.
func (r *Repo) Results(ctx context.Context, jobID string) ([]*Result, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT id, job_id, kind, storage_key, language, byte_size, sha256, created_at FROM job_results WHERE job_id=$1 ORDER BY created_at`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Result
	for rows.Next() {
		var res Result
		if err := rows.Scan(&res.ID, &res.JobID, &res.Kind, &res.StorageKey, &res.Language, &res.ByteSize, &res.SHA256, &res.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &res)
	}
	return out, rows.Err()
}

// Complete marks the job succeeded or failed.
func (r *Repo) Complete(ctx context.Context, id string, success bool, errMsg string) error {
	status := "succeeded"
	var msgPtr *string
	if !success {
		status = "failed"
		if errMsg != "" {
			msgPtr = &errMsg
		}
	}
	_, err := r.pool.Exec(ctx, `
		UPDATE jobs SET
			status = $2::job_status,
			error_message = $3,
			finished_at = now(),
			progress_pct = CASE WHEN $4 THEN 100 ELSE progress_pct END
		WHERE id = $1`,
		id, status, msgPtr, success)
	return err
}

// Cancel marks an active job (queued/claimed/running) as canceled. Returns true
// if a job was actually transitioned.
func (r *Repo) Cancel(ctx context.Context, id string) (bool, error) {
	tag, err := r.pool.Exec(ctx, `
		UPDATE jobs SET status='canceled', finished_at=now()
		WHERE id=$1 AND status IN ('queued','claimed','running')`, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// Delete removes a job row (job_results and job_logs cascade).
func (r *Repo) Delete(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx, `DELETE FROM jobs WHERE id=$1`, id)
	return err
}

// IsCanceled reports whether a job is canceled or no longer exists (both mean
// a worker should stop processing it).
func (r *Repo) IsCanceled(ctx context.Context, id string) bool {
	var status string
	err := r.pool.QueryRow(ctx, `SELECT status FROM jobs WHERE id=$1`, id).Scan(&status)
	if err != nil {
		return true // gone == stop
	}
	return status == "canceled"
}

// RequeueStale re-queues jobs whose heartbeat expired, failing them past 3 attempts.
// Returns the number of affected jobs.
func (r *Repo) RequeueStale(ctx context.Context, timeout time.Duration) (int64, error) {
	tag, err := r.pool.Exec(ctx, `
		UPDATE jobs SET
			status = CASE WHEN attempt >= 3 THEN 'failed'::job_status ELSE 'queued'::job_status END,
			error_message = CASE WHEN attempt >= 3 THEN 'worker timed out' ELSE error_message END,
			finished_at = CASE WHEN attempt >= 3 THEN now() ELSE finished_at END,
			claimed_by = NULL,
			last_heartbeat = NULL
		WHERE status = 'running' AND last_heartbeat < now() - make_interval(secs => $1)`,
		timeout.Seconds())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

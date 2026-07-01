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
	// VideoDeletedAt is set once the source video has been removed (manually or
	// by the retention cleanup); when non-nil the job can't be re-run.
	VideoDeletedAt *time.Time `json:"videoDeletedAt"`
}

// Result is a produced subtitle artifact.
type Result struct {
	ID         string    `json:"id"`
	JobID      string    `json:"jobId"`
	Kind       string    `json:"kind"`
	StorageKey string    `json:"-"`
	Name       *string   `json:"name"`
	Language   *string   `json:"language"`
	ByteSize   *int64    `json:"byteSize"`
	SHA256     *string   `json:"sha256"`
	CreatedAt  time.Time `json:"createdAt"`
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
	created_at, started_at, finished_at, video_deleted_at`

func scanJob(row pgx.Row) (*Job, error) {
	var j Job
	err := row.Scan(&j.ID, &j.UserID, &j.Status, &j.WorkerClass, &j.SourceFilename, &j.InputKey,
		&j.Params, &j.ProgressPct, &j.ProgressStage, &j.ClaimedBy, &j.Attempt, &j.ErrorMessage,
		&j.CreatedAt, &j.StartedAt, &j.FinishedAt, &j.VideoDeletedAt)
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

// UpdateProgress sets progress percent and stage, but only while the job is
// still running. It returns applied=false when no running row matched (the job
// was canceled/requeued/finished), letting the caller signal the worker to stop
// in a single round-trip instead of a separate cancel check.
func (r *Repo) UpdateProgress(ctx context.Context, id string, pct int, stage string) (applied bool, err error) {
	tag, err := r.pool.Exec(ctx,
		`UPDATE jobs SET progress_pct=$2, progress_stage=$3, last_heartbeat=now()
		 WHERE id=$1 AND status='running'`,
		id, pct, stage)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
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

const resultCols = `id, job_id, kind, storage_key, name, language, byte_size, sha256, created_at`

func scanResult(row interface{ Scan(...any) error }, res *Result) error {
	return row.Scan(&res.ID, &res.JobID, &res.Kind, &res.StorageKey, &res.Name, &res.Language, &res.ByteSize, &res.SHA256, &res.CreatedAt)
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// AddResult records a produced artifact.
func (r *Repo) AddResult(ctx context.Context, jobID, kind, storageKey, language, name string, byteSize int64, sha256 string) (*Result, error) {
	var res Result
	err := scanResult(r.pool.QueryRow(ctx, `
		INSERT INTO job_results (job_id, kind, storage_key, name, language, byte_size, sha256)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING `+resultCols,
		jobID, kind, storageKey, strPtr(name), strPtr(language), byteSize, strPtr(sha256)), &res)
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// ReplaceResult overwrites an existing result's metadata (its storage object is
// replaced in place at the same key by the caller). Used for the editor's
// "overwrite" save when the kind — and therefore the storage key — is unchanged.
func (r *Repo) ReplaceResult(ctx context.Context, id, kind, name, language string, byteSize int64, sha256 string) (*Result, error) {
	var res Result
	err := scanResult(r.pool.QueryRow(ctx, `
		UPDATE job_results SET kind=$2, name=$3, language=$4, byte_size=$5, sha256=$6
		WHERE id=$1
		RETURNING `+resultCols,
		id, kind, strPtr(name), strPtr(language), byteSize, strPtr(sha256)), &res)
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// ReplaceResultWithKey is like ReplaceResult but also moves the result to a new
// storage key. Used when an overwrite changes the kind (and thus the object's
// extension), so storage_key stays consistent with the stored object.
func (r *Repo) ReplaceResultWithKey(ctx context.Context, id, kind, storageKey, name, language string, byteSize int64, sha256 string) (*Result, error) {
	var res Result
	err := scanResult(r.pool.QueryRow(ctx, `
		UPDATE job_results SET kind=$2, storage_key=$3, name=$4, language=$5, byte_size=$6, sha256=$7
		WHERE id=$1
		RETURNING `+resultCols,
		id, kind, storageKey, strPtr(name), strPtr(language), byteSize, strPtr(sha256)), &res)
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// ResultByID fetches a single result (for ownership checks + storage key).
func (r *Repo) ResultByID(ctx context.Context, id string) (*Result, error) {
	var res Result
	if err := scanResult(r.pool.QueryRow(ctx, `SELECT `+resultCols+` FROM job_results WHERE id=$1`, id), &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// DeleteResult removes a single result row.
func (r *Repo) DeleteResult(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx, `DELETE FROM job_results WHERE id=$1`, id)
	return err
}

// DeleteResultCascade removes one result and, if it was the job's last result,
// deletes the job too — atomically in a single transaction so a concurrent
// delete can't race to leave a job with zero results (or double-delete it).
// Returns jobDeleted=true when the whole job (and its cascaded rows) was removed.
func (r *Repo) DeleteResultCascade(ctx context.Context, jobID, resultID string) (jobDeleted bool, err error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err = tx.Exec(ctx, `DELETE FROM job_results WHERE id=$1 AND job_id=$2`, resultID, jobID); err != nil {
		return false, err
	}
	var remaining int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM job_results WHERE job_id=$1`, jobID).Scan(&remaining); err != nil {
		return false, err
	}
	if remaining == 0 {
		if _, err = tx.Exec(ctx, `DELETE FROM jobs WHERE id=$1`, jobID); err != nil {
			return false, err
		}
		jobDeleted = true
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	return jobDeleted, nil
}

// Results lists a job's artifacts.
func (r *Repo) Results(ctx context.Context, jobID string) ([]*Result, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT `+resultCols+` FROM job_results WHERE job_id=$1 ORDER BY created_at`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Result
	for rows.Next() {
		var res Result
		if err := scanResult(rows, &res); err != nil {
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

// Rerun re-queues a finished job (succeeded/failed/canceled) for a fresh
// extraction, resetting its run state. Refuses jobs whose video is gone. Returns
// true if a job was actually re-queued. Existing results are kept untouched;
// the new run appends its own.
func (r *Repo) Rerun(ctx context.Context, id string) (bool, error) {
	tag, err := r.pool.Exec(ctx, `
		UPDATE jobs SET
			status = 'queued',
			progress_pct = 0,
			progress_stage = NULL,
			error_message = NULL,
			claimed_by = NULL,
			claimed_at = NULL,
			last_heartbeat = NULL,
			started_at = NULL,
			finished_at = NULL,
			attempt = 0
		WHERE id = $1 AND status IN ('succeeded','failed','canceled') AND video_deleted_at IS NULL`,
		id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// MarkVideoDeleted records that a job's source video has been removed.
func (r *Repo) MarkVideoDeleted(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx, `UPDATE jobs SET video_deleted_at=now() WHERE id=$1 AND video_deleted_at IS NULL`, id)
	return err
}

// VideoRef is a job id plus its source-video storage key and filename.
type VideoRef struct {
	ID             string
	InputKey       string
	SourceFilename string
}

// VideosForCleanup lists finished jobs whose source video is still present and
// older than the cutoff — candidates for retention cleanup. Active jobs
// (queued/claimed/running) are never returned: their video is still needed.
func (r *Repo) VideosForCleanup(ctx context.Context, cutoff time.Time) ([]VideoRef, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, input_key, source_filename FROM jobs
		WHERE video_deleted_at IS NULL
		  AND status IN ('succeeded','failed','canceled')
		  AND COALESCE(finished_at, created_at) < $1`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []VideoRef
	for rows.Next() {
		var v VideoRef
		if err := rows.Scan(&v.ID, &v.InputKey, &v.SourceFilename); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// CountPresentVideos counts finished jobs whose source video is still stored —
// the full scope a cleanup run examines (the "checked" figure).
func (r *Repo) CountPresentVideos(ctx context.Context) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT count(*) FROM jobs
		WHERE video_deleted_at IS NULL
		  AND status IN ('succeeded','failed','canceled')`).Scan(&n)
	return n, err
}

// Delete removes a job row (job_results and job_logs cascade).
func (r *Repo) Delete(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx, `DELETE FROM jobs WHERE id=$1`, id)
	return err
}

// StorageKeysForUser returns every storage key (source-video inputs + result
// artifacts) belonging to a user's jobs, so the blobs can be deleted before the
// DB rows cascade away on user deletion.
func (r *Repo) StorageKeysForUser(ctx context.Context, userID string) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT input_key FROM jobs WHERE user_id=$1
		UNION ALL
		SELECT res.storage_key FROM job_results res
		JOIN jobs j ON j.id = res.job_id
		WHERE j.user_id=$1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		if k != "" {
			out = append(out, k)
		}
	}
	return out, rows.Err()
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

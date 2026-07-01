package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"subtitleextractor/internal/auth"
	"subtitleextractor/internal/events"
	"subtitleextractor/internal/jobs"
	"subtitleextractor/internal/settings"
	"subtitleextractor/internal/workers"
)

// handleWorkerEnroll issues a per-worker token. It is guarded by the shared
// bootstrap InternalAPIToken (the only route that still accepts it): a worker
// presents the bootstrap secret once at startup, upserts its row, and receives a
// random token whose SHA-256 hash is stored. The plaintext is returned ONCE and
// never persisted; re-enrolling rotates the token.
func (s *Server) handleWorkerEnroll(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkerID     string          `json:"workerId"`
		WorkerClass  string          `json:"workerClass"`
		Capabilities json.RawMessage `json:"capabilities"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.WorkerID == "" {
		writeError(w, http.StatusBadRequest, "workerId required")
		return
	}
	if body.WorkerClass == "" {
		body.WorkerClass = "any"
	}

	// 32 random bytes → base64url (no padding); ~256 bits of entropy.
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	wk, err := s.workers.Enroll(r.Context(), body.WorkerID, body.WorkerClass, body.Capabilities, auth.HashWorkerToken(token))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "enrollment failed")
		return
	}
	if s.audit != nil {
		_ = s.audit.Record(r.Context(), "", "worker.enroll", wk.ID, map[string]any{"name": wk.Name, "class": wk.WorkerClass})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workerId": wk.ID,
		"name":     wk.Name,
		"token":    token,
	})
}

// handleWorkerHeartbeat upserts the worker (registration + liveness) and returns
// its enabled flag plus effective config (global defaults overlaid by per-worker).
func (s *Server) handleWorkerHeartbeat(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name         string          `json:"name"`
		WorkerClass  string          `json:"workerClass"`
		Capabilities json.RawMessage `json:"capabilities"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	// Identity comes from the per-worker token, not the request body: a worker
	// cannot heartbeat as some other worker. The body still carries class +
	// capabilities so admin config/UI stay fresh.
	ident := auth.WorkerFromContext(r.Context())
	if ident == nil {
		writeError(w, http.StatusUnauthorized, "worker not authenticated")
		return
	}
	name := ident.Name
	class := body.WorkerClass
	if class == "" {
		class = ident.WorkerClass
	}
	if class == "" {
		class = "any"
	}
	wk, err := s.workers.Upsert(r.Context(), name, class, body.Capabilities)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "heartbeat failed")
		return
	}
	var defaults settings.Settings
	if st, err := s.settings.Get(r.Context()); err == nil {
		defaults = *st
	}
	rules := defaults.OCRSubstitutionRules
	if len(rules) == 0 {
		rules = json.RawMessage(`[]`)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workerId":             wk.ID,
		"enabled":              wk.Enabled,
		"configVersion":        wk.ConfigVersion,
		"config":               json.RawMessage(workers.EffectiveConfig(defaults.WorkerDefaults, wk.Config)),
		"ocrSubstitutionRules": rules,
	})
}

// handleClaim hands the oldest matching queued job to a worker, with a
// presigned URL to fetch the input video. Returns 204 when nothing is queued.
func (s *Server) handleClaim(w http.ResponseWriter, r *http.Request) {
	workerClass := r.URL.Query().Get("worker_class")
	if workerClass == "" {
		workerClass = "any"
	}
	// Identity is derived from the per-worker token (RequireWorkerToken), never
	// from a client-set header: claimed_by uses this resolved name so ownership
	// can be enforced on later posts.
	wk := auth.WorkerFromContext(r.Context())
	if wk == nil {
		writeError(w, http.StatusUnauthorized, "worker not authenticated")
		return
	}
	workerID := wk.Name

	// A disabled worker is not allowed to take new jobs.
	if !wk.Enabled {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// A worker accepts jobs tagged with its own class and the catch-all "any".
	classes := []string{workerClass}
	if workerClass != "any" {
		classes = append(classes, "any")
	}

	job, err := s.jobs.Claim(r.Context(), workerID, classes)
	if errors.Is(err, jobs.ErrNotFound) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "claim failed")
		return
	}
	_ = s.workers.SetCurrentJob(r.Context(), workerID, &job.ID)

	inputURL, err := s.store.PresignGet(r.Context(), job.InputKey, downloadTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to sign input URL")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"job":      job,
		"inputUrl": inputURL,
	})
}

// workerID returns the identity the worker presents on /internal calls. It is
// derived from the per-worker token by RequireWorkerToken (not a client header),
// and matches the name stored in the job's claimed_by column at claim time,
// which bindWorker enforces.
func workerID(r *http.Request) string {
	if wk := auth.WorkerFromContext(r.Context()); wk != nil {
		return wk.Name
	}
	return ""
}

// bindWorker verifies that the job in the URL exists and is genuinely owned by
// the worker making the request. It returns the fetched job so callers can
// avoid a second round-trip. On any ownership/state failure it writes the
// response and returns ok=false.
//
// Rules (item 12 — prevent double-processing after a stale requeue):
//   - the worker must be authenticated (per-worker token → resolved identity);
//   - the job must be in an active state (running/claimed) — a requeued/finished
//     job returns 409 so the worker aborts;
//   - claimed_by must equal the caller's worker id. A nil claimed_by on a
//     non-terminal job means it was requeued away from this worker → not yours.
func (s *Server) bindWorker(w http.ResponseWriter, r *http.Request, id string) (*jobs.Job, bool) {
	job, err := s.jobs.Get(r.Context(), id)
	if err != nil {
		// The job vanished (deleted). Reply 409 — the "stop now" signal — so the
		// worker aborts gracefully and returns to its claim loop.
		writeError(w, http.StatusConflict, "job no longer exists")
		return nil, false
	}
	wid := workerID(r)
	if wid == "" {
		writeError(w, http.StatusUnauthorized, "worker not authenticated")
		return nil, false
	}
	// The job must still be active; a requeued or finished job is no longer this
	// worker's to touch.
	if job.Status != "running" && job.Status != "claimed" {
		writeError(w, http.StatusConflict, "job is no longer active")
		return nil, false
	}
	// Ownership: nil claimed_by on an active job means it was requeued out from
	// under this worker; a different claimed_by means another worker owns it.
	if job.ClaimedBy == nil || *job.ClaimedBy != wid {
		writeError(w, http.StatusConflict, "job is claimed by another worker")
		return nil, false
	}
	return job, true
}

func (s *Server) handleProgress(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Pct   int    `json:"pct"`
		Stage string `json:"stage"`
		Log   string `json:"log"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if _, ok := s.bindWorker(w, r, id); !ok {
		return
	}
	// Single round-trip: update only while running, and use rows-affected to
	// detect cancellation/requeue. No running row → tell the worker to abort.
	applied, err := s.jobs.UpdateProgress(r.Context(), id, body.Pct, body.Stage)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update progress")
		return
	}
	if !applied {
		writeError(w, http.StatusConflict, "job canceled")
		return
	}
	s.hub.Publish(id, events.Event{Type: "progress", Data: map[string]any{"pct": body.Pct, "stage": body.Stage}})
	if body.Log != "" {
		_ = s.jobs.AppendLog(r.Context(), id, "info", body.Log)
		s.publishLog(id, "info", body.Log)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, ok := s.bindWorker(w, r, id); !ok {
		return
	}
	if err := s.jobs.Heartbeat(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "heartbeat failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleInternalLog(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Level   string `json:"level"`
		Message string `json:"message"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	id := chi.URLParam(r, "id")
	if _, ok := s.bindWorker(w, r, id); !ok {
		return
	}
	if err := s.jobs.AppendLog(r.Context(), id, body.Level, body.Message); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to append log")
		return
	}
	s.publishLog(id, body.Level, body.Message)
	w.WriteHeader(http.StatusNoContent)
}

// handleResult receives a produced subtitle file (multipart: fields kind,
// language, sha256 + the file part) and records it against the job.
func (s *Server) handleResult(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "id")
	if _, ok := s.bindWorker(w, r, jobID); !ok {
		return
	}

	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "expected multipart/form-data")
		return
	}

	var (
		storageKey string
		fields     = map[string]string{}
	)
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, "malformed multipart body")
			return
		}
		if part.FormName() == "file" {
			name := sanitizeFilename(part.FileName())
			// Unique key prefix so re-running a job never overwrites the blob of a
			// previously produced (possibly hand-edited) result — runs accumulate.
			storageKey = "results/" + jobID + "/" + uuid.NewString() + "-" + name
			if err := s.store.Put(r.Context(), storageKey, part, -1, "application/octet-stream"); err != nil {
				part.Close()
				writeError(w, http.StatusInternalServerError, "failed to store result")
				return
			}
		} else {
			buf, _ := io.ReadAll(io.LimitReader(part, 1<<16))
			fields[part.FormName()] = strings.TrimSpace(string(buf))
		}
		part.Close()
	}

	if storageKey == "" {
		writeError(w, http.StatusBadRequest, "missing \"file\" part")
		return
	}

	kind := fields["kind"]
	if kind == "" {
		kind = "srt"
	}

	var size int64 = -1
	if blob, err := s.store.Stat(r.Context(), storageKey); err == nil {
		size = blob.Size
	}

	res, err := s.jobs.AddResult(r.Context(), jobID, kind, storageKey, fields["language"], fields["name"], size, fields["sha256"])
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record result")
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

func (s *Server) handleComplete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Status string `json:"status"` // "success" | "failure"
		Error  string `json:"error"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	jobID := chi.URLParam(r, "id")
	if _, ok := s.bindWorker(w, r, jobID); !ok {
		return
	}
	if err := s.jobs.Complete(r.Context(), jobID, body.Status == "success", body.Error); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to complete job")
		return
	}
	_ = s.workers.ClearJob(r.Context(), jobID)
	status := "succeeded"
	if body.Status != "success" {
		status = "failed"
	}
	s.hub.Publish(jobID, events.Event{Type: "status", Data: map[string]any{"status": status}})
	w.WriteHeader(http.StatusNoContent)
}

// StartStaleRequeuer periodically re-queues jobs whose worker stopped heart-beating
// and detaches workers from jobs that are no longer running.
func StartStaleRequeuer(ctx context.Context, repo *jobs.Repo, workerRepo *workers.Repo, timeout time.Duration, logf func(string, ...any)) {
	ticker := time.NewTicker(30 * time.Second)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				n, err := repo.RequeueStale(ctx, timeout)
				if err != nil {
					logf("requeue stale: %v", err)
				} else if n > 0 {
					logf("re-queued %d stale job(s)", n)
				}
				if err := workerRepo.ClearStaleJobs(ctx); err != nil {
					logf("clear stale worker jobs: %v", err)
				}
			}
		}
	}()
}

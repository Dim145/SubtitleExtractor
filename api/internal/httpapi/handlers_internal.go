package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"subtitleextractor/internal/events"
	"subtitleextractor/internal/jobs"
	"subtitleextractor/internal/settings"
	"subtitleextractor/internal/workers"
)

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
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, "worker name required")
		return
	}
	if body.WorkerClass == "" {
		body.WorkerClass = "any"
	}
	wk, err := s.workers.Upsert(r.Context(), body.Name, body.WorkerClass, body.Capabilities)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "heartbeat failed")
		return
	}
	var defaults settings.Settings
	if st, err := s.settings.Get(r.Context()); err == nil {
		defaults = *st
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workerId":      wk.ID,
		"enabled":       wk.Enabled,
		"configVersion": wk.ConfigVersion,
		"config":        json.RawMessage(workers.EffectiveConfig(defaults.WorkerDefaults, wk.Config)),
	})
}

// handleClaim hands the oldest matching queued job to a worker, with a
// presigned URL to fetch the input video. Returns 204 when nothing is queued.
func (s *Server) handleClaim(w http.ResponseWriter, r *http.Request) {
	workerClass := r.URL.Query().Get("worker_class")
	if workerClass == "" {
		workerClass = "any"
	}
	workerID := r.Header.Get("X-Worker-Id")
	if workerID == "" {
		workerID = "worker-" + workerClass
	}

	// A disabled worker is not allowed to take new jobs.
	if wk, err := s.workers.GetByName(r.Context(), workerID); err == nil && !wk.Enabled {
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
	// Tell the worker to abort if the job was canceled or deleted.
	if s.jobs.IsCanceled(r.Context(), id) {
		writeError(w, http.StatusConflict, "job canceled")
		return
	}
	if err := s.jobs.UpdateProgress(r.Context(), id, body.Pct, body.Stage); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update progress")
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
	if s.jobs.IsCanceled(r.Context(), id) {
		writeError(w, http.StatusConflict, "job canceled")
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
	if _, err := s.jobs.Get(r.Context(), jobID); err != nil {
		writeError(w, http.StatusNotFound, "job not found")
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
			storageKey = "results/" + jobID + "/" + name
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

	res, err := s.jobs.AddResult(r.Context(), jobID, kind, storageKey, fields["language"], size, fields["sha256"])
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

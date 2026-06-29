package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"subtitleextractor/internal/auth"
	"subtitleextractor/internal/jobs"
)

// downloadTTL is how long presigned result/input URLs stay valid.
const downloadTTL = time.Hour

// handleCreateJob accepts a streaming multipart upload (a "file" part plus
// optional parameter fields), stores the video, and queues an extraction job.
func (s *Server) handleCreateJob(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFromContext(r.Context())
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "expected multipart/form-data")
		return
	}

	var (
		inputKey string
		filename string
		fields   = map[string]string{}
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
			filename = sanitizeFilename(part.FileName())
			inputKey = "inputs/" + uuid.NewString() + "/" + filename
			ct := part.Header.Get("Content-Type")
			if err := s.store.Put(r.Context(), inputKey, part, -1, ct); err != nil {
				part.Close()
				writeError(w, http.StatusInternalServerError, "failed to store upload")
				return
			}
		} else {
			buf, _ := io.ReadAll(io.LimitReader(part, 1<<16))
			fields[part.FormName()] = strings.TrimSpace(string(buf))
		}
		part.Close()
	}

	if inputKey == "" {
		writeError(w, http.StatusBadRequest, "missing \"file\" part")
		return
	}

	// Worker routing is automatic — any enabled worker can claim the job.
	job, err := s.jobs.Create(r.Context(), u.ID, "any", filename, inputKey, buildParams(fields))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create job")
		return
	}
	writeJSON(w, http.StatusCreated, job)
}

// buildParams turns the provided form fields into the job's params JSON.
func buildParams(fields map[string]string) json.RawMessage {
	params := map[string]any{}
	if v := fields["language"]; v != "" {
		params["language"] = v
	}
	if v := fields["ocrBackend"]; v != "" {
		params["ocr_backend"] = v
	}
	if v := fields["crop"]; v != "" {
		params["crop"] = v // "x:y:w:h" in pixels, or relative band
	}
	if v := fields["fps"]; v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			params["fps"] = f
		}
	}
	if v := fields["formats"]; v != "" {
		var formats []string
		for _, f := range strings.Split(v, ",") {
			if f = strings.TrimSpace(f); f != "" {
				formats = append(formats, f)
			}
		}
		if len(formats) > 0 {
			params["formats"] = formats
		}
	}
	// zones: JSON array of normalized rects [{x,y,w,h}] (0..1), up to 2.
	if v := fields["zones"]; v != "" {
		var zones []map[string]float64
		if err := json.Unmarshal([]byte(v), &zones); err == nil && len(zones) > 0 {
			if len(zones) > 2 {
				zones = zones[:2]
			}
			params["zones"] = zones
		}
	}
	b, _ := json.Marshal(params)
	return b
}

func (s *Server) handleListJobs(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFromContext(r.Context())
	list, err := s.jobs.ListForUser(r.Context(), u.ID, 100)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list jobs")
		return
	}
	if list == nil {
		list = []*jobs.Job{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleGetJob(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (s *Server) handleJobLogs(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	logs, err := s.jobs.Logs(r.Context(), job.ID, after, 500)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read logs")
		return
	}
	if logs == nil {
		logs = []*jobs.LogEntry{}
	}
	writeJSON(w, http.StatusOK, logs)
}

// handleJobVideo returns a presigned URL to the job's source video so the
// browser editor can use it as the preview track.
func (s *Server) handleJobVideo(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	if job.VideoDeletedAt != nil {
		writeError(w, http.StatusNotFound, "source video has been deleted")
		return
	}
	url, err := s.store.PresignGet(r.Context(), job.InputKey, downloadTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to sign video URL")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"url":      url,
		"filename": job.SourceFilename,
	})
}

func (s *Server) handleJobResults(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	results, err := s.jobs.Results(r.Context(), job.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read results")
		return
	}
	// Decorate with presigned download URLs.
	type resultDTO struct {
		*jobs.Result
		DownloadURL string `json:"downloadUrl"`
	}
	out := make([]resultDTO, 0, len(results))
	for _, res := range results {
		url, err := s.store.PresignGet(r.Context(), res.StorageKey, downloadTTL)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to sign download URL")
			return
		}
		out = append(out, resultDTO{Result: res, DownloadURL: url})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleSaveResult stores an edited subtitle file (multipart: kind, language +
// file) against the caller's own job. This is the editor's "save to server".
func (s *Server) handleSaveResult(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "expected multipart/form-data")
		return
	}
	// When overwriting, we must resolve the target's storage key before storing,
	// so buffer the small subtitle body and process fields first.
	const maxBody = 8 << 20 // subtitles are tiny; cap and reject anything larger.
	var (
		body        []byte
		fields      = map[string]string{}
		namePresent bool
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
			// Read one extra byte so we can detect (and reject) oversize uploads
			// rather than silently truncating them.
			body, _ = io.ReadAll(io.LimitReader(part, maxBody+1))
			if len(body) > maxBody {
				part.Close()
				writeError(w, http.StatusRequestEntityTooLarge, "subtitle exceeds 8MB limit")
				return
			}
		} else {
			buf, _ := io.ReadAll(io.LimitReader(part, 1<<16))
			val := strings.TrimSpace(string(buf))
			if part.FormName() == "name" {
				namePresent = val != ""
			}
			fields[part.FormName()] = val
		}
		part.Close()
	}
	if len(body) == 0 {
		writeError(w, http.StatusBadRequest, "missing \"file\" part")
		return
	}
	kind := fields["kind"]
	if kind == "" {
		kind = "ass"
	}
	// Only derive a name when one was actually provided; don't depend on the
	// sanitize sentinel to detect "no name".
	name := ""
	if namePresent {
		if n := sanitizeFilename(fields["name"]); n != "upload.bin" {
			name = n
		}
	}

	// Overwrite an existing result, or create a new one.
	var overwrite *jobs.Result
	if rid := fields["resultId"]; rid != "" {
		ex, err := s.jobs.ResultByID(r.Context(), rid)
		if err != nil || ex.JobID != job.ID {
			writeError(w, http.StatusNotFound, "result not found")
			return
		}
		overwrite = ex
	}

	// Decide the storage key. On a new result, or when an overwrite changes the
	// kind (and thus the object's extension), mint a fresh key so storage_key
	// stays consistent with the stored object. Otherwise reuse the existing key.
	newKey := "results/" + job.ID + "/" + uuid.NewString() + "-" + resultBase(name, kind)
	storageKey := newKey
	keyChanged := true
	if overwrite != nil && overwrite.Kind == kind {
		storageKey = overwrite.StorageKey
		keyChanged = false
	}

	if err := s.store.Put(r.Context(), storageKey, bytes.NewReader(body), int64(len(body)), "text/plain; charset=utf-8"); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to store subtitle")
		return
	}
	size := int64(len(body))

	var res *jobs.Result
	var err2 error
	switch {
	case overwrite != nil && keyChanged:
		res, err2 = s.jobs.ReplaceResultWithKey(r.Context(), overwrite.ID, kind, storageKey, name, fields["language"], size, "")
	case overwrite != nil:
		res, err2 = s.jobs.ReplaceResult(r.Context(), overwrite.ID, kind, name, fields["language"], size, "")
	default:
		res, err2 = s.jobs.AddResult(r.Context(), job.ID, kind, storageKey, fields["language"], name, size, "")
	}
	if err2 != nil {
		writeError(w, http.StatusInternalServerError, "failed to record subtitle")
		return
	}
	// On a successful key change, drop the now-orphaned old object (best effort).
	if overwrite != nil && keyChanged {
		_ = s.store.Delete(r.Context(), overwrite.StorageKey)
	}
	writeJSON(w, http.StatusCreated, res)
}

// handleDeleteResult removes one subtitle result (file + row). If it was the
// job's last result, the whole job (input + remaining files) is deleted too.
func (s *Server) handleDeleteResult(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	res, err := s.jobs.ResultByID(r.Context(), chi.URLParam(r, "resultId"))
	if err != nil || res.JobID != job.ID {
		writeError(w, http.StatusNotFound, "result not found")
		return
	}
	// Delete the DB row first so the user-facing state is consistent even if a
	// storage delete later fails (an orphaned blob is harmless; a dangling row
	// pointing at a missing object is not). Storage cleanup is best-effort.
	if err := s.jobs.DeleteResult(r.Context(), res.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete result")
		return
	}
	remaining, _ := s.jobs.Results(r.Context(), job.ID)
	if len(remaining) == 0 {
		// Last result: delete the job row before touching the input object so we
		// never orphan a job whose input has already been removed.
		if err := s.jobs.Delete(r.Context(), job.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to delete job")
			return
		}
		_ = s.workers.ClearJob(r.Context(), job.ID)
		_ = s.store.Delete(r.Context(), res.StorageKey)
		_ = s.store.Delete(r.Context(), job.InputKey)
		writeJSON(w, http.StatusOK, map[string]bool{"jobDeleted": true})
		return
	}
	_ = s.store.Delete(r.Context(), res.StorageKey)
	writeJSON(w, http.StatusOK, map[string]bool{"jobDeleted": false})
}

// handleWorkerAvailability returns aggregate worker counts (no names/config) so
// any signed-in user can tell whether a job will be picked up promptly.
func (s *Server) handleWorkerAvailability(w http.ResponseWriter, r *http.Request) {
	list, err := s.workers.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read workers")
		return
	}
	total, online, busy, idle := 0, 0, 0, 0
	for _, wk := range list {
		total++
		if !wk.Enabled {
			continue
		}
		switch wk.Status {
		case "online":
			idle++
			online++
		case "busy":
			busy++
			online++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"total":     total,
		"online":    online,
		"busy":      busy,
		"idle":      idle,
		"available": idle > 0,
	})
}

// handleCancelJob cancels an active job; the worker stops on its next progress
// post (which then gets a 409). Worker temp files are cleaned up on abort.
func (s *Server) handleCancelJob(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	canceled, err := s.jobs.Cancel(r.Context(), job.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to cancel job")
		return
	}
	if !canceled {
		writeError(w, http.StatusConflict, "job is not active")
		return
	}
	_ = s.workers.ClearJob(r.Context(), job.ID)
	_ = s.jobs.AppendLog(r.Context(), job.ID, "warn", "canceled by user")
	s.publishLog(job.ID, "warn", "canceled by user")
	s.publishStatus(job.ID, "canceled")
	w.WriteHeader(http.StatusNoContent)
}

// handleRerunJob re-queues a finished job (succeeded/failed/canceled) for a
// fresh extraction. Allowed only while the source video is still in storage.
// Existing subtitle results are kept; the new run appends its own.
func (s *Server) handleRerunJob(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	if job.VideoDeletedAt != nil {
		writeError(w, http.StatusConflict, "source video has been deleted; cannot re-run")
		return
	}
	// Confirm the blob really exists (an external deletion may not be recorded).
	if _, err := s.store.Stat(r.Context(), job.InputKey); err != nil {
		_ = s.jobs.MarkVideoDeleted(r.Context(), job.ID)
		writeError(w, http.StatusConflict, "source video is no longer available; cannot re-run")
		return
	}
	requeued, err := s.jobs.Rerun(r.Context(), job.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to re-run job")
		return
	}
	if !requeued {
		writeError(w, http.StatusConflict, "job can't be re-run in its current state")
		return
	}
	_ = s.jobs.AppendLog(r.Context(), job.ID, "info", "re-queued by user")
	s.publishLog(job.ID, "info", "re-queued by user")
	s.publishStatus(job.ID, "queued")
	updated, err := s.jobs.Get(r.Context(), job.ID)
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleDeleteVideo removes only the source video blob, freeing storage while
// keeping the job and its subtitle results. Refused while the job is active —
// the worker still needs the video.
func (s *Server) handleDeleteVideo(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	switch job.Status {
	case "queued", "claimed", "running":
		writeError(w, http.StatusConflict, "job is still active; cancel it before deleting the video")
		return
	}
	if job.VideoDeletedAt == nil {
		_ = s.store.Delete(r.Context(), job.InputKey) // best-effort
		if err := s.jobs.MarkVideoDeleted(r.Context(), job.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to delete video")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDeleteJob removes a job from history along with its stored files
// (input video + result subtitles). Running jobs are stopped as a side effect.
func (s *Server) handleDeleteJob(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	// Collect the storage keys before the row (and its cascaded results) are
	// gone, but delete the DB row FIRST so the user-facing state is consistent;
	// blob cleanup is best-effort afterwards. An orphaned blob is harmless; a
	// row pointing at deleted objects is not.
	keys := []string{job.InputKey}
	if results, err := s.jobs.Results(r.Context(), job.ID); err == nil {
		for _, res := range results {
			keys = append(keys, res.StorageKey)
		}
	}
	if err := s.jobs.Delete(r.Context(), job.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete job")
		return
	}
	_ = s.workers.ClearJob(r.Context(), job.ID)
	for _, k := range keys {
		_ = s.store.Delete(r.Context(), k)
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDownloadResult streams a subtitle result through the API (same-origin).
// This is the reliable fallback to the presigned download URL: it never needs a
// public bucket and is immune to S3 clock-skew / signature issues ("Date is too
// old"), because the API fetches the object with its own credentials.
func (s *Server) handleDownloadResult(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	res, err := s.jobs.ResultByID(r.Context(), chi.URLParam(r, "resultId"))
	if err != nil || res.JobID != job.ID {
		writeError(w, http.StatusNotFound, "result not found")
		return
	}
	rc, err := s.store.Get(r.Context(), res.StorageKey)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read result")
		return
	}
	defer rc.Close()
	name := "subtitles." + res.Kind
	if res.Name != nil && *res.Name != "" {
		name = sanitizeFilename(*res.Name)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+strings.ReplaceAll(name, "\"", "")+"\"")
	_, _ = io.Copy(w, rc)
}

// handleVideoStream proxies the source video through the API (same-origin, with
// HTTP Range support so the editor can seek). Reliable fallback to the presigned
// /video URL for non-public buckets / S3 signature issues.
func (s *Server) handleVideoStream(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	if job.VideoDeletedAt != nil {
		writeError(w, http.StatusNotFound, "source video has been deleted")
		return
	}
	rc, err := s.store.Get(r.Context(), job.InputKey)
	if err != nil {
		writeError(w, http.StatusNotFound, "source video unavailable")
		return
	}
	defer rc.Close()
	ct := "video/mp4"
	if blob, err := s.store.Stat(r.Context(), job.InputKey); err == nil && blob.ContentType != "" {
		ct = blob.ContentType
	}
	w.Header().Set("Content-Type", ct)
	if rs, ok := rc.(io.ReadSeeker); ok {
		// ServeContent handles Range, Content-Length and conditional requests.
		http.ServeContent(w, r, job.SourceFilename, time.Time{}, rs)
		return
	}
	_, _ = io.Copy(w, rc)
}

// ownedJob fetches the job in the URL and enforces ownership (admins bypass).
func (s *Server) ownedJob(w http.ResponseWriter, r *http.Request) (*jobs.Job, bool) {
	u := auth.UserFromContext(r.Context())
	job, err := s.jobs.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "job not found")
		return nil, false
	}
	if job.UserID != u.ID && !u.IsAdmin {
		writeError(w, http.StatusForbidden, "not your job")
		return nil, false
	}
	return job, true
}

// resultBase returns the filename portion of a saved-result storage key: the
// provided (already-sanitized) name when present, else a kind-derived default.
func resultBase(name, kind string) string {
	if name != "" {
		return name
	}
	return "edited." + kind
}

// sanitizeFilename strips any path components from an uploaded filename.
func sanitizeFilename(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return "upload.bin"
	}
	return name
}

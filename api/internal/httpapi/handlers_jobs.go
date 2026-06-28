package httpapi

import (
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
	var (
		body   []byte
		fields = map[string]string{}
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
			body, _ = io.ReadAll(io.LimitReader(part, 8<<20)) // subtitles are tiny
		} else {
			buf, _ := io.ReadAll(io.LimitReader(part, 1<<16))
			fields[part.FormName()] = strings.TrimSpace(string(buf))
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
	name := sanitizeFilename(fields["name"])
	if name == "upload.bin" {
		name = ""
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

	storageKey := ""
	if overwrite != nil {
		storageKey = overwrite.StorageKey
	} else {
		base := name
		if base == "" {
			base = "edited." + kind
		}
		storageKey = "results/" + job.ID + "/" + uuid.NewString() + "-" + base
	}
	if err := s.store.Put(r.Context(), storageKey, strings.NewReader(string(body)), int64(len(body)), "text/plain; charset=utf-8"); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to store subtitle")
		return
	}
	size := int64(len(body))

	var res *jobs.Result
	var err2 error
	if overwrite != nil {
		res, err2 = s.jobs.ReplaceResult(r.Context(), overwrite.ID, kind, name, fields["language"], size, "")
	} else {
		res, err2 = s.jobs.AddResult(r.Context(), job.ID, kind, storageKey, fields["language"], name, size, "")
	}
	if err2 != nil {
		writeError(w, http.StatusInternalServerError, "failed to record subtitle")
		return
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
	_ = s.store.Delete(r.Context(), res.StorageKey)
	if err := s.jobs.DeleteResult(r.Context(), res.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete result")
		return
	}
	remaining, _ := s.jobs.Results(r.Context(), job.ID)
	if len(remaining) == 0 {
		_ = s.store.Delete(r.Context(), job.InputKey)
		_ = s.workers.ClearJob(r.Context(), job.ID)
		_ = s.jobs.Delete(r.Context(), job.ID)
		writeJSON(w, http.StatusOK, map[string]bool{"jobDeleted": true})
		return
	}
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

// handleDeleteJob removes a job from history along with its stored files
// (input video + result subtitles). Running jobs are stopped as a side effect.
func (s *Server) handleDeleteJob(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	// Remove result files, then the input, then the row (logs/results cascade).
	if results, err := s.jobs.Results(r.Context(), job.ID); err == nil {
		for _, res := range results {
			_ = s.store.Delete(r.Context(), res.StorageKey)
		}
	}
	_ = s.store.Delete(r.Context(), job.InputKey)
	_ = s.workers.ClearJob(r.Context(), job.ID)
	if err := s.jobs.Delete(r.Context(), job.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete job")
		return
	}
	w.WriteHeader(http.StatusNoContent)
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

// sanitizeFilename strips any path components from an uploaded filename.
func sanitizeFilename(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return "upload.bin"
	}
	return name
}

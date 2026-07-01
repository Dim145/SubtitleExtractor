package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"subtitleextractor/internal/auth"
	"subtitleextractor/internal/cleanup"
	"subtitleextractor/internal/cronspec"
	"subtitleextractor/internal/settings"
)

// handleAdminCreateUser lets an admin provision a local account (allowed when
// local registration is enabled).
func (s *Server) handleAdminCreateUser(w http.ResponseWriter, r *http.Request) {
	if !s.registrationAllowed(r) {
		writeError(w, http.StatusForbidden, "local registration is disabled")
		return
	}
	var body struct {
		Email       string `json:"email"`
		Password    string `json:"password"`
		DisplayName string `json:"displayName"`
		IsAdmin     bool   `json:"isAdmin"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Email = strings.TrimSpace(strings.ToLower(body.Email))
	if body.Email == "" || len(body.Password) < 8 {
		writeError(w, http.StatusBadRequest, "email required and password must be at least 8 characters")
		return
	}
	if _, err := s.users.GetByEmail(r.Context(), body.Email); err == nil {
		writeError(w, http.StatusConflict, "email already registered")
		return
	}
	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to hash password")
		return
	}
	u, err := s.users.CreateLocal(r.Context(), body.Email, body.DisplayName, hash, body.IsAdmin)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create user")
		return
	}
	s.recordAudit(r, "user.create", u.ID, map[string]any{"email": u.Email, "isAdmin": u.IsAdmin})
	writeJSON(w, http.StatusCreated, u)
}

// --- users ---------------------------------------------------------------

func (s *Server) handleAdminListUsers(w http.ResponseWriter, r *http.Request) {
	list, err := s.users.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list users")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleAdminPatchUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IsAdmin *bool `json:"isAdmin"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	id := chi.URLParam(r, "id")
	if body.IsAdmin != nil {
		// Guard against an admin removing their own admin rights and locking out.
		if me := auth.UserFromContext(r.Context()); me != nil && me.ID == id && !*body.IsAdmin {
			writeError(w, http.StatusBadRequest, "you can't revoke your own admin role")
			return
		}
		// Guard against demoting the last remaining admin (system-wide lockout).
		if !*body.IsAdmin {
			if n, err := s.users.CountAdmins(r.Context()); err == nil && n <= 1 {
				writeError(w, http.StatusConflict, "cannot demote the last remaining admin")
				return
			}
		}
		if err := s.users.SetAdmin(r.Context(), id, *body.IsAdmin); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update user")
			return
		}
		s.recordAudit(r, "user.setAdmin", id, map[string]any{"isAdmin": *body.IsAdmin})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if me := auth.UserFromContext(r.Context()); me != nil && me.ID == id {
		writeError(w, http.StatusBadRequest, "you can't delete your own account here")
		return
	}
	target, err := s.users.GetByID(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	// Guard against deleting the last remaining admin (system-wide lockout).
	if target.IsAdmin {
		if n, err := s.users.CountAdmins(r.Context()); err == nil && n <= 1 {
			writeError(w, http.StatusConflict, "cannot delete the last remaining admin")
			return
		}
	}
	// Enumerate the user's blobs (inputs + results) before the DB cascade removes
	// the rows, so we can free their storage. Cleanup is best-effort.
	keys, _ := s.jobs.StorageKeysForUser(r.Context(), id)
	if err := s.users.Delete(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete user")
		return
	}
	for _, k := range keys {
		_ = s.store.Delete(r.Context(), k)
	}
	s.recordAudit(r, "user.delete", id, map[string]any{"email": target.Email, "blobsDeleted": len(keys)})
	w.WriteHeader(http.StatusNoContent)
}

// --- settings ------------------------------------------------------------

func (s *Server) handleAdminGetSettings(w http.ResponseWriter, r *http.Request) {
	st, err := s.settings.Get(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read settings")
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleAdminPutSettings(w http.ResponseWriter, r *http.Request) {
	var st settings.Settings
	if !decodeJSON(w, r, &st) {
		return
	}
	if len(st.WorkerDefaults) == 0 {
		st.WorkerDefaults = json.RawMessage(`{}`)
	}
	if st.VideoCleanupCron != "" {
		if _, err := cronspec.Parse(st.VideoCleanupCron); err != nil {
			writeError(w, http.StatusBadRequest, "invalid cleanup schedule (expected a 5-field cron expression)")
			return
		}
	}
	if err := s.settings.Update(r.Context(), &st); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save settings")
		return
	}
	s.recordAudit(r, "settings.update", "app_settings", nil)
	writeJSON(w, http.StatusOK, st)
}

// handleAdminRunCleanup triggers a video-retention cleanup immediately and
// returns the resulting run record.
func (s *Server) handleAdminRunCleanup(w http.ResponseWriter, r *http.Request) {
	if s.cleaner == nil {
		writeError(w, http.StatusServiceUnavailable, "cleanup is not available")
		return
	}
	run, err := s.cleaner.RunNow(r.Context())
	if errors.Is(err, ErrCleanupBusy) {
		writeError(w, http.StatusConflict, "a cleanup run is already in progress")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "cleanup failed")
		return
	}
	writeJSON(w, http.StatusOK, run)
}

// handleAdminListCleanupRuns returns the most recent cleanup runs (default 7).
func (s *Server) handleAdminListCleanupRuns(w http.ResponseWriter, r *http.Request) {
	if s.cleaner == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	runs, err := s.cleaner.ListRuns(r.Context(), 7)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list cleanup runs")
		return
	}
	if runs == nil {
		runs = []*cleanup.Run{} // serialize as [] not null
	}
	writeJSON(w, http.StatusOK, runs)
}

// --- workers -------------------------------------------------------------

func (s *Server) handleAdminListWorkers(w http.ResponseWriter, r *http.Request) {
	list, err := s.workers.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list workers")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleAdminPatchWorker(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled *bool           `json:"enabled"`
		Config  json.RawMessage `json:"config"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	id := chi.URLParam(r, "id")
	if body.Enabled != nil {
		if err := s.workers.SetEnabled(r.Context(), id, *body.Enabled); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update worker")
			return
		}
		s.recordAudit(r, "worker.setEnabled", id, map[string]any{"enabled": *body.Enabled})
	}
	if len(body.Config) > 0 {
		if err := s.workers.UpdateConfig(r.Context(), id, body.Config); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update worker config")
			return
		}
		s.recordAudit(r, "worker.updateConfig", id, nil)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAdminDeleteWorker(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.workers.Delete(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete worker")
		return
	}
	s.recordAudit(r, "worker.delete", id, nil)
	w.WriteHeader(http.StatusNoContent)
}

// recordAudit writes an audit entry attributed to the current admin. Best-effort:
// a logging failure must not fail the mutation that already succeeded.
func (s *Server) recordAudit(r *http.Request, action, target string, detail any) {
	if s.audit == nil {
		return
	}
	var actorID string
	if me := auth.UserFromContext(r.Context()); me != nil {
		actorID = me.ID
	}
	_ = s.audit.Record(r.Context(), actorID, action, target, detail)
}

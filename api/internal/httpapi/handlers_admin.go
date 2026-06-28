package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"subtitleextractor/internal/auth"
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
		if err := s.users.SetAdmin(r.Context(), id, *body.IsAdmin); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update user")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if me := auth.UserFromContext(r.Context()); me != nil && me.ID == id {
		writeError(w, http.StatusBadRequest, "you can't delete your own account here")
		return
	}
	if err := s.users.Delete(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete user")
		return
	}
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
	if err := s.settings.Update(r.Context(), &st); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save settings")
		return
	}
	writeJSON(w, http.StatusOK, st)
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
	}
	if len(body.Config) > 0 {
		if err := s.workers.UpdateConfig(r.Context(), id, body.Config); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update worker config")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAdminDeleteWorker(w http.ResponseWriter, r *http.Request) {
	if err := s.workers.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete worker")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

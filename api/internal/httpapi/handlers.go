package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/oauth2"

	"subtitleextractor/internal/auth"
	"subtitleextractor/internal/storage"
)

// --- health --------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleReady is a readiness probe: it verifies the database is reachable and
// that the storage backend responds. /healthz stays a pure liveness check.
func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if s.pool != nil {
		if err := s.pool.Ping(ctx); err != nil {
			writeError(w, http.StatusServiceUnavailable, "database unavailable")
			return
		}
	}
	// Cheap storage reachability probe: a Stat on a key that shouldn't exist. A
	// "not found" style response means the backend is reachable and healthy; only
	// a transport/credential failure (context deadline, connection refused) is a
	// readiness failure.
	if _, err := s.store.Stat(ctx, "healthz/readiness-probe"); err != nil {
		if ctx.Err() != nil {
			writeError(w, http.StatusServiceUnavailable, "storage unavailable")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

// --- auth config (consumed by the frontend login screen) -----------------

func (s *Server) handleAuthConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"localEnabled":             s.cfg.Auth.LocalEnabled,
		"localRegistrationEnabled": s.registrationAllowed(r),
		"oidcEnabled":              s.oidc != nil,
	})
}

// registrationAllowed combines the env switch with the DB-backed site setting.
func (s *Server) registrationAllowed(r *http.Request) bool {
	if !s.cfg.Auth.LocalEnabled {
		return false
	}
	st, err := s.settings.Get(r.Context())
	if err != nil {
		// Fall back to the env default if settings can't be read.
		return s.cfg.Auth.LocalRegistrationEnabled
	}
	return st.RegistrationEnabled
}

// --- local accounts ------------------------------------------------------

type credentials struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.registrationAllowed(r) {
		writeError(w, http.StatusForbidden, "local registration is disabled")
		return
	}
	var body credentials
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
	// The very first account becomes an admin to bootstrap the deployment.
	count, err := s.users.CountAll(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	u, err := s.users.CreateLocal(r.Context(), body.Email, body.DisplayName, hash, count == 0)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create user")
		return
	}
	if err := s.sessions.Issue(w, u.ID, u.TokenVersion); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start session")
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Auth.LocalEnabled {
		writeError(w, http.StatusForbidden, "local login is disabled")
		return
	}
	var body credentials
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Email = strings.TrimSpace(strings.ToLower(body.Email))
	u, err := s.users.GetByEmail(r.Context(), body.Email)
	if err != nil || u.Provider != "local" || u.PasswordHash == nil {
		// Run a dummy verify against a constant hash so the response time for an
		// unknown/OIDC account matches the found-user path (no enumeration signal).
		_, _ = auth.VerifyPassword(body.Password, auth.DummyHash)
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	ok, err := auth.VerifyPassword(body.Password, *u.PasswordHash)
	if err != nil || !ok {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err := s.sessions.Issue(w, u.ID, u.TokenVersion); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start session")
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	// Best-effort: bump the user's token_version so the just-cleared token (and
	// any other sessions) can't be replayed. Failures here don't block logout.
	if c, err := r.Cookie(auth.SessionCookieName); err == nil {
		if uid, _, perr := s.sessions.Parse(c.Value); perr == nil {
			_ = s.users.BumpTokenVersion(r.Context(), uid)
		}
	}
	s.sessions.Clear(w)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFromContext(r.Context())
	if u == nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	writeJSON(w, http.StatusOK, u)
}

// handleUpdateProfile lets a local user edit their own display name, email and
// password. OIDC accounts are managed by the identity provider and rejected.
// Changing the email or password requires the current password.
func (s *Server) handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFromContext(r.Context())
	if u == nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if u.Provider != "local" || u.PasswordHash == nil {
		writeError(w, http.StatusForbidden, "your profile is managed by your SSO provider")
		return
	}
	var body struct {
		DisplayName     *string `json:"displayName"`
		Email           *string `json:"email"`
		Password        *string `json:"password"`
		CurrentPassword string  `json:"currentPassword"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}

	newName, newEmail := u.DisplayName, u.Email
	if body.DisplayName != nil {
		newName = strings.TrimSpace(*body.DisplayName)
	}
	emailChange := false
	if body.Email != nil {
		e := strings.TrimSpace(strings.ToLower(*body.Email))
		if e == "" {
			writeError(w, http.StatusBadRequest, "email cannot be empty")
			return
		}
		if e != u.Email {
			emailChange = true
			newEmail = e
		}
	}
	pwChange := body.Password != nil && *body.Password != ""

	// Sensitive changes require re-entering the current password.
	if emailChange || pwChange {
		ok, err := auth.VerifyPassword(body.CurrentPassword, *u.PasswordHash)
		if err != nil || !ok {
			writeError(w, http.StatusForbidden, "current password is incorrect")
			return
		}
	}
	if emailChange {
		if _, err := s.users.GetByEmail(r.Context(), newEmail); err == nil {
			writeError(w, http.StatusConflict, "that email is already in use")
			return
		}
	}
	if pwChange && len(*body.Password) < 8 {
		writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}

	if _, err := s.users.UpdateProfile(r.Context(), u.ID, newName, newEmail); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update profile")
		return
	}
	if pwChange {
		hash, err := auth.HashPassword(*body.Password)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to hash password")
			return
		}
		if err := s.users.SetPassword(r.Context(), u.ID, hash); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update password")
			return
		}
	}
	updated, err := s.users.GetByID(r.Context(), u.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reload profile")
		return
	}
	// A password change bumped token_version (invalidating all sessions). Re-issue
	// a fresh cookie for the current request so the caller isn't logged out here,
	// while any *other* outstanding tokens remain revoked.
	if pwChange {
		if err := s.sessions.Issue(w, updated.ID, updated.TokenVersion); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to refresh session")
			return
		}
	}
	writeJSON(w, http.StatusOK, updated)
}

// --- OIDC flow -----------------------------------------------------------

const (
	oidcStateCookie = "subext_oidc_state"
	oidcNonceCookie = "subext_oidc_nonce"
	oidcPKCECookie  = "subext_oidc_pkce"
	oidcFlowTTL     = 10 * time.Minute
)

func (s *Server) handleOIDCLogin(w http.ResponseWriter, r *http.Request) {
	state := randomToken()
	nonce := randomToken()
	verifier := oauth2.GenerateVerifier()

	s.setFlowCookie(w, oidcStateCookie, state)
	s.setFlowCookie(w, oidcNonceCookie, nonce)
	s.setFlowCookie(w, oidcPKCECookie, verifier)

	http.Redirect(w, r, s.oidc.AuthCodeURL(state, nonce, verifier), http.StatusFound)
}

func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	stateCookie, err := r.Cookie(oidcStateCookie)
	if err != nil || r.URL.Query().Get("state") != stateCookie.Value {
		writeError(w, http.StatusBadRequest, "invalid OIDC state")
		return
	}
	nonceCookie, err := r.Cookie(oidcNonceCookie)
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing OIDC nonce")
		return
	}
	pkceCookie, err := r.Cookie(oidcPKCECookie)
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing PKCE verifier")
		return
	}

	claims, err := s.oidc.Exchange(r.Context(), r.URL.Query().Get("code"), nonceCookie.Value, pkceCookie.Value)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "OIDC exchange failed")
		return
	}
	if claims.Email == "" {
		writeError(w, http.StatusBadRequest, "OIDC provider returned no email")
		return
	}

	u, err := s.users.UpsertOIDC(r.Context(), s.oidc.Issuer(), claims.Subject,
		strings.ToLower(claims.Email), claims.DisplayName, claims.IsAdmin)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to provision user")
		return
	}

	// Clear flow cookies and start the session.
	s.clearFlowCookie(w, oidcStateCookie)
	s.clearFlowCookie(w, oidcNonceCookie)
	s.clearFlowCookie(w, oidcPKCECookie)
	if err := s.sessions.Issue(w, u.ID, u.TokenVersion); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start session")
		return
	}
	http.Redirect(w, r, s.frontendURL(), http.StatusFound)
}

// --- local file download (signed token) ----------------------------------

func (s *Server) handleLocalFile(w http.ResponseWriter, r *http.Request) {
	local, ok := s.store.(*storage.LocalStorage)
	if !ok {
		http.NotFound(w, r)
		return
	}
	key, err := local.VerifyToken(chi.URLParam(r, "token"))
	if err != nil {
		writeError(w, http.StatusForbidden, "invalid or expired link")
		return
	}
	rc, err := local.Get(r.Context(), key)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer rc.Close()

	// Optional friendly download name (e.g. "Movie.srt"). Only affects the saved
	// filename, so it doesn't need to be signed; sanitize to strip any path and
	// quotes before putting it in the header.
	if raw := r.URL.Query().Get("name"); raw != "" {
		name := strings.ReplaceAll(sanitizeFilename(raw), "\"", "")
		w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
	}

	// Serve with range support when possible.
	if rs, ok := rc.(io.ReadSeeker); ok {
		http.ServeContent(w, r, key, time.Time{}, rs)
		return
	}
	_, _ = io.Copy(w, rc)
}

// --- helpers -------------------------------------------------------------

func (s *Server) setFlowCookie(w http.ResponseWriter, name, value string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/api/auth/oidc",
		HttpOnly: true,
		Secure:   s.cfg.SessionCookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(oidcFlowTTL.Seconds()),
	})
}

func (s *Server) clearFlowCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: "", Path: "/api/auth/oidc",
		HttpOnly: true, Secure: s.cfg.SessionCookieSecure,
		SameSite: http.SameSiteLaxMode, MaxAge: -1,
	})
}

// frontendURL is where users land after an OIDC login completes.
func (s *Server) frontendURL() string {
	if len(s.cfg.CORSOrigins) > 0 && s.cfg.CORSOrigins[0] != "" {
		return s.cfg.CORSOrigins[0]
	}
	return s.cfg.PublicURL
}

func randomToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

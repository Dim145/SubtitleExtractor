package httpapi

import (
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
	if err := s.sessions.Issue(w, u.ID); err != nil {
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
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	ok, err := auth.VerifyPassword(body.Password, *u.PasswordHash)
	if err != nil || !ok {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err := s.sessions.Issue(w, u.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start session")
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
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
	if err := s.sessions.Issue(w, u.ID); err != nil {
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

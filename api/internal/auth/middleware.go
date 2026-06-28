package auth

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"

	"subtitleextractor/internal/users"
)

type ctxKey int

const userCtxKey ctxKey = iota

// Authenticator validates session cookies and loads the user.
type Authenticator struct {
	sessions *SessionManager
	users    *users.Repo
}

// NewAuthenticator wires the session manager and user repo together.
func NewAuthenticator(sessions *SessionManager, repo *users.Repo) *Authenticator {
	return &Authenticator{sessions: sessions, users: repo}
}

// RequireAuth rejects unauthenticated requests; on success the user is in context.
func (a *Authenticator) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(SessionCookieName)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		userID, err := a.sessions.Parse(cookie.Value)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		u, err := a.users.GetByID(r.Context(), userID)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userCtxKey, u)))
	})
}

// UserFromContext returns the authenticated user, or nil.
func UserFromContext(ctx context.Context) *users.User {
	u, _ := ctx.Value(userCtxKey).(*users.User)
	return u
}

// RequireAdmin rejects non-admin requests. Must run after RequireAuth.
func (a *Authenticator) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := UserFromContext(r.Context())
		if u == nil || !u.IsAdmin {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireInternal guards the /internal/* worker endpoints with a shared bearer token.
func RequireInternal(token string) func(http.Handler) http.Handler {
	want := []byte("Bearer " + token)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := r.Header.Get("Authorization")
			if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(got)), want) != 1 {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

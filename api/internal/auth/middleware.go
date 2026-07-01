package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"strings"

	"subtitleextractor/internal/users"
	"subtitleextractor/internal/workers"
)

type ctxKey int

const (
	userCtxKey ctxKey = iota
	workerCtxKey
)

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
		userID, tokenVersion, err := a.sessions.Parse(cookie.Value)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		u, err := a.users.GetByID(r.Context(), userID)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// Reject tokens whose version is stale (logout / password change bumped it).
		if tokenVersion != u.TokenVersion {
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

// RequireInternal guards the enrollment endpoint (and /metrics) with the shared
// bootstrap bearer token. It is NO LONGER accepted on the per-job worker
// protocol routes, which use RequireWorkerToken instead.
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

// HashWorkerToken returns the lowercase hex SHA-256 of a per-worker token. The
// same function is used at enrollment (to store the hash) and on every request
// (to look the worker up), so the two always agree.
func HashWorkerToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// workerTokenFromRequest extracts the presented per-worker token from either
// the X-Worker-Token header or an Authorization: Bearer header.
func workerTokenFromRequest(r *http.Request) string {
	if t := strings.TrimSpace(r.Header.Get("X-Worker-Token")); t != "" {
		return t
	}
	if a := strings.TrimSpace(r.Header.Get("Authorization")); a != "" {
		if rest, ok := strings.CutPrefix(a, "Bearer "); ok {
			return strings.TrimSpace(rest)
		}
	}
	return ""
}

// RequireWorkerToken authenticates a worker by its per-worker token: it hashes
// the presented token, looks up the owning worker, and puts that resolved
// identity into the request context. Rejects 401 when no worker owns the token
// (unknown or rotated). This replaces trusting a client-set X-Worker-Id — the
// identity is derived from the secret, not claimed by the caller.
func RequireWorkerToken(repo *workers.Repo) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tok := workerTokenFromRequest(r)
			if tok == "" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			wk, err := repo.GetByTokenHash(r.Context(), HashWorkerToken(tok))
			if err != nil {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), workerCtxKey, wk)))
		})
	}
}

// WorkerFromContext returns the worker resolved by RequireWorkerToken, or nil.
func WorkerFromContext(ctx context.Context) *workers.Worker {
	wk, _ := ctx.Value(workerCtxKey).(*workers.Worker)
	return wk
}

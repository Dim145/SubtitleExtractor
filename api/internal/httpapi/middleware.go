package httpapi

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// sameOriginGuard is an Origin/Referer-check CSRF defense for the
// cookie-authenticated API. State-changing requests (POST/PUT/PATCH/DELETE)
// must carry an Origin (or, failing that, Referer) whose host matches the app's
// own origin or an allowed CORS origin. Safe methods and requests without a
// browser-set Origin/Referer (e.g. server-to-server, curl) are left alone — the
// goal is to stop a malicious site from riding the user's session cookie.
func (s *Server) sameOriginGuard(next http.Handler) http.Handler {
	allowed := map[string]bool{}
	if h := originHost(s.cfg.PublicURL); h != "" {
		allowed[h] = true
	}
	for _, o := range s.cfg.CORSOrigins {
		if h := originHost(o); h != "" {
			allowed[h] = true
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		src := r.Header.Get("Origin")
		if src == "" {
			src = r.Header.Get("Referer")
		}
		if src != "" {
			// Allow when the Origin/Referer host matches the request's own Host
			// (true same-origin — the single-origin nginx deployment, needs no
			// config) or an explicitly configured public/CORS origin.
			h := originHost(src)
			if h == "" || (h != strings.ToLower(r.Host) && !allowed[h]) {
				writeError(w, http.StatusForbidden, "cross-origin request rejected")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// originHost extracts the host:port (lowercased) from an origin/referer URL.
func originHost(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Host)
}

// jsonLogger emits one structured (JSON) access-log line per request, including
// the chi request id. The token in /api/files/{token} URLs and any query string
// are redacted so signed download URLs never land in logs.
func jsonLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		entry := map[string]any{
			"requestId": middleware.GetReqID(r.Context()),
			"method":    r.Method,
			"path":      redactPath(r.URL.Path),
			"status":    ww.Status(),
			"bytes":     ww.BytesWritten(),
			"durationMs": time.Since(start).Milliseconds(),
			"remoteIp":  r.RemoteAddr,
		}
		if b, err := json.Marshal(entry); err == nil {
			log.Println(string(b))
		}
	})
}

// redactPath masks the signed token segment of /api/files/{token} so secrets in
// download URLs don't leak into access logs. Query strings are dropped entirely.
func redactPath(path string) string {
	const prefix = "/api/files/"
	if strings.HasPrefix(path, prefix) {
		return prefix + "[redacted]"
	}
	return path
}

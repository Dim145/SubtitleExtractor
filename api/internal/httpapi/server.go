// Package httpapi builds the HTTP router and request handlers.
package httpapi

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/go-chi/httprate"
	"github.com/jackc/pgx/v5/pgxpool"

	"subtitleextractor/internal/audit"
	"subtitleextractor/internal/auth"
	"subtitleextractor/internal/config"
	"subtitleextractor/internal/events"
	"subtitleextractor/internal/jobs"
	"subtitleextractor/internal/settings"
	"subtitleextractor/internal/storage"
	"subtitleextractor/internal/users"
	"subtitleextractor/internal/workers"
)

// maxSSEPerUser caps the number of concurrent event streams a single user may
// hold open, so a client can't exhaust connections by opening many SSE requests.
const maxSSEPerUser = 8

// Server holds the handler dependencies.
type Server struct {
	cfg      *config.Config
	pool     *pgxpool.Pool
	users    *users.Repo
	jobs     *jobs.Repo
	settings *settings.Repo
	workers  *workers.Repo
	audit    *audit.Repo
	sessions *auth.SessionManager
	authn    *auth.Authenticator
	oidc     *auth.OIDC // nil when OIDC is disabled
	store    storage.Storage
	hub      *events.Hub
	cleaner  *VideoCleaner // set post-construction; nil until StartVideoCleaner
	metrics  *metrics

	sseMu     sync.Mutex
	sseByUser map[string]int // active SSE streams per user id
}

// SetVideoCleaner attaches the retention cleaner so admin endpoints can trigger
// runs and read their history.
func (s *Server) SetVideoCleaner(vc *VideoCleaner) { s.cleaner = vc }

// NewServer constructs the server with its dependencies.
func NewServer(cfg *config.Config, pool *pgxpool.Pool, repo *users.Repo, jobRepo *jobs.Repo, settingsRepo *settings.Repo,
	workerRepo *workers.Repo, auditRepo *audit.Repo, sessions *auth.SessionManager, authn *auth.Authenticator,
	oidc *auth.OIDC, store storage.Storage) *Server {
	return &Server{
		cfg: cfg, pool: pool, users: repo, jobs: jobRepo, settings: settingsRepo, workers: workerRepo,
		audit: auditRepo, sessions: sessions, authn: authn, oidc: oidc, store: store, hub: events.NewHub(),
		sseByUser: map[string]int{}, metrics: newMetrics(),
	}
}

// StartMetrics begins the periodic refresh of the job-count and workers-online
// gauges. Safe to call once after construction; the goroutine stops on ctx.
func (s *Server) StartMetrics(ctx context.Context, logf func(string, ...any)) {
	s.metrics.startRefresher(ctx, s.pool, 90*time.Second, logf)
}

// Router builds the chi router with all routes mounted.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(jsonLogger)
	r.Use(middleware.Recoverer)
	r.Use(s.metrics.middleware)

	if len(s.cfg.CORSOrigins) > 0 {
		r.Use(cors.Handler(cors.Options{
			AllowedOrigins:   s.cfg.CORSOrigins,
			AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
			AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
			AllowCredentials: true,
			MaxAge:           300,
		}))
	}

	r.Get("/healthz", s.handleHealth)
	r.Get("/readyz", s.handleReady)

	// Prometheus metrics, gated behind the bootstrap internal token so scrape
	// access is a shared secret rather than world-readable.
	r.With(auth.RequireInternal(s.cfg.InternalAPIToken)).Handle("/metrics", s.metrics.handler())

	r.Route("/api", func(r chi.Router) {
		r.Route("/auth", func(r chi.Router) {
			r.Get("/config", s.handleAuthConfig)
			// Throttle credential endpoints per client IP to blunt brute-force /
			// account-enumeration attempts. RealIP (above) normalizes RemoteAddr
			// from X-Forwarded-For/X-Real-IP, so LimitByIP keys off the true client.
			authLimit := httprate.LimitByIP(10, time.Minute)
			r.With(authLimit).Post("/register", s.handleRegister)
			r.With(authLimit).Post("/login", s.handleLogin)
			r.Post("/logout", s.handleLogout)
			r.With(s.authn.RequireAuth).Get("/me", s.handleMe)
			r.With(s.authn.RequireAuth).Patch("/me", s.handleUpdateProfile)

			if s.oidc != nil {
				r.Get("/oidc/login", s.handleOIDCLogin)
				r.Get("/oidc/callback", s.handleOIDCCallback)
			}
		})

		// Per-user (falling back to per-IP) rate limit for the upload endpoint, to
		// bound how fast a single account/client can enqueue expensive jobs.
		uploadLimit := httprate.Limit(20, time.Minute, httprate.WithKeyFuncs(func(r *http.Request) (string, error) {
			if u := auth.UserFromContext(r.Context()); u != nil {
				return "u:" + u.ID, nil
			}
			return httprate.KeyByIP(r)
		}))

		// Authenticated job endpoints. The Origin/Referer CSRF guard protects the
		// cookie-authenticated mutating routes.
		r.Group(func(r chi.Router) {
			r.Use(s.authn.RequireAuth)
			r.Use(s.sameOriginGuard)
			r.Get("/workers/availability", s.handleWorkerAvailability)
			r.With(uploadLimit).Post("/jobs", s.handleCreateJob)
			r.Get("/jobs", s.handleListJobs)
			r.Get("/jobs/{id}", s.handleGetJob)
			r.Post("/jobs/{id}/cancel", s.handleCancelJob)
			r.Post("/jobs/{id}/rerun", s.handleRerunJob)
			r.Delete("/jobs/{id}", s.handleDeleteJob)
			r.Delete("/jobs/{id}/video", s.handleDeleteVideo)
			r.Get("/jobs/{id}/logs", s.handleJobLogs)
			r.Get("/jobs/{id}/results", s.handleJobResults)
			r.Post("/jobs/{id}/results", s.handleSaveResult)
			r.Delete("/jobs/{id}/results/{resultId}", s.handleDeleteResult)
			r.Get("/jobs/{id}/results/{resultId}/download", s.handleDownloadResult)
			r.Get("/jobs/{id}/video", s.handleJobVideo)
			r.Get("/jobs/{id}/video/raw", s.handleVideoStream)
			r.Get("/jobs/{id}/events", s.handleJobEvents)
		})

		// Admin endpoints — authenticated + admin only.
		r.Group(func(r chi.Router) {
			r.Use(s.authn.RequireAuth, s.authn.RequireAdmin, s.sameOriginGuard)
			r.Get("/admin/users", s.handleAdminListUsers)
			r.Post("/admin/users", s.handleAdminCreateUser)
			r.Patch("/admin/users/{id}", s.handleAdminPatchUser)
			r.Delete("/admin/users/{id}", s.handleAdminDeleteUser)
			r.Get("/admin/settings", s.handleAdminGetSettings)
			r.Put("/admin/settings", s.handleAdminPutSettings)
			r.Post("/admin/video-cleanup/run", s.handleAdminRunCleanup)
			r.Get("/admin/video-cleanup/runs", s.handleAdminListCleanupRuns)
			r.Get("/admin/workers", s.handleAdminListWorkers)
			r.Patch("/admin/workers/{id}", s.handleAdminPatchWorker)
			r.Delete("/admin/workers/{id}", s.handleAdminDeleteWorker)
		})

		// Worker protocol. Enrollment is guarded by the shared bootstrap token and
		// issues a per-worker token; every other route is guarded by that
		// per-worker token, which also resolves the worker's identity (the shared
		// bootstrap token is NO LONGER accepted on the job routes).
		r.Route("/internal", func(r chi.Router) {
			r.With(auth.RequireInternal(s.cfg.InternalAPIToken)).
				Post("/workers/enroll", s.handleWorkerEnroll)

			r.Group(func(r chi.Router) {
				r.Use(auth.RequireWorkerToken(s.workers))
				r.Post("/workers/heartbeat", s.handleWorkerHeartbeat)
				r.Post("/jobs/claim", s.handleClaim)
				r.Post("/jobs/{id}/progress", s.handleProgress)
				r.Post("/jobs/{id}/heartbeat", s.handleHeartbeat)
				r.Post("/jobs/{id}/log", s.handleInternalLog)
				r.Put("/jobs/{id}/result", s.handleResult)
				r.Post("/jobs/{id}/complete", s.handleComplete)
			})
		})

		// Local-storage signed download URLs resolve here.
		r.Get("/files/{token}", s.handleLocalFile)
	})

	return r
}

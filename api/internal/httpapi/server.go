// Package httpapi builds the HTTP router and request handlers.
package httpapi

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/go-chi/httprate"

	"subtitleextractor/internal/auth"
	"subtitleextractor/internal/config"
	"subtitleextractor/internal/events"
	"subtitleextractor/internal/jobs"
	"subtitleextractor/internal/settings"
	"subtitleextractor/internal/storage"
	"subtitleextractor/internal/users"
	"subtitleextractor/internal/workers"
)

// Server holds the handler dependencies.
type Server struct {
	cfg      *config.Config
	users    *users.Repo
	jobs     *jobs.Repo
	settings *settings.Repo
	workers  *workers.Repo
	sessions *auth.SessionManager
	authn    *auth.Authenticator
	oidc     *auth.OIDC // nil when OIDC is disabled
	store    storage.Storage
	hub      *events.Hub
	cleaner  *VideoCleaner // set post-construction; nil until StartVideoCleaner
}

// SetVideoCleaner attaches the retention cleaner so admin endpoints can trigger
// runs and read their history.
func (s *Server) SetVideoCleaner(vc *VideoCleaner) { s.cleaner = vc }

// NewServer constructs the server with its dependencies.
func NewServer(cfg *config.Config, repo *users.Repo, jobRepo *jobs.Repo, settingsRepo *settings.Repo,
	workerRepo *workers.Repo, sessions *auth.SessionManager, authn *auth.Authenticator,
	oidc *auth.OIDC, store storage.Storage) *Server {
	return &Server{
		cfg: cfg, users: repo, jobs: jobRepo, settings: settingsRepo, workers: workerRepo,
		sessions: sessions, authn: authn, oidc: oidc, store: store, hub: events.NewHub(),
	}
}

// Router builds the chi router with all routes mounted.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

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

		// Authenticated job endpoints.
		r.Group(func(r chi.Router) {
			r.Use(s.authn.RequireAuth)
			r.Get("/workers/availability", s.handleWorkerAvailability)
			r.Post("/jobs", s.handleCreateJob)
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
			r.Use(s.authn.RequireAuth, s.authn.RequireAdmin)
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

		// Worker protocol — guarded by the shared internal bearer token.
		r.Route("/internal", func(r chi.Router) {
			r.Use(auth.RequireInternal(s.cfg.InternalAPIToken))
			r.Post("/workers/heartbeat", s.handleWorkerHeartbeat)
			r.Post("/jobs/claim", s.handleClaim)
			r.Post("/jobs/{id}/progress", s.handleProgress)
			r.Post("/jobs/{id}/heartbeat", s.handleHeartbeat)
			r.Post("/jobs/{id}/log", s.handleInternalLog)
			r.Put("/jobs/{id}/result", s.handleResult)
			r.Post("/jobs/{id}/complete", s.handleComplete)
		})

		// Local-storage signed download URLs resolve here.
		r.Get("/files/{token}", s.handleLocalFile)
	})

	return r
}

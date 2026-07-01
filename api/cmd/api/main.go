// Command api is the SubtitleExtractor control-plane HTTP service.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"subtitleextractor/internal/audit"
	"subtitleextractor/internal/auth"
	"subtitleextractor/internal/cleanup"
	"subtitleextractor/internal/config"
	"subtitleextractor/internal/db"
	"subtitleextractor/internal/httpapi"
	"subtitleextractor/internal/jobs"
	"subtitleextractor/internal/settings"
	"subtitleextractor/internal/storage"
	"subtitleextractor/internal/users"
	"subtitleextractor/internal/workers"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("fatal: %v", err)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	// Root context canceled on SIGINT/SIGTERM; background goroutines observe it.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	log.Println("connected to database")

	if err := db.Migrate(ctx, pool); err != nil {
		return err
	}
	log.Println("migrations applied")

	store, err := storage.New(cfg.Storage, cfg.PublicURL, cfg.JWTSigningKey)
	if err != nil {
		return err
	}
	log.Printf("storage backend: %s", cfg.Storage.Backend)

	userRepo := users.NewRepo(pool)
	jobRepo := jobs.NewRepo(pool)
	settingsRepo := settings.NewRepo(pool)
	workerRepo := workers.NewRepo(pool)
	auditRepo := audit.NewRepo(pool)
	sessions := auth.NewSessionManager(cfg.JWTSigningKey, cfg.SessionTTL, cfg.SessionCookieSecure)
	authn := auth.NewAuthenticator(sessions, userRepo)

	var oidcProvider *auth.OIDC
	if cfg.Auth.OIDCEnabled {
		oidcProvider, err = auth.NewOIDC(ctx, cfg.Auth)
		if err != nil {
			return err
		}
		log.Printf("OIDC enabled (issuer: %s)", cfg.Auth.OIDCIssuerURL)
	}

	srv := httpapi.NewServer(cfg, pool, userRepo, jobRepo, settingsRepo, workerRepo, auditRepo, sessions, authn, oidcProvider, store)

	// Re-queue jobs whose worker stopped heart-beating.
	httpapi.StartStaleRequeuer(ctx, jobRepo, workerRepo, cfg.WorkerHeartbeatTimeout, log.Printf)

	// Delete source videos past the admin-configured retention window.
	cleanupRepo := cleanup.NewRepo(pool)
	srv.SetVideoCleaner(httpapi.StartVideoCleaner(ctx, jobRepo, settingsRepo, cleanupRepo, store, log.Printf))

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Graceful shutdown: when the root context is canceled (SIGINT/SIGTERM),
	// stop accepting requests and drain in-flight ones. The background goroutines
	// (requeuer, cleaner) observe the same ctx.Done() and return, after which the
	// deferred pool.Close() is safe.
	go func() {
		<-ctx.Done()
		log.Println("shutting down...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	log.Printf("listening on %s", cfg.HTTPAddr)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

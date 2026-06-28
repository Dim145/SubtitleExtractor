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

	"subtitleextractor/internal/auth"
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

	ctx := context.Background()

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

	srv := httpapi.NewServer(cfg, userRepo, jobRepo, settingsRepo, workerRepo, sessions, authn, oidcProvider, store)

	// Re-queue jobs whose worker stopped heart-beating.
	httpapi.StartStaleRequeuer(ctx, jobRepo, workerRepo, cfg.WorkerHeartbeatTimeout, log.Printf)

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Graceful shutdown on SIGINT/SIGTERM.
	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
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

// Package config loads all runtime configuration from environment variables.
package config

import (
	"errors"
	"log"
	"strings"
	"time"

	"github.com/caarlos0/env/v11"
)

// Placeholder secrets shipped in .env.example. The service refuses to start if
// any of these is used verbatim, so a forgotten copy-paste cannot ship to prod.
const (
	placeholderJWTSigningKey = "change-me-please-32-bytes-minimum-secret"
	placeholderInternalToken = "change-me-internal-worker-token"
)

// Config is the fully-resolved application configuration.
type Config struct {
	HTTPAddr    string   `env:"API_HTTP_ADDR" envDefault:":8080"`
	PublicURL   string   `env:"API_PUBLIC_URL" envDefault:"http://localhost:8080"`
	CORSOrigins []string `env:"API_CORS_ORIGINS" envSeparator:","`

	DatabaseURL string `env:"DATABASE_URL,required"`

	JWTSigningKey string        `env:"JWT_SIGNING_KEY,required"`
	SessionTTL    time.Duration `env:"SESSION_TTL" envDefault:"24h"`
	// SessionCookieSecureOverride is the raw env override (nil = unset). When
	// unset, SessionCookieSecure is derived from whether the deployment is HTTPS.
	SessionCookieSecureOverride *bool `env:"SESSION_COOKIE_SECURE"`
	// SessionCookieSecure is the resolved Secure-flag value used by handlers.
	SessionCookieSecure bool `env:"-"`

	Auth    AuthConfig
	Storage StorageConfig

	InternalAPIToken       string        `env:"INTERNAL_API_TOKEN,required"`
	WorkerHeartbeatTimeout time.Duration `env:"WORKER_HEARTBEAT_TIMEOUT" envDefault:"2m"`
}

// AuthConfig controls the available authentication methods.
type AuthConfig struct {
	LocalEnabled             bool `env:"AUTH_LOCAL_ENABLED" envDefault:"true"`
	LocalRegistrationEnabled bool `env:"AUTH_LOCAL_REGISTRATION_ENABLED" envDefault:"true"`

	OIDCEnabled         bool     `env:"AUTH_OIDC_ENABLED" envDefault:"false"`
	OIDCIssuerURL       string   `env:"OIDC_ISSUER_URL"`
	OIDCClientID        string   `env:"OIDC_CLIENT_ID"`
	OIDCClientSecret    string   `env:"OIDC_CLIENT_SECRET"`
	OIDCRedirectURL     string   `env:"OIDC_REDIRECT_URL"`
	OIDCScopes          []string `env:"OIDC_SCOPES" envSeparator:"," envDefault:"openid,email,profile"`
	OIDCAdminClaim      string   `env:"OIDC_ADMIN_CLAIM"`
	OIDCAdminClaimValue string   `env:"OIDC_ADMIN_CLAIM_VALUE"`
}

// StorageConfig selects and configures the blob storage backend.
type StorageConfig struct {
	Backend string `env:"STORAGE_BACKEND" envDefault:"local"` // "local" | "s3"

	LocalRoot string `env:"STORAGE_LOCAL_ROOT" envDefault:"/data/blobs"`

	S3Endpoint       string `env:"STORAGE_S3_ENDPOINT"`
	S3Bucket         string `env:"STORAGE_S3_BUCKET"`
	S3Region         string `env:"STORAGE_S3_REGION" envDefault:"us-east-1"`
	S3AccessKey      string `env:"STORAGE_S3_ACCESS_KEY"`
	S3SecretKey      string `env:"STORAGE_S3_SECRET_KEY"`
	S3UseSSL         bool   `env:"STORAGE_S3_USE_SSL" envDefault:"false"`
	S3ForcePathStyle bool   `env:"STORAGE_S3_FORCE_PATH_STYLE" envDefault:"true"`
}

// Load parses the environment into a Config, applying defaults.
func Load() (*Config, error) {
	cfg := &Config{}
	if err := env.Parse(cfg); err != nil {
		return nil, err
	}

	// Refuse to boot with the placeholder secrets from .env.example: shipping
	// these to a real deployment would hand out forgeable sessions and let
	// anyone hit the worker-internal API.
	if cfg.JWTSigningKey == placeholderJWTSigningKey {
		return nil, errors.New("JWT_SIGNING_KEY is still the .env.example placeholder; set a real secret (e.g. `openssl rand -hex 32`)")
	}
	if cfg.InternalAPIToken == placeholderInternalToken {
		return nil, errors.New("INTERNAL_API_TOKEN is still the .env.example placeholder; set a real secret (e.g. `openssl rand -hex 32`)")
	}
	if len(cfg.JWTSigningKey) < 32 {
		log.Printf("WARNING: JWT_SIGNING_KEY is shorter than 32 bytes (%d); use at least 32 bytes (e.g. `openssl rand -hex 32`)", len(cfg.JWTSigningKey))
	}

	// Resolve the session-cookie Secure flag: honor an explicit override,
	// otherwise auto-enable when the deployment is served over HTTPS so dev on
	// http://localhost still works without config.
	if cfg.SessionCookieSecureOverride != nil {
		cfg.SessionCookieSecure = *cfg.SessionCookieSecureOverride
	} else {
		cfg.SessionCookieSecure = cfg.isHTTPS()
	}

	return cfg, nil
}

// isHTTPS reports whether the public deployment URL (or, failing that, the
// first configured CORS origin) is served over HTTPS.
func (c *Config) isHTTPS() bool {
	if strings.HasPrefix(strings.ToLower(c.PublicURL), "https://") {
		return true
	}
	if len(c.CORSOrigins) > 0 && strings.HasPrefix(strings.ToLower(c.CORSOrigins[0]), "https://") {
		return true
	}
	return false
}

// Package config loads all runtime configuration from environment variables.
package config

import (
	"time"

	"github.com/caarlos0/env/v11"
)

// Config is the fully-resolved application configuration.
type Config struct {
	HTTPAddr    string   `env:"API_HTTP_ADDR" envDefault:":8080"`
	PublicURL   string   `env:"API_PUBLIC_URL" envDefault:"http://localhost:8080"`
	CORSOrigins []string `env:"API_CORS_ORIGINS" envSeparator:","`

	DatabaseURL string `env:"DATABASE_URL,required"`

	JWTSigningKey       string        `env:"JWT_SIGNING_KEY,required"`
	SessionTTL          time.Duration `env:"SESSION_TTL" envDefault:"24h"`
	SessionCookieSecure bool          `env:"SESSION_COOKIE_SECURE" envDefault:"false"`

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
	return cfg, nil
}

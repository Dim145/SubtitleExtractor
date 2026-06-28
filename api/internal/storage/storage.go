// Package storage abstracts blob storage behind a single interface with two
// backends — local filesystem and S3-compatible (MinIO/R2/AWS) — selected by env.
package storage

import (
	"context"
	"fmt"
	"io"
	"time"

	"subtitleextractor/internal/config"
)

// Blob is metadata about a stored object.
type Blob struct {
	Key         string
	ContentType string
	Size        int64
}

// Storage is the backend-agnostic blob store contract.
type Storage interface {
	// Put stores r under key. size may be -1 if unknown (S3 streams in that case).
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
	Stat(ctx context.Context, key string) (Blob, error)
	// PresignGet returns a time-limited download URL. For the local backend this
	// is an API-served /api/files/{token} URL; for S3 it is a real presigned URL.
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
}

// New constructs the configured storage backend.
//
// publicURL and tokenSecret are only used by the local backend to mint and
// later verify signed download URLs.
func New(cfg config.StorageConfig, publicURL, tokenSecret string) (Storage, error) {
	switch cfg.Backend {
	case "local", "":
		return NewLocal(cfg.LocalRoot, publicURL, []byte(tokenSecret))
	case "s3":
		return NewS3(cfg)
	default:
		return nil, fmt.Errorf("unknown STORAGE_BACKEND %q (expected \"local\" or \"s3\")", cfg.Backend)
	}
}

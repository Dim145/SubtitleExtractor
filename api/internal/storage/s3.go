package storage

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"subtitleextractor/internal/config"
)

// S3Storage is an S3-compatible backend (AWS S3, MinIO, Cloudflare R2, ...).
type S3Storage struct {
	client *minio.Client
	bucket string
}

// NewS3 builds an S3-compatible client from config and ensures the bucket exists.
func NewS3(cfg config.StorageConfig) (*S3Storage, error) {
	endpoint := cfg.S3Endpoint
	// minio-go wants a bare host:port, not a scheme.
	if u, err := url.Parse(cfg.S3Endpoint); err == nil && u.Host != "" {
		endpoint = u.Host
	}

	client, err := minio.New(endpoint, &minio.Options{
		Creds:        credentials.NewStaticV4(cfg.S3AccessKey, cfg.S3SecretKey, ""),
		Secure:       cfg.S3UseSSL,
		Region:       cfg.S3Region,
		BucketLookup: bucketLookup(cfg.S3ForcePathStyle),
	})
	if err != nil {
		return nil, fmt.Errorf("init s3 client: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	exists, err := client.BucketExists(ctx, cfg.S3Bucket)
	if err != nil {
		return nil, fmt.Errorf("check bucket: %w", err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, cfg.S3Bucket, minio.MakeBucketOptions{Region: cfg.S3Region}); err != nil {
			return nil, fmt.Errorf("create bucket %q: %w", cfg.S3Bucket, err)
		}
	}

	return &S3Storage{client: client, bucket: cfg.S3Bucket}, nil
}

func bucketLookup(forcePathStyle bool) minio.BucketLookupType {
	if forcePathStyle {
		return minio.BucketLookupPath
	}
	return minio.BucketLookupAuto
}

func (s *S3Storage) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	_, err := s.client.PutObject(ctx, s.bucket, key, r, size, minio.PutObjectOptions{ContentType: contentType})
	return err
}

func (s *S3Storage) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	// Surface a missing object as an error eagerly.
	if _, err := obj.Stat(); err != nil {
		obj.Close()
		return nil, err
	}
	return obj, nil
}

func (s *S3Storage) Delete(ctx context.Context, key string) error {
	return s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

func (s *S3Storage) Stat(ctx context.Context, key string) (Blob, error) {
	info, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return Blob{}, err
	}
	return Blob{Key: key, ContentType: info.ContentType, Size: info.Size}, nil
}

func (s *S3Storage) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	u, err := s.client.PresignedGetObject(ctx, s.bucket, key, ttl, url.Values{})
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

package storage

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// LocalStorage stores blobs on the local filesystem. Download URLs are signed,
// expiring tokens served by the API's /api/files/{token} handler.
type LocalStorage struct {
	root      string
	publicURL string
	secret    []byte
}

// NewLocal creates a filesystem-backed store rooted at root.
func NewLocal(root, publicURL string, secret []byte) (*LocalStorage, error) {
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("create storage root: %w", err)
	}
	return &LocalStorage{root: root, publicURL: strings.TrimRight(publicURL, "/"), secret: secret}, nil
}

// path resolves key to an absolute path, guarding against traversal.
func (l *LocalStorage) path(key string) (string, error) {
	clean := filepath.Clean("/" + key) // force-absolute then strip leading slash
	full := filepath.Join(l.root, clean)
	if !strings.HasPrefix(full, filepath.Clean(l.root)+string(os.PathSeparator)) {
		return "", errors.New("invalid storage key")
	}
	return full, nil
}

func (l *LocalStorage) Put(ctx context.Context, key string, r io.Reader, _ int64, _ string) error {
	full, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		return err
	}
	f, err := os.Create(full)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := io.Copy(f, r); err != nil {
		return err
	}
	return f.Sync()
}

func (l *LocalStorage) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	full, err := l.path(key)
	if err != nil {
		return nil, err
	}
	return os.Open(full)
}

func (l *LocalStorage) Delete(ctx context.Context, key string) error {
	full, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(full); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Best-effort: prune the now-empty parent dir (e.g. results/<jobID>/).
	_ = os.Remove(filepath.Dir(full))
	return nil
}

func (l *LocalStorage) Stat(ctx context.Context, key string) (Blob, error) {
	full, err := l.path(key)
	if err != nil {
		return Blob{}, err
	}
	fi, err := os.Stat(full)
	if err != nil {
		return Blob{}, err
	}
	return Blob{Key: key, Size: fi.Size()}, nil
}

// PresignGet returns a signed, expiring URL handled by the /api/files/ route.
func (l *LocalStorage) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	exp := time.Now().Add(ttl).Unix()
	token := l.signToken(key, exp)
	return fmt.Sprintf("%s/api/files/%s", l.publicURL, token), nil
}

// signToken builds base64("key:exp:hmac").
func (l *LocalStorage) signToken(key string, exp int64) string {
	payload := fmt.Sprintf("%s:%d", key, exp)
	mac := hmac.New(sha256.New, l.secret)
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return base64.RawURLEncoding.EncodeToString([]byte(payload + ":" + sig))
}

// VerifyToken validates a token produced by signToken and returns the storage key.
func (l *LocalStorage) VerifyToken(token string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return "", errors.New("malformed token")
	}
	parts := strings.Split(string(raw), ":")
	if len(parts) != 3 {
		return "", errors.New("malformed token")
	}
	key, expStr, sig := parts[0], parts[1], parts[2]
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil {
		return "", errors.New("malformed token")
	}
	if time.Now().Unix() > exp {
		return "", errors.New("token expired")
	}
	expected := l.signToken(key, exp)
	// Re-decode expected to compare just the signature segment safely.
	rawExpected, _ := base64.RawURLEncoding.DecodeString(expected)
	expectedSig := strings.Split(string(rawExpected), ":")[2]
	if !hmac.Equal([]byte(sig), []byte(expectedSig)) {
		return "", errors.New("bad signature")
	}
	return key, nil
}

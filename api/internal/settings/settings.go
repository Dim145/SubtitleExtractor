// Package settings holds DB-backed, admin-editable site settings (single row).
package settings

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Settings is the site-wide configuration.
type Settings struct {
	RegistrationEnabled  bool            `json:"registrationEnabled"`
	DefaultOCRBackend    string          `json:"defaultOcrBackend"`
	DefaultFPS           float64         `json:"defaultFps"`
	DefaultMinConfidence float64         `json:"defaultMinConfidence"`
	WorkerDefaults       json.RawMessage `json:"workerDefaults"`
}

type Repo struct {
	pool *pgxpool.Pool
}

func NewRepo(pool *pgxpool.Pool) *Repo { return &Repo{pool: pool} }

// Get returns the current settings row.
func (r *Repo) Get(ctx context.Context) (*Settings, error) {
	var s Settings
	err := r.pool.QueryRow(ctx, `
		SELECT registration_enabled, default_ocr_backend, default_fps,
		       default_min_confidence, worker_defaults
		FROM app_settings WHERE id = 1`).
		Scan(&s.RegistrationEnabled, &s.DefaultOCRBackend, &s.DefaultFPS,
			&s.DefaultMinConfidence, &s.WorkerDefaults)
	if err != nil {
		return nil, err
	}
	if len(s.WorkerDefaults) == 0 {
		s.WorkerDefaults = json.RawMessage(`{}`)
	}
	return &s, nil
}

// Update writes all settings fields.
func (r *Repo) Update(ctx context.Context, s *Settings) error {
	wd := s.WorkerDefaults
	if len(wd) == 0 {
		wd = json.RawMessage(`{}`)
	}
	_, err := r.pool.Exec(ctx, `
		UPDATE app_settings SET
			registration_enabled = $1,
			default_ocr_backend = $2,
			default_fps = $3,
			default_min_confidence = $4,
			worker_defaults = $5,
			updated_at = now()
		WHERE id = 1`,
		s.RegistrationEnabled, s.DefaultOCRBackend, s.DefaultFPS, s.DefaultMinConfidence, wd)
	return err
}

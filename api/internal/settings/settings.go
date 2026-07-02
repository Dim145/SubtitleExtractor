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
	// OCRSubstitutionRules is a JSON array of {find, replace, isRegex, applyTo}
	// applied by workers to cue text after merging (global, inter-worker).
	OCRSubstitutionRules json.RawMessage `json:"ocrSubstitutionRules"`
	// Video retention: a cron-scheduled job deletes source videos older than the
	// retention window. Subtitles and job rows are kept.
	VideoCleanupEnabled bool   `json:"videoCleanupEnabled"`
	VideoRetentionDays  int    `json:"videoRetentionDays"`
	VideoCleanupCron    string `json:"videoCleanupCron"`
	// Storage quotas (optional, disabled by default). When enabled, uploads are
	// blocked once a user's currently-stored bytes would exceed their effective
	// limit. StorageQuotaDefaultBytes is the fallback limit; 0 = unlimited.
	StorageQuotaEnabled      bool  `json:"storageQuotaEnabled"`
	StorageQuotaDefaultBytes int64 `json:"storageQuotaDefaultBytes"`
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
		       default_min_confidence, worker_defaults, ocr_substitution_rules,
		       video_cleanup_enabled, video_retention_days, video_cleanup_cron,
		       storage_quota_enabled, storage_quota_default_bytes
		FROM app_settings WHERE id = 1`).
		Scan(&s.RegistrationEnabled, &s.DefaultOCRBackend, &s.DefaultFPS,
			&s.DefaultMinConfidence, &s.WorkerDefaults, &s.OCRSubstitutionRules,
			&s.VideoCleanupEnabled, &s.VideoRetentionDays, &s.VideoCleanupCron,
			&s.StorageQuotaEnabled, &s.StorageQuotaDefaultBytes)
	if err != nil {
		return nil, err
	}
	if len(s.WorkerDefaults) == 0 {
		s.WorkerDefaults = json.RawMessage(`{}`)
	}
	if len(s.OCRSubstitutionRules) == 0 {
		s.OCRSubstitutionRules = json.RawMessage(`[]`)
	}
	return &s, nil
}

// Update writes all settings fields.
func (r *Repo) Update(ctx context.Context, s *Settings) error {
	wd := s.WorkerDefaults
	if len(wd) == 0 {
		wd = json.RawMessage(`{}`)
	}
	rules := s.OCRSubstitutionRules
	if len(rules) == 0 {
		rules = json.RawMessage(`[]`)
	}
	days := s.VideoRetentionDays
	if days < 1 {
		days = 1
	}
	cron := s.VideoCleanupCron
	if cron == "" {
		cron = "0 3 * * *"
	}
	quotaDefault := s.StorageQuotaDefaultBytes
	if quotaDefault < 0 {
		quotaDefault = 0
	}
	_, err := r.pool.Exec(ctx, `
		UPDATE app_settings SET
			registration_enabled = $1,
			default_ocr_backend = $2,
			default_fps = $3,
			default_min_confidence = $4,
			worker_defaults = $5,
			ocr_substitution_rules = $6,
			video_cleanup_enabled = $7,
			video_retention_days = $8,
			video_cleanup_cron = $9,
			storage_quota_enabled = $10,
			storage_quota_default_bytes = $11,
			updated_at = now()
		WHERE id = 1`,
		s.RegistrationEnabled, s.DefaultOCRBackend, s.DefaultFPS, s.DefaultMinConfidence, wd, rules,
		s.VideoCleanupEnabled, days, cron, s.StorageQuotaEnabled, quotaDefault)
	return err
}

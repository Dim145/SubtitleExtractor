// Package audit records administrative mutations to an append-only audit_log
// table for accountability (who did what, to which target, when).
package audit

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Repo writes audit-log entries.
type Repo struct {
	pool *pgxpool.Pool
}

// NewRepo wires the repository to the pool.
func NewRepo(pool *pgxpool.Pool) *Repo { return &Repo{pool: pool} }

// Record appends one audit entry. actorID may be empty (recorded as NULL).
// detail is any JSON-serializable value (nil → {}). Failures are returned so
// callers can log them; they should not block the primary mutation.
func (r *Repo) Record(ctx context.Context, actorID, action, target string, detail any) error {
	var detailJSON []byte = []byte(`{}`)
	if detail != nil {
		if b, err := json.Marshal(detail); err == nil {
			detailJSON = b
		}
	}
	var actor any
	if actorID != "" {
		actor = actorID
	}
	_, err := r.pool.Exec(ctx,
		`INSERT INTO audit_log (actor_id, action, target, detail) VALUES ($1,$2,$3,$4)`,
		actor, action, target, detailJSON)
	return err
}

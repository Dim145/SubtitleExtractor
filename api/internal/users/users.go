// Package users holds the user model and its Postgres repository. Both the
// local and OIDC auth flows converge on rows in the users table.
package users

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a lookup matches no user.
var ErrNotFound = errors.New("user not found")

// User mirrors a row in the users table.
type User struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	DisplayName  string    `json:"displayName"`
	Provider     string    `json:"provider"`
	PasswordHash *string   `json:"-"`
	OIDCIssuer   *string   `json:"-"`
	OIDCSubject  *string   `json:"-"`
	IsAdmin      bool      `json:"isAdmin"`
	TokenVersion int       `json:"-"`
	CreatedAt    time.Time `json:"createdAt"`
}

// Repo is the user data-access layer.
type Repo struct {
	pool *pgxpool.Pool
}

// NewRepo wires a repository to the connection pool.
func NewRepo(pool *pgxpool.Pool) *Repo {
	return &Repo{pool: pool}
}

const selectColumns = `id, email, display_name, provider, password_hash, oidc_issuer, oidc_subject, is_admin, token_version, created_at`

func scanUser(row pgx.Row) (*User, error) {
	var u User
	var displayName *string
	err := row.Scan(&u.ID, &u.Email, &displayName, &u.Provider, &u.PasswordHash,
		&u.OIDCIssuer, &u.OIDCSubject, &u.IsAdmin, &u.TokenVersion, &u.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if displayName != nil {
		u.DisplayName = *displayName
	}
	return &u, nil
}

// GetByID looks up a user by primary key.
func (r *Repo) GetByID(ctx context.Context, id string) (*User, error) {
	return scanUser(r.pool.QueryRow(ctx, `SELECT `+selectColumns+` FROM users WHERE id=$1`, id))
}

// GetByEmail looks up a user by email.
func (r *Repo) GetByEmail(ctx context.Context, email string) (*User, error) {
	return scanUser(r.pool.QueryRow(ctx, `SELECT `+selectColumns+` FROM users WHERE email=$1`, email))
}

// CreateLocal inserts a new local (password) account.
func (r *Repo) CreateLocal(ctx context.Context, email, displayName, passwordHash string, isAdmin bool) (*User, error) {
	return scanUser(r.pool.QueryRow(ctx, `
		INSERT INTO users (email, display_name, provider, password_hash, is_admin)
		VALUES ($1, $2, 'local', $3, $4)
		RETURNING `+selectColumns, email, displayName, passwordHash, isAdmin))
}

// UpsertOIDC creates or updates a user identified by (issuer, subject).
func (r *Repo) UpsertOIDC(ctx context.Context, issuer, subject, email, displayName string, isAdmin bool) (*User, error) {
	return scanUser(r.pool.QueryRow(ctx, `
		INSERT INTO users (email, display_name, provider, oidc_issuer, oidc_subject, is_admin)
		VALUES ($1, $2, 'oidc', $3, $4, $5)
		ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE
		SET email = EXCLUDED.email,
		    display_name = EXCLUDED.display_name,
		    is_admin = EXCLUDED.is_admin
		RETURNING `+selectColumns, email, displayName, issuer, subject, isAdmin))
}

// CountAll returns the total number of users (used to bootstrap the first admin).
func (r *Repo) CountAll(ctx context.Context) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

// List returns all users, newest first (admin).
func (r *Repo) List(ctx context.Context) ([]*User, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+selectColumns+` FROM users ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// UpdateProfile changes a user's display name and email (local accounts).
func (r *Repo) UpdateProfile(ctx context.Context, id, displayName, email string) (*User, error) {
	return scanUser(r.pool.QueryRow(ctx, `
		UPDATE users SET display_name=$2, email=$3 WHERE id=$1
		RETURNING `+selectColumns, id, displayName, email))
}

// SetPassword updates a user's password hash (local accounts). Changing the
// password bumps token_version, invalidating any existing session tokens.
func (r *Repo) SetPassword(ctx context.Context, id, passwordHash string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE users SET password_hash=$2, token_version=token_version+1 WHERE id=$1`, id, passwordHash)
	return err
}

// SetAdmin grants or revokes admin on a user.
func (r *Repo) SetAdmin(ctx context.Context, id string, isAdmin bool) error {
	_, err := r.pool.Exec(ctx, `UPDATE users SET is_admin=$2 WHERE id=$1`, id, isAdmin)
	return err
}

// BumpTokenVersion invalidates all existing session tokens for a user (logout).
func (r *Repo) BumpTokenVersion(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx, `UPDATE users SET token_version=token_version+1 WHERE id=$1`, id)
	return err
}

// CountAdmins returns the number of admin users (guards last-admin lockout).
func (r *Repo) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE is_admin=true`).Scan(&n)
	return n, err
}

// Delete removes a user (their jobs cascade).
func (r *Repo) Delete(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, id)
	return err
}

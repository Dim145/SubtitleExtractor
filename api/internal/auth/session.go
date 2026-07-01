package auth

import (
	"errors"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// SessionCookieName is the cookie carrying the signed session token.
const SessionCookieName = "subext_session"

// SessionManager issues and validates JWT session cookies.
type SessionManager struct {
	key    []byte
	ttl    time.Duration
	secure bool
}

// sessionClaims carries the standard registered claims plus a per-user token
// version, so bumping the DB token_version revokes previously issued tokens.
type sessionClaims struct {
	jwt.RegisteredClaims
	TokenVersion int `json:"tv"`
}

// NewSessionManager creates a manager with the given signing key and lifetime.
func NewSessionManager(signingKey string, ttl time.Duration, secure bool) *SessionManager {
	return &SessionManager{key: []byte(signingKey), ttl: ttl, secure: secure}
}

// Issue signs a session for userID (with its current token version) and writes
// it as an httpOnly cookie.
func (s *SessionManager) Issue(w http.ResponseWriter, userID string, tokenVersion int) error {
	now := time.Now()
	claims := sessionClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(s.ttl)),
		},
		TokenVersion: tokenVersion,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(s.key)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    signed,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  now.Add(s.ttl),
		MaxAge:   int(s.ttl.Seconds()),
	})
	return nil
}

// Parse validates a session token string and returns its user ID and the token
// version embedded in the claim (the caller compares it against the current DB
// value to enforce revocation on logout/password change).
func (s *SessionManager) Parse(tokenStr string) (userID string, tokenVersion int, err error) {
	claims := &sessionClaims{}
	token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return s.key, nil
	})
	if err != nil || !token.Valid {
		return "", 0, errors.New("invalid session")
	}
	if claims.Subject == "" {
		return "", 0, errors.New("invalid session subject")
	}
	return claims.Subject, claims.TokenVersion, nil
}

// Clear removes the session cookie.
func (s *SessionManager) Clear(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

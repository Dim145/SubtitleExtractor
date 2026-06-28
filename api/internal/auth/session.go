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

// NewSessionManager creates a manager with the given signing key and lifetime.
func NewSessionManager(signingKey string, ttl time.Duration, secure bool) *SessionManager {
	return &SessionManager{key: []byte(signingKey), ttl: ttl, secure: secure}
}

// Issue signs a session for userID and writes it as an httpOnly cookie.
func (s *SessionManager) Issue(w http.ResponseWriter, userID string) error {
	now := time.Now()
	claims := jwt.RegisteredClaims{
		Subject:   userID,
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(now.Add(s.ttl)),
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

// Parse validates a session token string and returns its user ID.
func (s *SessionManager) Parse(tokenStr string) (string, error) {
	claims := &jwt.RegisteredClaims{}
	token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return s.key, nil
	})
	if err != nil || !token.Valid {
		return "", errors.New("invalid session")
	}
	if claims.Subject == "" {
		return "", errors.New("invalid session subject")
	}
	return claims.Subject, nil
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

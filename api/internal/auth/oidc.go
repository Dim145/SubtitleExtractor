package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"subtitleextractor/internal/config"
)

// OIDC wraps an OIDC provider for the Authorization Code + PKCE flow.
type OIDC struct {
	provider        *oidc.Provider
	verifier        *oidc.IDTokenVerifier
	oauth2Config    oauth2.Config
	issuer          string
	adminClaim      string
	adminClaimValue string
}

// Claims is the subset of ID-token claims we consume.
type Claims struct {
	Subject     string
	Email       string
	DisplayName string
	IsAdmin     bool
}

// NewOIDC discovers the provider and builds the verifier + oauth2 config.
func NewOIDC(ctx context.Context, cfg config.AuthConfig) (*OIDC, error) {
	if cfg.OIDCIssuerURL == "" || cfg.OIDCClientID == "" {
		return nil, errors.New("OIDC enabled but OIDC_ISSUER_URL / OIDC_CLIENT_ID are not set")
	}
	provider, err := oidc.NewProvider(ctx, cfg.OIDCIssuerURL)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}
	return &OIDC{
		provider: provider,
		verifier: provider.Verifier(&oidc.Config{ClientID: cfg.OIDCClientID}),
		oauth2Config: oauth2.Config{
			ClientID:     cfg.OIDCClientID,
			ClientSecret: cfg.OIDCClientSecret,
			RedirectURL:  cfg.OIDCRedirectURL,
			Endpoint:     provider.Endpoint(),
			Scopes:       cfg.OIDCScopes,
		},
		issuer:          cfg.OIDCIssuerURL,
		adminClaim:      cfg.OIDCAdminClaim,
		adminClaimValue: cfg.OIDCAdminClaimValue,
	}, nil
}

// Issuer returns the configured issuer URL.
func (o *OIDC) Issuer() string { return o.issuer }

// AuthCodeURL builds the provider redirect URL with state, nonce and PKCE challenge.
func (o *OIDC) AuthCodeURL(state, nonce, pkceVerifier string) string {
	return o.oauth2Config.AuthCodeURL(state,
		oidc.Nonce(nonce),
		oauth2.S256ChallengeOption(pkceVerifier),
	)
}

// Exchange swaps the authorization code for tokens, verifies the ID token, and
// returns the claims we care about.
func (o *OIDC) Exchange(ctx context.Context, code, nonce, pkceVerifier string) (*Claims, error) {
	tok, err := o.oauth2Config.Exchange(ctx, code, oauth2.VerifierOption(pkceVerifier))
	if err != nil {
		return nil, fmt.Errorf("token exchange: %w", err)
	}
	rawID, ok := tok.Extra("id_token").(string)
	if !ok {
		return nil, errors.New("no id_token in token response")
	}
	idToken, err := o.verifier.Verify(ctx, rawID)
	if err != nil {
		return nil, fmt.Errorf("verify id_token: %w", err)
	}
	if idToken.Nonce != nonce {
		return nil, errors.New("nonce mismatch")
	}

	var raw map[string]any
	if err := idToken.Claims(&raw); err != nil {
		return nil, err
	}

	c := &Claims{Subject: idToken.Subject}
	if v, ok := raw["email"].(string); ok {
		c.Email = v
	}
	if v, ok := raw["name"].(string); ok {
		c.DisplayName = v
	} else if v, ok := raw["preferred_username"].(string); ok {
		c.DisplayName = v
	}
	c.IsAdmin = o.evalAdmin(raw)
	return c, nil
}

// evalAdmin maps a configured claim to admin status. Admin mapping is only
// active when BOTH the claim name and the required value are configured; if
// either is empty the mapping is disabled (no one is granted admin via OIDC),
// so a misconfiguration cannot silently promote every authenticated user.
func (o *OIDC) evalAdmin(raw map[string]any) bool {
	if o.adminClaim == "" || o.adminClaimValue == "" {
		return false
	}
	val, ok := raw[o.adminClaim]
	if !ok {
		return false
	}
	switch v := val.(type) {
	case string:
		return v == o.adminClaimValue
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok && s == o.adminClaimValue {
				return true
			}
		}
	}
	return false
}

package auth

import "github.com/alexedwards/argon2id"

// DummyHash is a valid argon2id hash (of a random secret) used to spend the same
// verification time on the login path when no matching user exists, so response
// timing doesn't leak whether an email is registered. Computed once at startup
// with DefaultParams so its cost matches real stored hashes.
var DummyHash string

func init() {
	h, err := argon2id.CreateHash("dummy-password-for-constant-time-login", argon2id.DefaultParams)
	if err == nil {
		DummyHash = h
	}
}

// HashPassword derives an argon2id hash (OWASP-recommended) for storage.
func HashPassword(plain string) (string, error) {
	return argon2id.CreateHash(plain, argon2id.DefaultParams)
}

// VerifyPassword reports whether plain matches the stored argon2id hash.
func VerifyPassword(plain, encodedHash string) (bool, error) {
	return argon2id.ComparePasswordAndHash(plain, encodedHash)
}

package auth

import "github.com/alexedwards/argon2id"

// HashPassword derives an argon2id hash (OWASP-recommended) for storage.
func HashPassword(plain string) (string, error) {
	return argon2id.CreateHash(plain, argon2id.DefaultParams)
}

// VerifyPassword reports whether plain matches the stored argon2id hash.
func VerifyPassword(plain, encodedHash string) (bool, error) {
	return argon2id.ComparePasswordAndHash(plain, encodedHash)
}

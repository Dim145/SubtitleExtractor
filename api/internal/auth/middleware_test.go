package auth

import (
	"net/http/httptest"
	"testing"
)

func TestHashWorkerToken(t *testing.T) {
	// Known SHA-256("test") hex, so we verify the exact encoding (lowercase hex).
	const in = "test"
	const want = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
	if got := HashWorkerToken(in); got != want {
		t.Fatalf("HashWorkerToken(%q) = %q, want %q", in, got, want)
	}

	// Determinism + sensitivity: same input hashes the same, different differs.
	if HashWorkerToken("a") != HashWorkerToken("a") {
		t.Error("hash is not deterministic")
	}
	if HashWorkerToken("a") == HashWorkerToken("b") {
		t.Error("distinct inputs produced identical hashes")
	}
}

func TestWorkerTokenFromRequest(t *testing.T) {
	cases := []struct {
		name, header, value, want string
	}{
		{"x-worker-token", "X-Worker-Token", "tok123", "tok123"},
		{"x-worker-token trimmed", "X-Worker-Token", "  tok123  ", "tok123"},
		{"bearer", "Authorization", "Bearer tok456", "tok456"},
		{"bearer trimmed", "Authorization", "Bearer   tok456  ", "tok456"},
		{"authorization non-bearer ignored", "Authorization", "Basic abc", ""},
		{"missing", "", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/", nil)
			if c.header != "" {
				r.Header.Set(c.header, c.value)
			}
			if got := workerTokenFromRequest(r); got != c.want {
				t.Errorf("workerTokenFromRequest = %q, want %q", got, c.want)
			}
		})
	}

	// X-Worker-Token takes precedence over Authorization.
	r := httptest.NewRequest("POST", "/", nil)
	r.Header.Set("X-Worker-Token", "primary")
	r.Header.Set("Authorization", "Bearer secondary")
	if got := workerTokenFromRequest(r); got != "primary" {
		t.Errorf("precedence: got %q, want %q", got, "primary")
	}
}

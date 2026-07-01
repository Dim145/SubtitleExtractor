package workers

import (
	"testing"
	"time"
)

func TestDeriveStatus(t *testing.T) {
	now := time.Now()
	recent := now.Add(-10 * time.Second)
	stale := now.Add(-5 * time.Minute)
	job := "job-123"

	cases := []struct {
		name       string
		enabled    bool
		lastHB     *time.Time
		currentJob *string
		want       string
	}{
		{"busy overrides everything", true, &recent, &job, "busy"},
		{"busy even when disabled", false, &recent, &job, "busy"},
		{"enabled + recent heartbeat = online", true, &recent, nil, "online"},
		{"disabled never online", false, &recent, nil, "offline"},
		{"enabled + stale heartbeat = offline", true, &stale, nil, "offline"},
		{"enabled + no heartbeat = offline", true, nil, nil, "offline"},
	}
	for _, c := range cases {
		if got := deriveStatus(c.enabled, c.lastHB, c.currentJob); got != c.want {
			t.Errorf("%s: deriveStatus(%v,...) = %q, want %q", c.name, c.enabled, got, c.want)
		}
	}
}

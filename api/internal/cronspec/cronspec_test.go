package cronspec

import (
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.Parse("2006-01-02 15:04", s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestMatches(t *testing.T) {
	cases := []struct {
		expr string
		when string
		want bool
	}{
		{"0 3 * * *", "2026-06-29 03:00", true},
		{"0 3 * * *", "2026-06-29 03:01", false},
		{"0 3 * * *", "2026-06-29 04:00", false},
		{"*/15 * * * *", "2026-06-29 12:30", true},
		{"*/15 * * * *", "2026-06-29 12:31", false},
		{"30 1,13 * * *", "2026-06-29 13:30", true},
		{"30 1,13 * * *", "2026-06-29 12:30", false},
		{"0 0 1 * *", "2026-06-01 00:00", true},
		{"0 0 1 * *", "2026-06-02 00:00", false},
		// 2026-06-29 is a Monday (weekday 1).
		{"0 9 * * 1", "2026-06-29 09:00", true},
		{"0 9 * * 1", "2026-06-30 09:00", false},
		// Sunday accepted as both 0 and 7. 2026-07-05 is a Sunday.
		{"0 9 * * 7", "2026-07-05 09:00", true},
		{"0 9 * * 0", "2026-07-05 09:00", true},
		// dom + dow both restricted → OR semantics. day 1 OR Monday.
		{"0 9 1 * 1", "2026-06-29 09:00", true},  // Monday
		{"0 9 1 * 1", "2026-06-01 09:00", true},  // the 1st (also a Monday, still matches)
		{"0 9 1 * 5", "2026-06-15 09:00", false}, // not the 1st, not Friday
	}
	for _, c := range cases {
		s, err := Parse(c.expr)
		if err != nil {
			t.Fatalf("Parse(%q) error: %v", c.expr, err)
		}
		if got := s.Matches(at(c.when)); got != c.want {
			t.Errorf("Parse(%q).Matches(%s) = %v, want %v", c.expr, c.when, got, c.want)
		}
	}
}

func TestParseErrors(t *testing.T) {
	bad := []string{"", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "0 3 * * 8", "a * * * *", "*/0 * * * *"}
	for _, e := range bad {
		if _, err := Parse(e); err == nil {
			t.Errorf("Parse(%q) expected error, got nil", e)
		}
	}
}

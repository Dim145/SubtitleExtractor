package httpapi

import "testing"

func TestFormatBytes(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{0, "0 o"},
		{-5, "0 o"},
		{999, "999 o"},
		{1000, "1,0 Ko"},
		{1500, "1,5 Ko"},
		{1_000_000, "1,0 Mo"},
		{4_200_000_000, "4,2 Go"},
		{5_000_000_000, "5,0 Go"},
		{1_000_000_000_000, "1,0 To"},
	}
	for _, c := range cases {
		if got := formatBytes(c.in); got != c.want {
			t.Errorf("formatBytes(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestEffectiveQuotaLimit(t *testing.T) {
	p := func(v int64) *int64 { return &v }
	cases := []struct {
		name          string
		override      *int64
		def           int64
		wantLimit     int64
		wantUnlimited bool
	}{
		{"no override, positive default", nil, 5_000_000_000, 5_000_000_000, false},
		{"no override, zero default (unlimited)", nil, 0, 0, true},
		{"override positive beats default", p(1_000), 5_000_000_000, 1_000, false},
		{"override zero = unlimited for user", p(0), 5_000_000_000, 0, true},
		{"override positive, zero default", p(2_000), 0, 2_000, false},
		{"both zero = unlimited", p(0), 0, 0, true},
	}
	for _, c := range cases {
		limit, unlimited := effectiveQuotaLimit(c.override, c.def)
		if limit != c.wantLimit || unlimited != c.wantUnlimited {
			t.Errorf("%s: effectiveQuotaLimit(%v,%d) = (%d,%v), want (%d,%v)",
				c.name, c.override, c.def, limit, unlimited, c.wantLimit, c.wantUnlimited)
		}
	}
}

func TestQuotaExceeded(t *testing.T) {
	cases := []struct {
		name             string
		used, add, limit int64
		want             bool
	}{
		{"unlimited (limit 0)", 1 << 40, 1 << 40, 0, false},
		{"under limit", 100, 100, 500, false},
		{"exactly at limit is ok", 400, 100, 500, false},
		{"one over the limit", 400, 101, 500, true},
		{"already over before add", 600, 0, 500, true},
	}
	for _, c := range cases {
		if got := quotaExceeded(c.used, c.add, c.limit); got != c.want {
			t.Errorf("%s: quotaExceeded(%d,%d,%d) = %v, want %v",
				c.name, c.used, c.add, c.limit, got, c.want)
		}
	}
}

func TestCountingReaderQuotaTrip(t *testing.T) {
	// A limit of 0 means no cap: reader passes all bytes through.
	cr := &countingReader{r: bytesReader("hello world"), limit: 0}
	buf := make([]byte, 32)
	n, err := cr.Read(buf)
	if err != nil {
		t.Fatalf("unexpected error with no limit: %v", err)
	}
	if int64(n) != cr.n || cr.overQuota {
		t.Fatalf("no-limit read: n=%d cr.n=%d over=%v", n, cr.n, cr.overQuota)
	}

	// A tight limit trips overQuota once consumption passes it.
	cr = &countingReader{r: bytesReader("0123456789"), limit: 4}
	_, err = cr.Read(make([]byte, 10))
	if err != errQuotaExceeded || !cr.overQuota {
		t.Fatalf("expected quota trip, got err=%v over=%v n=%d", err, cr.overQuota, cr.n)
	}
}

// bytesReader is a tiny io.Reader over a string (avoids importing bytes/strings
// just for the test helper's intent to stay obvious).
type bytesReader string

func (b bytesReader) Read(p []byte) (int, error) {
	n := copy(p, b)
	if n < len(b) {
		return n, nil
	}
	return n, nil
}

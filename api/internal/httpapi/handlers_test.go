package httpapi

import "testing"

func TestSanitizeFilename(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"movie.mp4", "movie.mp4"},
		{"../../etc/passwd", "passwd"},
		{`C:\Users\me\clip.mkv`, "clip.mkv"},
		{"my video (2024).mp4", "my_video_2024_.mp4"},
		{"a::b::c.srt", "a_b_c.srt"},          // ':' collapses, no split fragility
		{"  spaced name .ts ", "spaced_name_.ts"},
		{"", "upload.bin"},
		{".", "upload.bin"},
		{"..", "upload.bin"},
		{"???", "upload.bin"}, // all-unsafe collapses to "_" then trims to empty
		{"résumé.srt", "r_sum_.srt"},
		{"__leading.and.trailing__", "leading.and.trailing"},
	}
	for _, c := range cases {
		if got := sanitizeFilename(c.in); got != c.want {
			t.Errorf("sanitizeFilename(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestTerminalStatus(t *testing.T) {
	terminal := []string{"succeeded", "failed", "canceled"}
	for _, s := range terminal {
		if !terminalStatus(s) {
			t.Errorf("terminalStatus(%q) = false, want true", s)
		}
	}
	nonTerminal := []string{"queued", "claimed", "running", "", "unknown"}
	for _, s := range nonTerminal {
		if terminalStatus(s) {
			t.Errorf("terminalStatus(%q) = true, want false", s)
		}
	}
}

func TestAllowedVideoExt(t *testing.T) {
	ok := []string{"a.mp4", "a.MKV", "a.webm", "a.mov", "a.avi", "a.m4v", "a.ts"}
	for _, n := range ok {
		if !allowedVideoExt(n) {
			t.Errorf("allowedVideoExt(%q) = false, want true", n)
		}
	}
	bad := []string{"a.exe", "a.txt", "a", "a.mp3", "a.srt"}
	for _, n := range bad {
		if allowedVideoExt(n) {
			t.Errorf("allowedVideoExt(%q) = true, want false", n)
		}
	}
}

func TestRedactPath(t *testing.T) {
	if got := redactPath("/api/files/abcdefsecrettoken"); got != "/api/files/[redacted]" {
		t.Errorf("redactPath token = %q", got)
	}
	if got := redactPath("/api/jobs/123"); got != "/api/jobs/123" {
		t.Errorf("redactPath non-token = %q", got)
	}
}

func TestOriginHost(t *testing.T) {
	cases := map[string]string{
		"https://app.example.com":       "app.example.com",
		"http://localhost:5173/x":       "localhost:5173",
		"HTTPS://APP.EXAMPLE.COM":       "app.example.com",
		"":                              "",
		"not a url with spaces":         "",
	}
	for in, want := range cases {
		if got := originHost(in); got != want {
			t.Errorf("originHost(%q) = %q, want %q", in, got, want)
		}
	}
}

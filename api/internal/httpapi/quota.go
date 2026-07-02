package httpapi

import (
	"fmt"
	"strings"
)

// effectiveQuotaLimit resolves a user's effective storage limit in bytes:
// the per-user override if set (non-nil), otherwise the admin default. A value
// of 0 (from either source) means UNLIMITED. The returned unlimited flag is
// true when no positive limit applies.
func effectiveQuotaLimit(override *int64, defaultBytes int64) (limit int64, unlimited bool) {
	if override != nil {
		limit = *override
	} else {
		limit = defaultBytes
	}
	if limit <= 0 {
		return 0, true
	}
	return limit, false
}

// quotaExceeded reports whether storing addBytes more on top of used would push
// a user past limit. limit<=0 means unlimited (never exceeded). addBytes may be
// a conservative upper bound (e.g. Content-Length incl. multipart overhead).
func quotaExceeded(used, addBytes, limit int64) bool {
	if limit <= 0 {
		return false
	}
	return used+addBytes > limit
}

// formatBytes renders a byte count in French SI-ish units (o, Ko, Mo, Go, To)
// using a decimal (1000) scale and a comma decimal separator, matching the
// user-facing quota messages. Values below 1 Ko are shown as whole octets.
func formatBytes(n int64) string {
	if n < 0 {
		n = 0
	}
	const unit = 1000
	if n < unit {
		return fmt.Sprintf("%d o", n)
	}
	units := []string{"Ko", "Mo", "Go", "To", "Po"}
	value := float64(n) / unit
	idx := 0
	for value >= unit && idx < len(units)-1 {
		value /= unit
		idx++
	}
	// One decimal place, French comma separator.
	s := fmt.Sprintf("%.1f", value)
	s = strings.Replace(s, ".", ",", 1)
	return s + " " + units[idx]
}

// quotaErrorMessage builds the explicit French over-quota message including the
// human-formatted used/limit figures.
func quotaErrorMessage(used, limit int64) string {
	return fmt.Sprintf(
		"Quota de stockage dépassé : %s utilisés sur %s. Supprimez des vidéos ou demandez une augmentation à un administrateur.",
		formatBytes(used), formatBytes(limit))
}

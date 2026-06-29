// Package cronspec is a tiny standard 5-field cron parser/matcher (minute hour
// day-of-month month day-of-week). It supports '*', '*/n', 'a-b', 'a-b/n',
// comma lists, and single values — enough to schedule the daily video cleanup
// without an external dependency. Day-of-week accepts 0 or 7 for Sunday.
package cronspec

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Schedule is a parsed cron expression.
type Schedule struct {
	min, hour, dom, month, dow uint64 // bitmask per field
	domStar, dowStar           bool   // whether the field was "*"
}

type fieldRange struct{ min, max int }

var ranges = []fieldRange{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 7}}

// Parse parses a standard 5-field cron expression.
func Parse(expr string) (*Schedule, error) {
	parts := strings.Fields(strings.TrimSpace(expr))
	if len(parts) != 5 {
		return nil, fmt.Errorf("cron: expected 5 fields, got %d", len(parts))
	}
	s := &Schedule{}
	masks := make([]uint64, 5)
	for i, p := range parts {
		m, err := parseField(p, ranges[i])
		if err != nil {
			return nil, fmt.Errorf("cron field %d (%q): %w", i+1, p, err)
		}
		masks[i] = m
	}
	s.min, s.hour, s.dom, s.month, s.dow = masks[0], masks[1], masks[2], masks[3], masks[4]
	s.domStar = parts[2] == "*"
	s.dowStar = parts[4] == "*"
	// Normalize: Sunday is both bit 0 and bit 7.
	if s.dow&(1<<7) != 0 {
		s.dow |= 1 << 0
	}
	if s.dow&(1<<0) != 0 {
		s.dow |= 1 << 7
	}
	return s, nil
}

func parseField(field string, rg fieldRange) (uint64, error) {
	var mask uint64
	for _, part := range strings.Split(field, ",") {
		step := 1
		rangePart := part
		if slash := strings.Index(part, "/"); slash >= 0 {
			var err error
			step, err = strconv.Atoi(part[slash+1:])
			if err != nil || step < 1 {
				return 0, fmt.Errorf("bad step")
			}
			rangePart = part[:slash]
		}
		lo, hi := rg.min, rg.max
		if rangePart != "*" {
			if dash := strings.Index(rangePart, "-"); dash >= 0 {
				var err error
				lo, err = strconv.Atoi(rangePart[:dash])
				if err != nil {
					return 0, fmt.Errorf("bad range start")
				}
				hi, err = strconv.Atoi(rangePart[dash+1:])
				if err != nil {
					return 0, fmt.Errorf("bad range end")
				}
			} else {
				v, err := strconv.Atoi(rangePart)
				if err != nil {
					return 0, fmt.Errorf("bad value")
				}
				lo, hi = v, v
			}
		}
		if lo < rg.min || hi > rg.max || lo > hi {
			return 0, fmt.Errorf("out of range %d-%d", rg.min, rg.max)
		}
		for v := lo; v <= hi; v += step {
			mask |= 1 << uint(v)
		}
	}
	return mask, nil
}

// Matches reports whether t (at minute resolution) satisfies the schedule.
func (s *Schedule) Matches(t time.Time) bool {
	if s.min&(1<<uint(t.Minute())) == 0 {
		return false
	}
	if s.hour&(1<<uint(t.Hour())) == 0 {
		return false
	}
	if s.month&(1<<uint(t.Month())) == 0 {
		return false
	}
	domOK := s.dom&(1<<uint(t.Day())) != 0
	dowOK := s.dow&(1<<uint(t.Weekday())) != 0
	// Standard cron: when both day fields are restricted, match if EITHER holds;
	// otherwise both (the unrestricted "*" one is always true) must hold.
	if !s.domStar && !s.dowStar {
		return domOK || dowOK
	}
	return domOK && dowOK
}

package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"subtitleextractor/internal/auth"
	"subtitleextractor/internal/events"
)

func terminalStatus(s string) bool {
	return s == "succeeded" || s == "failed" || s == "canceled"
}

// handleJobEvents streams a job's progress, logs and final status over SSE.
// On connect it sends a snapshot (current status + existing logs), then live
// events from the hub until the job finishes or the client disconnects.
// maxSSEStreamDuration bounds how long a single SSE subscriber may stay open,
// so abandoned/half-open connections don't accumulate indefinitely.
const maxSSEStreamDuration = 30 * time.Minute

func (s *Server) handleJobEvents(w http.ResponseWriter, r *http.Request) {
	job, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	// Cap concurrent streams per user before writing any SSE headers.
	u := auth.UserFromContext(r.Context())
	if u != nil {
		if !s.acquireSSE(u.ID) {
			writeError(w, http.StatusTooManyRequests, "too many open event streams")
			return
		}
		defer s.releaseSSE(u.ID)
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // tell nginx not to buffer

	// Subscribe before the snapshot so no event is missed in the gap.
	sub := s.hub.Subscribe(job.ID)
	defer s.hub.Unsubscribe(job.ID, sub)

	// Re-fetch the job after subscribing: it may have reached a terminal state (or
	// been re-run back to queued) between ownedJob's read and Subscribe. Evaluate
	// terminality on this fresh snapshot to avoid both a missed close and a
	// premature one on a re-run.
	if fresh, err := s.jobs.Get(r.Context(), job.ID); err == nil {
		job = fresh
	}

	writeSSE(w, "status", map[string]any{
		"status": job.Status, "progressPct": job.ProgressPct, "stage": job.ProgressStage,
	})
	if logs, err := s.jobs.Logs(r.Context(), job.ID, 0, 1000); err == nil {
		for _, l := range logs {
			writeSSE(w, "log", map[string]any{"ts": l.TS, "level": l.Level, "message": l.Message})
		}
	}
	flusher.Flush()

	if terminalStatus(job.Status) {
		writeSSE(w, "done", nil)
		flusher.Flush()
		return
	}

	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()
	deadline := time.NewTimer(maxSSEStreamDuration)
	defer deadline.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-deadline.C:
			// Bound the subscriber lifetime; the client can reconnect.
			return
		case ev := <-sub:
			writeSSE(w, ev.Type, ev.Data)
			flusher.Flush()
			// Only close when a status event reports a terminal status — a re-run
			// republishes a non-terminal "queued" status that must NOT close us.
			if ev.Type == "status" {
				if data, ok := ev.Data.(map[string]any); ok {
					if st, _ := data["status"].(string); terminalStatus(st) {
						writeSSE(w, "done", nil)
						flusher.Flush()
						return
					}
				}
			}
		case <-keepalive.C:
			_, _ = io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

// acquireSSE reserves an SSE slot for a user, returning false when the per-user
// cap is already reached.
func (s *Server) acquireSSE(userID string) bool {
	s.sseMu.Lock()
	defer s.sseMu.Unlock()
	if s.sseByUser[userID] >= maxSSEPerUser {
		return false
	}
	s.sseByUser[userID]++
	return true
}

func (s *Server) releaseSSE(userID string) {
	s.sseMu.Lock()
	defer s.sseMu.Unlock()
	if s.sseByUser[userID] > 0 {
		s.sseByUser[userID]--
	}
	if s.sseByUser[userID] == 0 {
		delete(s.sseByUser, userID)
	}
}

func writeSSE(w io.Writer, event string, data any) {
	fmt.Fprintf(w, "event: %s\n", event)
	if data == nil {
		_, _ = io.WriteString(w, "data: {}\n\n")
		return
	}
	b, err := json.Marshal(data)
	if err != nil {
		b = []byte("{}")
	}
	fmt.Fprintf(w, "data: %s\n\n", b)
}

// publishLog/publishStatus push events to SSE subscribers.
func (s *Server) publishLog(jobID, level, message string) {
	s.hub.Publish(jobID, events.Event{Type: "log", Data: map[string]any{
		"ts": time.Now(), "level": level, "message": message,
	}})
}

func (s *Server) publishStatus(jobID, status string) {
	s.hub.Publish(jobID, events.Event{Type: "status", Data: map[string]any{"status": status}})
}

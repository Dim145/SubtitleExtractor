package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"subtitleextractor/internal/events"
)

func terminalStatus(s string) bool {
	return s == "succeeded" || s == "failed" || s == "canceled"
}

// handleJobEvents streams a job's progress, logs and final status over SSE.
// On connect it sends a snapshot (current status + existing logs), then live
// events from the hub until the job finishes or the client disconnects.
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

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // tell nginx not to buffer

	// Subscribe before the snapshot so no event is missed in the gap.
	sub := s.hub.Subscribe(job.ID)
	defer s.hub.Unsubscribe(job.ID, sub)

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
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-sub:
			writeSSE(w, ev.Type, ev.Data)
			flusher.Flush()
			if ev.Type == "status" {
				// status is only published on completion → close the stream.
				writeSSE(w, "done", nil)
				flusher.Flush()
				return
			}
		case <-keepalive.C:
			_, _ = io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
		}
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

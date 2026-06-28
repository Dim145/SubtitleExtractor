// Package events is a tiny in-process pub/sub used to push job progress/logs to
// SSE subscribers in real time (single API instance; no external broker).
package events

import "sync"

// Event is one server-sent event: a named type plus a JSON-serializable payload.
type Event struct {
	Type string
	Data any
}

// Hub fans out events to per-job subscribers.
type Hub struct {
	mu   sync.RWMutex
	subs map[string]map[chan Event]struct{} // jobID -> set of subscriber channels
}

// NewHub creates an empty hub.
func NewHub() *Hub {
	return &Hub{subs: make(map[string]map[chan Event]struct{})}
}

// Subscribe returns a buffered channel receiving events for jobID.
func (h *Hub) Subscribe(jobID string) chan Event {
	ch := make(chan Event, 32)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.subs[jobID] == nil {
		h.subs[jobID] = make(map[chan Event]struct{})
	}
	h.subs[jobID][ch] = struct{}{}
	return ch
}

// Unsubscribe removes and closes a subscriber channel.
func (h *Hub) Unsubscribe(jobID string, ch chan Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.subs[jobID]; ok {
		if _, ok := set[ch]; ok {
			delete(set, ch)
			close(ch)
		}
		if len(set) == 0 {
			delete(h.subs, jobID)
		}
	}
}

// Publish delivers ev to all current subscribers of jobID (non-blocking: a slow
// subscriber drops the event rather than stalling the publisher).
func (h *Hub) Publish(jobID string, ev Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.subs[jobID] {
		select {
		case ch <- ev:
		default:
		}
	}
}

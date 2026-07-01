package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// jobStatuses is the fixed set of job states exposed as gauge labels, so a
// status that momentarily drops to zero rows still reports 0 (not disappears).
var jobStatuses = []string{"queued", "claimed", "running", "succeeded", "failed", "canceled"}

// metrics holds the Prometheus collectors for the service.
type metrics struct {
	registry    *prometheus.Registry
	httpReqs    *prometheus.CounterVec
	jobs        *prometheus.GaugeVec
	workersOnln prometheus.Gauge
}

// newMetrics builds and registers all collectors on a private registry (so we
// don't leak the default global collectors, and tests stay hermetic).
func newMetrics() *metrics {
	reg := prometheus.NewRegistry()
	m := &metrics{
		registry: reg,
		httpReqs: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "subext_http_requests_total",
			Help: "Total HTTP requests by method, route pattern and status.",
		}, []string{"method", "route", "status"}),
		jobs: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "subext_jobs",
			Help: "Number of jobs by status.",
		}, []string{"status"}),
		workersOnln: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "subext_workers_online",
			Help: "Number of workers currently online (heartbeat within the offline window).",
		}),
	}
	reg.MustRegister(m.httpReqs, m.jobs, m.workersOnln)
	// Seed every status label so absent states report 0 rather than vanishing.
	for _, st := range jobStatuses {
		m.jobs.WithLabelValues(st).Set(0)
	}
	return m
}

// middleware counts every HTTP request by method, matched chi route pattern, and
// status code. The route pattern (not the raw path) keeps cardinality bounded.
func (m *metrics) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		route := "unknown"
		if rc := chi.RouteContext(r.Context()); rc != nil && rc.RoutePattern() != "" {
			route = rc.RoutePattern()
		}
		m.httpReqs.WithLabelValues(r.Method, route, strconv.Itoa(ww.Status())).Inc()
	})
}

// handler serves the metrics in Prometheus text format.
func (m *metrics) handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// startRefresher refreshes the job-count and workers-online gauges on a ticker
// from a single grouped query each. A failing DB query is logged and skipped so
// it never blocks startup or wedges the ticker.
func (m *metrics) startRefresher(ctx context.Context, pool *pgxpool.Pool, offlineWindow time.Duration, logf func(string, ...any)) {
	refresh := func() {
		counts := map[string]float64{}
		rows, err := pool.Query(ctx, `SELECT status, count(*) FROM jobs GROUP BY status`)
		if err != nil {
			logf("metrics: job counts query failed: %v", err)
		} else {
			for rows.Next() {
				var status string
				var n float64
				if err := rows.Scan(&status, &n); err != nil {
					logf("metrics: scan job count: %v", err)
					continue
				}
				counts[status] = n
			}
			rows.Close()
			for _, st := range jobStatuses {
				m.jobs.WithLabelValues(st).Set(counts[st])
			}
		}

		var online float64
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM workers WHERE enabled AND last_heartbeat IS NOT NULL AND last_heartbeat > now() - $1::interval`,
			offlineWindow.String(),
		).Scan(&online); err != nil {
			logf("metrics: workers-online query failed: %v", err)
		} else {
			m.workersOnln.Set(online)
		}
	}

	go func() {
		refresh()
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				refresh()
			}
		}
	}()
}

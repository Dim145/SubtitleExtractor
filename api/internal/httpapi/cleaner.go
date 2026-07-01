package httpapi

import (
	"context"
	"errors"
	"sync"
	"time"

	"subtitleextractor/internal/cleanup"
	"subtitleextractor/internal/cronspec"
	"subtitleextractor/internal/jobs"
	"subtitleextractor/internal/settings"
	"subtitleextractor/internal/storage"
)

// ErrCleanupBusy is returned when a run is requested while one is in progress.
var ErrCleanupBusy = errors.New("a cleanup run is already in progress")

// VideoCleaner periodically deletes source videos older than the configured
// retention window. It re-reads settings every tick, so changes made in the
// admin UI (enable/disable, schedule, retention) take effect without a restart.
// It never touches job rows or subtitle results — only the input video blob.
// Each run (scheduled or manual) is recorded for the admin history.
type VideoCleaner struct {
	jobs     *jobs.Repo
	settings *settings.Repo
	runs     *cleanup.Repo
	store    storage.Storage
	logf     func(string, ...any)

	mu      sync.Mutex
	lastRun time.Time // minute we last fired, so a matching minute runs once
	running bool      // a run is in progress (manual + scheduled are mutually exclusive)
}

// StartVideoCleaner launches the retention loop until ctx is canceled.
func StartVideoCleaner(ctx context.Context, jobsRepo *jobs.Repo, settingsRepo *settings.Repo, runsRepo *cleanup.Repo, store storage.Storage, logf func(string, ...any)) *VideoCleaner {
	vc := &VideoCleaner{jobs: jobsRepo, settings: settingsRepo, runs: runsRepo, store: store, logf: logf}
	ticker := time.NewTicker(30 * time.Second)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				vc.tick(ctx)
			}
		}
	}()
	return vc
}

func (vc *VideoCleaner) tick(ctx context.Context) {
	st, err := vc.settings.Get(ctx)
	if err != nil {
		vc.logf("video cleanup: read settings: %v", err)
		return
	}
	if !st.VideoCleanupEnabled {
		return
	}
	sched, err := cronspec.Parse(st.VideoCleanupCron)
	if err != nil {
		vc.logf("video cleanup: invalid cron %q: %v", st.VideoCleanupCron, err)
		return
	}
	now := time.Now().UTC()
	if !sched.Matches(now) {
		return
	}
	minute := now.Truncate(time.Minute)
	vc.mu.Lock()
	if minute.Equal(vc.lastRun) {
		vc.mu.Unlock()
		return // already fired this minute
	}
	vc.lastRun = minute
	vc.mu.Unlock()
	if _, err := vc.execute(ctx, "scheduled", st.VideoRetentionDays); err != nil && !errors.Is(err, ErrCleanupBusy) {
		vc.logf("video cleanup: %v", err)
	}
}

// ListRuns returns the most recent cleanup runs.
func (vc *VideoCleaner) ListRuns(ctx context.Context, n int) ([]*cleanup.Run, error) {
	return vc.runs.ListRecent(ctx, n)
}

// RunNow triggers a cleanup immediately (admin "run now"). It works even when
// auto-cleanup is disabled, using the currently configured retention window.
// Returns ErrCleanupBusy if a run is already in progress.
func (vc *VideoCleaner) RunNow(ctx context.Context) (*cleanup.Run, error) {
	st, err := vc.settings.Get(ctx)
	if err != nil {
		return nil, err
	}
	return vc.execute(ctx, "manual", st.VideoRetentionDays)
}

// execute performs one cleanup, records it, and returns the run. Only one run
// proceeds at a time; concurrent callers get ErrCleanupBusy.
func (vc *VideoCleaner) execute(ctx context.Context, trigger string, retentionDays int) (*cleanup.Run, error) {
	vc.mu.Lock()
	if vc.running {
		vc.mu.Unlock()
		return nil, ErrCleanupBusy
	}
	vc.running = true
	vc.mu.Unlock()
	defer func() {
		vc.mu.Lock()
		vc.running = false
		vc.mu.Unlock()
	}()

	if retentionDays < 1 {
		retentionDays = 7
	}
	run := &cleanup.Run{StartedAt: time.Now(), Trigger: trigger, Status: "success", Files: []cleanup.FileRef{}}

	if n, err := vc.jobs.CountPresentVideos(ctx); err == nil {
		run.Checked = n
	}

	cutoff := run.StartedAt.Add(-time.Duration(retentionDays) * 24 * time.Hour)
	refs, err := vc.jobs.VideosForCleanup(ctx, cutoff)
	if err != nil {
		run.Status = "error"
		msg := err.Error()
		run.Error = &msg
	} else {
		var failures int
		for _, ref := range refs {
			var size int64
			if ref.InputKey != "" {
				if blob, err := vc.store.Stat(ctx, ref.InputKey); err == nil {
					size = blob.Size
				}
				// Only mark the video deleted (and count freed bytes) when the blob
				// was actually removed; a failed delete leaves the row untouched so
				// the next run retries it.
				if err := vc.store.Delete(ctx, ref.InputKey); err != nil {
					vc.logf("video cleanup: delete blob for job %s: %v", ref.ID, err)
					failures++
					continue
				}
			}
			if err := vc.jobs.MarkVideoDeleted(ctx, ref.ID); err != nil {
				vc.logf("video cleanup: mark job %s: %v", ref.ID, err)
				failures++
				continue
			}
			run.Deleted++
			run.BytesFreed += size
			run.Files = append(run.Files, cleanup.FileRef{JobID: ref.ID, Filename: ref.SourceFilename, Size: size})
		}
		if failures > 0 {
			run.Status = "partial"
			msg := "some videos could not be removed"
			run.Error = &msg
		}
	}

	run.FinishedAt = time.Now()
	if err := vc.runs.Insert(ctx, run); err != nil {
		vc.logf("video cleanup: record run: %v", err)
	}
	if run.Deleted > 0 {
		vc.logf("video cleanup (%s): removed %d/%d source video(s) older than %dd", trigger, run.Deleted, run.Checked, retentionDays)
	}
	return run, nil
}

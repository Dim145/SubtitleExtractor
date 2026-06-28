import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { Spinner } from "../components/ui";
import { subtitleFilename } from "../lib/format";
import { sameOriginApiUrl } from "../lib/url";
import { useWaveform } from "../editor/useWaveform";
import {
  displayTime,
  newCue,
  parseDisplayTime,
  parseSubtitles,
  toASS,
  toSRT,
  type Cue,
} from "../editor/subtitles";

const AN_GRID = [7, 8, 9, 4, 5, 6, 1, 2, 3];

// Position a subtitle line within the video box from its ASS \an alignment (1-9).
function anStyle(an: number): CSSProperties {
  const col = (an - 1) % 3; // 0 left, 1 center, 2 right
  const s: CSSProperties = { position: "absolute", maxWidth: "92%" };
  let transform = "";
  if (an >= 7) s.top = "6%";
  else if (an >= 4) {
    s.top = "50%";
    transform = "translateY(-50%)";
  } else s.bottom = "10%";
  if (col === 0) {
    s.left = "4%";
    s.textAlign = "left";
  } else if (col === 1) {
    s.left = "50%";
    transform += " translateX(-50%)";
    s.textAlign = "center";
  } else {
    s.right = "4%";
    s.textAlign = "right";
  }
  if (transform) s.transform = transform.trim();
  return s;
}

// Lightweight, always-aligned caption overlay (replaces JASSUB, whose canvas
// mis-positioned over the absolutely-laid-out video). Faithful enough for our
// text + \an ASS, and works for any playable source.
function CueOverlay({ cue }: { cue: Cue }) {
  return (
    <div
      style={{
        ...anStyle(cue.an),
        color: "#fff",
        fontFamily: "var(--font-ui)",
        fontWeight: 600,
        fontSize: "clamp(13px, 3vw, 30px)",
        lineHeight: 1.25,
        whiteSpace: "pre-wrap",
        textShadow:
          "0 0 4px #000, 1px 1px 2px #000, -1px -1px 2px #000, 1px -1px 2px #000, -1px 1px 2px #000",
      }}
    >
      {cue.text}
    </div>
  );
}

export function Editor() {
  const { id = "" } = useParams();
  const [cues, setCues] = useState<Cue[]>([]);
  const [dims, setDims] = useState({ width: 1280, height: 720 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [serverVideo, setServerVideo] = useState<string | null>(null);
  const [localVideo, setLocalVideo] = useState<string | null>(null);
  const [videoBroken, setVideoBroken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [waveEl, setWaveEl] = useState<HTMLDivElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);

  // ── load cues + video ──────────────────────────────────────────────────
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        api.getJob(id).then((j) => { if (!stop) setVideoName(j.sourceFilename); }).catch(() => {});
        const results = await api.jobResults(id);
        const pick =
          results.find((r) => r.kind === "ass") ??
          results.find((r) => r.kind === "srt") ??
          results.find((r) => r.kind === "vtt");
        if (!pick) {
          setError("This job has no subtitle results to edit.");
          setLoading(false);
          return;
        }
        const text = await fetch(sameOriginApiUrl(pick.downloadUrl)).then((r) => r.text());
        const parsed = parseSubtitles(text, pick.kind);
        if (stop) return;
        setCues(parsed.cues);
        setDims({ width: parsed.width, height: parsed.height });
        try {
          const v = await api.jobVideo(id);
          if (!stop) setServerVideo(sameOriginApiUrl(v.url));
        } catch {
          /* video preview is optional */
        }
      } catch {
        if (!stop) setError("Failed to load subtitles.");
      } finally {
        if (!stop) setLoading(false);
      }
    })();
    return () => {
      stop = true;
    };
  }, [id]);

  const videoSrc = localVideo ?? serverVideo;

  // ── cue mutations ────────────────────────────────────────────────────────
  const updateCue = useCallback((cueId: string, patch: Partial<Cue>) => {
    setCues((prev) => prev.map((c) => (c.id === cueId ? { ...c, ...patch } : c)));
  }, []);

  const seek = useCallback(
    (t: number) => {
      if (videoEl) videoEl.currentTime = t;
      setCurrentTime(t);
    },
    [videoEl],
  );

  const sorted = useMemo(
    () => cues.slice().sort((a, b) => a.start - b.start),
    [cues],
  );
  const activeId = useMemo(() => {
    const a = sorted.find((c) => currentTime >= c.start && currentTime < c.end);
    return a?.id ?? null;
  }, [sorted, currentTime]);
  // All cues showing at the playhead (two zones can overlap, e.g. top + bottom).
  const activeCues = useMemo(
    () => sorted.filter((c) => currentTime >= c.start && currentTime < c.end),
    [sorted, currentTime],
  );

  const selected = cues.find((c) => c.id === selectedId) ?? null;

  useWaveform(
    waveEl,
    videoEl,
    cues,
    (cueId, start, end) => updateCue(cueId, { start, end }),
    (cueId) => {
      setSelectedId(cueId);
      const c = cues.find((x) => x.id === cueId);
      if (c) seek(c.start);
    },
  );

  async function save() {
    setSaving(true);
    setSaveMsg(null);
    try {
      await api.saveResult(id, toASS(cues, dims.width, dims.height), "ass", "edited");
      setSaveMsg("Saved to server");
    } catch {
      setSaveMsg("Save failed");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 4000);
    }
  }

  function addCue() {
    const c = newCue(currentTime, currentTime + 2);
    setCues((prev) => [...prev, c]);
    setSelectedId(c.id);
  }
  function deleteCue(cueId: string) {
    setCues((prev) => prev.filter((c) => c.id !== cueId));
  }

  function download(kind: "srt" | "ass") {
    const body =
      kind === "srt" ? toSRT(cues) : toASS(cues, dims.width, dims.height);
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = subtitleFilename(videoName, kind);
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading)
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <Spinner size={22} />
      </div>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 52px)" }}>
      {/* command bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-1)",
        }}
      >
        <Link to={`/jobs/${id}`} style={{ fontSize: 13, color: "var(--text-muted)" }}>
          ← Job
        </Link>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>
          Subtitle editor
        </span>
        <span className="mono" style={{ fontSize: 12, color: "var(--text-faint)" }}>
          {cues.length} cues · {dims.width}×{dims.height}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {saveMsg && (
            <span
              style={{
                fontSize: 12,
                color: saveMsg.includes("fail") ? "var(--err)" : "var(--accent-2)",
              }}
            >
              {saveMsg}
            </span>
          )}
          <button className="btn" onClick={() => download("srt")}>
            Export SRT
          </button>
          <button className="btn" onClick={() => download("ass")}>
            Export ASS
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 16, color: "var(--err)" }}>{error}</div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 420px", flex: 1, minHeight: 0 }}>
        {/* left: video preview + transport */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            borderRight: "1px solid var(--border)",
            minHeight: 0,
          }}
        >
          <div
            style={{
              flex: 1,
              display: "grid",
              placeItems: "center",
              background: "#000",
              minHeight: 0,
              position: "relative",
            }}
          >
            {videoSrc && !videoBroken ? (
              <div style={{ position: "relative", display: "inline-block", maxWidth: "100%", maxHeight: "100%" }}>
                <video
                  ref={setVideoEl}
                  src={videoSrc}
                  controls
                  onError={() => setVideoBroken(true)}
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  style={{ display: "block", maxWidth: "100%", maxHeight: "100%" }}
                />
                {/* Subtitle overlay aligned to the video box (positioned by \an). */}
                <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                  {activeCues.map((c) => (
                    <CueOverlay key={c.id} cue={c} />
                  ))}
                </div>
              </div>
            ) : (
              <NoVideo
                onPick={(file) => {
                  setVideoBroken(false);
                  setLocalVideo(URL.createObjectURL(file));
                }}
                broken={videoBroken}
              />
            )}
          </div>
          {selected && (
            <Transport
              currentTime={currentTime}
              onSetStart={() => updateCue(selected.id, { start: currentTime })}
              onSetEnd={() => updateCue(selected.id, { end: currentTime })}
              onSeekStart={() => seek(selected.start)}
            />
          )}
        </div>

        {/* right: cue table */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "10px 14px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <h2 style={{ fontSize: 14 }}>Cues</h2>
            <button
              className="btn btn-ghost"
              style={{ marginLeft: "auto", color: "var(--accent-2)" }}
              onClick={addCue}
            >
              + at playhead
            </button>
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {sorted.map((c) => (
              <CueRow
                key={c.id}
                cue={c}
                active={c.id === activeId}
                selected={c.id === selectedId}
                onSelect={() => {
                  setSelectedId(c.id);
                  seek(c.start);
                }}
                onChange={(patch) => updateCue(c.id, patch)}
                onDelete={() => deleteCue(c.id)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* bottom: waveform timeline (drag region edges to retime cues) */}
      <div style={{ borderTop: "1px solid var(--border)", background: "var(--bg-1)" }}>
        <div style={{ padding: "6px 14px", fontSize: 12, color: "var(--text-muted)" }}>
          Waveform — drag a region or its edges to retime a cue
        </div>
        <div ref={setWaveEl} style={{ padding: "0 8px 10px", minHeight: 84 }} />
      </div>
    </div>
  );
}

function CueRow({
  cue,
  active,
  selected,
  onSelect,
  onChange,
  onDelete,
}: {
  cue: Cue;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<Cue>) => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        padding: "10px 14px",
        borderBottom: "1px solid var(--border)",
        borderLeft: `3px solid ${active ? "var(--accent-2)" : selected ? "var(--accent)" : "transparent"}`,
        background: selected ? "var(--bg-2)" : active ? "rgba(52,216,201,0.06)" : "transparent",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <TimeField
          value={cue.start}
          onCommit={(v) => onChange({ start: v })}
        />
        <span style={{ color: "var(--text-faint)" }}>→</span>
        <TimeField value={cue.end} onCommit={(v) => onChange({ end: v })} />
        <select
          value={cue.an}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange({ an: parseInt(e.target.value, 10) })}
          title="Alignment"
          style={{ width: 56, padding: "2px 4px", fontSize: 12, marginLeft: "auto" }}
        >
          {AN_GRID.map((n) => (
            <option key={n} value={n}>
              ⌗{n}
            </option>
          ))}
        </select>
        <button
          className="btn btn-ghost"
          style={{ padding: "2px 8px", color: "var(--err)" }}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete cue"
        >
          ✕
        </button>
      </div>
      <textarea
        value={cue.text}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChange({ text: e.target.value })}
        rows={Math.max(1, cue.text.split("\n").length)}
        style={{ resize: "vertical", fontSize: 13, lineHeight: 1.4 }}
      />
    </div>
  );
}

function TimeField({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(displayTime(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(displayTime(value));
  }, [value, editing]);
  return (
    <input
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const v = parseDisplayTime(draft);
        if (v != null) onCommit(v);
        else setDraft(displayTime(value));
      }}
      className="mono"
      style={{ width: 108, padding: "4px 6px", fontSize: 12 }}
    />
  );
}

function Transport({
  currentTime,
  onSetStart,
  onSetEnd,
  onSeekStart,
}: {
  currentTime: number;
  onSetStart: () => void;
  onSetEnd: () => void;
  onSeekStart: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-1)",
      }}
    >
      <span className="mono" style={{ fontSize: 13, color: "var(--accent)" }}>
        {displayTime(currentTime)}
      </span>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>selected cue:</span>
      <button className="btn" onClick={onSeekStart}>
        Go to
      </button>
      <button className="btn" onClick={onSetStart}>
        Set start
      </button>
      <button className="btn" onClick={onSetEnd}>
        Set end
      </button>
    </div>
  );
}

function NoVideo({
  onPick,
  broken,
}: {
  onPick: (f: File) => void;
  broken: boolean;
}) {
  return (
    <div style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>
      <p style={{ marginBottom: 12 }}>
        {broken
          ? "This video can't play in the browser (e.g. MKV/HEVC)."
          : "No preview video loaded."}{" "}
        You can still edit cues and export.
      </p>
      <label className="btn" style={{ cursor: "pointer" }}>
        Load local video
        <input
          type="file"
          accept="video/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
          }}
        />
      </label>
    </div>
  );
}

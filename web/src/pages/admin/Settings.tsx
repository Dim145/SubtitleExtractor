import { useEffect, useState, type FormEvent } from "react";
import { api, APIError } from "../../api/client";
import type { SiteSettings } from "../../api/types";
import { Card, Spinner } from "../../components/ui";

export function Settings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [defaultOcrBackend, setDefaultOcrBackend] = useState("");
  const [defaultFps, setDefaultFps] = useState("4");
  const [defaultMinConfidence, setDefaultMinConfidence] = useState("0.5");
  const [workerDefaultsText, setWorkerDefaultsText] = useState("{}");

  function load(s: SiteSettings) {
    setRegistrationEnabled(s.registrationEnabled);
    setDefaultOcrBackend(s.defaultOcrBackend);
    setDefaultFps(String(s.defaultFps));
    setDefaultMinConfidence(String(s.defaultMinConfidence));
    setWorkerDefaultsText(JSON.stringify(s.workerDefaults ?? {}, null, 2));
  }

  useEffect(() => {
    (async () => {
      try {
        load(await api.admin.settings());
      } catch (err) {
        setError(err instanceof APIError ? err.message : "Failed to load settings");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    let workerDefaults: Record<string, unknown>;
    try {
      const parsed = JSON.parse(workerDefaultsText);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Worker defaults must be a JSON object");
      }
      workerDefaults = parsed as Record<string, unknown>;
    } catch (err) {
      setError(
        err instanceof Error
          ? `Worker defaults: ${err.message}`
          : "Worker defaults: invalid JSON",
      );
      return;
    }

    setSaving(true);
    try {
      const next = await api.admin.saveSettings({
        registrationEnabled,
        defaultOcrBackend,
        defaultFps: Number(defaultFps),
        defaultMinConfidence: Number(defaultMinConfidence),
        workerDefaults,
      });
      load(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <Spinner /> <span style={{ color: "var(--text-muted)" }}>Loading settings…</span>
      </Card>
    );
  }

  return (
    <Card>
      <form onSubmit={submit} style={{ display: "grid", gap: 18, maxWidth: 560 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={registrationEnabled}
            onChange={(e) => setRegistrationEnabled(e.target.checked)}
            style={{ width: "auto" }}
          />
          Allow new user registration
        </label>

        <Field label="Default OCR backend">
          <select
            value={defaultOcrBackend}
            onChange={(e) => setDefaultOcrBackend(e.target.value)}
          >
            <option value="">none (worker default)</option>
            <option value="rapidocr">RapidOCR</option>
            <option value="ppocr">PP-OCR</option>
          </select>
        </Field>

        <Field label="Default sample FPS">
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            value={defaultFps}
            onChange={(e) => setDefaultFps(e.target.value)}
          />
        </Field>

        <Field label="Default minimum confidence (0–1)">
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={defaultMinConfidence}
            onChange={(e) => setDefaultMinConfidence(e.target.value)}
          />
        </Field>

        <Field label="Worker defaults (JSON)">
          <textarea
            value={workerDefaultsText}
            onChange={(e) => setWorkerDefaultsText(e.target.value)}
            rows={8}
            spellCheck={false}
            className="mono"
            style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
        </Field>

        {error && (
          <p role="alert" style={{ color: "var(--err)", fontSize: 13, margin: 0 }}>
            {error}
          </p>
        )}
        {saved && !error && (
          <p style={{ color: "var(--ok)", fontSize: 13, margin: 0 }}>Settings saved.</p>
        )}

        <div>
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

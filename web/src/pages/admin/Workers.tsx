import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { api, APIError } from "../../api/client";
import type { ConfigField, Worker } from "../../api/types";
import { Card, EmptyState, Spinner } from "../../components/ui";
import { formatRelative } from "../../lib/format";

const STATUS_COLOR: Record<Worker["status"], string> = {
  online: "var(--ok)",
  busy: "var(--accent-2)",
  offline: "var(--text-faint)",
};

export function Workers() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setWorkers(await api.admin.workers());
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to load workers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  if (loading) {
    return (
      <Card>
        <Spinner /> <span style={{ color: "var(--text-muted)" }}>Loading workers…</span>
      </Card>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error && (
        <p role="alert" style={{ color: "var(--err)", fontSize: 13, margin: 0 }}>
          {error}
        </p>
      )}

      {workers.length === 0 ? (
        <Card>
          <EmptyState
            title="No workers"
            hint="No workers have registered yet."
          />
        </Card>
      ) : (
        workers.map((w) => (
          <WorkerRow key={w.id} worker={w} onChanged={refresh} />
        ))
      )}
    </div>
  );
}

function initialFormValues(
  schema: ConfigField[],
  config: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of schema) {
    values[field.key] = config[field.key] ?? field.default;
  }
  return values;
}

function WorkerRow({ worker, onChanged }: { worker: Worker; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const schema = worker.capabilities?.config_schema as ConfigField[] | undefined;
  const hasSchema = Array.isArray(schema) && schema.length > 0;

  const [configText, setConfigText] = useState(() =>
    JSON.stringify(worker.config ?? {}, null, 2),
  );
  const [formValues, setFormValues] = useState<Record<string, unknown>>(() =>
    hasSchema ? initialFormValues(schema, worker.config ?? {}) : {},
  );
  // Track the last server config we synced so live polling doesn't clobber edits.
  const lastSynced = useRef(JSON.stringify(worker.config ?? {}, null, 2));

  useEffect(() => {
    const incoming = JSON.stringify(worker.config ?? {}, null, 2);
    // Only sync from the server when the editor is closed, so a user actively
    // editing a config form (or the JSON textarea) is never clobbered by polling.
    if (!open && incoming !== lastSynced.current) {
      setConfigText(incoming);
      if (hasSchema) {
        setFormValues(initialFormValues(schema, worker.config ?? {}));
      }
      lastSynced.current = incoming;
    }
  }, [worker.config, open, hasSchema, schema]);

  function setField(key: string, value: unknown) {
    setSaved(false);
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }

  async function saveForm() {
    if (!hasSchema) return;
    setError(null);
    setSaved(false);
    const values: Record<string, unknown> = {};
    for (const field of schema) {
      const raw = formValues[field.key];
      if (field.type === "number") {
        values[field.key] = raw === "" || raw == null ? field.default ?? null : Number(raw);
      } else if (field.type === "boolean") {
        values[field.key] = Boolean(raw);
      } else {
        values[field.key] = raw ?? "";
      }
    }
    setBusy(true);
    try {
      await api.admin.patchWorker(worker.id, { config: values });
      lastSynced.current = JSON.stringify(values, null, 2);
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to save config");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled() {
    setBusy(true);
    setError(null);
    try {
      await api.admin.patchWorker(worker.id, { enabled: !worker.enabled });
      onChanged();
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to update worker");
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    setError(null);
    setSaved(false);
    let config: Record<string, unknown>;
    try {
      const parsed = JSON.parse(configText);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Config must be a JSON object");
      }
      config = parsed as Record<string, unknown>;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON");
      return;
    }
    setBusy(true);
    try {
      await api.admin.patchWorker(worker.id, { config });
      lastSynced.current = JSON.stringify(config, null, 2);
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to save config");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete worker ${worker.name}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.admin.deleteWorker(worker.id);
      onChanged();
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to delete worker");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: 16,
          alignItems: "center",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: STATUS_COLOR[worker.status],
                boxShadow:
                  worker.status === "busy"
                    ? `0 0 8px ${STATUS_COLOR[worker.status]}`
                    : "none",
                flexShrink: 0,
              }}
            />
            <span className="mono" style={{ fontWeight: 600, fontSize: 14 }}>
              {worker.name}
            </span>
            <span
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                border: "1px solid var(--border-strong)",
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              {worker.workerClass}
            </span>
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              marginTop: 6,
              display: "flex",
              gap: 14,
              flexWrap: "wrap",
            }}
          >
            <span
              className="mono"
              style={{ color: STATUS_COLOR[worker.status], textTransform: "uppercase" }}
            >
              {worker.status}
            </span>
            <span>heartbeat {formatRelative(worker.lastHeartbeat)}</span>
            <span>config v{worker.configVersion}</span>
            {worker.status === "busy" && worker.currentJobLabel && (
              <span style={{ color: "var(--accent-2)" }}>
                running: {worker.currentJobLabel}
              </span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            <input
              type="checkbox"
              checked={worker.enabled}
              disabled={busy}
              onChange={toggleEnabled}
              style={{ width: "auto" }}
            />
            enabled
          </label>
          <button
            className="btn btn-ghost"
            onClick={() =>
              setOpen((o) => {
                if (o) {
                  setError(null);
                  setSaved(false);
                }
                return !o;
              })
            }
          >
            {open ? "Hide" : "Config"}
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={remove}
            style={{ color: "var(--err)" }}
          >
            Delete
          </button>
        </div>
      </div>

      {open && hasSchema && (
        <div style={{ marginTop: 16, display: "grid", gap: 14 }}>
          {schema.map((field) => (
            <ConfigFieldControl
              key={field.key}
              field={field}
              value={formValues[field.key]}
              onChange={(v) => setField(field.key, v)}
            />
          ))}
          {error && (
            <p role="alert" style={{ color: "var(--err)", fontSize: 13, margin: 0 }}>
              {error}
            </p>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button className="btn btn-primary" disabled={busy} onClick={saveForm}>
              {busy ? "Saving…" : "Save config"}
            </button>
            {saved && (
              <span role="status" style={{ color: "var(--ok)", fontSize: 13 }}>
                Saved
              </span>
            )}
          </div>
        </div>
      )}

      {open && !hasSchema && (
        <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
          <label
            htmlFor={`worker-config-${worker.id}`}
            style={{ fontSize: 12, color: "var(--text-muted)" }}
          >
            Config (JSON)
          </label>
          <textarea
            id={`worker-config-${worker.id}`}
            value={configText}
            onChange={(e) => {
              setSaved(false);
              setConfigText(e.target.value);
            }}
            rows={10}
            spellCheck={false}
            className="mono"
            style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
          {error && (
            <p role="alert" style={{ color: "var(--err)", fontSize: 13, margin: 0 }}>
              {error}
            </p>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button className="btn btn-primary" disabled={busy} onClick={saveConfig}>
              {busy ? "Saving…" : "Save config"}
            </button>
            {saved && (
              <span role="status" style={{ color: "var(--ok)", fontSize: 13 }}>
                Saved
              </span>
            )}
          </div>
        </div>
      )}

      {!open && error && (
        <p role="alert" style={{ color: "var(--err)", fontSize: 13, margin: "12px 0 0" }}>
          {error}
        </p>
      )}
    </Card>
  );
}

function ConfigFieldControl({
  field,
  value,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `cfg-${field.key}`;
  const helpId = field.help ? `${id}-help` : undefined;
  const labelStyle: CSSProperties = {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text)",
  };
  const help = field.help && (
    <p
      id={helpId}
      style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 0" }}
    >
      {field.help}
    </p>
  );

  if (field.type === "boolean") {
    return (
      <div>
        <label
          htmlFor={id}
          style={{ display: "flex", alignItems: "center", gap: 8, ...labelStyle }}
        >
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            aria-describedby={helpId}
            style={{ width: "auto" }}
          />
          {field.label}
        </label>
        {help}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <label htmlFor={id} style={labelStyle}>
        {field.label}
      </label>
      {field.type === "select" ? (
        <select
          id={id}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={helpId}
        >
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : field.type === "number" ? (
        <input
          id={id}
          type="number"
          value={value == null ? "" : String(value)}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={helpId}
        />
      ) : (
        <input
          id={id}
          type="text"
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={helpId}
        />
      )}
      {help}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { api, APIError } from "../../api/client";
import type { OCRSubstitutionRule, SiteSettings } from "../../api/types";
import { Card, EmptyState, Spinner } from "../../components/ui";

// Languages offered for the per-rule "Apply to" selector. "all" = every job.
const LANGS = ["all", "fr", "en", "es", "de", "it", "pt", "nl", "ja", "zh", "ko", "ru", "ar"];

const COLS = "1fr 1fr 78px 132px 40px";

function blankRule(): OCRSubstitutionRule {
  return { find: "", replace: "", isRegex: false, applyTo: "all" };
}

function regexError(rule: OCRSubstitutionRule): string | null {
  if (!rule.isRegex || !rule.find) return null;
  try {
    new RegExp(rule.find);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid regular expression";
  }
}

export function Substitutions() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The rest of the settings, preserved untouched on save.
  const [base, setBase] = useState<SiteSettings | null>(null);
  const [rules, setRules] = useState<OCRSubstitutionRule[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.admin.settings();
        setBase(s);
        setRules(s.ocrSubstitutionRules ?? []);
      } catch (err) {
        setError(err instanceof APIError ? err.message : "Failed to load rules");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const rowErrors = useMemo(() => rules.map(regexError), [rules]);
  const hasErrors = rowErrors.some(Boolean);

  function patch(i: number, change: Partial<OCRSubstitutionRule>) {
    setSaved(false);
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...change } : r)));
  }
  function addRule() {
    setSaved(false);
    setRules((rs) => [...rs, blankRule()]);
  }
  function removeRule(i: number) {
    setSaved(false);
    setRules((rs) => rs.filter((_, idx) => idx !== i));
  }

  async function save() {
    if (!base || hasErrors) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    // Drop rules with an empty "find" — they would be no-ops.
    const clean = rules.filter((r) => r.find.trim() !== "");
    try {
      const next = await api.admin.saveSettings({ ...base, ocrSubstitutionRules: clean });
      setBase(next);
      setRules(next.ocrSubstitutionRules ?? []);
      setSaved(true);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to save rules");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <Spinner /> <span style={{ color: "var(--text-muted)" }}>Loading rules…</span>
      </Card>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>OCR substitutions</h2>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", maxWidth: 560 }}>
              Find &amp; replace rules applied to recognized subtitle text after extraction,
              on <strong>every worker</strong>. Use them to fix recurring OCR mistakes or strip
              watermarks. Literal by default; enable <em>Regex</em> for patterns (e.g.{" "}
              <code className="mono">\s+,</code> → <code className="mono">,</code>).
            </p>
          </div>
          <button className="btn" type="button" onClick={addRule} style={{ flexShrink: 0 }}>
            + Add rule
          </button>
        </div>
      </Card>

      <Card style={{ padding: rules.length ? "10px 12px 16px" : 0 }}>
        {rules.length === 0 ? (
          <EmptyState
            title="No substitution rules"
            hint="Add a rule to automatically correct recognized text across all workers."
            action={
              <button className="btn btn-primary" type="button" onClick={addRule}>
                + Add your first rule
              </button>
            }
          />
        ) : (
          <div role="table" aria-label="OCR substitution rules" style={{ display: "grid", gap: 8 }}>
            <div
              role="row"
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: 10,
                padding: "4px 6px",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--text-faint)",
              }}
            >
              <span role="columnheader">Find</span>
              <span role="columnheader">Replace with</span>
              <span role="columnheader" style={{ textAlign: "center" }}>Regex</span>
              <span role="columnheader">Apply to</span>
              <span role="columnheader" aria-label="Remove" />
            </div>

            {rules.map((rule, i) => {
              const err = rowErrors[i];
              return (
                <div key={i} role="row" style={{ display: "grid", gap: 4 }}>
                  <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 10, alignItems: "center" }}>
                    <input
                      aria-label={`Find (row ${i + 1})`}
                      className="mono"
                      value={rule.find}
                      placeholder="text or pattern"
                      onChange={(e) => patch(i, { find: e.target.value })}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 13,
                        borderColor: err ? "var(--err)" : undefined,
                      }}
                    />
                    <input
                      aria-label={`Replace with (row ${i + 1})`}
                      className="mono"
                      value={rule.replace}
                      placeholder="replacement"
                      onChange={(e) => patch(i, { replace: e.target.value })}
                      style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}
                    />
                    <label
                      style={{ display: "flex", justifyContent: "center", cursor: "pointer" }}
                      title="Treat 'Find' as a regular expression"
                    >
                      <input
                        type="checkbox"
                        aria-label={`Regex (row ${i + 1})`}
                        checked={rule.isRegex}
                        onChange={(e) => patch(i, { isRegex: e.target.checked })}
                        style={{ width: "auto" }}
                      />
                    </label>
                    <select
                      aria-label={`Apply to (row ${i + 1})`}
                      value={rule.applyTo || "all"}
                      onChange={(e) => patch(i, { applyTo: e.target.value })}
                      style={{ fontSize: 13 }}
                    >
                      {LANGS.map((l) => (
                        <option key={l} value={l}>
                          {l === "all" ? "All languages" : l}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      aria-label={`Remove rule ${i + 1}`}
                      title="Remove rule"
                      onClick={() => removeRule(i)}
                      style={{ padding: "6px 8px", color: "var(--err)" }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  {err && (
                    <p role="alert" style={{ margin: "0 0 0 2px", fontSize: 12, color: "var(--err)" }}>
                      Invalid regex: {err}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button className="btn btn-primary" type="button" onClick={save} disabled={saving || hasErrors}>
          {saving ? "Saving…" : "Save rules"}
        </button>
        {hasErrors && (
          <span style={{ fontSize: 13, color: "var(--err)" }}>Fix the invalid regex before saving.</span>
        )}
        {error && (
          <span role="alert" style={{ fontSize: 13, color: "var(--err)" }}>{error}</span>
        )}
        {saved && !error && (
          <span style={{ fontSize: 13, color: "var(--ok)" }}>Rules saved.</span>
        )}
      </div>
    </div>
  );
}

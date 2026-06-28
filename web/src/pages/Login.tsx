import { useState, type FormEvent } from "react";
import { api, APIError } from "../api/client";
import { useAuth } from "../auth/AuthContext";

export function Login() {
  const { config, login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canRegister = config?.localRegistrationEnabled ?? false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password, displayName);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 9,
              background: "var(--accent)",
              boxShadow: "0 0 24px rgba(245,181,68,0.4)",
              margin: "0 auto 16px",
            }}
          />
          <h1 style={{ fontSize: 22, marginBottom: 6 }}>SubtitleExtractor</h1>
          <p style={{ color: "var(--text-muted)", margin: 0, fontSize: 13 }}>
            Extract hardcoded subtitles · edit in the browser
          </p>
        </div>

        <div
          style={{
            background: "var(--bg-1)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 24,
          }}
        >
          {config?.localEnabled && (
            <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
              {mode === "register" && (
                <Field label="Display name">
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Ada Lovelace"
                    autoComplete="name"
                  />
                </Field>
              )}
              <Field label="Email">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@studio.com"
                  autoComplete="email"
                  required
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  required
                />
              </Field>

              {error && (
                <p
                  role="alert"
                  style={{ color: "var(--err)", fontSize: 13, margin: 0 }}
                >
                  {error}
                </p>
              )}

              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
              </button>
            </form>
          )}

          {config?.oidcEnabled && (
            <>
              {config.localEnabled && <Divider />}
              <a className="btn" href={api.oidcLoginUrl()} style={{ width: "100%" }}>
                Continue with SSO
              </a>
            </>
          )}

          {!config?.localEnabled && !config?.oidcEnabled && (
            <p style={{ color: "var(--text-muted)", textAlign: "center", margin: 0 }}>
              No sign-in methods are enabled.
            </p>
          )}
        </div>

        {config?.localEnabled && canRegister && (
          <p style={{ textAlign: "center", marginTop: 16, fontSize: 13, color: "var(--text-muted)" }}>
            {mode === "login" ? "No account yet?" : "Already have an account?"}{" "}
            <button
              className="btn btn-ghost"
              style={{ padding: "2px 6px", color: "var(--accent-2)" }}
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError(null);
              }}
            >
              {mode === "login" ? "Register" : "Sign in"}
            </button>
          </p>
        )}
      </div>
    </div>
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

function Divider() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        margin: "16px 0",
        color: "var(--text-faint)",
        fontSize: 12,
      }}
    >
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
      or
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
    </div>
  );
}

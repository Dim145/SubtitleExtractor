import { useEffect, useState } from "react";
import { api, APIError } from "../../api/client";
import type { User } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { Card, EmptyState, Spinner } from "../../components/ui";
import { formatRelative } from "../../lib/format";

export function Users() {
  const { user, config } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    try {
      setUsers(await api.admin.users());
      setError(null);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function toggleAdmin(row: User) {
    setBusyId(row.id);
    setError(null);
    try {
      await api.admin.setUserAdmin(row.id, !row.isAdmin);
      await refresh();
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to update user");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: User) {
    if (!window.confirm(`Delete user ${row.email}? This cannot be undone.`)) return;
    setBusyId(row.id);
    setError(null);
    try {
      await api.admin.deleteUser(row.id);
      await refresh();
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to delete user");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <Card>
        <Spinner /> <span style={{ color: "var(--text-muted)" }}>Loading users…</span>
      </Card>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {config?.localRegistrationEnabled ? (
        <CreateUserForm onCreated={refresh} />
      ) : (
        <p style={{ color: "var(--text-faint)", fontSize: 12, margin: 0 }}>
          Local registration is disabled in Settings.
        </p>
      )}

      {error && (
        <p role="alert" style={{ color: "var(--err)", fontSize: 13, margin: 0 }}>
          {error}
        </p>
      )}

      {users.length === 0 ? (
        <Card>
          <EmptyState title="No users" hint="No users have been created yet." />
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 110px 90px 110px 80px",
              gap: 12,
              padding: "12px 18px",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text-muted)",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-2)",
            }}
          >
            <span>User</span>
            <span>Provider</span>
            <span>Admin</span>
            <span>Created</span>
            <span style={{ textAlign: "right" }}>Actions</span>
          </div>

          {users.map((row) => {
            const isSelf = user?.id === row.id;
            const disabled = busyId === row.id;
            return (
              <div
                key={row.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 110px 90px 110px 80px",
                  gap: 12,
                  padding: "12px 18px",
                  alignItems: "center",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 13,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {row.displayName || row.email}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-faint)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {row.email}
                  </div>
                </div>

                <span>
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
                    {row.provider}
                  </span>
                </span>

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    color: isSelf ? "var(--text-faint)" : "var(--text-muted)",
                  }}
                  title={isSelf ? "You cannot change your own admin status" : undefined}
                >
                  <input
                    type="checkbox"
                    checked={row.isAdmin}
                    disabled={isSelf || disabled}
                    onChange={() => toggleAdmin(row)}
                    style={{ width: "auto" }}
                  />
                  admin
                </label>

                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {formatRelative(row.createdAt)}
                </span>

                <div style={{ textAlign: "right" }}>
                  <button
                    className="btn btn-ghost"
                    disabled={isSelf || disabled}
                    onClick={() => remove(row)}
                    title={isSelf ? "You cannot delete yourself" : "Delete user"}
                    style={{ color: isSelf ? undefined : "var(--err)" }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

function CreateUserForm({ onCreated }: { onCreated: () => Promise<void> | void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  function validateEmail(value: string): string | null {
    if (!value.trim()) return "Email is required.";
    return null;
  }

  function validatePassword(value: string): string | null {
    if (value.length < 8) return "Password must be at least 8 characters.";
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSuccess(false);
    const emErr = validateEmail(email);
    const pwErr = validatePassword(password);
    setEmailError(emErr);
    setPasswordError(pwErr);
    if (emErr || pwErr) return;

    setBusy(true);
    try {
      await api.admin.createUser({
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
        isAdmin,
      });
      setEmail("");
      setPassword("");
      setDisplayName("");
      setIsAdmin(false);
      setShowPassword(false);
      setSuccess(true);
      await onCreated();
    } catch (err) {
      setFormError(err instanceof APIError ? err.message : "Failed to create user");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 14px" }}>New user</h2>
      <form onSubmit={submit} noValidate style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <label htmlFor="new-user-email" style={{ fontSize: 13, fontWeight: 500 }}>
            Email
          </label>
          <input
            id="new-user-email"
            type="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError) setEmailError(null);
              setSuccess(false);
            }}
            onBlur={() => setEmailError(validateEmail(email))}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? "new-user-email-error" : undefined}
          />
          {emailError && (
            <p
              id="new-user-email-error"
              role="alert"
              style={{ color: "var(--err)", fontSize: 12, margin: 0 }}
            >
              {emailError}
            </p>
          )}
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <label htmlFor="new-user-password" style={{ fontSize: 13, fontWeight: 500 }}>
            Password
          </label>
          <div style={{ position: "relative" }}>
            <input
              id="new-user-password"
              type={showPassword ? "text" : "password"}
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (passwordError) setPasswordError(null);
                setSuccess(false);
              }}
              onBlur={() => setPasswordError(validatePassword(password))}
              aria-invalid={passwordError ? true : undefined}
              aria-describedby={
                passwordError ? "new-user-password-error" : "new-user-password-help"
              }
              style={{ width: "100%", paddingRight: 64 }}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              style={{
                position: "absolute",
                right: 4,
                top: "50%",
                transform: "translateY(-50%)",
                padding: "2px 8px",
                fontSize: 12,
              }}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
          {passwordError ? (
            <p
              id="new-user-password-error"
              role="alert"
              style={{ color: "var(--err)", fontSize: 12, margin: 0 }}
            >
              {passwordError}
            </p>
          ) : (
            <p
              id="new-user-password-help"
              style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}
            >
              At least 8 characters.
            </p>
          )}
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <label htmlFor="new-user-name" style={{ fontSize: 13, fontWeight: 500 }}>
            Display name <span style={{ color: "var(--text-faint)" }}>(optional)</span>
          </label>
          <input
            id="new-user-name"
            type="text"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setSuccess(false);
            }}
          />
        </div>

        <label
          htmlFor="new-user-admin"
          style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
        >
          <input
            id="new-user-admin"
            type="checkbox"
            checked={isAdmin}
            onChange={(e) => {
              setIsAdmin(e.target.checked);
              setSuccess(false);
            }}
            style={{ width: "auto" }}
          />
          Admin
        </label>

        {formError && (
          <p role="alert" style={{ color: "var(--err)", fontSize: 13, margin: 0 }}>
            {formError}
          </p>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Create user"}
          </button>
          {success && (
            <span role="status" style={{ color: "var(--ok)", fontSize: 13 }}>
              User created
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

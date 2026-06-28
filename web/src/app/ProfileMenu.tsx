import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { LogOut, UserCog, ShieldCheck, X, Check } from "lucide-react";
import { useMe, useLogout, useUpdateProfile } from "@/api/auth";
import { APIError } from "@/api/client";
import type { User } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";

function initials(name: string, email: string): string {
  const base = (name || email || "?").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

const avatarCls = "grid place-items-center rounded-full bg-gradient-to-br from-amber to-accent font-bold text-[#06121a]";

export function ProfileMenu() {
  const { data: me } = useMe();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  if (!me) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title={me.email}
        className={cn(avatarCls, "size-8 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent")}
      >
        {initials(me.displayName, me.email)}
      </button>

      {open && (
        <div role="menu" className="animate-in absolute right-0 z-40 mt-2 w-64 origin-top-right rounded-xl border border-border-strong bg-surface p-1.5 shadow-2xl" style={{ animationDuration: "0.16s" }}>
          <div className="flex items-center gap-2.5 px-2 py-2">
            <div className={cn(avatarCls, "size-9 text-sm")}>{initials(me.displayName, me.email)}</div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{me.displayName || me.email}</div>
              <div className="truncate text-xs text-faint">{me.email}</div>
            </div>
          </div>
          {me.provider === "oidc" && (
            <div className="mx-2 mb-1 flex items-center gap-1.5 text-[11px] text-faint"><ShieldCheck className="size-3" /> Signed in via SSO</div>
          )}
          <div className="my-1 h-px bg-border" />

          <MenuItem icon={UserCog} onClick={() => { setOpen(false); setEditing(true); }}>
            {me.provider === "local" ? "Edit profile" : "View profile"}
          </MenuItem>
          {me.isAdmin && (
            <Link to="/admin" onClick={() => setOpen(false)}>
              <MenuItem icon={ShieldCheck}>Admin</MenuItem>
            </Link>
          )}
          <div className="my-1 h-px bg-border" />
          <MenuItem icon={LogOut} danger onClick={() => logout.mutate()}>Sign out</MenuItem>
        </div>
      )}

      {editing && <ProfileModal me={me} onClose={() => setEditing(false)} />}
    </div>
  );
}

function MenuItem({ icon: Icon, children, onClick, danger }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; onClick?: () => void; danger?: boolean }) {
  return (
    <button
      role="menuitem" onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
        danger ? "text-muted hover:bg-err/10 hover:text-err" : "text-text hover:bg-surface-2",
      )}
    >
      <Icon className="size-4 opacity-80" /> {children}
    </button>
  );
}

const field = "h-9 w-full rounded-lg border border-border-strong bg-surface-2 px-3 text-sm outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-60";
const labelCls = "grid gap-1.5 text-sm";
const spanCls = "text-xs font-medium text-muted";

function ProfileModal({ me, onClose }: { me: User; onClose: () => void }) {
  const upd = useUpdateProfile();
  const oidc = me.provider !== "local";
  const [displayName, setDisplayName] = useState(me.displayName);
  const [email, setEmail] = useState(me.email);
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [done, setDone] = useState(false);

  const emailChanged = email.trim().toLowerCase() !== me.email;
  const nameChanged = displayName.trim() !== me.displayName;
  const pwChanged = password.length > 0;
  const needsCurrent = emailChanged || pwChanged;
  const dirty = emailChanged || nameChanged || pwChanged;
  const err = upd.error instanceof APIError ? upd.error.message : upd.isError ? "Something went wrong" : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty) { onClose(); return; }
    upd.mutate(
      {
        displayName: nameChanged ? displayName.trim() : undefined,
        email: emailChanged ? email.trim() : undefined,
        password: pwChanged ? password : undefined,
        currentPassword: needsCurrent ? current : undefined,
      },
      { onSuccess: () => { setDone(true); setPassword(""); setCurrent(""); window.setTimeout(onClose, 700); } },
    );
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="animate-in w-full max-w-md rounded-2xl border border-border-strong bg-surface p-5 shadow-2xl" style={{ animationDuration: "0.18s" }}>
        <div className="mb-4 flex items-center justify-between">
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Your profile</div>
          <button onClick={onClose} className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"><X className="size-4" /></button>
        </div>

        {oidc ? (
          <div className="grid gap-3">
            <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-muted">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" />
              <span>Your account is managed by your SSO provider. Name, email and password are changed there, not here.</span>
            </div>
            <label className={labelCls}><span className={spanCls}>Display name</span><input className={field} value={me.displayName} disabled /></label>
            <label className={labelCls}><span className={spanCls}>Email</span><input className={field} value={me.email} disabled /></label>
            <div className="mt-1 flex justify-end"><Button variant="default" size="sm" onClick={onClose}>Close</Button></div>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-3" noValidate>
            <label className={labelCls}>
              <span className={spanCls}>Display name</span>
              <input className={field} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Email</span>
              <input className={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>New password <span className="text-faint">· leave blank to keep</span></span>
              <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
            </label>
            {needsCurrent && (
              <label className={labelCls}>
                <span className={spanCls}>Current password <span className="text-accent">· required to change email/password</span></span>
                <input className={field} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
              </label>
            )}

            {err && <p role="alert" className="text-sm text-err">{err}</p>}

            <div className="mt-1 flex items-center justify-end gap-2">
              {done && <span className="mr-auto flex items-center gap-1 text-xs text-ok"><Check className="size-3.5" /> Saved</span>}
              <Button variant="default" size="sm" type="button" onClick={onClose}>Cancel</Button>
              <Button variant="primary" size="sm" type="submit" disabled={upd.isPending || !dirty || (needsCurrent && !current)}>
                {upd.isPending ? <Spinner className="border-accent-foreground/40 border-t-accent-foreground" /> : <Check className="size-3.5" />} Save changes
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

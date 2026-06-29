import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Trash2, Plus, X, ChevronDown, Check, Play, ChevronRight, CircleCheck, TriangleAlert, CircleX, Film } from "lucide-react";
import {
  useUsers, useCreateUser, usePatchUser, useDeleteUser,
  useAdminSettings, useSaveSettings, useCleanupRuns, useRunCleanup,
  useAdminWorkers, usePatchWorker, useDeleteWorker,
} from "@/api/admin";
import type { CleanupRun, ConfigField, OCRSubstitutionRule, SiteSettings, Worker } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useDialog } from "@/components/ui/useDialog";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/cn";

const TABS = [
  { id: "workers", label: "Workers" },
  { id: "subs", label: "Substitutions" },
  { id: "users", label: "Users" },
  { id: "settings", label: "Settings" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const input = "h-9 w-full rounded-lg border border-border-strong bg-surface-2 px-3 text-sm outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/25";
const eyebrow = "text-[11px] font-bold uppercase tracking-[0.12em] text-faint";

/** Parse a numeric input value, tolerating a comma decimal separator (locales
 * like fr-FR). Returns null for blank/invalid so callers can keep the old value. */
function parseDecimal(raw: string): number | null {
  const v = raw.trim().replace(",", ".");
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function Admin() {
  const [tab, setTab] = useState<Tab>("workers");
  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <div className={eyebrow}>System</div>
      <h1 className="mt-1 mb-5 text-2xl font-semibold tracking-tight">Administration</h1>
      <div className="mb-6 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cn("-mb-px border-b-2 px-3 py-2 text-[13px] font-medium",
              tab === t.id ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "workers" && <Workers />}
      {tab === "subs" && <Substitutions />}
      {tab === "users" && <Users />}
      {tab === "settings" && <Settings />}
    </div>
  );
}

// ---------------- Workers ----------------
function Workers() {
  const workers = useAdminWorkers();
  const patch = usePatchWorker();
  const del = useDeleteWorker();
  const [openId, setOpenId] = useState<string | null>(null);

  if (workers.isLoading) return <Loading />;
  if (!workers.data?.length) return <Empty msg="No workers have registered yet." />;

  const dot = (s: Worker["status"]) => s === "online" ? "bg-ok" : s === "busy" ? "bg-accent animate-pulse" : "bg-faint";

  return (
    <div className="grid gap-3">
      {workers.data.map((w) => (
        <div key={w.id} className="rounded-xl border border-border bg-surface">
          <div className="flex items-center gap-3 px-4 py-3">
            <span className={cn("size-2 rounded-full", dot(w.status))} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{w.name}</div>
              <div className="font-mono text-xs text-faint">{w.workerClass} · {w.status}{w.lastHeartbeat ? ` · seen ${new Date(w.lastHeartbeat).toLocaleTimeString()}` : ""}</div>
            </div>
            <Switch checked={w.enabled} onCheckedChange={(v) => patch.mutate({ id: w.id, enabled: v })} aria-label={w.enabled ? "Enabled" : "Disabled"} />
            <Button variant="ghost" size="sm" onClick={() => setOpenId(openId === w.id ? null : w.id)}>
              Configure <ChevronDown className={cn("size-3.5 transition-transform", openId === w.id && "rotate-180")} />
            </Button>
            <Button variant="ghost" size="icon" className="hover:text-err" onClick={() => del.mutate(w.id)}><Trash2 className="size-4" /></Button>
          </div>
          {openId === w.id && <WorkerConfig worker={w} />}
        </div>
      ))}
    </div>
  );
}

function WorkerConfig({ worker }: { worker: Worker }) {
  const patch = usePatchWorker();
  const [saved, setSaved] = useState(false);
  const schema = (worker.capabilities?.config_schema as ConfigField[] | undefined) ?? [];
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of schema) v[f.key] = worker.config?.[f.key] ?? f.default;
    return v;
  });
  function save() {
    setSaved(false);
    patch.mutate(
      { id: worker.id, config: values },
      { onSuccess: () => { setSaved(true); window.setTimeout(() => setSaved(false), 2500); } },
    );
  }
  if (!schema.length) return <div className="border-t border-border px-4 py-3 text-sm text-muted">This worker advertises no configurable parameters.</div>;
  const set = (k: string, val: unknown) => setValues((p) => ({ ...p, [k]: val }));
  return (
    <div className="border-t border-border px-4 py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {schema.map((f) => (
          <label key={f.key} className="grid gap-1">
            <span className="text-xs font-medium text-muted">{f.label}</span>
            {f.type === "select" ? (
              <select className={input} value={String(values[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === "boolean" ? (
              <div className="pt-0.5"><Switch checked={Boolean(values[f.key])} onCheckedChange={(v) => set(f.key, v)} aria-label={f.label} /></div>
            ) : f.type === "number" ? (
              <input type="number" inputMode="decimal" className={input} min={f.min} max={f.max} step={f.step} value={String(values[f.key] ?? "")} onChange={(e) => { const n = parseDecimal(e.target.value); set(f.key, n ?? (e.target.value.trim() === "" ? "" : values[f.key])); }} />
            ) : (
              <input className={input} value={String(values[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />
            )}
            {f.help && <span className="text-[11px] text-faint">{f.help}</span>}
          </label>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" size="sm" onClick={save} disabled={patch.isPending}>
          {patch.isPending ? (
            <><Spinner className="border-accent-foreground/40 border-t-accent-foreground" /> Saving…</>
          ) : saved ? (
            <><Check className="size-3.5" /> Saved</>
          ) : (
            "Save config"
          )}
        </Button>
        {saved && !patch.isPending && (
          <span className="flex items-center gap-1 text-xs text-ok" role="status"><Check className="size-3.5" /> Configuration saved</span>
        )}
        {patch.isError && <span className="text-xs text-err" role="alert">Save failed — try again.</span>}
      </div>
    </div>
  );
}

// ---------------- Substitutions ----------------
const LANGS = ["all", "fr", "en", "es", "de", "it", "pt", "nl", "ja", "zh", "ko"];
function regexError(r: OCRSubstitutionRule): boolean {
  if (!r.isRegex || !r.find) return false;
  try { new RegExp(r.find); return false; } catch { return true; }
}
function Substitutions() {
  const settings = useAdminSettings();
  const save = useSaveSettings();
  const [rules, setRules] = useState<OCRSubstitutionRule[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (settings.data) setRules(settings.data.ocrSubstitutionRules ?? []); }, [settings.data]);
  const bad = useMemo(() => rules.some(regexError), [rules]);
  if (settings.isLoading) return <Loading />;

  const patch = (i: number, p: Partial<OCRSubstitutionRule>) => { setSaved(false); setRules((rs) => rs.map((r, idx) => idx === i ? { ...r, ...p } : r)); };
  function submit() {
    if (!settings.data || bad) return;
    save.mutate({ ...settings.data, ocrSubstitutionRules: rules.filter((r) => r.find.trim()) }, { onSuccess: () => setSaved(true) });
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between">
        <div><div className={eyebrow}>OCR substitutions</div><p className="mt-1 text-sm text-muted">Find &amp; replace applied on every worker after extraction.</p></div>
        <Button size="sm" onClick={() => { setSaved(false); setRules((r) => [...r, { find: "", replace: "", isRegex: false, applyTo: "all" }]); }}><Plus className="size-3.5" /> Add rule</Button>
      </div>
      {rules.length === 0 ? <p className="py-6 text-center text-sm text-muted">No rules yet.</p> : (
        <div className="grid gap-2">
          <div className="grid grid-cols-[1fr_1fr_64px_120px_36px] gap-2 text-[10px] font-bold uppercase tracking-wide text-faint">
            <span>Find</span><span>Replace</span><span className="text-center">Regex</span><span>Apply to</span><span />
          </div>
          {rules.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_64px_120px_36px] items-center gap-2">
              <input className={cn(input, "font-mono", regexError(r) && "border-err")} value={r.find} onChange={(e) => patch(i, { find: e.target.value })} placeholder="pattern" />
              <input className={cn(input, "font-mono")} value={r.replace} onChange={(e) => patch(i, { replace: e.target.value })} placeholder="replacement" />
              <div className="flex justify-center"><Switch checked={r.isRegex} onCheckedChange={(v) => patch(i, { isRegex: v })} aria-label="Regex" /></div>
              <select className={input} value={r.applyTo} onChange={(e) => patch(i, { applyTo: e.target.value })}>
                {LANGS.map((l) => <option key={l} value={l}>{l === "all" ? "All" : l}</option>)}
              </select>
              <Button variant="ghost" size="icon" className="hover:text-err" onClick={() => setRules((rs) => rs.filter((_, idx) => idx !== i))}><X className="size-4" /></Button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" size="sm" onClick={submit} disabled={bad || save.isPending}>Save rules</Button>
        {bad && <span className="text-xs text-err">Fix the invalid regex first.</span>}
        {saved && <span className="text-xs text-ok">Saved.</span>}
      </div>
    </div>
  );
}

// ---------------- Users ----------------
function Users() {
  const users = useUsers();
  const create = useCreateUser();
  const patch = usePatchUser();
  const del = useDeleteUser();
  const [email, setEmail] = useState(""); const [pw, setPw] = useState(""); const [name, setName] = useState("");
  if (users.isLoading) return <Loading />;
  return (
    <div className="grid gap-4">
      <div className="overflow-hidden rounded-xl border border-border">
        {users.data?.map((u, i) => (
          <div key={u.id} className={cn("flex items-center gap-3 bg-surface px-4 py-3", i > 0 && "border-t border-border")}>
            <div className="flex-1"><div className="font-medium">{u.displayName || u.email}</div><div className="font-mono text-xs text-faint">{u.email} · {u.provider}</div></div>
            <span className="flex items-center gap-2 text-xs text-muted"><Switch checked={u.isAdmin} onCheckedChange={(v) => patch.mutate({ id: u.id, isAdmin: v })} aria-label="Admin" /> admin</span>
            <Button variant="ghost" size="icon" className="hover:text-err" onClick={() => del.mutate(u.id)}><Trash2 className="size-4" /></Button>
          </div>
        ))}
      </div>
      <form className="rounded-xl border border-border bg-surface p-5" onSubmit={(e) => { e.preventDefault(); create.mutate({ email, password: pw, displayName: name }, { onSuccess: () => { setEmail(""); setPw(""); setName(""); } }); }}>
        <div className={eyebrow}>Create user</div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <input className={input} placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input className={input} placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={input} placeholder="Password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} required />
        </div>
        <Button variant="primary" size="sm" type="submit" className="mt-3" disabled={create.isPending}>Create</Button>
      </form>
    </div>
  );
}

// ---------------- Settings ----------------
function Settings() {
  const settings = useAdminSettings();
  const save = useSaveSettings();
  const [form, setForm] = useState<SiteSettings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (settings.data) setForm(settings.data); }, [settings.data]);
  if (!form) return <Loading />;
  const upd = (p: Partial<SiteSettings>) => { setSaved(false); setForm({ ...form, ...p }); };
  return (
    <div className="grid max-w-lg gap-4">
    <form className="grid gap-4 rounded-xl border border-border bg-surface p-5"
      onSubmit={(e) => { e.preventDefault(); save.mutate(form, { onSuccess: () => setSaved(true) }); }}>
      <span className="flex items-center gap-2.5 text-sm"><Switch checked={form.registrationEnabled} onCheckedChange={(v) => upd({ registrationEnabled: v })} aria-label="Allow self-registration" /> Allow self-registration</span>
      <label className="grid gap-1"><span className="text-xs font-medium text-muted">Default OCR backend</span>
        <select className={input} value={form.defaultOcrBackend} onChange={(e) => upd({ defaultOcrBackend: e.target.value })}>
          <option value="">(worker default)</option><option value="rapidocr">RapidOCR</option><option value="ppocr">PP-OCR</option><option value="paddleocr_vl">PaddleOCR-VL</option>
        </select></label>
      <label className="grid gap-1"><span className="text-xs font-medium text-muted">Default sample FPS</span><input className={input} type="number" inputMode="decimal" min={0.5} step={0.5} value={form.defaultFps} onChange={(e) => { const n = parseDecimal(e.target.value); upd({ defaultFps: n ?? form.defaultFps }); }} /></label>
      <label className="grid gap-1"><span className="text-xs font-medium text-muted">Default min confidence</span><input className={input} type="number" inputMode="decimal" min={0} max={1} step={0.05} value={form.defaultMinConfidence} onChange={(e) => { const n = parseDecimal(e.target.value); upd({ defaultMinConfidence: n ?? form.defaultMinConfidence }); }} /></label>

      <div className="mt-1 border-t border-border pt-4">
        <div className={eyebrow}>Video retention</div>
        <p className="mt-1 text-xs text-muted">Automatically delete source videos after a delay to free storage. Jobs and subtitles are never removed.</p>
      </div>
      <span className="flex items-center gap-2.5 text-sm"><Switch checked={form.videoCleanupEnabled} onCheckedChange={(v) => upd({ videoCleanupEnabled: v })} aria-label="Automatically delete old videos" /> Automatically delete old videos</span>
      <div className={cn("grid gap-4", !form.videoCleanupEnabled && "opacity-50")}>
        <label className="grid gap-1"><span className="text-xs font-medium text-muted">Keep videos for (days)</span>
          <input className={input} type="number" inputMode="numeric" min={1} step={1} disabled={!form.videoCleanupEnabled}
            value={form.videoRetentionDays}
            onChange={(e) => { const n = parseDecimal(e.target.value); upd({ videoRetentionDays: n != null ? Math.max(1, Math.round(n)) : form.videoRetentionDays }); }} /></label>
        <label className="grid gap-1"><span className="text-xs font-medium text-muted">Cleanup schedule (cron)</span>
          <input className={cn(input, "font-mono")} disabled={!form.videoCleanupEnabled} placeholder="0 3 * * *"
            value={form.videoCleanupCron} onChange={(e) => upd({ videoCleanupCron: e.target.value })} />
          <span className="text-[11px] text-faint">5-field cron · default <span className="font-mono">0 3 * * *</span> (daily at 03:00)</span></label>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" type="submit" disabled={save.isPending}>Save settings</Button>
        {saved && <span className="text-xs text-ok">Saved.</span>}
        {save.isError && <span className="text-xs text-err">{save.error instanceof Error ? save.error.message : "Save failed"}</span>}
      </div>
    </form>

    <CleanupRuns />
    </div>
  );
}

const RUN_STATUS = {
  success: { Icon: CircleCheck, cls: "text-ok" },
  partial: { Icon: TriangleAlert, cls: "text-warn" },
  error: { Icon: CircleX, cls: "text-err" },
} as const;

function fmtRunTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "Run cleanup now" + history of the last 7 retention runs. Runs that deleted
 * files open a modal listing them. */
function CleanupRuns() {
  const runs = useCleanupRuns();
  const run = useRunCleanup();
  const [openRun, setOpenRun] = useState<CleanupRun | null>(null);
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className={eyebrow}>Cleanup runs</div>
          <p className="mt-1 text-xs text-muted">Last 7 runs · rows with deletions open the file list.</p>
        </div>
        <Button variant="default" size="sm" disabled={run.isPending}
          onClick={() => run.mutate(undefined, { onError: (e: unknown) => window.alert(e instanceof Error ? e.message : "Cleanup failed") })}>
          {run.isPending ? <Spinner /> : <Play className="size-3.5" />} Run cleanup now
        </Button>
      </div>

      <div className="mt-4">
        {runs.isLoading ? (
          <div className="grid place-items-center py-8"><Spinner className="size-5" /></div>
        ) : !runs.data || runs.data.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface-2 px-4 py-6 text-center text-sm text-muted">No cleanup has run yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {runs.data.map((r, i) => {
              const { Icon, cls } = RUN_STATUS[r.status] ?? RUN_STATUS.success;
              const clickable = r.deleted > 0;
              return (
                <button
                  key={r.id} type="button" disabled={!clickable}
                  onClick={() => clickable && setOpenRun(r)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm",
                    i > 0 && "border-t border-border",
                    clickable ? "hover:bg-surface-2" : "cursor-default",
                  )}
                >
                  <Icon className={cn("size-4 shrink-0", cls)} />
                  <span className="w-24 shrink-0 font-mono text-xs text-muted">{fmtRunTime(r.startedAt)}</span>
                  <span className="shrink-0 rounded border border-border-strong px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint">{r.trigger}</span>
                  <span className="ml-auto text-[13px] text-muted">
                    checked <span className="font-medium text-text">{r.checked}</span> · deleted <span className={cn("font-medium", r.deleted > 0 ? "text-accent" : "text-text")}>{r.deleted}</span>
                  </span>
                  <span className="hidden w-20 shrink-0 text-right font-mono text-xs text-faint sm:inline">{r.deleted > 0 ? formatBytes(r.bytesFreed) : "—"}</span>
                  {clickable ? <ChevronRight className="size-4 shrink-0 text-faint" /> : <span className="size-4 shrink-0" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {openRun && <RunFilesModal run={openRun} onClose={() => setOpenRun(null)} />}
    </div>
  );
}

/** Modal listing the source videos a cleanup run deleted. */
function RunFilesModal({ run, onClose }: { run: CleanupRun; onClose: () => void }) {
  const dlg = useDialog<HTMLDivElement>(onClose);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={dlg.onBackdropMouseDown}>
      <div ref={dlg.ref} {...dlg.dialogProps} aria-label="Deleted videos" className="w-full max-w-md rounded-2xl border border-border-strong bg-surface p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-base font-medium">Deleted videos</div>
            <div className="mt-0.5 text-xs text-muted">{fmtRunTime(run.startedAt)} · {run.trigger} · {run.deleted} file{run.deleted === 1 ? "" : "s"} · {formatBytes(run.bytesFreed)} freed</div>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="grid size-8 place-items-center rounded-lg text-faint transition hover:bg-surface-2 hover:text-text"><X className="size-4" /></button>
        </div>
        <div className="mt-4 grid max-h-[60vh] gap-1.5 overflow-auto">
          {run.files.map((f, i) => (
            <Link key={`${f.jobId}-${i}`} to="/jobs/$id" params={{ id: f.jobId }}
              className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm transition hover:border-accent">
              <Film className="size-4 shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate">{f.filename || "(unknown)"}</span>
              <span className="shrink-0 font-mono text-xs text-faint">{formatBytes(f.size)}</span>
            </Link>
          ))}
          {run.files.length < run.deleted && (
            <p className="px-1 pt-1 text-center text-xs text-faint">Showing {run.files.length} of {run.deleted} deleted files.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Loading() { return <div className="grid place-items-center py-16"><Spinner className="size-6" /></div>; }
function Empty({ msg }: { msg: string }) { return <div className="rounded-xl border border-border bg-surface px-6 py-12 text-center text-sm text-muted">{msg}</div>; }

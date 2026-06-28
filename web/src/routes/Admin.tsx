import { useEffect, useMemo, useState } from "react";
import { Trash2, Plus, X, ChevronDown, Check } from "lucide-react";
import {
  useUsers, useCreateUser, usePatchUser, useDeleteUser,
  useAdminSettings, useSaveSettings,
  useAdminWorkers, usePatchWorker, useDeleteWorker,
} from "@/api/admin";
import type { ConfigField, OCRSubstitutionRule, SiteSettings, Worker } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";

const TABS = [
  { id: "workers", label: "Workers" },
  { id: "subs", label: "Substitutions" },
  { id: "users", label: "Users" },
  { id: "settings", label: "Settings" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const input = "h-9 w-full rounded-lg border border-border-strong bg-surface-2 px-3 text-sm outline-none focus:border-accent";
const eyebrow = "text-[11px] font-bold uppercase tracking-[0.12em] text-faint";

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
            <button onClick={() => patch.mutate({ id: w.id, enabled: !w.enabled })}
              className={cn("relative h-5 w-9 rounded-full transition-colors", w.enabled ? "bg-accent" : "bg-surface-3")} title={w.enabled ? "Enabled" : "Disabled"}>
              <span className={cn("absolute top-0.5 size-4 rounded-full bg-white transition-all", w.enabled ? "left-[18px]" : "left-0.5")} />
            </button>
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
              <input type="checkbox" className="size-4" checked={Boolean(values[f.key])} onChange={(e) => set(f.key, e.target.checked)} />
            ) : f.type === "number" ? (
              <input type="number" className={input} min={f.min} max={f.max} step={f.step} value={String(values[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value === "" ? "" : Number(e.target.value))} />
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
              <input type="checkbox" className="mx-auto size-4" checked={r.isRegex} onChange={(e) => patch(i, { isRegex: e.target.checked })} />
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
            <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" className="size-4" checked={u.isAdmin} onChange={(e) => patch.mutate({ id: u.id, isAdmin: e.target.checked })} /> admin</label>
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
    <form className="grid max-w-lg gap-4 rounded-xl border border-border bg-surface p-5"
      onSubmit={(e) => { e.preventDefault(); save.mutate(form, { onSuccess: () => setSaved(true) }); }}>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={form.registrationEnabled} onChange={(e) => upd({ registrationEnabled: e.target.checked })} /> Allow self-registration</label>
      <label className="grid gap-1"><span className="text-xs font-medium text-muted">Default OCR backend</span>
        <select className={input} value={form.defaultOcrBackend} onChange={(e) => upd({ defaultOcrBackend: e.target.value })}>
          <option value="">(worker default)</option><option value="rapidocr">RapidOCR</option><option value="ppocr">PP-OCR</option><option value="paddleocr_vl">PaddleOCR-VL</option>
        </select></label>
      <label className="grid gap-1"><span className="text-xs font-medium text-muted">Default sample FPS</span><input className={input} type="number" min={0.5} step={0.5} value={form.defaultFps} onChange={(e) => upd({ defaultFps: Number(e.target.value) })} /></label>
      <label className="grid gap-1"><span className="text-xs font-medium text-muted">Default min confidence</span><input className={input} type="number" min={0} max={1} step={0.05} value={form.defaultMinConfidence} onChange={(e) => upd({ defaultMinConfidence: Number(e.target.value) })} /></label>
      <div className="flex items-center gap-3"><Button variant="primary" size="sm" type="submit" disabled={save.isPending}>Save settings</Button>{saved && <span className="text-xs text-ok">Saved.</span>}</div>
    </form>
  );
}

function Loading() { return <div className="grid place-items-center py-16"><Spinner className="size-6" /></div>; }
function Empty({ msg }: { msg: string }) { return <div className="rounded-xl border border-border bg-surface px-6 py-12 text-center text-sm text-muted">{msg}</div>; }

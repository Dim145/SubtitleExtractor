import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

// Phase-0 placeholder screens. Real implementations land in P1–P5.
function Stub({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-faint">{eyebrow}</div>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-6">{children}</div>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-border bg-surface p-5">{children}</div>;
}

export function Login() {
  return (
    <div className="grid min-h-[70vh] place-items-center px-5">
      <Panel>
        <div className="w-[360px]">
          <div className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-accent to-amber text-[#06121a]">SE</div>
          <h1 className="text-lg font-semibold">Welcome back</h1>
          <p className="mt-1 text-sm text-muted">Extract burned-in subtitles with OCR — edit them in your browser.</p>
          <div className="mt-5 grid gap-3">
            <input className="h-10 rounded-lg border border-border-strong bg-surface-2 px-3 text-sm" placeholder="Email" />
            <input className="h-10 rounded-lg border border-border-strong bg-surface-2 px-3 text-sm" type="password" placeholder="Password" />
            <Button variant="primary" className="h-10">Sign in</Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

export function Dashboard() {
  return (
    <Stub eyebrow="Workspace" title="Jobs">
      <Panel>
        <p className="text-sm text-muted">
          Phase 0 shell is live. The dashboard (upload + live jobs) lands in Phase 2.
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="primary">New extraction</Button>
          <Link to="/jobs/$id/editor" params={{ id: "demo" }}><Button variant="default">Open editor</Button></Link>
        </div>
      </Panel>
    </Stub>
  );
}

export function JobDetail() {
  return <Stub eyebrow="running · ocr" title="Job detail"><Panel><p className="text-sm text-muted">Phase 3.</p></Panel></Stub>;
}

export function Editor() {
  return <Stub eyebrow="Editor" title="Subtitle editor"><Panel><p className="text-sm text-muted">The centerpiece — Phase 4 (waveform, cue table, sync).</p></Panel></Stub>;
}

export function Admin() {
  return <Stub eyebrow="System" title="Administration"><Panel><p className="text-sm text-muted">Phase 5.</p></Panel></Stub>;
}

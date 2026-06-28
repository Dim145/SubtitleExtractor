import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { LayoutGrid, Pencil, Settings, Plus, SunMoon, Search, LogOut } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { useLogout } from "@/api/auth";

/** ⌘K command palette: navigation + quick actions. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const toggleTheme = useTheme((s) => s.toggle);
  const logout = useLogout();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function run(fn: () => void) {
    setOpen(false);
    fn();
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-9 min-w-[190px] items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 text-[13px] text-muted hover:border-border-strong"
      >
        <Search className="size-3.5" /> Search or run…
        <kbd className="ml-auto rounded border border-border-strong bg-surface-3 px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
      </button>

      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label="Command palette"
        className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/55 pt-[12vh] backdrop-blur-sm data-[state=closed]:hidden"
        onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
      >
        <div className="w-full max-w-[540px] overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl">
          <div className="flex items-center gap-2.5 border-b border-border px-4">
            <Search className="size-4 text-faint" />
            <Command.Input
              autoFocus
              placeholder="Search jobs, run a command…"
              className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
            />
          </div>
          <Command.List className="max-h-[340px] overflow-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted">No results.</Command.Empty>
            <Command.Group heading="Go to" className="px-1 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-faint [&_[cmdk-group-items]]:mt-1">
              <Item onSelect={() => run(() => navigate({ to: "/" }))} icon={<LayoutGrid className="size-4" />}>Dashboard</Item>
              <Item onSelect={() => run(() => navigate({ to: "/jobs/$id/editor", params: { id: "demo" } }))} icon={<Pencil className="size-4" />}>Open editor</Item>
              <Item onSelect={() => run(() => navigate({ to: "/admin" }))} icon={<Settings className="size-4" />}>Administration</Item>
            </Command.Group>
            <Command.Group heading="Actions" className="px-1 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-faint [&_[cmdk-group-items]]:mt-1">
              <Item onSelect={() => run(() => navigate({ to: "/" }))} icon={<Plus className="size-4" />}>New extraction</Item>
              <Item onSelect={() => run(toggleTheme)} icon={<SunMoon className="size-4" />}>Toggle theme</Item>
              <Item onSelect={() => run(() => logout.mutate(undefined, { onSuccess: () => navigate({ to: "/login" }) }))} icon={<LogOut className="size-4" />}>Sign out</Item>
            </Command.Group>
          </Command.List>
        </div>
      </Command.Dialog>
    </>
  );
}

function Item({ children, icon, onSelect }: { children: React.ReactNode; icon: React.ReactNode; onSelect: () => void }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-text data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
    >
      {icon}
      {children}
    </Command.Item>
  );
}

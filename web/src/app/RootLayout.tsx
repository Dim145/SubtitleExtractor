import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Captions, Moon, Sun } from "lucide-react";
import { CommandPalette } from "@/app/CommandPalette";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/cn";

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/admin", label: "Admin" },
] as const;

export function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { theme, toggle } = useTheme();

  // Auth screen renders without the app chrome.
  if (pathname === "/login") return <Outlet />;

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-border bg-surface/85 px-4 backdrop-blur">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-accent to-amber text-accent-foreground">
            <Captions className="size-4" />
          </span>
          Sub<span className="text-accent">Extractor</span>
        </Link>

        <nav className="ml-2 flex gap-0.5">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.to === "/" }}
              className="rounded-lg px-3 py-2 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
              activeProps={{ className: "bg-surface-2 text-text" }}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="flex-1" />
        <CommandPalette />
        <button
          onClick={toggle}
          aria-label="Toggle theme"
          className="grid size-9 place-items-center rounded-lg border border-border bg-surface-2 text-muted hover:text-text hover:border-border-strong"
        >
          {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
        </button>
        <div className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-amber to-accent text-xs font-bold text-[#06121a]">DD</div>
      </header>

      <main className={cn("min-h-[calc(100%-3.5rem)]")}>
        <Outlet />
      </main>
    </div>
  );
}

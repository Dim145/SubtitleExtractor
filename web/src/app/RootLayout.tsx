import { useEffect } from "react";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Captions, Moon, Sun } from "lucide-react";
import { CommandPalette } from "@/app/CommandPalette";
import { ProfileMenu } from "@/app/ProfileMenu";
import { useMe } from "@/api/auth";
import { useTheme } from "@/lib/theme";
import { Spinner } from "@/components/ui/spinner";

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/admin", label: "Admin" },
] as const;

export function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const { data: me, isLoading } = useMe();
  const onLogin = pathname === "/login";

  useEffect(() => {
    if (isLoading) return;
    if (!me && !onLogin) navigate({ to: "/login" });
    else if (me && onLogin) navigate({ to: "/" });
  }, [me, isLoading, onLogin, navigate]);

  if (isLoading) {
    return <div className="grid min-h-dvh place-items-center"><Spinner className="size-6" /></div>;
  }
  if (onLogin) return <Outlet />;
  if (!me) return <div className="grid min-h-dvh place-items-center"><Spinner className="size-6" /></div>;

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
          className="grid size-10 place-items-center rounded-lg border border-border bg-surface-2 text-muted hover:border-border-strong hover:text-text sm:size-9"
        >
          {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
        </button>
        <ProfileMenu />
      </header>

      <main className="min-h-[calc(100%-3.5rem)]">
        <div key={pathname} className="route-fade">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

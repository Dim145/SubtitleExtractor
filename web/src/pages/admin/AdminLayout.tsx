import { Link, Outlet, useLocation } from "react-router-dom";

const TABS = [
  { to: "/admin/users", label: "Users" },
  { to: "/admin/settings", label: "Settings" },
  { to: "/admin/workers", label: "Workers" },
  { to: "/admin/substitutions", label: "Substitutions" },
];

export function AdminLayout() {
  const loc = useLocation();

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", display: "grid", gap: 22 }}>
      <div>
        <h1 style={{ fontSize: 22, marginBottom: 14 }}>Administration</h1>
        <nav
          style={{
            display: "flex",
            gap: 4,
            borderBottom: "1px solid var(--border)",
          }}
        >
          {TABS.map((t) => {
            const active = loc.pathname === t.to || loc.pathname.startsWith(t.to + "/");
            return (
              <Link
                key={t.to}
                to={t.to}
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: active ? "var(--text)" : "var(--text-muted)",
                  padding: "9px 14px",
                  textDecoration: "none",
                  borderBottom: active
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
                  marginBottom: -1,
                }}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <Outlet />
    </div>
  );
}

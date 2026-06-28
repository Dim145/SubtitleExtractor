import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const onEditor = loc.pathname.includes("/editor");

  return (
    <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          height: 52,
          padding: "0 20px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-1)",
        }}
      >
        <Link
          to="/"
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 15,
            letterSpacing: "-0.02em",
            color: "var(--text)",
            textDecoration: "none",
            display: "flex",
            alignItems: "center",
            gap: 9,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: "var(--accent)",
              boxShadow: "0 0 10px var(--accent)",
            }}
          />
          SubtitleExtractor
        </Link>

        <nav style={{ display: "flex", gap: 4, marginLeft: 12 }}>
          <NavLink to="/" active={loc.pathname === "/"}>
            Jobs
          </NavLink>
          {user?.isAdmin && (
            <NavLink to="/admin/users" active={loc.pathname.startsWith("/admin")}>
              Admin
            </NavLink>
          )}
        </nav>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          {user && (
            <>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {user.displayName || user.email}
                {user.isAdmin && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 11,
                      color: "var(--accent)",
                      border: "1px solid var(--border-strong)",
                      borderRadius: 4,
                      padding: "1px 6px",
                    }}
                  >
                    admin
                  </span>
                )}
              </span>
              <button className="btn btn-ghost" onClick={() => logout()}>
                Sign out
              </button>
            </>
          )}
        </div>
      </header>

      <main
        style={{
          flex: 1,
          width: "100%",
          maxWidth: onEditor ? "none" : 1080,
          margin: "0 auto",
          padding: onEditor ? 0 : "28px 20px",
        }}
      >
        {children}
      </main>
    </div>
  );
}

function NavLink({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      style={{
        fontSize: 13,
        fontWeight: 500,
        color: active ? "var(--text)" : "var(--text-muted)",
        background: active ? "var(--bg-2)" : "transparent",
        padding: "6px 12px",
        borderRadius: 6,
        textDecoration: "none",
      }}
    >
      {children}
    </Link>
  );
}

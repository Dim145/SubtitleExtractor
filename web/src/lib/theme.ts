import { create } from "zustand";

type Theme = "dark" | "light";
const KEY = "subext-theme";

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function initial(): Theme {
  const saved = localStorage.getItem(KEY) as Theme | null;
  if (saved === "dark" || saved === "light") return saved;
  return "dark"; // Fusion is dark-first
}

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  set: (t: Theme) => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: "dark",
  toggle: () => get().set(get().theme === "dark" ? "light" : "dark"),
  set: (t) => {
    localStorage.setItem(KEY, t);
    apply(t);
    set({ theme: t });
  },
}));

/** Call once at startup, before React renders, to avoid a flash. */
export function initTheme() {
  const t = initial();
  apply(t);
  useTheme.setState({ theme: t });
}

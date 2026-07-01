import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";

export type ToastKind = "success" | "error" | "info" | "warn";
interface Toast { id: number; kind: ToastKind; message: string }

interface ToastApi {
  toast: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

const ICONS = {
  success: { Icon: CircleCheck, cls: "text-ok" },
  error: { Icon: CircleX, cls: "text-err" },
  warn: { Icon: TriangleAlert, cls: "text-warn" },
  info: { Icon: Info, cls: "text-info" },
} as const;

const AUTO_DISMISS_MS = 5000;

/** App-wide toast host. Errors use role="alert" (assertive); the rest use
 * role="status" (polite). Auto-dismiss after a few seconds; also dismissable. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, kind, message }]);
    window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
  }, [dismiss]);

  const api = useRef<ToastApi>({
    toast: push,
    success: (m) => push(m, "success"),
    error: (m) => push(m, "error"),
    info: (m) => push(m, "info"),
  });
  // Keep the callbacks fresh (push identity is stable via useCallback).
  api.current = {
    toast: push,
    success: (m) => push(m, "success"),
    error: (m) => push(m, "error"),
    info: (m) => push(m, "info"),
  };

  return (
    <ToastCtx.Provider value={api.current}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end">
        {toasts.map((t) => {
          const { Icon, cls } = ICONS[t.kind];
          return (
            <div
              key={t.id}
              role={t.kind === "error" ? "alert" : "status"}
              className="animate-in pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border border-border-strong bg-surface px-3.5 py-2.5 text-sm shadow-2xl"
            >
              <Icon className={cn("mt-0.5 size-4 shrink-0", cls)} />
              <span className="min-w-0 flex-1 break-words">{t.message}</span>
              <button
                type="button" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}
                className="-mr-1 grid size-6 shrink-0 place-items-center rounded text-faint transition hover:bg-surface-2 hover:text-text"
              ><X className="size-3.5" /></button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

/** Access the toast API. Must be used under <ToastProvider>. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  useEffect(() => {
    if (!ctx) console.error("useToast must be used within a ToastProvider");
  }, [ctx]);
  return ctx ?? { toast: () => {}, success: () => {}, error: () => {}, info: () => {} };
}

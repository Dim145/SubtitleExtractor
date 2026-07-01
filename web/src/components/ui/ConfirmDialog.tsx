import { useCallback, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDialog } from "@/components/ui/useDialog";

interface ConfirmOptions {
  title: string;
  /** Body text stating the consequences of confirming. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (default true — most uses are deletes). */
  danger?: boolean;
}

/**
 * Promise-based confirmation dialog. Returns `[confirm, dialog]`:
 *  - `confirm(opts)` resolves `true`/`false` when the user chooses.
 *  - `dialog` is the JSX to render once anywhere in the component tree.
 * Reuses `useDialog` for focus-trap / Esc / restore, matching the app's dialogs.
 */
export function useConfirm(): [(opts: ConfirmOptions) => Promise<boolean>, React.ReactNode] {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  }, []);

  const dialog = opts ? <ConfirmBox opts={opts} onSettle={settle} /> : null;
  return [confirm, dialog];
}

function ConfirmBox({ opts, onSettle }: { opts: ConfirmOptions; onSettle: (ok: boolean) => void }) {
  const danger = opts.danger ?? true;
  const dlg = useDialog<HTMLDivElement>(() => onSettle(false));
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={dlg.onBackdropMouseDown}>
      <div ref={dlg.ref} {...dlg.dialogProps} aria-label={opts.title} className="w-full max-w-md rounded-2xl border border-border-strong bg-surface p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          {danger && (
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-err/10 text-err"><TriangleAlert className="size-4" /></span>
          )}
          <div className="min-w-0">
            <div className="text-base font-medium">{opts.title}</div>
            <p className="mt-1 text-sm text-muted">{opts.message}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="default" size="sm" onClick={() => onSettle(false)}>{opts.cancelLabel ?? "Cancel"}</Button>
          <Button variant={danger ? "danger" : "primary"} size="sm" autoFocus onClick={() => onSettle(true)}>
            {opts.confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  );
}

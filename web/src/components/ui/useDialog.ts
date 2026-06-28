import { useCallback, useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessibility behavior for a custom modal dialog. Returns a ref to put on the
 * dialog container, plus the ARIA props to spread on it. Handles:
 *  - role="dialog" + aria-modal (via dialogProps)
 *  - Escape to close
 *  - moving focus into the dialog on open (first focusable, or the container)
 *  - trapping Tab focus within the dialog
 *  - restoring focus to the previously-focused element on close
 *
 * Pair with a backdrop that calls `onClose` on outside click (kept at the call
 * site so existing visuals are untouched).
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus into the dialog (prefer an [autofocus] target, else first focusable).
    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    const auto = node.querySelector<HTMLElement>("[autofocus]");
    const first = auto ?? focusables()[0] ?? node;
    // Defer so the element is laid out (and any autoFocus react attr is applied).
    const raf = requestAnimationFrame(() => first?.focus());

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey) {
        if (activeEl === firstItem || !node.contains(activeEl)) { e.preventDefault(); lastItem.focus(); }
      } else if (activeEl === lastItem || !node.contains(activeEl)) {
        e.preventDefault(); firstItem.focus();
      }
    };

    node.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      node.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);

  const onBackdropMouseDown = useCallback(
    (e: React.MouseEvent) => { if (e.target === e.currentTarget) closeRef.current(); },
    [],
  );

  return {
    ref,
    dialogProps: { role: "dialog" as const, "aria-modal": true },
    onBackdropMouseDown,
  };
}

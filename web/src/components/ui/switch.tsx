import { cn } from "@/lib/cn";

/** Accessible on/off toggle (slider). Use instead of a native checkbox for
 * boolean settings. */
export function Switch({
  checked, onCheckedChange, disabled, id, className, "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={ariaLabel} id={id} disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border p-0.5 transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        // Off state: a distinct track fill + a stronger border so the control
        // boundary meets 3:1 and isn't conveyed by color alone (the thumb
        // position already carries state too).
        checked ? "border-accent bg-accent" : "border-muted bg-surface-3",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block size-[18px] rounded-full bg-white shadow-sm ring-0 transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

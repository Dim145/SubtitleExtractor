import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const button = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-[background,border-color,transform,filter] duration-150 active:translate-y-px disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-foreground border border-transparent hover:brightness-110",
        default: "bg-surface-2 text-text border border-border-strong hover:border-accent",
        ghost: "bg-transparent text-muted hover:text-text hover:bg-surface-2",
        danger: "bg-surface-2 text-text border border-border-strong hover:border-err hover:text-err",
      },
      size: {
        md: "h-9 px-4 text-sm",
        sm: "h-8 px-3 text-[13px]",
        // ~40px touch target on small screens, trimmed to 36px on desktop.
        icon: "size-10 sm:size-9",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(button({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";

import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string; // used for the tooltip and screen readers
  size?: "sm" | "md";
};

export function IconButton({ icon: Icon, label, size = "md", className, ...props }: Props) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors",
        "hover:bg-surface-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "size-7" : "size-9",
        className,
      )}
      {...props}
    >
      <Icon className={size === "sm" ? "size-4" : "size-5"} />
    </button>
  );
}

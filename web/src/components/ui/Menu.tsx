import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export type MenuItem = {
  label: string;
  hint?: string; // a second, smaller line
  icon: LucideIcon;
  onSelect: () => void;
};

type Props = {
  // Renders the button that opens the menu; spread the props onto it.
  trigger: (props: { onClick: () => void; "aria-haspopup": "menu"; "aria-expanded": boolean }) => ReactNode;
  items: MenuItem[];
  label: string; // for screen readers
  className?: string; // where the menu pops up, relative to the trigger
};

// A small pop-up menu (LibreChat style): opens above its button, closes on a click outside,
// Escape, or when focus moves away (Tab), and works with the arrow keys.
export function Menu({ trigger, items, label, className }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const focusTrigger = () => (root.current?.querySelector("[aria-haspopup]") as HTMLElement | null)?.focus();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      focusTrigger();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const current = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    const next = (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    itemRefs.current[next]?.focus();
  };

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (open && !root.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {trigger({ onClick: () => setOpen((o) => !o), "aria-haspopup": "menu", "aria-expanded": open })}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cn(
            "absolute bottom-full left-0 z-50 mb-2 min-w-60 rounded-2xl border border-border-light bg-surface-primary p-1.5 shadow-lg",
            className,
          )}
        >
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                focusTrigger(); // the item disappears; keep keyboard users where they were
                item.onSelect();
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-text-primary outline-none hover:bg-surface-hover focus-visible:bg-surface-hover"
            >
              <item.icon className="size-5 shrink-0 text-text-secondary" />
              <span className="flex flex-col">
                <span>{item.label}</span>
                {item.hint && <span className="text-xs text-text-tertiary">{item.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

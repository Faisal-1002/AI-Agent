import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

type Props = {
  header: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
};

// A header you click to reveal content — used for "Thoughts" and tool calls.
export function Collapsible({ header, children, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex max-w-full items-center gap-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
      >
        {header}
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {/* grid-rows 0fr → 1fr animates height without measuring the content */}
      <div
        id={contentId}
        className={cn(
          "grid transition-all duration-200 ease-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

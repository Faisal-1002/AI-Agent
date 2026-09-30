import { ShieldAlert } from "lucide-react";
import type { GuardVerdict } from "../../../../shared/chat";
import { cn } from "../../lib/cn";

// Shown on a reply the safety filter (Qwen3Guard) flagged after it finished.
export function GuardNotice({ verdict }: { verdict: GuardVerdict }) {
  const unsafe = verdict.safety === "Unsafe";
  const categories = verdict.categories.length ? verdict.categories.join(", ") : "no category";
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-sm",
        unsafe
          ? "border-text-destructive/40 bg-text-destructive/10 text-text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <span>
        The safety filter rated this reply <strong>{verdict.safety.toLowerCase()}</strong> ({categories}{verdict.source === "rules" ? ", matched a personal-data pattern" : ""}).
        {unsafe && " Treat it with care."}
      </span>
    </div>
  );
}

import { Sparkles, UserRound } from "lucide-react";
import type { Role } from "../../../../shared/chat";
import { cn } from "../../lib/cn";

type Props = { role: Role; size?: "sm" | "lg" };

// Round icon for "You" and "seyl-ai".
export function Avatar({ role, size = "sm" }: Props) {
  const Icon = role === "user" ? UserRound : Sparkles;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full",
        role === "user" ? "bg-surface-tertiary text-text-primary" : "bg-surface-brand text-white",
        size === "sm" ? "size-7" : "size-14",
      )}
    >
      <Icon className={size === "sm" ? "size-4" : "size-7"} />
    </div>
  );
}

import { Sparkles, UserRound } from "lucide-react";
import type { Role } from "../../../../shared/chat";
import { cn } from "../../lib/cn";

type Props = { role: Role; size?: "sm" | "md" | "lg" };

const BOX = { sm: "size-7", md: "size-10", lg: "size-14" };
const ICON = { sm: "size-4", md: "size-5", lg: "size-7" };

// Round icon for "You" and "seyl-ai".
export function Avatar({ role, size = "sm" }: Props) {
  const Icon = role === "user" ? UserRound : Sparkles;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full",
        role === "user" ? "bg-surface-tertiary text-text-primary" : "bg-surface-brand text-white",
        BOX[size],
      )}
    >
      <Icon className={ICON[size]} />
    </div>
  );
}

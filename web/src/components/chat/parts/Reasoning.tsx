import { Lightbulb } from "lucide-react";
import { cn } from "../../../lib/cn";
import { Collapsible } from "../../ui/Collapsible";

type Props = { text: string; thinking: boolean };

// The model's chain of thought, collapsed by default ("Thoughts" in LibreChat).
export function Reasoning({ text, thinking }: Props) {
  if (!text.trim() && !thinking) return null;

  return (
    <Collapsible
      header={
        <>
          <Lightbulb className="size-4 shrink-0" />
          <span className={cn("font-medium", thinking && "animate-pulse")}>
            {thinking ? "Thinking…" : "Thoughts"}
          </span>
        </>
      }
    >
      <div className="mt-2 whitespace-pre-wrap rounded-2xl border border-border-light bg-surface-secondary p-4 text-sm leading-6 text-text-secondary">
        {text.trim() || "…"}
      </div>
    </Collapsible>
  );
}

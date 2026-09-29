import { ArrowUp, Square } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { mode: "send" | "stop" };

// Round button at the end of the composer: ↑ to send, ■ to stop the agent.
export function ComposerButton({ mode, ...props }: Props) {
  const send = mode === "send";
  return (
    <button
      type={send ? "submit" : "button"}
      aria-label={send ? "Send message" : "Stop generating"}
      title={send ? "Send message" : "Stop generating"}
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-text-primary text-surface-primary transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-20"
      {...props}
    >
      {send ? <ArrowUp className="size-5" strokeWidth={2.5} /> : <Square className="size-3.5 fill-current" />}
    </button>
  );
}

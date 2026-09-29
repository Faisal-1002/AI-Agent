import { memo } from "react";
import type { ChatPart } from "../../../../shared/chat";
import type { Turn } from "../../lib/conversations";
import { Avatar } from "../ui/Avatar";
import { CopyButton } from "../ui/CopyButton";
import { Markdown } from "../ui/Markdown";
import { Reasoning } from "./parts/Reasoning";
import { ToolCall } from "./parts/ToolCall";

type Props = { turn: Turn; streaming: boolean };

function Part({ part, isUser, streaming }: { part: ChatPart; isUser: boolean; streaming: boolean }) {
  switch (part.kind) {
    case "text":
      return isUser ? <p className="whitespace-pre-wrap leading-7">{part.text}</p> : <Markdown text={part.text} />;
    case "reasoning":
      return <Reasoning text={part.text} thinking={streaming && !part.done} />;
    case "tool":
      return <ToolCall part={part} />;
  }
}

// One row in the chat: avatar + name, then everything said in that turn.
export const MessageTurn = memo(function MessageTurn({ turn, streaming }: Props) {
  const isUser = turn.role === "user";
  const parts = turn.messages.flatMap((m) => m.parts);
  const errors = turn.messages.map((m) => m.error).filter(Boolean);
  const text = parts
    .filter((p) => p.kind === "text")
    .map((p) => p.text)
    .join("\n\n");

  return (
    <div className="group mx-auto flex w-full max-w-3xl gap-3 px-4 py-3 md:px-5">
      <Avatar role={turn.role} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="select-none pt-0.5 text-sm font-semibold">{isUser ? "You" : "seyl-ai"}</div>

        <div className="flex flex-col gap-2 text-text-primary">
          {parts.map((part) => (
            <Part key={part.id} part={part} isUser={isUser} streaming={streaming} />
          ))}
          {streaming && parts.every((p) => p.kind !== "text") && (
            <span className="mt-1 inline-block size-3 animate-pulse rounded-full bg-text-primary" aria-label="Typing" />
          )}
          {errors.map((error, i) => (
            <div key={i} className="rounded-xl border border-text-destructive/40 bg-text-destructive/10 px-4 py-3 text-sm text-text-destructive">
              {error}
            </div>
          ))}
        </div>

        {!streaming && text && (
          <div className="flex gap-1 pt-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyButton
              getText={() => text}
              label="Copy to clipboard"
              className="p-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            />
          </div>
        )}
      </div>
    </div>
  );
});

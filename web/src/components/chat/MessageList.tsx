import { useMemo } from "react";
import type { ChatMessage } from "../../../../shared/chat";
import { groupTurns, type Turn } from "../../lib/conversations";
import { useStickToBottom } from "../../hooks/useStickToBottom";
import { MessageTurn } from "./MessageTurn";

type Props = { messages: ChatMessage[]; busy: boolean; canSpeak: boolean };

const PENDING: Turn = { id: "pending", role: "assistant", messages: [] };

export function MessageList({ messages, busy, canSpeak }: Props) {
  const turns = useMemo(() => groupTurns(messages), [messages]);
  const scrollRef = useStickToBottom<HTMLDivElement>(messages);

  const last = turns.at(-1);
  // The agent is working but its reply hasn't started yet: show a placeholder row.
  const waiting = busy && last?.role !== "assistant";

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="flex flex-col pb-6 pt-2">
        {turns.map((turn) => (
          <MessageTurn
            key={turn.id}
            turn={turn}
            streaming={busy && turn === last && turn.role === "assistant"}
            canSpeak={canSpeak}
          />
        ))}
        {waiting && <MessageTurn turn={PENDING} streaming canSpeak={false} />}
      </div>
    </div>
  );
}

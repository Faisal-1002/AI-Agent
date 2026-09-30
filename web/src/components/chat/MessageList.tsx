import { useMemo } from "react";
import type { ChatMessage, GuardFlags, PermissionAsk, PermissionReply } from "../../../../shared/chat";
import { groupTurns, type Turn } from "../../lib/conversations";
import { useStickToBottom } from "../../hooks/useStickToBottom";
import { MessageTurn } from "./MessageTurn";
import { PermissionCard } from "./PermissionCard";

type Props = {
  messages: ChatMessage[];
  busy: boolean;
  canSpeak: boolean;
  flags: GuardFlags;
  permissions: PermissionAsk[];
  onPermission: (id: string, reply: PermissionReply) => void;
};

const PENDING: Turn = { id: "pending", role: "assistant", messages: [] };

export function MessageList({ messages, busy, canSpeak, flags, permissions, onPermission }: Props) {
  const turns = useMemo(() => groupTurns(messages), [messages]);
  const content = useMemo(() => [messages, permissions], [messages, permissions]); // changes when either does
  const scrollRef = useStickToBottom<HTMLDivElement>(content);

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
            flag={flags[turn.id]}
          />
        ))}
        {waiting && <MessageTurn turn={PENDING} streaming canSpeak={false} />}
        {permissions.map((ask) => (
          <PermissionCard key={ask.id} ask={ask} onAnswer={(reply) => onPermission(ask.id, reply)} />
        ))}
      </div>
    </div>
  );
}

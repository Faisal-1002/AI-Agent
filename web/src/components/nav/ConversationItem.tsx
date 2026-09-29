import { Trash2 } from "lucide-react";
import type { Conversation } from "../../../../shared/chat";
import { cn } from "../../lib/cn";
import { displayTitle } from "../../lib/conversations";
import { IconButton } from "../ui/IconButton";

type Props = {
  conversation: Conversation;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
};

export function ConversationItem({ conversation, active, onSelect, onDelete }: Props) {
  const title = displayTitle(conversation.title);
  return (
    <li>
      <div
        className={cn(
          "group relative flex h-9 items-center rounded-lg text-sm transition-colors hover:bg-surface-active-alt",
          active && "bg-surface-active-alt",
        )}
      >
        <button
          type="button"
          onClick={() => onSelect(conversation.id)}
          title={title}
          aria-current={active ? "page" : undefined}
          className="h-full min-w-0 flex-1 truncate px-2 text-left"
        >
          {title}
        </button>
        <IconButton
          icon={Trash2}
          label="Delete conversation"
          size="sm"
          onClick={() => onDelete(conversation.id)}
          className={cn(
            "mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            active && "opacity-100",
          )}
        />
      </div>
    </li>
  );
}

import { FileText, Laptop, LogOut, PanelLeftClose, SquarePen } from "lucide-react";
import { useMemo } from "react";
import type { Conversation, User } from "../../../../shared/chat";
import { cn } from "../../lib/cn";
import { groupByDate } from "../../lib/conversations";
import { Avatar } from "../ui/Avatar";
import { IconButton } from "../ui/IconButton";
import { ConversationItem } from "./ConversationItem";

type Props = {
  open: boolean;
  overlay: boolean; // small screens: float above the chat instead of pushing it
  conversations: Conversation[];
  activeId?: string;
  onClose: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenDocuments: () => void;
  onOpenDevices: () => void;
  user: User;
  onSignOut: () => void;
};

export function Sidebar({ open, overlay, conversations, activeId, onClose, onNewChat, onSelect, onDelete, onOpenDocuments, onOpenDevices, user, onSignOut }: Props) {
  const groups = useMemo(() => groupByDate(conversations), [conversations]);

  return (
    <>
      {overlay && open && (
        <div className="fixed inset-0 z-20 bg-black/40" onClick={onClose} aria-hidden="true" />
      )}
      <aside
        aria-label="Conversations"
        className={cn(
          "flex h-full shrink-0 flex-col overflow-hidden bg-surface-primary-alt transition-[width] duration-200",
          overlay && "fixed inset-y-0 left-0 z-30 shadow-xl",
          open ? "w-[260px]" : "w-0",
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between px-2">
          <IconButton icon={PanelLeftClose} label="Close sidebar" onClick={onClose} />
          <IconButton icon={SquarePen} label="New chat" onClick={onNewChat} />
        </div>

        <nav className="min-w-[260px] flex-1 overflow-y-auto px-2 pb-4">
          {groups.length === 0 && (
            <p className="px-2 py-4 text-sm text-text-tertiary">Your conversations will appear here.</p>
          )}
          {groups.map((group) => (
            <section key={group.label} className="mt-5 first:mt-1">
              <h2 className="px-2 pb-1 text-xs font-semibold text-text-tertiary">{group.label}</h2>
              <ul className="flex flex-col gap-0.5">
                {group.items.map((conversation) => (
                  <ConversationItem
                    key={conversation.id}
                    conversation={conversation}
                    active={conversation.id === activeId}
                    onSelect={onSelect}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            </section>
          ))}
        </nav>

        <div className="min-w-[260px] border-t border-border-light p-2">
          <button
            type="button"
            onClick={onOpenDocuments}
            className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm hover:bg-surface-active-alt"
          >
            <FileText className="size-4 text-text-secondary" />
            Documents
          </button>
          <button
            type="button"
            onClick={onOpenDevices}
            className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm hover:bg-surface-active-alt"
          >
            <Laptop className="size-4 text-text-secondary" />
            Devices
          </button>
        </div>
        <div className="flex min-w-[260px] items-center gap-2 border-t border-border-light px-3 py-2.5 text-sm">
          {user.local ? (
            <Avatar role="assistant" />
          ) : (
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-tertiary font-semibold" aria-hidden>
              {user.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{user.local ? "seyl-ai" : user.name}</div>
            {user.email && <div className="truncate text-xs text-text-tertiary">{user.email}</div>}
          </div>
          {!user.local && <IconButton icon={LogOut} label="Sign out" size="sm" onClick={onSignOut} />}
        </div>
      </aside>
    </>
  );
}

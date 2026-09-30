import type { ChatMessage, Conversation, Role } from "../../../shared/chat";

// OpenCode names new sessions "New session - <timestamp>" until it generates a title.
export function displayTitle(title: string): string {
  return /^New session/i.test(title) ? "New Chat" : title;
}

export type ConversationGroup = { label: string; items: Conversation[] };

// Sidebar groups, like LibreChat: Today, Yesterday, Previous 7 days, Previous 30 days, then by month.
export function groupByDate(conversations: Conversation[], now = new Date()): ConversationGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;

  const labelFor = (time: number) => {
    if (time >= startOfToday) return "Today";
    if (time >= startOfToday - day) return "Yesterday";
    if (time >= startOfToday - 7 * day) return "Previous 7 days";
    if (time >= startOfToday - 30 * day) return "Previous 30 days";
    return new Date(time).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  };

  const groups: ConversationGroup[] = [];
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const conversation of sorted) {
    const label = labelFor(conversation.updatedAt);
    const group = groups.at(-1);
    if (group?.label === label) group.items.push(conversation);
    else groups.push({ label, items: [conversation] });
  }
  return groups;
}

// One agent reply can span several OpenCode messages (one per loop step:
// think → call tool → think → answer). Show consecutive messages from the
// same role as a single "turn", the way LibreChat shows one response.
export type Turn = { id: string; role: Role; messages: ChatMessage[] };

export function groupTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    // Hidden messages (e.g. the backend's synthetic "write your answer" nudge) have no
    // visible parts; skipping them also lets the assistant turn around them stay one turn.
    if (message.role === "user" && message.parts.length === 0) continue;
    const last = turns.at(-1);
    if (last?.role === message.role && message.role === "assistant") last.messages.push(message);
    else turns.push({ id: message.id, role: message.role, messages: [message] });
  }
  return turns;
}

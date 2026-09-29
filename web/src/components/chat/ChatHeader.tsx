import { Cpu, PanelLeftOpen, SquarePen } from "lucide-react";
import type { ModelInfo } from "../../../../shared/chat";
import { IconButton } from "../ui/IconButton";

type Props = {
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onNewChat: () => void;
  model?: ModelInfo;
};

export function ChatHeader({ sidebarOpen, onOpenSidebar, onNewChat, model }: Props) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 px-2">
      {!sidebarOpen && (
        <>
          <IconButton icon={PanelLeftOpen} label="Open sidebar" onClick={onOpenSidebar} />
          <IconButton icon={SquarePen} label="New chat" onClick={onNewChat} />
        </>
      )}
      {model && <ModelBadge model={model} />}
    </header>
  );
}

// Which model is answering (LibreChat's model selector, display-only for now).
function ModelBadge({ model }: { model: ModelInfo }) {
  return (
    <div className="ml-1 flex items-center gap-2 rounded-xl border border-border-light bg-surface-secondary px-3 py-1.5 text-sm">
      <Cpu className="size-4 text-text-secondary" />
      <span className="text-text-secondary">{model.provider}</span>
      <span className="text-text-tertiary">/</span>
      <span className="font-medium">{model.name}</span>
      <span className="size-2 rounded-full bg-surface-brand" title="Running locally" />
    </div>
  );
}

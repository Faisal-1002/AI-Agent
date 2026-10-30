import { useCallback, useEffect, useState } from "react";
import type { User } from "../../shared/chat";
import { LoginScreen } from "./components/auth/LoginScreen";
import { ChatHeader } from "./components/chat/ChatHeader";
import { Landing } from "./components/chat/Landing";
import { MessageList } from "./components/chat/MessageList";
import { ChatForm } from "./components/input/ChatForm";
import { DevicesPanel } from "./components/devices/DevicesPanel";
import { DocumentsPanel } from "./components/documents/DocumentsPanel";
import { Sidebar } from "./components/nav/Sidebar";
import { useAuth } from "./hooks/useAuth";
import { useChat } from "./hooks/useChat";
import { useConversations } from "./hooks/useConversations";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useModel } from "./hooks/useModel";
import { useVoiceStatus } from "./hooks/useVoiceStatus";

// Sign-in gate: nothing loads until the api says who you are.
export function App() {
  const { auth, signIn, signOut } = useAuth();
  if (auth.status === "loading") return <div className="h-dvh bg-presentation" />;
  if (auth.status === "signed-out") return <LoginScreen onSignIn={signIn} error={auth.error} />;
  return <ChatApp user={auth.user} onSignOut={signOut} />;
}

function ChatApp({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const wide = useMediaQuery("(min-width: 768px)");
  const [sidebarOpen, setSidebarOpen] = useState(wide);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [activeId, setActiveId] = useState<string>();
  const model = useModel();
  const voice = useVoiceStatus();
  const { conversations, add, rename, remove } = useConversations();

  const chat = useChat(activeId, {
    onCreated: (conversation) => {
      add(conversation);
      setActiveId(conversation.id);
    },
    onTitle: rename,
  });

  useEffect(() => setSidebarOpen(wide), [wide]);

  const select = useCallback(
    (id: string | undefined) => {
      setActiveId(id);
      if (!wide) setSidebarOpen(false);
    },
    [wide],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this conversation? This can't be undone.")) return;
      await remove(id);
      if (id === activeId) setActiveId(undefined);
    },
    [remove, activeId],
  );

  const empty = chat.messages.length === 0 && !chat.busy;

  return (
    <div className="flex h-dvh overflow-hidden bg-presentation text-text-primary">
      <Sidebar
        open={sidebarOpen}
        overlay={!wide}
        conversations={conversations}
        activeId={activeId}
        onClose={() => setSidebarOpen(false)}
        onNewChat={() => select(undefined)}
        onSelect={select}
        onDelete={deleteConversation}
        onOpenDocuments={() => setDocumentsOpen(true)}
        onOpenDevices={() => setDevicesOpen(true)}
        user={user}
        onSignOut={onSignOut}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          sidebarOpen={sidebarOpen}
          onOpenSidebar={() => setSidebarOpen(true)}
          onNewChat={() => select(undefined)}
          model={model}
        />

        {empty ? (
          <Landing />
        ) : (
          <MessageList
            key={activeId}
            messages={chat.messages}
            busy={chat.busy}
            canSpeak={voice.tts}
            flags={chat.flags}
            permissions={chat.permissions}
            onPermission={chat.answerPermission}
          />
        )}

        {chat.error && (
          <div className="mx-auto mb-2 w-full max-w-3xl px-4 md:px-5">
            <div className="rounded-xl border border-text-destructive/40 bg-text-destructive/10 px-4 py-2 text-sm text-text-destructive">
              {chat.error}
            </div>
          </div>
        )}

        <ChatForm
          busy={chat.busy}
          canTranscribe={voice.asr}
          canAttachImages={model?.vision ?? false}
          onSend={chat.send}
          onStop={chat.stop}
        />
        <p className="px-4 py-2 text-center text-xs text-text-tertiary">
          Ai-Agent runs locally on your PC and can make mistakes.
        </p>
      </main>
      {documentsOpen && <DocumentsPanel onClose={() => setDocumentsOpen(false)} />}
      {devicesOpen && <DevicesPanel onClose={() => setDevicesOpen(false)} />}
    </div>
  );
}

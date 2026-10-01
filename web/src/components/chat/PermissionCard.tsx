import { FilePen, ShieldQuestion } from "lucide-react";
import type { PermissionAsk, PermissionReply } from "../../../../shared/chat";
import { CodeBlock } from "../ui/CodeBlock";

const ACTIONS: Record<string, string> = {
  edit: "change files",
  bash: "run a command",
  webfetch: "open a web page",
  external_directory: "work outside your workspace",
};

// The agent is paused, waiting for the user to approve an action (e.g. editing a file).
export function PermissionCard({ ask, onAnswer }: { ask: PermissionAsk; onAnswer: (reply: PermissionReply) => void }) {
  const what = ACTIONS[ask.action] ?? ask.action;
  const Icon = ask.action === "edit" ? FilePen : ShieldQuestion;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-2 md:px-5">
      <div role="alertdialog" aria-label="Approval needed" className="rounded-2xl border border-amber-500/50 bg-amber-500/5 p-4">
        <div className="flex items-start gap-2">
          <Icon className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">seyl-ai wants to {what}</div>
            {ask.files.length > 0 && (
              <div className="truncate font-mono text-sm text-text-secondary">{ask.files.join(", ")}</div>
            )}
          </div>
        </div>

        {ask.diff && (
          <CodeBlock language="diff" maxHeight>
            {ask.diff}
          </CodeBlock>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onAnswer("once")}
            className="rounded-lg bg-surface-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            Allow once
          </button>
          <button
            type="button"
            onClick={() => onAnswer("always")}
            title="Don't ask again for this kind of action in this conversation"
            className="rounded-lg border border-border-medium px-3 py-1.5 text-sm font-medium hover:bg-surface-hover"
          >
            Allow for this chat
          </button>
          <button
            type="button"
            onClick={() => onAnswer("reject")}
            className="rounded-lg border border-border-medium px-3 py-1.5 text-sm font-medium text-text-destructive hover:bg-surface-hover"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}

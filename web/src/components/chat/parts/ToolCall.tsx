import { CircleAlert, LoaderCircle, Wrench } from "lucide-react";
import type { ChatPart } from "../../../../../shared/chat";
import { cn } from "../../../lib/cn";
import { shortPath } from "../../../lib/paths";
import { CodeBlock } from "../../ui/CodeBlock";
import { Collapsible } from "../../ui/Collapsible";

type ToolPart = Extract<ChatPart, { kind: "tool" }>;

function label(part: ToolPart): string {
  switch (part.status) {
    case "pending":
    case "running":
      return `Running ${part.tool}…`;
    case "completed":
      return `Ran ${part.tool}`;
    case "error":
      return `Error in ${part.tool}`;
  }
}

// One tool the agent used (read a file, search, …). Expand to see input and output.
export function ToolCall({ part }: { part: ToolPart }) {
  const running = part.status === "pending" || part.status === "running";
  const Icon = running ? LoaderCircle : part.status === "error" ? CircleAlert : Wrench;

  return (
    <Collapsible
      header={
        <>
          <Icon
            className={cn(
              "size-4 shrink-0",
              running && "animate-spin",
              part.status === "error" && "text-text-destructive",
            )}
          />
          <span className="font-medium">{label(part)}</span>
          {part.title && <span className="truncate text-text-tertiary">{shortPath(part.title)}</span>}
        </>
      }
    >
      <div className="mt-2 flex flex-col gap-1">
        <div className="text-xs font-medium text-text-tertiary">Input</div>
        <CodeBlock language="json" maxHeight>
          {JSON.stringify(part.input, null, 2)}
        </CodeBlock>
        {(part.output !== undefined || part.error) && (
          <>
            <div className="text-xs font-medium text-text-tertiary">{part.error ? "Error" : "Output"}</div>
            <CodeBlock maxHeight>{part.error ?? part.output}</CodeBlock>
          </>
        )}
      </div>
    </Collapsible>
  );
}

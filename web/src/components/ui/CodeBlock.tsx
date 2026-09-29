import { useRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { CopyButton } from "./CopyButton";

type Props = {
  language?: string;
  children: ReactNode;
  maxHeight?: boolean; // cap tall blocks (e.g. tool output) and scroll inside
};

// Dark code block with a language label and copy button (always dark, like LibreChat).
export function CodeBlock({ language, children, maxHeight = false }: Props) {
  const pre = useRef<HTMLPreElement>(null);

  return (
    <div className="not-prose my-2 overflow-hidden rounded-xl border border-neutral-800 bg-black text-sm">
      <div className="flex items-center justify-between bg-neutral-800 px-4 py-1.5 text-xs text-neutral-300">
        <span className="font-mono">{language ?? "text"}</span>
        <CopyButton
          getText={() => pre.current?.textContent ?? ""}
          label="Copy code"
          showLabel
          className="hover:text-white"
        />
      </div>
      <pre
        ref={pre}
        className={cn(
          "overflow-x-auto p-4 font-mono text-[13px] leading-relaxed text-neutral-100",
          maxHeight && "max-h-72 overflow-y-auto",
        )}
      >
        {children}
      </pre>
    </div>
  );
}

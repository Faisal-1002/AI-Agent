import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";

type Props = {
  getText: () => string;
  label?: string;
  showLabel?: boolean;
  className?: string;
};

export function CopyButton({ getText, label = "Copy", showLabel = false, className }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => navigator.clipboard.writeText(getText()).then(() => setCopied(true))}
      className={cn("inline-flex items-center gap-1.5 rounded-md transition-colors", className)}
    >
      <Icon className="size-4" />
      {showLabel && <span>{copied ? "Copied!" : label}</span>}
    </button>
  );
}

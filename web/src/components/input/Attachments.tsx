import { CircleAlert, FileText, LoaderCircle, X } from "lucide-react";
import type { ImageAttachment } from "../../../../shared/chat";
import type { PendingDocument } from "../../hooks/useAttachments";
import { cn } from "../../lib/cn";

const STATUS: Record<PendingDocument["status"], string> = {
  uploading: "Uploading…",
  indexing: "Indexing…",
  ready: "Ready",
  failed: "Failed",
};

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-text-primary text-surface-primary"
    >
      <X className="size-3" />
    </button>
  );
}

// A document chip, as LibreChat shows attached files: icon tile, name, and a status line.
export function DocumentChip({ name, status, error }: { name: string; status?: PendingDocument["status"]; error?: string }) {
  const failed = status === "failed";
  return (
    <div className="flex w-56 items-center gap-2 rounded-2xl border border-border-light bg-surface-primary p-2" title={error ?? name}>
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg text-white",
          failed ? "bg-text-destructive" : "bg-[rgb(var(--green-700))]",
        )}
      >
        {status === "uploading" || status === "indexing" ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : failed ? (
          <CircleAlert className="size-4" />
        ) : (
          <FileText className="size-4" />
        )}
      </div>
      <div className="min-w-0 text-left">
        <div className="truncate text-sm font-medium text-text-primary">{name}</div>
        <div className={cn("truncate text-xs", failed ? "text-text-destructive" : "text-text-tertiary")}>
          {status ? (failed && error ? error : STATUS[status]) : "Document"}
        </div>
      </div>
    </div>
  );
}

type Props = {
  images: ImageAttachment[];
  documents: PendingDocument[];
  onRemoveImage: (index: number) => void;
  onRemoveDocument: (key: string) => void;
};

// Everything attached to the message being written, above the text box.
export function Attachments({ images, documents, onRemoveImage, onRemoveDocument }: Props) {
  if (images.length === 0 && documents.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-2 pb-1 pt-1">
      {images.map((image, i) => (
        <div key={`img-${i}`} className="relative">
          <img src={image.dataUrl} alt={image.name} className="size-14 rounded-xl border border-border-light object-cover" />
          <RemoveButton label={`Remove ${image.name}`} onClick={() => onRemoveImage(i)} />
        </div>
      ))}
      {documents.map((doc) => (
        <div key={doc.key} className="relative">
          <DocumentChip name={doc.name} status={doc.status} error={doc.error} />
          {/* Removing it here only detaches it from this message; it stays in the library. */}
          <RemoveButton label={`Remove ${doc.name} from this message`} onClick={() => onRemoveDocument(doc.key)} />
        </div>
      ))}
    </div>
  );
}

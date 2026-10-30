import { CircleAlert, FileText, LoaderCircle, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { DOCUMENT_TYPES, type DocumentInfo } from "../../../../shared/chat";
import { useDocuments } from "../../hooks/useDocuments";
import { cn } from "../../lib/cn";
import { IconButton } from "../ui/IconButton";

const ACCEPT = DOCUMENT_TYPES.map((t) => `.${t}`).join(",");

const formatSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function DocumentRow({ doc, onDelete }: { doc: DocumentInfo; onDelete: (id: string) => void }) {
  return (
    <li className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover">
      <FileText className="size-5 shrink-0 text-text-secondary" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={doc.name}>
          {doc.name}
        </div>
        <div className={cn("flex items-center gap-1 text-xs", doc.status === "failed" ? "text-text-destructive" : "text-text-tertiary")}>
          {doc.status === "indexing" && <LoaderCircle className="size-3 animate-spin" />}
          {doc.status === "failed" && <CircleAlert className="size-3" />}
          <span className="truncate" title={doc.error}>
            {doc.type.toUpperCase()} · {formatSize(doc.size)} ·{" "}
            {doc.status === "ready" ? `${doc.chunks} passages` : doc.status === "indexing" ? "Indexing…" : `Failed: ${doc.error}`}
          </span>
        </div>
      </div>
      <IconButton icon={Trash2} label={`Delete ${doc.name}`} size="sm" onClick={() => onDelete(doc.id)} />
    </li>
  );
}

// The document library ("chat with your documents"): upload, see indexing status, delete.
export function DocumentsPanel({ onClose }: { onClose: () => void }) {
  const { documents, error, upload, remove } = useDocuments();
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload([...e.dataTransfer.files]);
  };

  const confirmDelete = (id: string) => {
    const doc = documents.find((d) => d.id === id);
    if (window.confirm(`Delete "${doc?.name}" from the library? Ai-Agent won't be able to search it any more.`)) void remove(id);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="documents-title"
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-surface-primary shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <div>
            <h2 id="documents-title" className="text-lg font-semibold">
              Documents
            </h2>
            <p className="text-sm text-text-secondary">Ai-Agent searches these when answering your questions.</p>
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>

        <div className="px-5 py-2">
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex w-full flex-col items-center gap-1 rounded-xl border-2 border-dashed px-4 py-6 text-sm transition-colors",
              dragging ? "border-surface-brand bg-surface-brand/10" : "border-border-medium hover:bg-surface-hover",
            )}
          >
            <Upload className="size-6 text-text-secondary" />
            <span className="font-medium">Drop files here or click to upload</span>
            <span className="text-xs text-text-tertiary">PDF, Word, Markdown, text, CSV, JSON, HTML · up to 20 MB</span>
          </button>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              void upload([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          {error && <p className="pt-2 text-sm text-text-destructive">{error}</p>}
        </div>

        <ul className="flex-1 overflow-y-auto px-3 pb-4">
          {documents.length === 0 && <li className="px-2 py-6 text-center text-sm text-text-tertiary">No documents yet.</li>}
          {documents.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} onDelete={confirmDelete} />
          ))}
        </ul>
      </div>
    </div>
  );
}

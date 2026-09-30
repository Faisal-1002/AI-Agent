import { Lightbulb } from "lucide-react";
import { useCallback, useEffect, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import TextareaAutosize from "react-textarea-autosize";
import type { AttachedDocument, ImageAttachment } from "../../../../shared/chat";
import { useAttachments } from "../../hooks/useAttachments";
import { cn } from "../../lib/cn";
import { AttachMenu } from "./AttachMenu";
import { Attachments } from "./Attachments";
import { ComposerButton } from "./ComposerButton";
import { MicButton } from "./MicButton";

const THINK_KEY = "seyl.think";

// "Think" is remembered per browser; storage can be unavailable (private mode), hence try/catch.
const savedThink = () => {
  try {
    return localStorage.getItem(THINK_KEY) === "on";
  } catch {
    return false;
  }
};

type Props = {
  busy: boolean;
  canTranscribe: boolean; // speech-to-text service is up → show the 🎤 button
  canAttachImages: boolean; // the model can see images → offer "Upload image"
  // false = refused (e.g. by the safety filter): the message and attachments come back.
  onSend: (text: string, images: ImageAttachment[], think: boolean, documents: AttachedDocument[]) => Promise<boolean>;
  onStop: () => void;
};

// The message box: grows with the text, Enter sends, Shift+Enter adds a new line.
// 📎 attaches images or documents; files can also be pasted or dropped onto it.
export function ChatForm({ busy, canTranscribe, canAttachImages, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string>();
  // Off by default: answers come 2–4x faster. On: the model reasons first ("Thoughts").
  const [think, setThink] = useState(savedThink);
  const attachments = useAttachments({ canAttachImages, onHint: useCallback((h: string) => setHint(h), []) });
  const hasContent = text.trim().length > 0 || attachments.images.length > 0 || attachments.ready.length > 0;
  // Not while documents are still being prepared — or if one failed: sending without it would
  // look fine, but the agent wouldn't have the file you meant.
  const canSend = hasContent && !busy && !attachments.waiting && attachments.failed.length === 0;

  // Hints ("didn't catch that", "only images") fade out on their own.
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(undefined), 5000);
    return () => clearTimeout(timer);
  }, [hint]);

  const submit = () => {
    if (!canSend) return;
    const sentText = text.trim();
    const documents = attachments.ready;
    const taken = attachments.take();
    setText("");
    // If the message was refused, give it back so nothing is lost.
    onSend(sentText, taken.images, think, documents).then((ok) => {
      if (ok) return;
      setText((current) => current || sentText);
      attachments.restore(taken);
    });
  };

  const toggleThink = () => {
    setThink((on) => {
      try {
        localStorage.setItem(THINK_KEY, on ? "off" : "on");
      } catch {}
      return !on;
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      attachments.addFiles(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    attachments.addFiles([...e.dataTransfer.files]);
  };

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        submit();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className="mx-auto w-full max-w-3xl px-4 md:px-5"
    >
      <div className="rounded-3xl border border-border-light bg-surface-chat p-2 shadow-md transition-colors focus-within:border-border-medium">
        <Attachments
          images={attachments.images}
          documents={attachments.documents}
          onRemoveImage={attachments.removeImage}
          onRemoveDocument={attachments.removeDocument}
        />
        <div className="flex items-end gap-1">
          <AttachMenu
            canAttachImages={canAttachImages}
            onImages={(files) => void attachments.addImages(files)}
            onDocuments={attachments.addDocuments}
          />
          <TextareaAutosize
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder="Message seyl-ai"
            aria-label="Message seyl-ai"
            autoFocus
            minRows={1}
            maxRows={12}
            className="my-1.5 flex-1 resize-none bg-transparent pl-1 leading-6 text-text-primary placeholder:text-text-tertiary focus:outline-none"
          />
          <button
            type="button"
            onClick={toggleThink}
            aria-pressed={think}
            title={
              think
                ? "Thinking on: slower, reasons step by step first"
                : "Think before answering (slower, for harder questions). Questions about your files and documents always think first."
            }
            className={cn(
              "mb-0.5 inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-sm transition-colors",
              think
                ? "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                : "border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary",
            )}
          >
            <Lightbulb className="size-4" />
            <span>Think</span>
          </button>
          {canTranscribe && (
            <MicButton
              // Spoken words are added to the box, so you can check them before sending.
              onText={(spoken) => setText((current) => (current.trim() ? `${current.trimEnd()} ${spoken}` : spoken))}
              onError={setHint}
            />
          )}
          {busy ? <ComposerButton mode="stop" onClick={onStop} /> : <ComposerButton mode="send" disabled={!canSend} />}
        </div>
      </div>
      {hint ? (
        <p className="px-5 pt-1.5 text-xs text-text-destructive">{hint}</p>
      ) : attachments.failed.length > 0 ? (
        <p className="px-5 pt-1.5 text-xs text-text-destructive">
          {attachments.failed.map((d) => d.name).join(", ")} couldn't be added — remove it to send, or try uploading it again.
        </p>
      ) : (
        attachments.waiting && <p className="px-5 pt-1.5 text-xs text-text-tertiary">Preparing your documents — you can send once they're ready.</p>
      )}
    </form>
  );
}

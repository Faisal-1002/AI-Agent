import { Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import TextareaAutosize from "react-textarea-autosize";
import type { ImageAttachment } from "../../../../shared/chat";
import { isImage, prepareImage } from "../../lib/images";
import { IconButton } from "../ui/IconButton";
import { ComposerButton } from "./ComposerButton";
import { MicButton } from "./MicButton";

const MAX_IMAGES = 4;

type Props = {
  busy: boolean;
  canTranscribe: boolean; // speech-to-text service is up → show the 🎤 button
  canAttachImages: boolean; // the model can see images → show the 📎 button
  onSend: (text: string, images: ImageAttachment[]) => Promise<boolean>; // false = refused (e.g. by the safety filter)
  onStop: () => void;
};

// The message box: grows with the text, Enter sends, Shift+Enter adds a new line.
// Images can be attached with 📎, pasted, or dropped onto it.
export function ChatForm({ busy, canTranscribe, canAttachImages, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [hint, setHint] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const canSend = (text.trim().length > 0 || images.length > 0) && !busy;

  // Hints ("didn't catch that", "only images") fade out on their own.
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(undefined), 5000);
    return () => clearTimeout(timer);
  }, [hint]);

  const addImages = async (files: File[]) => {
    if (!canAttachImages || files.length === 0) return;
    const usable = files.filter(isImage);
    if (usable.length < files.length) setHint("Only PNG, JPEG, WebP or GIF images can be attached.");
    const room = MAX_IMAGES - images.length;
    if (usable.length > room) setHint(`Up to ${MAX_IMAGES} images per message.`);
    const prepared = await Promise.all(usable.slice(0, Math.max(0, room)).map(prepareImage));
    setImages((current) => [...current, ...prepared].slice(0, MAX_IMAGES));
  };

  const submit = () => {
    if (!canSend) return;
    const sentText = text.trim();
    const sentImages = images;
    setText("");
    setImages([]);
    // If the message was refused, give it back so nothing is lost.
    onSend(sentText, sentImages).then((ok) => {
      if (ok) return;
      setText((current) => current || sentText);
      setImages((current) => (current.length ? current : sentImages));
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
    if (files.length && canAttachImages) {
      e.preventDefault();
      void addImages(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    void addImages([...e.dataTransfer.files]);
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
        {images.length > 0 && (
          <div className="flex gap-2 px-2 pb-1 pt-1">
            {images.map((image, i) => (
              <div key={i} className="group relative">
                <img src={image.dataUrl} alt={image.name} className="size-16 rounded-xl border border-border-light object-cover" />
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => setImages((current) => current.filter((_, j) => j !== i))}
                  className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-text-primary text-surface-primary"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1">
          {canAttachImages && (
            <>
              <IconButton icon={Paperclip} label="Attach images" onClick={() => fileInput.current?.click()} className="rounded-full" />
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                className="hidden"
                onChange={(e) => {
                  void addImages([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
            </>
          )}
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
            className={`my-1.5 flex-1 resize-none bg-transparent leading-6 text-text-primary placeholder:text-text-tertiary focus:outline-none ${canAttachImages ? "pl-1" : "pl-3"}`}
          />
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
      {hint && <p className="px-5 pt-1.5 text-xs text-text-destructive">{hint}</p>}
    </form>
  );
}

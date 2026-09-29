import { useState, type FormEvent, type KeyboardEvent } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { ComposerButton } from "./ComposerButton";

type Props = {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
};

// The message box: grows with the text, Enter sends, Shift+Enter adds a new line.
export function ChatForm({ busy, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const canSend = text.trim().length > 0 && !busy;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        submit();
      }}
      className="mx-auto w-full max-w-3xl px-4 md:px-5"
    >
      <div className="flex items-end gap-2 rounded-3xl border border-border-light bg-surface-chat p-2 pl-5 shadow-md transition-colors focus-within:border-border-medium">
        <TextareaAutosize
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message seyl-ai"
          aria-label="Message seyl-ai"
          autoFocus
          minRows={1}
          maxRows={12}
          className="my-1.5 flex-1 resize-none bg-transparent leading-6 text-text-primary placeholder:text-text-tertiary focus:outline-none"
        />
        {busy ? <ComposerButton mode="stop" onClick={onStop} /> : <ComposerButton mode="send" disabled={!canSend} />}
      </div>
    </form>
  );
}

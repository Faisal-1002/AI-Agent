import { LoaderCircle, Mic, Square } from "lucide-react";
import { useState } from "react";
import { useRecorder } from "../../hooks/useRecorder";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";

type Props = {
  onText: (text: string) => void;
  onError: (message: string) => void;
  disabled?: boolean;
};

// 🎤 Click to record, click again to stop; the words land in the message box (Qwen3-ASR).
export function MicButton({ onText, onError, disabled }: Props) {
  const { recording, start, stop } = useRecorder();
  const [transcribing, setTranscribing] = useState(false);

  const toggle = async () => {
    if (!recording) {
      await start().catch(() => onError("Microphone not available — check the browser's permission."));
      return;
    }
    const audio = await stop();
    setTranscribing(true);
    try {
      const { text } = await api.transcribe(audio);
      if (text) onText(text);
      else onError("Didn't catch that — try again.");
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setTranscribing(false);
    }
  };

  const Icon = transcribing ? LoaderCircle : recording ? Square : Mic;
  const label = transcribing ? "Transcribing…" : recording ? "Stop recording" : "Speak your message";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || transcribing}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40",
        recording
          ? "animate-pulse bg-text-destructive text-white"
          : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
      )}
    >
      <Icon className={cn(recording ? "size-3.5 fill-current" : "size-5", transcribing && "animate-spin")} />
    </button>
  );
}

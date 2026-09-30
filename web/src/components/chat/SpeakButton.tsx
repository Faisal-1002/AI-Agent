import { CircleAlert, LoaderCircle, Square, Volume2 } from "lucide-react";
import { useSpeaker } from "../../lib/speaker";
import { IconButton } from "../ui/IconButton";

const ICONS = { idle: Volume2, loading: LoaderCircle, playing: Square, error: CircleAlert };

// 🔊 Read a reply aloud (Qwen3-TTS). Click again to stop.
export function SpeakButton({ id, text }: { id: string; text: string }) {
  const { phase, toggle, error } = useSpeaker(id, text);
  const label = {
    idle: "Read aloud",
    loading: "Preparing audio… (click to cancel)",
    playing: "Stop reading",
    error: `Couldn't read aloud: ${error} (click to retry)`,
  }[phase];

  return (
    <IconButton
      icon={ICONS[phase]}
      label={label}
      size="sm"
      onClick={toggle}
      data-active={phase !== "idle" || undefined}
      className={phase === "loading" ? "[&_svg]:animate-spin" : phase === "error" ? "text-text-destructive" : undefined}
    />
  );
}

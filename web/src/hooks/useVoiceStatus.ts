import { useEffect, useState } from "react";
import type { VoiceStatus } from "../../../shared/chat";
import { api } from "../lib/api";

// Which voice features to show. Voice runs in optional containers, so ask once at start.
export function useVoiceStatus(): VoiceStatus {
  const [status, setStatus] = useState<VoiceStatus>({ asr: false, tts: false });
  useEffect(() => {
    api.voiceStatus().then(setStatus).catch(() => {});
  }, []);
  return status;
}

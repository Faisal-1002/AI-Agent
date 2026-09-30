import { useCallback, useEffect, useRef, useState } from "react";

// Records from the microphone with the browser's MediaRecorder (usually webm/opus).
export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const media = new MediaRecorder(stream);
    chunks.current = [];
    media.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
    media.start();
    recorder.current = media;
    setRecording(true);
  }, []);

  // Resolves with the recording once the browser has flushed the last chunk.
  const stop = useCallback(
    () =>
      new Promise<Blob>((resolve) => {
        const media = recorder.current;
        if (!media) return resolve(new Blob());
        media.onstop = () => {
          media.stream.getTracks().forEach((track) => track.stop()); // turn the mic off
          resolve(new Blob(chunks.current, { type: media.mimeType }));
        };
        media.stop();
        recorder.current = null;
        setRecording(false);
      }),
    [],
  );

  // Release the microphone if the component goes away mid-recording.
  useEffect(() => () => recorder.current?.stream.getTracks().forEach((t) => t.stop()), []);

  return { recording, start, stop };
}

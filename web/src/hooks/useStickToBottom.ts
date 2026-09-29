import { useEffect, useLayoutEffect, useRef } from "react";

// Keeps a scroll container pinned to the bottom while content streams in —
// unless the user has scrolled up to read something.
export function useStickToBottom<T extends HTMLElement>(content: unknown) {
  const ref = useRef<T>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [content]);

  return ref;
}

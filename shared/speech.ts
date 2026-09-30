// Turning a markdown reply into text worth reading aloud. Shared by the UI
// (to split it into chunks) and the backend (to sanitize what it sends to TTS).

const MAX_SPEAK_CHARS = 1000; // read at most this much of a reply
const CHUNK_CHARS = 220; // ~15 s of speech per request

// Markdown → plain sentences worth saying out loud (code blocks aren't).
export function toSpeakable(markdown: string): string {
  // Headings and list items become sentences, so the voice pauses after them.
  const endSentence = (line: string) => (/[.!?:;]$/.test(line) ? line : `${line}.`);
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+\.)\s+(.+?)\s*$/gm, (_, line: string) => endSentence(line))
    .replace(/^\s{0,3}>\s?/gm, "") // quotes
    .replace(/\|/g, " ") // table pipes
    .replace(/[*_~]{1,3}/g, "") // bold / italic / strikethrough
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= MAX_SPEAK_CHARS) return text;
  // Cut at the last sentence end that fits, so speech doesn't stop mid-word.
  const cut = text.slice(0, MAX_SPEAK_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > 200 ? cut.slice(0, end + 1) : cut;
}

// Split into sentence-aligned chunks, so playback can start after the first one
// is generated instead of waiting for the whole reply.
export function speechChunks(markdown: string): string[] {
  // A sentence ends at . ! ? followed by a space — so "notes.md" or "3.5" stay whole.
  const sentences = toSpeakable(markdown).split(/(?<=[.!?]["')\]]*)\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences.map((s) => s.trim()).filter(Boolean)) {
    // Keep the first chunk short: that's the wait before any sound.
    const limit = chunks.length === 0 ? CHUNK_CHARS / 2 : CHUNK_CHARS;
    if (current && current.length + sentence.length + 1 > limit) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

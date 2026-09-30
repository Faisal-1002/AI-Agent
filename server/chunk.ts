// Split a document into overlapping chunks for embedding.
//
// Why chunks: an embedding is one vector per text, so a whole document would blur into a
// single "average meaning". Chunks of a few paragraphs keep each vector specific enough
// to match a question. The overlap keeps a sentence that straddles a boundary findable.

const CHUNK_CHARS = 1200; // ≈ 300 tokens
const OVERLAP_CHARS = 200;

export function chunkText(text: string, size = CHUNK_CHARS, overlap = OVERLAP_CHARS): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];

  // Pieces no longer than `size`: paragraphs, or sentences of paragraphs that are too long.
  const pieces: string[] = [];
  for (const paragraph of clean.split(/\n\n/)) {
    if (paragraph.length <= size) pieces.push(paragraph);
    else
      for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
        for (let i = 0; i < sentence.length; i += size) pieces.push(sentence.slice(i, i + size)); // very long "sentences"
      }
  }

  // Pack pieces into chunks; start each new chunk with the tail of the previous one.
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > size) {
      chunks.push(current);
      const tail = current.slice(-overlap);
      current = `${tail.slice(tail.indexOf(" ") + 1)}\n\n${piece}`; // don't start mid-word
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

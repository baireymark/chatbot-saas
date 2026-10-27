// Simple keyword retrieval. Good for small sites (hundreds of chunks).
// Swap in embeddings + a vector index when a client's content grows large.

const STOP = new Set(
  'a an the and or of to in on for with is are was be it this that at by from as i you we our your me my do does can what how when where who why will would should about any'.split(' ')
);

export function chunkText(text, size = 800) {
  const pieces = [];
  for (const para of text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    for (let i = 0; i < para.length; i += size) pieces.push(para.slice(i, i + size));
  }
  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > size) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? current + '\n\n' + piece : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const tokenize = (s) =>
  (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 1 && !STOP.has(t));

export function searchChunks(chunks, query, k = 4) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const scored = [];
  for (const chunk of chunks) {
    const words = tokenize(chunk.text);
    const freq = new Map();
    for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
    let score = 0;
    for (const t of terms) if (freq.has(t)) score += 1 + Math.log(freq.get(t));
    if (score > 0) scored.push({ ...chunk, score: score / Math.sqrt(words.length + 1) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

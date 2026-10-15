/** Order and punctuation are evidence. Retrieval's bag-of-words key is not an equality key. */
export function exactKnowledge(value: string): string { return value.trim().replace(/\s+/g, ' '); }
const groups = [
  /\b(?:not|never|no|without|cannot|can't|isn't|doesn't)\b/gi,
  /\b(?:enabled|disabled)\b/gi, /\b(?:allowed|forbidden|prohibited)\b/gi,
  /\b(?:before|after)\b/gi, /\b(?:required|optional)\b/gi,
  /\b(?:always|sometimes)\b/gi, /\bv?\d+(?:\.\d+)*\b/gi,
];
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export function semanticRisk(a: string, b: string): boolean {
  if (exactKnowledge(a) === exactKnowledge(b)) return false;
  const left = words(a), right = words(b);
  // A bag-of-words match with a different sequence must never imply equality.
  if (left.slice().sort().join(' ') === right.slice().sort().join(' ') && left.join(' ') !== right.join(' ')) return true;
  if ((/[→←]|->|<-/.test(a + b)) && exactKnowledge(a) !== exactKnowledge(b)) return true;
  return groups.some((pattern) => {
    const x = [...new Set(a.toLowerCase().match(pattern) ?? [])].sort().join('|');
    const y = [...new Set(b.toLowerCase().match(pattern) ?? [])].sort().join('|');
    return x !== y && Boolean(x || y);
  });
}

export function evidenceSentences(content: string): string[] {
  return content.split(/(?:\r?\n)+|(?<=[.!?])\s+/u).map(exactKnowledge).filter(Boolean);
}
/** MVP uses extractive factual bodies: the model can select/compact, but cannot manufacture sentences. */
export function isExtractivelyGrounded(content: string, sources: string[]): boolean {
  const allowed = new Set(sources.flatMap(evidenceSentences));
  return evidenceSentences(content).every((sentence) => allowed.has(sentence));
}

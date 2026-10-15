const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "for", "from", "in", "is", "it", "must", "of", "on", "or", "the", "to", "use", "with"]);

export function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[`*_]/g, "").match(/[\p{L}\p{N}]+(?:[._/-][\p{L}\p{N}]+)*/gu)?.filter((token) => token.length > 1 && !STOP_WORDS.has(token)) ?? []);
}

export function normalized(value: string): string { return [...tokens(value)].sort().join(" "); }

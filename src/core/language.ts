const CODE = /```[\s\S]*?```|`[^`]*`/g;

/** Durable prose is English; identifiers and code literals may retain their source spelling. */
export function assertEnglishProse(values: Array<string | null | undefined>, subject = "Durable Prodero prose"): void {
  for (const value of values) {
    if (!value) continue;
    const prose = value.replace(CODE, "");
    for (const character of prose) {
      if (/\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character))
        throw new Error(`${subject} must be written in English; wrap exact non-English identifiers or code literals in backticks.`);
    }
  }
}

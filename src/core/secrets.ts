/** Best-effort screening, shared by core storage and plugin/provider boundaries. Not complete DLP. */
function placeholder(value: string): boolean {
  return /^(?:<[^>]+>|\$[\w{][\w}]*|\$\{[^}]+\}|process\.env\.[\w]+|os\.environ(?:\[[^\]]+\]|\.get\([^)]*\))|example|placeholder|changeme|your[_-].*|redacted|\*+|x{3,}|undefined|null)$/i.test(value);
}
export function hasSecret(value: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b|https?:\/\/[^\s/:]+:[^\s/@]+@/i.test(value)) return true;
  // Require a credential field and an assigned value, not a mention of a sensitive word.
  // Prefix components cover SERVICE_PASSWORD, AWS_SECRET_ACCESS_KEY and vendor TOKEN names.
  const assignment = /\b((?:[a-z][a-z0-9]*[_-])*_?(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|secret[_-]?(?:access[_-]?)?key|access[_-]?key[_-]?id|private[_-]?key|account[_-]?key|shared[_-]?access[_-]?signature|authorization)|[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*[_-]token|_auth)[ \t]*["']?[ \t]*(:(?!:)|=(?!=|>))[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|([^\s\\"',;]+))/gi;
  for (let match; (match = assignment.exec(value)) !== null;) {
    // An inline Markdown span can end immediately after a field name (`authorization:`).
    // That closing backtick is not the opening quote of a credential value. Resume
    // after it so a later assignment in the same prose is still screened.
    if (match[5] !== undefined && match[2] === ':') {
      const opening = match.index + match[0].indexOf('`');
      const lineStart = value.lastIndexOf('\n', match.index - 1) + 1;
      const preceding = value.slice(lineStart, opening).match(/`+/g) ?? [];
      const spanStart = value.lastIndexOf('`', opening - 1) + 1;
      const heading = value.slice(spanStart, opening);
      if (preceding.filter(run => run.length === 1).length % 2 === 1 && /^[A-Za-z][A-Za-z \t-]*:$/.test(heading)) {
        assignment.lastIndex = opening + 1;
        continue;
      }
    }
    const quoted = match[3] !== undefined || match[4] !== undefined || match[5] !== undefined;
    const token = (match[3] ?? match[4] ?? match[5] ?? match[6]).trim();
    // This exact Core workflow enum describes review semantics, not a credential.
    // Do not exempt other authorization values or the same literal in credential fields.
    if (match[1].toLowerCase() === 'authorization' && token === 'explicit_workflow_and_exact_preview_required') continue;
    if (placeholder(token) || /^(?:Bearer|Basic) /i.test(token) && placeholder(token.replace(/^(?:Bearer|Basic) +/i, ''))) continue;
    // Ordinary type declarations, variable/member references and function calls aren't literals.
    const declaration = /\b(?:const|let|var)\s+$/.test(value.slice(Math.max(0, match.index! - 16), match.index));
    if (!quoted && (/^(?:string|number|boolean|unknown|any|never|true|false|password|token|secret)[)}\]]*$/i.test(token) || /^(?:process\.env|os\.environ|config|env|settings)[.\[]/.test(token) || declaration && /^[A-Za-z_$][\w$]*(?:[.(\[]|$)/.test(token))) continue;
    if (/^(?:Bearer|Basic)$/i.test(token)) continue;
    if (token.length >= 6) return true;
  }
  // Unquoted HTTP authorization headers have a scheme followed by the credential.
  for (const match of value.matchAll(/\bauthorization[ \t]*:[ \t]*(?:Bearer|Basic)[ \t]+([^\s"',;]+)/gi)) {
    if (match[1].length >= 6 && !placeholder(match[1])) return true;
  }
  // Sampling/import boundaries also pass JSON-encoded source strings. Decode valid JSON
  // rather than letting escaped quotes hide an assignment from the same detector.
  if (/^\s*[\[{"]/.test(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return hasSecret(parsed);
      if (parsed && typeof parsed === 'object') return secretStrings(parsed).some(hasSecret);
    } catch { /* Ordinary source code is not JSON. */ }
  }
  return false;
}
const secretStrings = (input: unknown): string[] => typeof input === 'string' ? [input] : Array.isArray(input) ? input.flatMap(secretStrings) : input && typeof input === 'object' ? Object.entries(input).flatMap(([key, v]) => [typeof v === 'string' ? `${key}=${JSON.stringify(v)}` : '', ...secretStrings(v)]) : [];
export function assertNoSecrets(value: unknown): void {
  if (secretStrings(value).some(hasSecret)) throw new Error('Potential credential detected. Remove secrets before storing or sharing Prodero content. No secret value is included in this diagnostic.');
}

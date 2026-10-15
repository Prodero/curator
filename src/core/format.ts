export function parseFrontmatter(content: string, filename = "canonical Markdown"): { metadata: Record<string, unknown>; body: string } {
  content = content.replace(/\r\n/g, "\n");
  if (!content.startsWith("---\n")) return { metadata: {}, body: content };
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`Invalid canonical frontmatter: ${filename} has no closing delimiter.`);
  const metadata: Record<string, unknown> = {};
  for (const line of content.slice(4, end).split("\n")) {
    const match = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!line.trim()) continue;
    if (!match) throw new Error(`Invalid canonical frontmatter: ${filename} has a malformed metadata line.`);
    const [, key, raw] = match;
    if (Object.hasOwn(metadata, key)) throw new Error(`Invalid canonical frontmatter: ${filename} has duplicate ${key}.`);
    if (raw === "null" || raw === "") metadata[key] = null;
    else if (raw === "true" || raw === "false") metadata[key] = raw === "true";
    else if (raw.startsWith("[") || raw.startsWith("{") || raw.startsWith('"')) {
      try { metadata[key] = JSON.parse(raw); } catch { throw new Error(`Invalid canonical frontmatter: ${filename} has malformed ${key}.`); }
    } else if (/^-?\d+$/.test(raw)) metadata[key] = Number(raw);
    else metadata[key] = raw;
  }
  return { metadata, body: content.slice(end + 5).replace(/^\r?\n/, "") };
}

export function frontmatter(metadata: Record<string, unknown>, body: string): string {
  const lines = Object.entries(metadata).map(([key, value]) => {
    if (value === null || value === undefined) return `${key}: null`;
    if (typeof value === "number" || typeof value === "boolean") return `${key}: ${value}`;
    if (Array.isArray(value) || typeof value === "object") return `${key}: ${JSON.stringify(value)}`;
    const stringValue = String(value);
    return `${key}: ${/[\n:[\]{}#,]|^\s|\s$|^"|^(?:true|false|null|-?\d+)$/.test(stringValue) ? JSON.stringify(stringValue) : stringValue}`;
  });
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

export function sectionBullets(body: string, headings: readonly string[]): Record<string, string[]> {
  const result = Object.fromEntries(headings.map((heading) => [heading, [] as string[]]));
  let current: string | null = null;
  let bullet: string[] | null = null;
  const flush = () => {
    if (current && bullet) {
      const value = bullet.join("\n").trim();
      if (value) result[current].push(value);
    }
    bullet = null;
  };
  for (const line of body.split(/\r?\n/)) {
    if (bullet && line.startsWith("  ")) { bullet.push(line.slice(2)); continue; }
    const heading = line.match(/^##\s+(.+?)\s*$/)?.[1];
    if (heading) {
      flush();
      current = headings.includes(heading) ? heading : null;
      continue;
    }
    const item = line.match(/^\s*[-*]\s+(.+)$/)?.[1];
    if (item && current) {
      flush();
      bullet = [item];
    } else if (bullet && /^\s{2,}\S/.test(line)) bullet.push(line.trim());
  }
  flush();
  return result;
}

export function parseObservationAnnotations(raw: string): { metadata: Record<string, string>; content: string } {
  if (!raw.startsWith("[")) return { metadata: {}, content: raw.trim() };
  let end = -1;
  let quoted = false;
  for (let i = 1; i < raw.length; i += 1) {
    if (raw[i] === "\\" && quoted) { i += 1; continue; }
    if (raw[i] === '"') quoted = !quoted;
    if (raw[i] === "]" && !quoted) { end = i; break; }
  }
  if (end < 0) return { metadata: {}, content: raw.trim() };
  const metadata: Record<string, string> = {};
  for (const match of raw.slice(1, end).matchAll(/([a-z_]+)=("(?:\\.|[^"\\])*"|[^\s;]+)/g)) {
    try { metadata[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2]; }
    catch { metadata[match[1]] = match[2].replace(/^"|"$/g, ""); }
  }
  return { metadata, content: raw.slice(end + 1).trim() };
}

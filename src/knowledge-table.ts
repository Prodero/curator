/** Plain-text catalogue for terminal chat. Keys are page-local navigation, never IDs. */
export interface KnowledgeTableRow {
  key: string;
  id: string;
  layer: string;
  category: string;
  priority: string;
  title: string;
}
const segments = new Intl.Segmenter('en', { granularity: 'grapheme' });
const width = (s: string) => {
  const cp = s.codePointAt(0) ?? 0;
  return /\p{Extended_Pictographic}/u.test(s) || cp >= 0x1100 && (
    cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 ||
    cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe6f ||
    cp >= 0xff01 && cp <= 0xff60 || cp >= 0x20000 && cp <= 0x3ffff) ? 2 : 1;
};
const cells = (value: string, limit: number) => {
  // Titles are untrusted data: keep terminal controls and Markdown fences out.
  const text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/`/g, "'").replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const lines: string[] = []; let line = '', used = 0;
  for (const { segment } of segments.segment(text)) {
    const size = width(segment);
    if (used + size > limit) { lines.push(line + ' '.repeat(limit - used)); line = ''; used = 0; }
    line += segment; used += size;
  }
  lines.push(line + ' '.repeat(limit - used));
  return lines;
};
export function renderKnowledgeTable(rows: KnowledgeTableRow[]): string {
  if (!rows.length) return 'No knowledge matches these filters.';
  const widths = [5, 44, 11, 10, 9];
  const border = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const row = (values: string[]) => {
    const columns = values.map((v, i) => cells(v, widths[i]));
    return Array.from({ length: Math.max(...columns.map(c => c.length)) }, (_, i) =>
      '| ' + columns.map((c, j) => c[i] ?? ' '.repeat(widths[j])).join(' | ') + ' |').join('\n');
  };
  return ['```text', border, row(['#', 'Knowledge', 'Type', 'Priority', 'Layer']), border,
    ...rows.flatMap(r => [row([r.key, r.title, r.category, r.priority, r.layer]), border]), '```'].join('\n');
}

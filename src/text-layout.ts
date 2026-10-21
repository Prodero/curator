/** Chat-native, I/O-free text layout. Core and shared action projections own state. */
import type { ProderoViewModel, ViewItem } from './presentation.js';
import { numberedActions } from './conversation-presentation.js';

export interface TextScene {
  action: string;
  project?: string;
  task?: string;
  budget?: { used: number; total: number; source: 'Bootstrap' | 'Task'; estimated: true };
  home?: { initialized?: boolean; records?: number; local?: number; versioned?: number; deferred?: number; pending?: number };
}
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemes = (s: string) => Array.from(segmenter.segment(s), x => x.segment);
const glyphWidth = (s: string) => {
  const n = s.codePointAt(0) ?? 0;
  if (/^[\p{Mark}]+$/u.test(s)) return 0;
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(s) || n >= 0x1100 && (n <= 0x115f || n >= 0x2e80 && n <= 0xa4cf || n >= 0xac00 && n <= 0xd7a3 || n >= 0xf900 && n <= 0xfaff || n >= 0xfe10 && n <= 0xfe6f || n >= 0xff01 && n <= 0xff60 || n >= 0x20000 && n <= 0x3ffff) ? 2 : 1;
};
export const textWidth = (s: string) => graphemes(s).reduce((n, g) => n + glyphWidth(g), 0);
// Formatting never permits terminal escapes, bidi controls or injected fence endings.
// Newlines and literal code/body spacing survive in the verbatim fallback below.
export const safeText = (s: unknown) => String(s ?? '').replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
export function wrapText(raw: string, width: number): string[] {
  const result: string[] = [];
  for (const paragraph of safeText(raw).replace(/\t/g, '    ').split(/\r?\n/)) {
    let line = '', used = 0;
    for (const g of graphemes(paragraph)) {
      const size = glyphWidth(g);
      if (used + size > width && line) {
        const cut = line.lastIndexOf(' ');
        if (cut > 0) { result.push(line.slice(0, cut)); line = line.slice(cut + 1); used = textWidth(line); }
        else { result.push(line); line = ''; used = 0; }
      }
      line += g; used += size;
    }
    result.push(line);
  }
  return result;
}
/** Dynamic fences retain complete Markdown/code examples without escaping their wording. */
export function textFence(content: string): string {
  const text = safeText(content);
  let longest = 2;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}
export function entryKey(index: number): string {
  let n = index + 1, key = '';
  do { n--; key = String.fromCharCode(65 + n % 26) + key; n = Math.floor(n / 26); } while (n);
  return key;
}
const number = (n: number) => n.toLocaleString('en-US');
export function budgetLines(b: NonNullable<TextScene['budget']>): string[] {
  if (!Number.isFinite(b.used) || !Number.isFinite(b.total) || b.used < 0 || b.total <= 0) return ['Budget unavailable.'];
  const percent = Math.round(b.used / b.total * 100);
  const filled = Math.max(0, Math.min(25, Math.round(b.used / b.total * 25)));
  return ['▰'.repeat(filled) + '▱'.repeat(25 - filled) + ` ${percent}%`, `${number(b.used)} / ${number(b.total)} est. tokens`, `${b.source} · Prodero allocation only.`, ...(b.used > b.total ? ['Allocation exceeds its budget.'] : [])];
}

export function renderProductText(vm: ProderoViewModel, diagnostics = false, expanded = diagnostics, plain = false): string {
  const scene = vm.textScene, action = scene?.action, v = vm.conversation;
  const width = 38, prefix = plain ? '| ' : '│ ', rule = plain ? '-' : '─';
  const screens: Record<string,string> = {open:'01',status:'01','status-details':'01',initialized:'01',knowledge:'02','knowledge-mutated':'02',prepare:'03',context:'03','memory-sync':'04','curation-question':'04',curation:'05','instruction-review':'06','instruction-optimize':'06','promotion-preview':'07','promotion-applied':'07','session-close':'08','session-review':'08','config-get':'09','update-instructions':'10',migration:'10',error:'00'};
  const screen = vm.knowledgeTable ? '02' : screens[action ?? ''] ?? '00';
  const head = `${plain ? '+-' : '╭─'} >_ PRODERO `;
  const lines = [head + rule.repeat(width - textWidth(head) - 4) + ` /${screen}`];
  const line = (text = '') => {
    const indent = (text.match(/^ +/)?.[0] ?? '').slice(0, 12);
    lines.push(...wrapText(text.slice(indent.length), width - 2 - indent.length).map(s => prefix.trimEnd() + (s.trimEnd() ? ' ' + indent + s.trimEnd() : '')));
  };
  const section = (title: string) => {
    if (textWidth(safeText(title)) > width - 5) { lines.push((plain ? '+' : '├') + rule.repeat(width - 1)); line(title); return; }
    const parts = wrapText(title, width - 5);
    const p = `${plain ? '+-' : '├─'} ${parts.shift()} `;
    lines.push(p + rule.repeat(Math.max(0, width - textWidth(p))));
    parts.forEach(part => line(part));
  };
  const inset = () => { line(); lines.push(prefix + '  ' + rule.repeat(27)); line(); };
  const title = vm.title.replace(/^Prodero · /, '');
  line(action === 'update-instructions' ? 'Prodero · terminal update' : scene?.project ? `${scene.project} · project memory` : 'Prodero');
  line();

  const prepared = action === 'prepare' || action === 'context';
  const full = expanded || !v || v.kind === 'details';
  const compactReady = prepared && !full && !v?.blocking && !v?.attention.length;
  if (compactReady) {
    const compact = ['>_ PRODERO /03 · Context Ready'];
    if (scene?.project) compact.push(...wrapText(scene.project, width));
    compact.push(...wrapText(v?.facts.find(x => x.includes(' required · ')) ?? '', width));
    if (scene?.budget) compact.push(...wrapText(`${number(scene.budget.used)} / ${number(scene.budget.total)} est. Prodero tokens`, width));
    compact.push('Ready · continuing the task');
    return textFence(compact.join('\n'));
  }
  // Exact bodies are deliberately unframed: long code/paths and whitespace are not
  // truncated or rewritten merely to fit a phone. The panel remains bounded.
  const bodies: string[] = [];
  const verbatim = (heading: string, items: ViewItem[]) => {
    if (!items.length) return;
    bodies.push(`${heading}:\n` + items.map(i => [i.title, i.body, ...i.notes].filter(Boolean).join('\n')).join('\n\n   ' + rule.repeat(27) + '\n\n'));
  };
  if (scene?.home && !full) {
    const h = scene.home;
    if (h.initialized) {
      if (action === 'initialized') { line('Initialized'); line(); }
      section('CONTEXT');
      if (scene.budget) budgetLines(scene.budget).forEach(x => line(plain ? x.replaceAll('▰','#').replaceAll('▱','.') : x));
      else line('Task allocation not prepared here.');
      line(); section('MEMORY');
      if (h.records !== undefined) line(`${number(h.records)} records`);
      if (h.local !== undefined && h.versioned !== undefined) line(`${number(h.local)} local · ${number(h.versioned)} versioned`);
      line(); section('ATTENTION');
      if (h.deferred !== undefined) line(`? ${h.deferred} deferred questions`);
      if (h.pending !== undefined) line(`Δ ${h.pending} unapplied change groups`);
      (v?.attention ?? []).forEach(x => line(x));
      if (!v?.attention.length && h.deferred === undefined && h.pending === undefined) line(action === 'status' && h.records === undefined ? 'Lightweight status; counts not loaded.' : 'No attention needed.');
      // Session activity is real data, not evidence of a background agent.
      v?.facts.filter(x => x.startsWith('Session')).forEach(x => line(x));
    } else {
      section(v?.state ?? title); (v?.facts ?? vm.notices).forEach(x => line(x));
      v?.attention.forEach(x => line(x));
    }
  } else if (prepared) {
    section(v?.blocking ? v.state : v?.attention.length ? 'Attention' : action === 'prepare' ? 'Context Ready' : 'View Context');
    if (!compactReady && scene?.task) line(`Task: ${scene.task}`);
    if (!v?.blocking) line(action === 'context' ? 'Read-only context view.' : v?.attention.length ? 'Task is not blocked; see attention.' : 'Ready · continuing the task');
    const facts = v?.facts.filter(x => !x.startsWith('Context  ')) ?? [];
    if (!compactReady) { line(); section('PROVIDED TO AGENT'); }
    facts.forEach(x => line(x));
    if (scene?.budget) {
      if (!compactReady) { line(); section('PRODERO CONTEXT'); budgetLines(scene.budget).forEach(x => line(plain ? x.replaceAll('▰','#').replaceAll('▱','.') : x)); }
      else line(`${number(scene.budget.used)} / ${number(scene.budget.total)} est. Prodero tokens`);
    }
    if (v?.attention.length) { line(); section('ATTENTION'); v.attention.forEach(x => line(x)); }
    if (full) for (const s of vm.sections) {
      section(s.title);
      s.items.forEach((i, index) => { if (index) inset(); line(i.title); });
      verbatim(s.title, s.items);
    }
  } else if (vm.knowledgeTable) {
    const t = vm.knowledgeTable;
    section('KNOWLEDGE');
    line(t.rows.length ? `Showing ${t.offset + 1}-${t.offset + t.rows.length} of ${t.total}` : 'No knowledge matches these filters.');
    t.rows.forEach((r, index) => {
      if (index) inset(); else line();
      line(`${r.key} · ${r.title}`); line(`  ${r.layer}`);
      const preview = vm.sections.find(s => s.title === 'Knowledge')?.items[index]?.body;
      if (preview) {
        const flat = safeText(preview).replace(/\s+/g, ' ').trim();
        const summary = graphemes(flat).slice(0, 90).join('');
        line('  ' + summary + (summary.length < flat.length ? '…' : ''));
      }
    });
    if (t.rows.length) { line(); line('Enter a letter to open its record.'); }
    if (expanded) verbatim('Knowledge', vm.sections.find(s => s.title === 'Knowledge')?.items ?? []);
  } else {
    if (action === 'memory-sync') {
      section('CURATE MEMORY');
      const state = full ? title.replace(/^Curate Memory · /,'') : v?.state ?? title;
      if (state !== 'Curate Memory') line(state);
    } else section(action === 'session-close' ? 'Session closed' : v?.kind !== 'details' && !full ? v?.state ?? title : title);
    if (action === 'session-close') line(v?.state ?? 'Check saved state');
    if (full && v?.reviewRequired) line('Review required · not approval.');
    if (!full && v?.kind !== 'details') {
      v?.facts.forEach(x => line(x));
      if (v?.attention.length) { line(); section('ATTENTION'); v.attention.forEach(x => line(x)); }
    } else {
      vm.metrics.forEach(m => line(`${m.label}  ${m.value}${m.detail ? ' · ' + m.detail : ''}`));
      if (!vm.sections.some(s => s.title === 'Knowledge detail')) vm.notices.forEach(x => line(x));
      for (const s of vm.sections) { section(s.title); s.items.forEach((i, n) => { if (n) inset(); line(i.title); }); verbatim(s.title, s.items); }
    }
  }
  // Exact reviews precede the approval menu; reading and approving remain distinct.
  if (v?.prompt) { line(); wrapText(v.prompt, width - 2).forEach(x => line(x)); }
  lines.push((plain ? '+' : '╰') + rule.repeat(width - 1));
  const actions = numberedActions(vm, full);
  const menu: string[] = [];
  if (actions.length) {
    menu.push('', 'Available actions:', '');
    for (const a of actions) {
      const key = `  ${a.number} > `;
      const parts = wrapText(a.label, width - key.length);
      menu.push(key + parts[0], ...parts.slice(1).map(x => ' '.repeat(key.length) + x));
      if (a.approval) menu.push('      Explicit approval required.');
      if (a.input) menu.push(...wrapText(a.input.prompt, width - 6).map(x => '      ' + x));
    }
    menu.push('', 'Reply with a number or the command name.');
  }
  // Keep the service separator outside the record and its metadata.
  if (vm.sections.some(s => s.title === 'Knowledge detail')) bodies.push('-------------\n' + vm.notices.join('\n'));
  if (diagnostics || action === 'curation' || full && action === 'migration') for (const s of vm.diagnostics ?? []) verbatim(s.title, s.items);
  const panel = textFence(lines.join('\n'));
  const exact = bodies.map(textFence);
  const approval = full && actions.some(a=>a.approval) && (action === 'memory-sync' || action === 'migration')
    ? action === 'memory-sync' ? 'Approve these exact changes?' : `${actions.find(a=>a.approval)!.label}?` : '';
  return [panel, ...exact, menu.length ? textFence(menu.join('\n').replace(/^\n/, '').trimEnd()) : '', approval].filter(Boolean).join('\n\n');
}

/** Public sanitized errors have no executable retry/apply action. */
export function renderTextError(message: string, plain = false): string {
  return renderProductText({version:1,title:'Prodero · Error',metrics:[],notices:[message],sections:[],actions:[],textScene:{action:'error'}}, false, true, plain);
}

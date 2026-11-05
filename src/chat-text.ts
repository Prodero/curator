/** Markdown for an assistant reply, independent of terminal width or host UI APIs. */
import type { ProderoViewModel, ViewItem } from './presentation.js';
import { numberedActions,chatOpenActions } from './conversation-presentation.js';
import { safeText, textFence } from './text-layout.js';

// Project names, titles and diagnostics are data, never Markdown structure or links.
export const markdownText = (value: unknown): string => safeText(value).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*{}\[\]()#!|~]/g, '\\$&').replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\$&');
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const plural = (value: number, noun: string) => `${value.toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`;
const hardBreak = '\\' + '\n';

export function renderChatText(vm: ProderoViewModel, diagnostics = false, expanded = diagnostics): string {
  const scene = vm.textScene, action = scene?.action, v = vm.conversation;
  const full = expanded || !v || v.kind === 'details';
  const parts: string[] = [];
  const text = (value: unknown) => { if (value !== undefined && value !== null && String(value).trim()) parts.push(markdownText(value)); };
  const heading = (value: string) => parts.push(`**${markdownText(value)}**`);
  const attention = () => { for (const value of v?.attention ?? []) text(value); };
  const bodies = (title: string, items: ViewItem[]) => {
    if (!items.length) return;
    parts.push(`### ${markdownText(title)}`);
    for (const item of items) {
      heading(item.title);
      // Exact requested evidence/code is literal. These fences contain source
      // material only, never the interface, navigation or a manufactured screen.
      if (item.body) parts.push(textFence(item.body));
      if (item.notes.length) parts.push(item.notes.map(note => `- ${markdownText(note)}`).join('\n'));
    }
  };
  const actions = () => {
    const available = numberedActions(vm, full);
    if (!available.length) return;
    parts.push('You can ask me to:\n\n' + available.map(a => `- ${markdownText(a.label)}${a.approval ? ' — Explicit approval required.' : ''}`).join('\n'));
  };

  if (scene?.home && !full) {
    // The small mark belongs to an explicit launch/overview, not every work step.
    parts.push('**›_ prodero**' + (scene.project ? ` · **${markdownText(scene.project)}**` : ''));
    const h = scene.home;
    if (h.initialized === true) {
      if(action==='initialized')text('Project memory initialized.');
      const memory=count(h.records)?plural(h.records,'record'):'not loaded';
      const local=count(h.local)?h.local.toLocaleString('en-US'):'not loaded';
      const versioned=count(h.versioned)?h.versioned.toLocaleString('en-US'):'not loaded';
      const context=count(h.loadedInstructions)?`Context loaded: ${plural(h.loadedInstructions,'instruction')}`:'Loaded instruction count: unavailable';
      parts.push([`├─ Memory: ${memory}`,`├─ Local: ${local} · Versioned: ${versioned}`,`└─ ${context}`].join(hardBreak));
      attention();
      const menu=chatOpenActions(vm);
      if(menu.length){parts.push(menu.map(a=>`**${a.number}.** ${markdownText(a.label)}`).join(hardBreak));text('Choose a number or ask in your own words.');}
      const updates = vm.notices.filter(notice => notice.startsWith('Update available:'));
      updates.forEach(text);
      if (updates.length) text('Ask me to show update instructions.');
    } else {
      heading(h.initialized === false ? 'Not initialized' : 'Project state unavailable');
      (v?.facts ?? vm.notices).forEach(text);
      attention();
      if (v?.prompt) text(v.prompt);
    }
  } else if (action === 'prepare' || action === 'context') {
    heading(v?.blocking ? v.state : action === 'context' ? 'View Context' : v?.attention.length ? 'Context prepared' : 'Context Ready');
    const loaded=v?.contextLoaded;
    if(loaded&&[loaded.instructions,loaded.knowledge,loaded.skills].every(count)) {
      text(`Loaded ${plural(loaded.instructions,'project instruction')} · ${plural(loaded.knowledge,'knowledge record')} · ${plural(loaded.skills,'skill')}.`);
    } else text('Loaded context counts unavailable.');
    if (v?.blocking || v?.attention.length) attention();
    else text(action === 'context' ? 'Read-only context view.' : 'Continuing the task.');
    if (v?.prompt) text(v.prompt);
    if (full) {
      if (scene?.task) text(`Task: ${scene.task}`);
      if (scene?.budget && Number.isFinite(scene.budget.used) && Number.isFinite(scene.budget.total)) text(`${scene.budget.used.toLocaleString('en-US')} / ${scene.budget.total.toLocaleString('en-US')} est. Prodero tokens`);
      vm.sections.forEach(s => bodies(s.title, s.items));
      actions();
    }
  } else if (action === 'session-close') {
    const receipt=v?.closeReceipt;
    if (receipt) parts.push(`**${markdownText(receipt.label)}** · ${markdownText(receipt.detail)}`);
    else text('Session status unavailable.');
    attention();
    if (full) {
      if (vm.metrics.length) parts.push(vm.metrics.map(m => `- ${markdownText(m.label)}: ${markdownText(m.value)}`).join('\n'));
      vm.sections.forEach(s => bodies(s.title, s.items));
      actions();
    }
  } else if (vm.knowledgeTable) {
    heading('Knowledge');
    const table = vm.knowledgeTable;
    text(table.rows.length ? `Showing ${table.offset + 1}–${table.offset + table.rows.length} of ${table.total}. Ask for a record by title.` : 'No knowledge matches these filters.');
    // Long titles and mobile clients benefit from lists, rather than a wide table.
    if (!expanded) parts.push(table.rows.map(row => `- **${markdownText(row.title)}** — ${markdownText(row.layer)} · ${markdownText(row.category)}`).join('\n'));
    else vm.sections.forEach(s => bodies(s.title, s.items));
    actions();
  } else {
    heading(vm.title.replace(/^Prodero · /, ''));
    if (!full && v) {
      if (v.state && v.state !== 'Ready') text(v.state);
      v.facts.forEach(text);
      attention();
    } else {
      if (vm.metrics.length) parts.push(vm.metrics.map(m => `- ${markdownText(m.label)}: ${markdownText(m.value)}${m.detail ? ` · ${markdownText(m.detail)}` : ''}`).join('\n'));
      vm.notices.forEach(text);
      vm.sections.forEach(s => bodies(s.title, s.items));
    }
    if (v?.prompt) text(v.prompt);
    actions();
  }
  if (diagnostics || full && action === 'migration') for (const section of vm.diagnostics ?? []) bodies(section.title, section.items);
  return parts.filter(Boolean).join('\n\n');
}

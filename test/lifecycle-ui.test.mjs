import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, PRODERO_TOOLS } from '../dist/server.js';
import { memoryCompression } from '../dist/core/telemetry.js';
import { lifecycleUi } from './helpers/lifecycle-ui.mjs';

const pending = (byType = {}, rawSessionTokens = 101) => ({ action: 'session-close', result: { learned: {
  byType, observations: Object.values(byType).reduce((a, b) => a + b, 0), rawSessionTokens,
  syncState: 'pending-auto-sync', synchronization: null,
} } });
const synchronized = (canonicalTokensAdded, outcomes = {}) => {
  const payload = pending({ decision: 2, lesson: 1, state_change: 1 }, 1820);
  Object.assign(payload.result.learned, { syncState: 'synchronized', synchronization: {
    sessionsProcessed: 1, rawSessionTokens: 1820, canonicalTokensAdded,
    memoryCompression: memoryCompression(1820, canonicalTokensAdded), ...outcomes,
  } });
  return payload;
};

const status = (overrides = {}) => ({
  product: 'Prodero', action: 'status-details', phase: 'ready', hydrationRequired: false, runtimeVersion: '0.1.0',
  update: { current: '0.1.0', latest: '0.1.0', available: false, source: 'local-checkout', status: 'current' },
  project: {
    root: '/tmp/project', name: 'project', initialized: true, git: true, agentsFile: true, schemaVersion: 5, canonicalStructure: true,
    knowledgeCount: 133, localKnowledgeCount: 0, versionedKnowledgeCount: 133, promotionRecommendedCount: 0,
    skillCount: 2, skillCandidateCount: 0, sessionCount: 12, pendingSessionCount: 0, checkpointCount: 4, conflictCount: 0,
    lastSyncAt: null, memoryHealth: { staleActiveItems: 0, missingProvenanceItems: 0, oversizedActiveItems: 0, status: 'healthy' },
    knowledgeGraph: { cacheState: 'warm', nodeCount: 133, edgeCount: 21, brokenReferences: 0, conflictEdges: 0 },
    ...overrides,
  },
});

test('Status groups current Local and Shared counts; technical statistics are secondary', async () => {
  const ui = await lifecycleUi();
  const html = ui.render(status());
  const primary=html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g,'');
  assert.match(primary, /133<\/strong><span>current memories/);
  assert.match(primary, /0<\/strong><span>Local Knowledge/);
  assert.match(primary, /133<\/strong><span>Shared \/ Versioned Knowledge/);
  assert.match(primary, /2<\/strong><span>active skills/);
  assert.doesNotMatch(primary,/checkpoints|graph edges|stale|pending/i);
  assert.match(html, /Project details/);
  assert.equal((html.match(/<div class="metric">/g) ?? []).length, 4);
});

test('Status uses planner conflict evidence, not structural age warnings, and offers sharing review', async () => {
  const ui = await lifecycleUi();
  const html = ui.render(status({promotionRecommendedCount:3,localKnowledgeCount:3,conflictCount:4,memoryOverview:{available:true,sessions:2,areas:[{id:'a',label:'Driving',recordCount:2,layers:{local:1,versioned:1},signals:['potential_conflict']}],workflow:null}}));
  assert.match(html,/3 Local memories available for sharing review/);
  assert.match(html,/1 area needs review/);
  assert.doesNotMatch(html,/Review Promotion|Possible conflict or state transition/);
});

test('Context Ready uses product labels, local disclosure and unchanged MCP telemetry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-lifecycle-ui-'));
  const server = createServer({projectRoot:root});
  const client = new Client({ name: 'lifecycle-ui', version: '1' },{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}});
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: { projectRoot: root, ...args } })).structuredContent;
  await fs.mkdir(path.join(root, '.git'));
  await call(PRODERO_TOOLS.initialize);
  const prepared = await call(PRODERO_TOOLS.prepare, { task: 'lifecycle UI' });
  const ui = await lifecycleUi();
  for (const pressure of ['normal', 'moderate', 'high']) {
    const payload = structuredClone(prepared);
    payload.result.context.metrics.requiredGlobalPressure = pressure;
    const before = JSON.stringify(payload);
    const html = ui.render(payload);
    for (const label of ['PRODERO · CONTEXT READY', 'What Prodero brought into this task.', 'Required', 'Relevant', 'Skills', 'Synced', 'Task context', 'Project knowledge', 'Knowledge selected', 'Required instructions']) assert.ok(html.includes(label), label);
    assert.doesNotMatch(html, />Global<|sessions auto-synced|Prodero context|Context selectivity|Required global|· (normal|moderate|high)/i);
    assert.match(html, /full context window or billing usage/);
    const expanded = ui.click('view-context');
    assert.match(expanded, /<h2>Prepared context<\/h2>/);
    assert.doesNotMatch(expanded, /Exact prepared snapshot/);
    assert.ok(expanded.indexOf('Prepared context</h2>') < expanded.indexOf('Session sess_'));
    assert.match(expanded, /<h2>Required<\/h2>/); assert.match(expanded, /<h2>Relevant<\/h2>/);
    assert.doesNotMatch(ui.click('close-context'), /<h2>Prepared context/);
    assert.equal(JSON.stringify(payload), before);
  }
  const bounded = structuredClone(prepared);
  Object.assign(bounded.result.context.metrics, {
    requiredGlobalExcludedItems: 3,
    requiredGlobalExcludedTokens: 202,
    requiredGlobalOmittedByBudget: 0,
    requiredGlobalOmittedByBudgetTokens: 0,
    requiredGlobalOmittedByItemLimit: 3,
    requiredGlobalOmittedByItemLimitTokens: 202,
  });
  bounded.result.context.selection.omittedRequired = [{ id: 'mem_omitted', title: 'Omitted global rule', category: 'decision', scope: 'global', scopeRef: null, priority: 'important', estimatedTokens: 72, score: 40, rankScore: 40, signals: [], reason: 'item-limit' }];
  bounded.result.uiState = { view: 'attention', attention: [{ kind: 'context-budget', title: 'Required instructions were truncated', detail: 'Review or consolidate the required instructions.' }] };
  const boundedHtml = ui.render(bounded);
  assert.match(boundedHtml, /PRODERO · REVIEW RECOMMENDED/);
  assert.match(boundedHtml, /Required instructions were truncated/);
  assert.match(boundedHtml, /data-action="view-context"/);
  const boundedExpanded = ui.click('view-context');
  assert.match(boundedExpanded, /Required instructions not loaded/);
  assert.match(boundedExpanded, /Omitted global rule/);
  ui.click('close-context');
  const sessionId = prepared.result.session.id;
  await call(PRODERO_TOOLS.sessionRecord, { sessionId, entries: [{ type: 'state_change', title: 'Lifecycle labels', content: 'Lifecycle cards now use clear product language.' }] });
  const closed = await call(PRODERO_TOOLS.sessionClose, { sessionId });
  assert.equal(closed.result.learned.byType.state_change, 1);
  assert.equal(closed.result.learned.observations, 1);
  assert.equal(closed.result.learned.syncState, 'synchronized');
  assert.match(ui.render(closed), /<strong>1<\/strong> Project change/);
  const next = await call(PRODERO_TOOLS.prepare, { task: 'Lifecycle labels' });
  assert.equal(next.result.automaticSync.sessionsProcessed, 0);
  assert.equal(typeof next.result.automaticSync.canonicalTokensAdded, 'number');
  assert.equal(typeof next.result.context.metrics.contextSelectivity, 'number');
  assert.ok(Object.hasOwn(next.result.context.metrics, 'requiredGlobalPressure'));
  assert.match(ui.render(closed), /Useful knowledge was saved automatically to Local Knowledge/);
  assert.equal(closed.result.synchronization.sessionsProcessed, 1);
  await call(PRODERO_TOOLS.sessionRecord, { sessionId: next.result.session.id, entries: [{ type: 'lesson', content: 'UI wording maps to unchanged internal telemetry.' }] });
  const syncedClose = await call(PRODERO_TOOLS.sessionClose, { sessionId: next.result.session.id, sync: true });
  assert.equal(syncedClose.result.learned.syncState, 'synchronized');
  assert.match(ui.render(syncedClose), /Useful knowledge was saved automatically to Local Knowledge/);
  assert.doesNotMatch(ui.render(syncedClose), /Pending sync/);
  const attention = structuredClone(next);
  attention.result.uiState = { view: 'attention', attention: [{ kind: 'conflict', title: 'Conflicting project knowledge', detail: 'Two current rules disagree.' }] };
  assert.match(ui.render(attention), /Conflicting project knowledge/);
});

test('Session Learned hides zeros and keeps the pending lifecycle concise', async () => {
  const ui = await lifecycleUi();
  const payload = pending({ decision: 0, lesson: 0, discovery: 0, state_change: 1, skill_candidate: 0 });
  const before = JSON.stringify(payload);
  const html = ui.render(payload);
  for (const label of ['PRODERO · SESSION LEARNED', 'What this task taught Prodero.', 'Learned', 'Project change', 'Session memory', 'Project memory', 'Pending sync', 'Saving was deferred. Prodero will recover it before the next work session.']) assert.ok(html.includes(label), label);
  assert.match(html, /101/);
  assert.doesNotMatch(html, /Decisions|Lessons|Discoveries|State changes|Skill candidate|Observations|observation|Raw session memory|Canonical contribution|Memory result|After automatic sync/);
  assert.equal(JSON.stringify(payload), before);
  const multiple = ui.render(pending({ decision: 2, lesson: 1, discovery: 1, state_change: 2, skill_candidate: 1, global_instruction_candidate: 1 }));
  for (const label of ['Decisions', 'Lesson', 'Discovery', 'Project changes', 'Skill candidate', 'Instruction candidate']) assert.ok(multiple.includes(label), label);
  const empty = ui.render(pending({ decision: 0, lesson: 0 }, 0));
  assert.match(empty, /No durable project updates recorded/);
  assert.doesNotMatch(empty, /learned-categories|Decisions|Lessons/);
});

test('synchronized outcomes expose real counts, compression, expansion and conflicts without zeros', async () => {
  const ui = await lifecycleUi();
  const payload = synchronized(620, { knowledgeCreated: 2, knowledgeConsolidated: 3, duplicates: 0, knowledgeSuperseded: 0, conflicts: 0 });
  const before = JSON.stringify(payload);
  const html = ui.render(payload);
  for (const label of ['Memory compression', '66%', '620', '1.82K', '+2 Added', '~3 Merged']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /Duplicates collapsed|Superseded|Conflicts|Pending sync|Memory result|Observations/);
  assert.equal(JSON.stringify(payload), before);
  const expanded = ui.render(synchronized(2000, { duplicates: 2, knowledgeSuperseded: 1, conflicts: 3 }));
  assert.match(expanded, /Canonical expansion/);
  assert.match(expanded, /\+9\.9%/);
  assert.doesNotMatch(expanded, /Memory compression|-[\d.]+%/);
  for (const label of ['2 Duplicates collapsed', '1 Superseded', '3 Conflicts']) assert.ok(expanded.includes(label), label);
  assert.match(expanded, /class="sync-conflicts"/);
  assert.match(ui.render(synchronized(1820)), /Unchanged/);
  const unavailable = synchronized(620);
  unavailable.result.learned.synchronization.memoryCompression = { kind: 'unavailable', ratio: null };
  assert.doesNotMatch(ui.render(unavailable), /Memory compression|Canonical expansion/);
});

test('context disclosure labels retrieval scores after reasons and explains saturation', async () => {
  const ui = await lifecycleUi();
  const item = { id: 'relevant', title: 'Relevant rule', category: 'decision', scope: 'module', content: 'Rule', sourceSessions: ['sess_source'], derivedFrom: ['sess_source#obs_1'] };
  const detail = { estimatedTokens: 10, rankScore: 18, signals: [{ label: 'Query matches lifecycle', score: 18 }] };
  const payload = { action: 'prepare', result: { context: {
    snapshot: { version: 1, sessionId: 'sess_snapshot', task: 'lifecycle' }, required: [], relevant: [item], skills: [],
    metrics: { contextTokens: 10, contextBudgetTokens: 6000, projectKnowledgeTokens: 100, contextSelectivity: .1, requiredGlobalTokens: 0, requiredContextBudgetTokens: 2000 },
    selection: { required: {}, relevant: { relevant: detail }, loadedKnowledgeItems: 1, omittedRelevantByBudget: 2, omittedRelevantByItemLimit: 15, omittedRelevantDetailsTruncated: 15,
      omittedRelevant: [{ ...item, ...detail, title: 'Budget item', reason: 'budget' }, { ...item, ...detail, title: 'Limit item', reason: 'item-limit' }] },
  } } };
  const before = JSON.stringify(payload);
  ui.render(payload);
  const html = ui.click('view-context');
  assert.match(html, /Additional matches · 17/);
  for (const label of ['Did not fit the context budget', 'Item limit reached', '2 of 17 matches shown', 'Why selected', 'Why matched', 'Sources', 'Retrieval score: 18.00']) assert.ok(html.includes(label), label);
  assert.ok(html.indexOf('Query matches lifecycle') < html.indexOf('Retrieval score:'));
  assert.doesNotMatch(html, /omitted by|>score|· item-limit/);
  assert.equal(JSON.stringify(payload), before);
});

test('assisted audit remains a compact product result and unresolved conflicts stay visible', async () => {
  const ui = await lifecycleUi();
  const payload = synchronized(620, { knowledgeCreated: 2, knowledgeConsolidated: 3, conflicts: 1, intelligence: { audit: { triggered: true, status: 'attention' } } });
  assert.match(ui.render(payload), /Attention · Review affected knowledge/);
  assert.match(ui.render(payload), /1 Conflicts/);
  payload.result.learned.synchronization.intelligence.audit.status = 'coherent';
  assert.match(ui.render(payload), /Audit · ✓ Coherent in the reviewed area/);
  assert.doesNotMatch(ui.render(payload), /DISTILL|RECONCILE|prompt|chain.of.thought/i);
});

test('Prepared context leads with supplied counts and token totals, then selected sections, then additional matches', async () => {
  const ui = await lifecycleUi();
  const item = (id, title) => ({ id, title, category: 'decision', scope: 'task', scopeRef: 'context-ui', content: `Exact body ${id}`, sourceSessions: ['sess_source'], derivedFrom: ['sess_source#obs_1'] });
  const detail = estimatedTokens => ({ estimatedTokens, score: 14, rankScore: 14, signals: [{ label: 'Task token overlap', score: 10 }, { label: 'Important priority', score: 4 }] });
  const context = {
    snapshot: { version: 1, sessionId: 'sess_hierarchy', task: 'context-ui' },
    required: [item('required1', 'Required first'), item('required2', 'Required second')],
    relevant: [item('selected', 'Selected match')],
    skills: [{ title: 'Selected procedure', content: 'Exact skill procedure', category: 'skill', scope: 'context-ui', estimatedTokens: 20, signals: [{ field: 'title', matches: ['context'], score: 8 }] }],
    metrics: { contextTokens: 120, contextBudgetTokens: 6000, projectKnowledgeTokens: 1000, contextSelectivity: .1, requiredGlobalTokens: 60, selectedContextualTokens: 40, selectedSkillsTokens: 20, requiredContextBudgetTokens: 2000 },
    selection: { required: { required1: detail(25), required2: detail(35) }, relevant: { selected: detail(40) }, loadedKnowledgeItems: 3,
      omittedRelevantByBudget: 2, omittedRelevantByItemLimit: 25, omittedRelevantDetailsTruncated: 25,
      omittedRelevant: [{ ...item('budget', 'Budget match'), ...detail(200), reason: 'budget' }, { ...item('limit', 'Limit match'), ...detail(10), reason: 'item-limit' }],
    },
  };
  for (const match of context.selection.omittedRelevant) {
    delete match.content;
    Object.defineProperty(match, 'content', { get() { throw new Error('Omitted bodies must not be read'); } });
  }
  const payload = { action: 'prepare', result: { context } };
  const before = JSON.stringify(payload);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(payload);
  ui.render(payload);
  // The UI adapter throws on any MCP call: disclosure can only read this frozen snapshot.
  const html = ui.click('view-context').split('aria-label="Prepared context"')[1];
  const ordered = ['Prepared context</h2>', 'Session sess_hierarchy', 'Provided to agent', '3 knowledge · 1 skill', '<h2>Required</h2>', 'Required first', '<h2>Relevant</h2>', 'Selected match', '<h2>Skills</h2>', 'Selected procedure', 'Additional matches · 27', 'Inspect matches', 'Budget match'];
  for (let i = 1; i < ordered.length; i++) assert.ok(html.indexOf(ordered[i - 1]) < html.indexOf(ordered[i]), `${ordered[i - 1]} before ${ordered[i]}`);
  assert.match(html, /120 \/ 6\.00K est\. tokens/);
  for (const label of ['2 items · 60 est. tokens', '1 item · 40 est. tokens', '1 skill · 20 est. tokens', '<dt>Required</dt><dd>2</dd>', '<dt>Relevant</dt><dd>1</dd>', '<dt>Skills</dt><dd>1</dd>', '25 est. tokens', '35 est. tokens', 'Exact body selected', 'Exact skill procedure']) assert.ok(html.includes(label), label);
  assert.equal(context.required.length + context.relevant.length, context.selection.loadedKnowledgeItems);
  assert.equal(context.metrics.requiredGlobalTokens + context.metrics.selectedContextualTokens + context.metrics.selectedSkillsTokens, context.metrics.contextTokens);
  const [selected, omitted] = html.split('<section class="context-saturation"');
  assert.match(selected, /Why selected/); assert.doesNotMatch(selected, /Why matched/);
  assert.match(omitted, /27 knowledge items matched retrieval signals but were not loaded/);
  assert.match(omitted, /Primary reason<\/span><b>Item limit reached/);
  for (const label of ['Why matched', 'Not loaded', 'Did not fit the context budget', 'Item limit reached · 25', '2 of 27 matches shown', 'Retrieval score: 14.00', 'decision · task: context-ui', 'Important priority']) assert.ok(omitted.includes(label), label);
  assert.doesNotMatch(omitted, /Why selected|relevant items|Relevant|Reason ·|item-limit/);
  ui.click('close-context'); ui.click('view-context');
  assert.equal(JSON.stringify(payload), before);
});

test('additional matches distinguish budget omissions, ties and empty supplied sections', async () => {
  const ui = await lifecycleUi();
  const context = { snapshot: { version: 1, sessionId: 'sess_empty' }, required: [], relevant: [], skills: [],
    metrics: { contextTokens: 0, contextBudgetTokens: 6000, requiredGlobalTokens: 0, selectedContextualTokens: 0, selectedSkillsTokens: 0 },
    selection: { required: {}, relevant: {}, omittedRelevant: [], omittedRelevantByBudget: 1, omittedRelevantByItemLimit: 0, omittedRelevantDetailsTruncated: 1 },
  };
  ui.render({ action: 'prepare', result: { context } });
  let html = ui.click('view-context');
  assert.match(html, /0 knowledge · 0 skills/);
  assert.match(html, /0 skills · 0 est\. tokens/);
  assert.match(html, /1 knowledge item matched retrieval signals but was not loaded/);
  assert.match(html, /Primary reason<\/span><b>Did not fit the context budget/);
  ui.click('close-context');
  context.selection.omittedRelevantByItemLimit = 1;
  ui.render({ action: 'prepare', result: { context } });
  html = ui.click('view-context');
  assert.match(html, /Primary reasons<\/span><b>Item limit reached · Did not fit the context budget/);
  ui.click('close-context');
  context.selection.omittedRelevantByItemLimit = context.selection.omittedRelevantByBudget = 0;
  ui.render({ action: 'prepare', result: { context } });
  assert.doesNotMatch(ui.click('view-context'), /Additional matches|Inspect matches/);
});

for (const action of ['open', 'status-details']) {
  test(`${action} renders the completed snapshot once without follow-up RPCs`, async () => {
    const calls = [];
    const ui = await lifecycleUi({ callServerTool: async request => { calls.push(request); throw new Error('Unexpected follow-up'); } });
    assert.deepEqual(ui.renders, [], 'no project UI before toolresult');
    const payload = { ...status(), action, bootstrap: { loaded: true, scope: null, instructions: [], warnings: [], metrics: { estimatedTokens: 0, omittedInstructions: 0 } } };
    const html = ui.render(payload);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.renders.length, 1);
    assert.equal(calls.length, 0);
    assert.match(html, /133<\/strong><span>current memories/);
    assert.match(html, /Bootstrap Context/);
    assert.doesNotMatch(html, /Preparing…|Preparing project intelligence|Not initialized|Initialize Prodero/);
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeProject, prepareProject, recordProjectSession, closeProjectSession, syncProject, getProjectStatus, getFastProjectStatus } from '../dist/core/project.js';
import { writeKnowledge, listKnowledge, renderKnowledge } from '../dist/core/memory.js';
import { discoverSessions } from '../dist/core/session-index.js';
import { loadMemoryCatalog } from '../dist/core/memory-index.js';
import { INTELLIGENCE_LIMITS as L } from '../dist/core/intelligence.js';
import { estimateTokens } from '../dist/core/telemetry.js';
import { observationEvidence, observationKey } from '../dist/core/knowledge-engine.js';
import { sha256 } from '../dist/core/storage.js';
import { commitSyncTransaction, recoverSyncTransaction, withSyncLock } from '../dist/core/sync-transaction.js';
import { fakeProvider, distilled, canonical } from './helpers/intelligence-provider.mjs';

async function fixture(t, assisted = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-engine-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git')); await initializeProject(root);
  const file = path.join(root, '.prodero/config.json');
  const config = JSON.parse(await fs.readFile(file)); config.knowledgeEngine = { mode: assisted ? 'assisted' : 'deterministic' };
  await fs.writeFile(file, JSON.stringify(config)); return root;
}
async function session(root, entries) {
  const p = await prepareProject(root);
  await recordProjectSession(root, p.session.id, entries);
  // This fixture exercises explicit manual assisted Sync, so leave evidence pending.
  await closeProjectSession(root, p.session.id, [], false);
  return p.session.id;
}
const entry = (content, extra = {}) => ({ type: 'decision', title: 'Cache lifecycle', content, scopeHint: 'module', scopeRef: 'cache', ...extra });
const seed = (content, overrides = {}) => ({ id: 'mem_existing', scope: 'module', scopeRef: 'cache', category: 'decision', priority: 'important', status: 'active', title: 'Cache lifecycle', content, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', sourceSessions: ['sess_old'], derivedFrom: ['sess_old#obs_1'], supersedes: [], related: [], ...overrides });
const checkpoint = async (root, result) => JSON.parse(await fs.readFile(path.join(root, '.prodero/checkpoints', `${result.checkpoint}.json`)));

const unsafePairs = [
 ['Caching is enabled for all API requests.', 'Caching is not enabled for all API requests.'],
 ['Frontend depends on backend.', 'Backend depends on frontend.'],
 ['Caching is enabled.', 'Caching is disabled.'], ['Upload is allowed.', 'Upload is forbidden.'],
 ['Run validation before migration.', 'Run validation after migration.'],
 ['A depends on B.', 'B depends on A.'], ['source → target', 'target → source'],
 ['client → server', 'server → client'], ['Use API v2.', 'Use API v3.'],
 ['Validation is required.', 'Validation is optional.'], ['Always cache requests.', 'Sometimes cache requests.'],
];
for (const [a, b] of unsafePairs) test(`semantic regression: ${a} / ${b}`, async (t) => {
  const root = await fixture(t, false); await writeKnowledge(root, seed(a), false, 'local'); await session(root, [entry(b)]);
  const fallback = await syncProject(root);
  assert.equal(fallback.duplicates, 0); assert.equal(fallback.consolidated, 0);
  assert.equal((await listKnowledge(root)).length, 2);
  const other = await fixture(t); await writeKnowledge(other, seed(a), false, 'local'); await session(other, [entry(b)]);
  const provider = fakeProvider({ reconcile: ({ candidate, related }) => ({ actions: [{ action: 'NO_CHANGE', sources: [candidate.id, related[0].id], canonical: null, reason: 'Unsafe model suggestion.' }] }) });
  await assert.rejects(syncProject(other, { provider }), /unsafe semantic|discard new evidence/);
  assert.equal((await getProjectStatus(other)).pendingSessionCount, 1);
  assert.equal((await listKnowledge(other))[0].content, a);
});

test('exact duplicates bypass all model calls, preserve provenance and skip audit', async (t) => {
  const root = await fixture(t); await writeKnowledge(root, seed('Keep cache local.'), false, 'local');
  const id = await session(root, [entry('Keep cache local.')]); const provider = fakeProvider();
  const result = await syncProject(root, { provider });
  assert.equal(provider.calls.length, 0); assert.equal(result.duplicates, 1); assert.equal(result.intelligence.audit.triggered, false);
  assert.ok((await listKnowledge(root))[0].sourceSessions.includes(id));
  assert.equal((await syncProject(root, { provider })).sessions, 0); assert.equal(provider.calls.length, 0);
});

test('valid distillation and complementary merge audit preserve evidence, preimages and concise reasons', async (t) => {
  const root = await fixture(t); await writeKnowledge(root, seed('Keep cache local.'), false, 'local');
  const id = await session(root, [entry('Worktrees own separate caches.')]);
  const provider = fakeProvider({ reconcile: ({ candidate, related }) => ({ actions: [{ action: 'MERGE', sources: [candidate.id, related[0].id], canonical: { ...canonical(candidate), content: `${related[0].content} ${candidate.content}` }, reason: 'Same cache lifecycle, with an additional worktree constraint.' }] }) });
  const result = await syncProject(root, { provider });
  assert.deepEqual(provider.calls.map((c) => c.phase), ['distill', 'reconcile', 'audit']);
  assert.equal(result.consolidated, 1); assert.equal(result.intelligence.audit.status, 'coherent');
  const item = (await listKnowledge(root))[0];
  assert.match(item.content, /Worktrees/); assert.ok(item.sourceSessions.includes(id)); assert.ok(item.derivedFrom.some((ref) => ref.startsWith(id + '#obs_')));
  const cp = await checkpoint(root, result); assert.equal(cp.knowledgeBefore[0].content, 'Keep cache local.');
  assert.equal(cp.reasoning[0].action, 'MERGE'); assert.equal(cp.reasoning[0].reason, 'Same cache lifecycle, with an additional worktree constraint.');
  assert.ok(item.evidence.some((e) => e.kind === 'session_observation'));
  assert.equal(result.intelligence.providerUsage.length, 0);
});
for (const action of ['SUPERSEDE', 'CONFLICT', 'LINK', 'UNCERTAIN']) test(`reconciliation supports ${action} without deleting source history`, async (t) => {
  const root = await fixture(t); await writeKnowledge(root, seed('Use API v2.'), false, 'local');
  const content = action === 'SUPERSEDE' ? 'Use API v3. Replaces mem_existing.' : 'Use API v3.';
  const id = await session(root, [entry(content)]);
  const provider = fakeProvider({ reconcile: ({ candidate, related }) => ({ actions: [{ action, sources: [candidate.id, related[0].id], canonical: null, reason: 'Preserve explicit relationship.' }] }) });
  const result = await syncProject(root, { provider }); const items = await listKnowledge(root);
  assert.equal(items.length, 2); assert.equal(items.find((m) => m.id === 'mem_existing').content, 'Use API v2.');
  if (action === 'SUPERSEDE') assert.equal(items.find((m) => m.id === 'mem_existing').status, 'superseded');
  if (action === 'CONFLICT') { assert.ok(items.every((m) => m.status === 'disputed')); assert.equal(result.intelligence.audit.status, 'attention'); }
  assert.match(await fs.readFile(path.join(root, '.prodero/sessions', `${id}.md`), 'utf8'), /Use API v3/);
});

const bad = [
 ['malformed output', { distill: () => 'plain prose' }],
 ['invented facts', { distill: (input) => { const r = distilled(input); r.candidates[0].content = 'Invented unsupported project fact.'; return r; } }],
 ['missing provenance', { distill: (input) => { const r = distilled(input); r.candidates[0].sources = ['sess_unknown#obs_0']; return r; } }],
 ['illegal state', { reconcile: ({ candidate }) => ({ actions: [{ action: 'CREATE', sources: [candidate.id], canonical: null, reason: 'new', status: 'active' }] }) }],
 ['nonexistent memory', { reconcile: ({ candidate }) => ({ actions: [{ action: 'MERGE', sources: [candidate.id, 'mem_missing'], canonical: canonical(candidate), reason: 'wrong' }] }) }],
 ['traversal ID', { reconcile: ({ candidate }) => ({ actions: [{ action: 'LINK', sources: [candidate.id, '../../outside'], canonical: null, reason: 'wrong' }] }) }],
 ['oversized body', { distill: (input) => { const r = distilled(input); r.candidates[0].content = 'X'.repeat(8001); return r; } }],
 ['scope escalation', { distill: (input) => { const r = distilled(input); r.candidates[0].scope = 'global'; return r; } }],
 ['invented supersession', { distill: (input) => { const r = distilled(input); r.candidates[0].supersedes = ['mem_existing']; return r; } }],
 ['provider failure', { reconcile: () => { throw new Error('Provider unavailable'); } }],
 ['audit failure', { audit: () => { throw new Error('Audit unavailable'); } }],
 ['out-of-area audit', { audit: () => ({ status: 'changes_proposed', issues: [], actions: [{ action: 'CONFLICT', sources: ['mem_missing'], canonical: null, reason: 'wrong' }] }) }],
];
for (const [name, overrides] of bad) test(`invalid ${name} fails without canonical writes or checkpoint`, async (t) => {
  const root = await fixture(t); const original = seed('Local cache rule.'); await writeKnowledge(root, original, false, 'local');
  await session(root, [entry('Worktree caches are separate.'), entry('Cache entries expire.'), entry('Tests check cache isolation.')]);
  const before = await fs.readFile(path.join(root, '.prodero/local/memory/mem_existing.md'), 'utf8');
  await assert.rejects(syncProject(root, { provider: fakeProvider(overrides) }));
  assert.equal((await listKnowledge(root)).length, 1); assert.equal(await fs.readFile(path.join(root, '.prodero/local/memory/mem_existing.md'), 'utf8'), before);
  assert.equal((await getProjectStatus(root)).pendingSessionCount, 1); assert.equal((await getProjectStatus(root)).checkpointCount, 0);
  // A fresh provider retries the original evidence without cache-dependent repair.
  await fs.rm(path.join(root, '.prodero/.cache'), { recursive: true, force: true });
  assert.equal((await syncProject(root, { provider: fakeProvider() })).sessions, 1);
});

test('audit correction and unresolved uncertainty use the same validator, one pass only', async (t) => {
  for (const uncertain of [false, true]) {
    const root = await fixture(t); await session(root, [entry('Rule alpha.'), entry('Rule beta.'), entry('Rule gamma.')]);
    const provider = fakeProvider({ audit: ({ items }) => uncertain ? { status: 'uncertain', issues: [{ kind: 'uncertain', sources: [items[0].id], reason: 'Needs project clarification.' }], actions: [] } : { status: 'changes_proposed', issues: [{ kind: 'fragmentation', sources: items.slice(0, 2).map((m) => m.id), reason: 'One concept.' }], actions: [{ action: 'MERGE', sources: items.slice(0, 2).map((m) => m.id), canonical: { ...canonical(items[0]), content: items.slice(0, 2).map((m) => m.content).join(' ') }, reason: 'Combine complementary statements.' }] } });
    const result = await syncProject(root, { provider });
    assert.equal(provider.calls.filter((c) => c.phase === 'audit').length, 1);
    assert.equal(result.intelligence.audit.status, uncertain ? 'attention' : 'coherent');
    assert.ok((await listKnowledge(root)).some((m) => m.status === (uncertain ? 'active' : 'consolidated')));
  }
});

test('skill/instruction candidates cannot be promoted into required canonical memory', async (t) => {
  const root = await fixture(t); await session(root, [entry('Review candidate procedure.', { type: 'skill_candidate' }), entry('Potential project rule.', { type: 'global_instruction_candidate' })]);
  const result = await syncProject(root, { provider: fakeProvider() });
  assert.equal(result.created, 0); assert.equal(result.skillCandidatesCreated, 1);
  const cp = await checkpoint(root, result); assert.equal(cp.instructionCandidates.length, 1);
  const skill = await fs.readFile(path.join(root, '.prodero/local/skills', cp.createdSkills[0] + '.md'), 'utf8');
  assert.match(skill, /status: candidate/);
  const fallback = await fixture(t, false); await session(fallback, [entry('Potential project rule.', { type: 'global_instruction_candidate' })]);
  assert.equal((await syncProject(fallback)).created, 0);
});

test('unavailable provider uses explicit offline fallback; changed sessions send only new observations', async (t) => {
  const root = await fixture(t); const p = await prepareProject(root);
  await recordProjectSession(root, p.session.id, [entry('Old durable fact.')]);
  const first = await syncProject(root);
  assert.equal(first.intelligence.mode, 'deterministic'); assert.match(first.intelligence.fallbackReason, /unavailable/);
  await recordProjectSession(root, p.session.id, [entry('New durable fact.')]);
  const provider = fakeProvider(); await syncProject(root, { provider });
  const inputs = provider.calls.filter((c) => c.phase === 'distill').flatMap((c) => c.input.observations);
  assert.equal(inputs.length, 1); assert.equal(inputs[0].content, 'New durable fact.');
});

test('bounded batches, related discovery and single audit with 10,000 canonical memories exclude historical sessions', async (t) => {
  const root = await fixture(t);
  await Promise.all(Array.from({ length: 10_000 }, (_, i) => writeKnowledge(root, seed(`Historical cache fact ${i}.`, { id: `mem_scale_${i}` }), false, 'local')));
  const historical = await prepareProject(root); await recordProjectSession(root, historical.session.id, [entry('HISTORICAL_PRIVATE_CONTENT')]);
  await closeProjectSession(root, historical.session.id, [], true);
  await loadMemoryCatalog(root); await discoverSessions(root);
  const p = await prepareProject(root);
  await recordProjectSession(root, p.session.id, Array.from({ length: 15 }, (_, i) => entry(`New fact ${i}. ${'Compact local constraint. '.repeat(50)}`)));
  await closeProjectSession(root, p.session.id, [], false);
  const provider = fakeProvider(); const result = await syncProject(root, { provider });
  assert.ok(provider.calls.filter((c) => c.phase === 'distill').length > 1);
  for (const call of provider.calls) {
    assert.doesNotMatch(JSON.stringify(call.input), /HISTORICAL_PRIVATE_CONTENT/);
    const limit = call.phase === 'distill' ? L.distillInputTokens : call.phase === 'reconcile' ? L.reconcileInputTokens : L.auditInputTokens;
    assert.ok(estimateTokens(JSON.stringify(call.input)) <= limit);
    if (call.phase === 'reconcile') assert.ok(call.input.related.length <= L.relatedMemories);
    if (call.phase === 'audit') assert.ok(call.input.items.length <= L.auditItems);
  }
  assert.equal(provider.calls.filter((c) => c.phase === 'audit').length, 1);
  assert.equal(result.diagnostics.sessionBodiesConsolidated, 1);
  const before = provider.calls.length; const fast = await getFastProjectStatus(root);
  assert.equal(Object.hasOwn(fast, 'knowledgeCount'), false); assert.equal(provider.calls.length, before);
});

test('validated write journal recovers after partial application and cache deletion; locks exclude concurrent Sync', async (t) => {
  const root = await fixture(t);
  const memory = renderKnowledge(seed('Preserved transactional content.', { id: 'mem_recovered' }));
  const writes = [{ path: 'memory/mem_recovered.md', before: null, after: memory }, { path: 'checkpoints/chk_recovered.json', before: null, after: JSON.stringify({ id: 'chk_recovered', createdAt: '2026-09-03T00:00:00Z', sessions: [] }) }];
  await fs.mkdir(path.join(root, '.prodero/.transactions'), { recursive: true });
  await fs.writeFile(path.join(root, '.prodero/.transactions/pending.json'), JSON.stringify({ version: 1, writes }));
  await fs.writeFile(path.join(root, '.prodero/memory/mem_recovered.md'), memory);
  await fs.rm(path.join(root, '.prodero/.cache'), { recursive: true, force: true });
  assert.equal(await recoverSyncTransaction(root), true); assert.equal(await recoverSyncTransaction(root), false);
  await withSyncLock(root, async () => { await assert.rejects(withSyncLock(root, async () => {}), /already running/); });
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, '.prodero/memory/mem_link.md'));
  await assert.rejects(commitSyncTransaction(root, [{ path: 'memory/mem_link.md', before: null, after: 'bad' }, { path: 'checkpoints/chk_bad.json', before: null, after: '{}' }]), /Symlink/);
});

test('a later invalid proposal rolls back earlier valid proposals; evidence cannot change while reasoning', async (t) => {
  const root = await fixture(t); const id = await session(root, [entry('First fact.'), entry('Second fact.')]);
  let count = 0;
  const provider = fakeProvider({ reconcile: ({ candidate }) => ({ actions: [{ action: 'CREATE', sources: [++count === 1 ? candidate.id : 'candidate_unknown'], canonical: null, reason: 'Test complete-plan validation.' }] }) });
  await assert.rejects(syncProject(root, { provider })); assert.equal((await listKnowledge(root)).length, 0);
  const changing = fakeProvider({ distill: async (input) => {
    const file = path.join(root, '.prodero/sessions', `${id}.md`);
    await fs.appendFile(file, '\n<!-- external change -->\n');
    return distilled(input);
  } });
  await assert.rejects(syncProject(root, { provider: changing }), /Session changed/);
  assert.equal((await listKnowledge(root)).length, 0);
});

test('merge cannot discard a source constraint or reactivate historical canonical records', async (t) => {
  const root = await fixture(t); await writeKnowledge(root, seed('Keep cache local. Preserve user overrides.'), false, 'local');
  await session(root, [entry('Worktrees isolate caches.')]);
  const lossy = fakeProvider({ reconcile: ({ candidate, related }) => ({ actions: [{ action: 'MERGE', sources: [candidate.id, related[0].id], canonical: { ...canonical(candidate), content: 'Keep cache local. Worktrees isolate caches.' }, reason: 'Incorrectly discarded a constraint.' }] }) });
  await assert.rejects(syncProject(root, { provider: lossy }), /drops source constraints/);
  const historical = await fixture(t); await writeKnowledge(historical, seed('Historical rule.', { status: 'superseded' }), false, 'local');
  await session(historical, [entry('New rule.')]);
  const invalid = fakeProvider({ reconcile: ({ candidate }) => ({ actions: [{ action: 'MERGE', sources: [candidate.id, 'mem_existing'], canonical: canonical(candidate), reason: 'Attempt to reactivate history.' }] }) });
  await assert.rejects(syncProject(historical, { provider: invalid }), /out-of-area|historical/);
});

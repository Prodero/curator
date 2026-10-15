import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeProject, prepareProject, closeProjectSession, resolveProjectContext, recordProjectSession, syncProject } from '../dist/core/project.js';
import { createSkillCandidate, createProjectSkill, getProjectSkill, previewProjectSkill, reviewProjectSkill, parseSkill, renderSkill, scoreSkill } from '../dist/core/skills.js';
import { buildSkillCurationInput, validateCurationOutput, CURATION_LIMITS } from '../dist/core/skill-curation.js';
import { writeKnowledge } from '../dist/core/memory.js';
import { estimateTokens } from '../dist/core/telemetry.js';
import { curationResponse } from './helpers/skill-curator.mjs';
import { lifecycleUi } from './helpers/lifecycle-ui.mjs';
const raw = { title: 'Verify disposable cache recovery in temporary projects', description: 'Verify missing derived caches and unchanged canonical project files.', scope: 'src/core/storage.ts', triggers: ['cache recovery', 'derived state changes'], content: '1. Use a temporary project fixture; never remove the real repository cache.\n2. Snapshot canonical project files.\n3. Remove derived indexes in the fixture and verify Fast Status.\n4. Verify detailed Status recovery with missing indexes.\n5. Compare canonical snapshots.\n6. During this session we ran checks twice.', references: ['test/cache.test.mjs'] };
const canonical = { id: 'mem_cache_contract', title: 'Derived cache / local project state', content: 'Derived cache is local project state in .prodero/.cache. Fast Status must not rebuild derived indexes. Detailed Status rebuilds missing indexes. Fresh clone and worktree recovery use the same derived indexes.', scope: 'module', scopeRef: 'derived-cache', category: 'invariant', priority: 'important', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(), sourceSessions: ['sess_evidence'], derivedFrom: ['sess_evidence#obs_contract'], supersedes: [], related: [] };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-curator-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git')); await initializeProject(root);
  await writeKnowledge(root, canonical);
  const prepared = await prepareProject(root);
  await recordProjectSession(root, prepared.session.id, [{ ...raw, type: 'skill_candidate', scopeRef: raw.scope, scopeHint: 'module', proposedReason: 'Repeated checks in test/cache.test.mjs' }]);
  await closeProjectSession(root, prepared.session.id); await syncProject(root);
  const { listProjectSkills } = await import('../dist/core/skills.js');
  const candidate = (await listProjectSkills(root))[0];
  return { root, candidate };
}
function curated(input) {
  return curationResponse(input, { title: 'Verify Derived Cache Recovery', description: 'Verify derived cache recovery and unchanged canonical project state.', scope: 'Derived cache / local project state', triggers: ['.prodero/.cache recovery', 'derived index recovery', 'fresh clone or worktree recovery'], relatedKnowledge: ['mem_cache_contract'], procedure: ['Use a temporary project fixture; never remove the real repository cache.', 'Snapshot canonical project files.', 'Remove derived indexes in the fixture and verify Fast Status.', 'Verify detailed Status recovery with missing indexes. Compare canonical snapshots.'] });
}
const provider = { name: 'curation-contract-double', curateSkill: async input => ({ output: curated(input) }) };

test('curator gets bounded raw candidate, actual source observation, known paths and canonical evidence', async t => {
  const { root, candidate } = await fixture(t);
  const input = await buildSkillCurationInput(root, candidate);
  assert.equal(input.candidate.scope, 'src/core/storage.ts');
  assert.equal(input.observations[0].content, raw.content);
  assert.ok(input.knownReferences.includes('src/core/storage.ts'));
  assert.ok(input.knownReferences.includes('test/cache.test.mjs'));
  const pathInput = await buildSkillCurationInput(root, { ...candidate, proposedReason: 'test/cache.test.mjs. Covers missing/invalid-cache.' });
  assert.equal(pathInput.knownReferences.filter(ref => ref === 'test/cache.test.mjs').length, 1);
  assert.ok(!pathInput.knownReferences.includes('missing/invalid-cache'));
  assert.ok(input.relatedKnowledge.some(k => k.id === canonical.id));
  assert.ok(estimateTokens(JSON.stringify(input)) <= CURATION_LIMITS.inputTokens);
  const preview = await previewProjectSkill(root, candidate.id, { provider });
  assert.equal(preview.mode, 'assisted', preview.notice);
  assert.equal(preview.draft.scope, 'Derived cache / local project state');
  assert.notEqual(preview.draft.description, candidate.description);
  assert.ok(preview.draft.triggers.includes('fresh clone or worktree recovery'));
  assert.ok(!preview.draft.content.includes('During this session'));
  assert.ok(preview.draft.content.includes('never remove the real repository cache.'));
  assert.deepEqual(preview.draft.relatedKnowledge, [canonical.id]);
  assert.equal((await getProjectSkill(root, candidate.id)).status, 'candidate');
});

test('related-memory and related-skill packages stay independently bounded with a large corpus', async t => {
  const { root, candidate } = await fixture(t);
  for (let i = 0; i < 80; i++) await writeKnowledge(root, { ...canonical, id: `mem_related_${i}`, title: `Derived cache recovery ${i}` });
  for (let i = 0; i < 9; i++) await createProjectSkill(root, { ...raw, title: `Derived cache verification ${i}` });
  const input = await buildSkillCurationInput(root, candidate);
  assert.ok(input.relatedKnowledge.length <= 6 && input.relatedKnowledge.length > 0);
  assert.ok(input.activeSkills.length <= 3 && input.activeSkills.length > 0);
  assert.ok(input.observations.length <= 4);
  assert.ok(estimateTokens(JSON.stringify(input)) <= CURATION_LIMITS.inputTokens);
});

for (const kind of ['reference', 'root-escape', 'knowledge', 'new-trigger', 'malformed', 'missing-constraint', 'target', 'missing-grounding']) test(`invalid curation ${kind} falls back without writing`, async t => {
  const { root, candidate } = await fixture(t);
  const bad = { name: 'bad-double', async curateSkill(input) {
    const out = curated(input);
    if (kind === 'reference') out.draft.references.push('invented/rules.md');
    if (kind === 'root-escape') out.draft.references.push('../outside.md');
    if (kind === 'knowledge') out.draft.relatedKnowledge.push('mem_nonexistent');
    if (kind === 'new-trigger') out.draft.triggers[0] = 'Production deployment cache rotation';
    if (kind === 'malformed') return { output: { prose: 'Just deploy it' } };
    if (kind === 'missing-constraint') out.draft.procedure[0] = 'Use a temporary fixture.';
    if (kind === 'target') out.disposition = { action: 'update', targetSkillId: 'not_supplied' };
    if (kind === 'missing-grounding') out.grounding = [];
    return { output: out };
  } };
  const preview = await previewProjectSkill(root, candidate.id, { provider: bad });
  assert.equal(preview.mode, 'deterministic');
  assert.equal(preview.draft.content, raw.content);
  assert.equal((await getProjectSkill(root, candidate.id)).status, 'candidate');
});

test('provider failure and no provider preserve a usable source draft', async t => {
  const { root, candidate } = await fixture(t);
  const fallback = await previewProjectSkill(root, candidate.id);
  const failed = await previewProjectSkill(root, candidate.id, { provider: { name: 'failed', curateSkill: async () => { throw new Error('offline'); } } });
  assert.deepEqual(failed.draft, fallback.draft);
  assert.equal(failed.mode, 'deterministic');
});

test('human edits bypass curation and the approved draft equals the persisted Markdown', async t => {
  const { root, candidate } = await fixture(t);
  let calls = 0;
  const counting = { name: 'counting', curateSkill: async input => { calls++; return { output: curated(input) }; } };
  const first = await previewProjectSkill(root, candidate.id, { provider: counting });
  const draft = { ...first.draft, title: 'Team approved derived cache checks' };
  const edited = await previewProjectSkill(root, candidate.id, { draft, previousPreview: first, provider: counting });
  assert.equal(calls, 1); assert.equal(edited.mode, 'edited');
  const active = await reviewProjectSkill(root, candidate.id, 'promote', 'UI approval', { approved: true, preview: edited });
  for (const [key, value] of Object.entries(edited.draft)) assert.deepEqual(active[key], value);
  assert.deepEqual(parseSkill(renderSkill(active), `${active.id}.md`), active);
  assert.match(renderSkill(active), /## Related knowledge/);
  assert.deepEqual(active.derivedFrom, candidate.derivedFrom);
});

test('overlap update requires approval and retains target identity, candidate history and existing provenance', async t => {
  const { root, candidate } = await fixture(t);
  const target = await createProjectSkill(root, { ...raw, title: 'Derived cache checks' }, 'sess_existing');
  const overlap = { name: 'overlap', async curateSkill(input) { const out = curated(input); out.disposition = { action: 'update', targetSkillId: target.id }; return { output: out }; } };
  const preview = await previewProjectSkill(root, candidate.id, { provider: overlap });
  assert.equal(preview.disposition.action, 'update'); assert.equal(preview.target.id, target.id);
  assert.deepEqual(await getProjectSkill(root, target.id), target);
  await assert.rejects(reviewProjectSkill(root, candidate.id, 'promote', undefined, { approved: false, preview }), /Workflow approval of a Project Skill preview is required\./);
  const active = await reviewProjectSkill(root, candidate.id, 'promote', undefined, { approved: true, preview });
  assert.equal(active.id, target.id);
  assert.deepEqual(active.sourceSessions, ['sess_existing', ...candidate.sourceSessions]);
  const history = await getProjectSkill(root, candidate.id);
  assert.equal(history.status, 'superseded'); assert.equal(history.promotedTo, target.id);
  assert.deepEqual((await resolveProjectContext(root, 'derived index recovery')).skills.map(s => s.id), [target.id]);
  assert.ok((await fs.readdir(path.join(root, '.prodero/checkpoints'))).length > 0);
});

test('covered candidates cannot be promoted; keep-separate leaves existing skill intact', async t => {
  const { root, candidate } = await fixture(t);
  const target = await createProjectSkill(root, raw);
  for (const action of ['covered', 'keep-separate']) {
    const preview = await previewProjectSkill(root, candidate.id, { provider: { name: action, async curateSkill(input) { const out = curated(input); out.disposition = { action, targetSkillId: action === 'covered' ? target.id : null }; return { output: out }; } } });
    assert.equal(preview.disposition.action, action);
    if (action === 'covered') await assert.rejects(reviewProjectSkill(root, candidate.id, 'promote', undefined, { approved: true, preview }), /already covered/);
  }
  assert.deepEqual(await getProjectSkill(root, target.id), target);
});

test('existing target changes invalidate both edited and approved update previews', async t => {
  const { root, candidate } = await fixture(t);
  const target = await createProjectSkill(root, raw);
  const preview = await previewProjectSkill(root, candidate.id, { provider: { name: 'update', async curateSkill(input) { const out = curated(input); out.disposition = { action: 'update', targetSkillId: target.id }; return { output: out }; } } });
  await fs.writeFile(path.join(root, '.prodero', target.path), renderSkill({ ...target, title: 'Someone edited the target' }));
  await assert.rejects(reviewProjectSkill(root, candidate.id, 'promote', undefined, { approved: true, preview }), /existing skill changed/);
  await assert.rejects(previewProjectSkill(root, candidate.id, { draft: preview.draft, previousPreview: preview }), /existing skill changed/);
});

test('explicit re-curation of active skill uses its original observation, never downgrades or auto-writes', async t => {
  const { root, candidate } = await fixture(t);
  const active = await reviewProjectSkill(root, candidate.id, 'promote', undefined, { approved: true, preview: await previewProjectSkill(root, candidate.id) });
  await assert.rejects(previewProjectSkill(root, active.id), /explicitly request/);
  const preview = await previewProjectSkill(root, active.id, { recurate: true, provider });
  assert.equal(preview.mode, 'assisted'); assert.equal(preview.target.id, active.id);
  assert.deepEqual(await getProjectSkill(root, active.id), active);
  const updated = await reviewProjectSkill(root, active.id, 'promote', undefined, { approved: true, preview });
  assert.equal(updated.id, active.id); assert.equal(updated.candidateTitle, raw.title);
});

test('curated retrieval distinguishes derived recovery from unrelated caching; reference paths do not rank', async t => {
  const { root, candidate } = await fixture(t);
  const preview = await previewProjectSkill(root, candidate.id, { provider });
  await reviewProjectSkill(root, candidate.id, 'promote', undefined, { approved: true, preview });
  const session = await prepareProject(root, { task: 'Recover .prodero/.cache after missing derived indexes' });
  assert.equal(session.context.skills.length, 1);
  const ui = await lifecycleUi();
  assert.match(ui.render({ action: 'prepare', result: session }), /<strong>1<\/strong><span>Skills<\/span>/);
  assert.match(ui.click('view-context'), /never remove the real repository cache/);
  for (const query of ['Test HTTP cache headers', 'Fix npm cache installation', 'Application cache tests', 'test/cache.test.mjs', 'src/core/storage.ts']) assert.deepEqual((await resolveProjectContext(root, query)).skills, [], query);
  assert.ok(scoreSkill('derived index recovery', preview.draft).score > 0);
  await closeProjectSession(root, session.session.id);
});

test('curation timeout returns fallback and aborts the provider request', async t => {
  const { root, candidate } = await fixture(t);
  const { curateProjectSkill } = await import('../dist/core/skill-curation.js');
  let signal, started;
  const ready = new Promise(resolve => { started = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = curateProjectSkill(root, candidate, { name: 'stalled', curateSkill: (_, abort) => { signal = abort; started(); return new Promise(() => {}); } });
  await ready;
  t.mock.timers.tick(CURATION_LIMITS.timeoutMs + 1);
  const result = await request;
  assert.equal(result.mode, 'deterministic'); assert.equal(signal.aborted, true);
});

test('reference validation rejects symlink escapes and malformed related IDs even on human edits', async t => {
  const { root, candidate } = await fixture(t);
  await fs.symlink(os.tmpdir(), path.join(root, 'outside'));
  await assert.rejects(previewProjectSkill(root, candidate.id, { draft: { ...raw, references: ['outside/anything.md'] } }), /escapes project/);
  await assert.rejects(previewProjectSkill(root, candidate.id, { draft: { ...raw, relatedKnowledge: ['../../other'] } }));
  for (const scope of ['src/../../outside', 'C:/outside', '\\outside', 'src\nother']) {
    await assert.rejects(previewProjectSkill(root, candidate.id, { draft: { ...raw, scope } }), /Invalid applicability scope/);
  }
});

test('a target edited while the curator is reasoning cannot acquire a fresh approval version silently', async t => {
  const { root, candidate } = await fixture(t);
  const target = await createProjectSkill(root, raw);
  const provider = { name: 'racing', async curateSkill(input) {
    const out = curated(input); out.disposition = { action: 'update', targetSkillId: target.id };
    await fs.writeFile(path.join(root, '.prodero', target.path), renderSkill({ ...target, title: 'Changed during curation' }));
    return { output: out };
  } };
  await assert.rejects(previewProjectSkill(root, candidate.id, { provider }), /existing skill changed/);
});

test('candidate ID cannot be invented by a provider; structured output rejects extra write fields', async t => {
  const { root, candidate } = await fixture(t);
  const input = await buildSkillCurationInput(root, candidate);
  const out = curated(input); out.draft.id = '../new-id';
  await assert.rejects(validateCurationOutput(root, out, input));
});

test('domain nouns are evidence requirements, not a generic curation vocabulary allowance', async t => {
  const { root, candidate } = await fixture(t);
  const input = await buildSkillCurationInput(root, candidate);
  const minimal = { ...input, candidate: { ...candidate, title: 'Inspect HTTP cache', description: 'Inspect HTTP cache headers.', content: 'Inspect HTTP cache headers.', scope: 'HTTP cache', triggers: [] }, observations: [], relatedKnowledge: [], activeSkills: [], protectedConstraints: [] };
  const output = curationResponse(minimal, { scope: 'Derived cache' });
  await assert.rejects(validateCurationOutput(root, output, minimal), /Unsupported concept/);
});

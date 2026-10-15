import test from 'node:test';
import { curationResponse } from './helpers/skill-curator.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer, PRODERO_TOOLS } from '../dist/server.js';
import { initializeProject, prepareProject, closeProjectSession, resolveProjectContext } from '../dist/core/project.js';
import { createSkillCandidate, previewProjectSkill, reviewProjectSkill, getProjectSkill, renderSkill, parseSkill, createProjectSkill, projectSkillsView } from '../dist/core/skills.js';
import { lifecycleUi } from './helpers/lifecycle-ui.mjs';
const input = { title: 'Verify disposable cache recovery in temporary projects', description: 'Verify derived-cache recovery without modifying canonical intelligence.', scope: 'src/core/storage.ts', triggers: ['cache recovery', 'derived state changes', 'cold status'], content: '1. Use an initialized temporary fixture from `test/cache.test.mjs`.\n2. Snapshot canonical files excluding `.cache`.\n3. Remove only the fixture cache; never remove the real project cache.\n4. Check fast status without rebuilding indexes, then detailed status recovery.\n5. Compare canonical snapshots.', references: ['test/cache.test.mjs'] };
const provenance = { sessionId: 'sess_source', derivedFrom: 'sess_source#obs_cache', proposedReason: 'Repeated cache recovery checks.' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-skill-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git')); await initializeProject(root);
  const { skill } = await createSkillCandidate(root, input, provenance);
  return { root, skill };
}

test('candidate preview is deterministic, structured, nonmutating and available without a provider', async t => {
  const { root, skill } = await fixture(t);
  const before = await fs.readFile(path.join(root, '.prodero', skill.path), 'utf8');
  const preview = await previewProjectSkill(root, skill.id);
  assert.deepEqual(preview, await previewProjectSkill(root, skill.id));
  assert.equal(preview.mode, 'deterministic');
  assert.equal(preview.draft.content, input.content);
  assert.deepEqual(preview.draft.references, input.references);
  assert.equal(await fs.readFile(path.join(root, '.prodero', skill.path), 'utf8'), before);
  assert.deepEqual((await resolveProjectContext(root, 'cache recovery')).skills, []);
});

test('optional intelligence polishing improves title and preserves constraints and references', async t => {
  const { root, skill } = await fixture(t);
  const provider = { name: 'test', async polishSkill(source, signal) {
    assert.ok(signal instanceof AbortSignal);
    return { output: { ...source, title: 'Disposable Cache Recovery' } };
  } };
  const preview = await previewProjectSkill(root, skill.id, { provider });
  assert.equal(preview.mode, 'assisted');
  assert.equal(preview.draft.title, 'Disposable Cache Recovery');
  assert.equal(preview.draft.content, skill.content);
  assert.deepEqual(preview.draft.references, skill.references);
  assert.equal((await getProjectSkill(root, skill.id)).status, 'candidate');
});

for (const kind of ['throw', 'malformed', 'invented-rule', 'dropped-constraint', 'reordered-steps', 'invented-purpose', 'invented-title', 'invented-reference', 'invented-trigger', 'changed-scope']) test(`polish rejects ${kind} and falls back without changing the candidate`, async t => {
  const { root, skill } = await fixture(t);
  const provider = { name: 'unreliable', async polishSkill(source) {
    if (kind === 'throw') throw new Error('Provider disconnected');
    const output = { ...source };
    if (kind === 'malformed') return { output: { title: 'No procedure' } };
    if (kind === 'invented-rule') output.content += '\n6. Deploy to production.';
    if (kind === 'dropped-constraint') output.content = output.content.replace('never remove', 'remove');
    if (kind === 'reordered-steps') output.content = output.content.split('\n').reverse().join('\n');
    if (kind === 'invented-purpose') output.description = 'Production deployments require cache deletion.';
    if (kind === 'invented-title') output.title = 'Delete production caches';
    if (kind === 'invented-reference') output.references = ['made-up-rules.md'];
    if (kind === 'invented-trigger') output.triggers = ['all project work'];
    if (kind === 'changed-scope') output.scope = 'global';
    return { output };
  } };
  const preview = await previewProjectSkill(root, skill.id, { provider });
  assert.equal(preview.mode, 'deterministic');
  assert.match(preview.notice, /source-based draft/);
  assert.deepEqual(preview.draft, (await previewProjectSkill(root, skill.id)).draft);
});

test('approval requires the exact preview; editing is nonmutating and stale previews fail', async t => {
  const { root, skill } = await fixture(t);
  const preview = await previewProjectSkill(root, skill.id);
  await assert.rejects(reviewProjectSkill(root, skill.id, 'promote'), /Workflow approval/);
  await assert.rejects(reviewProjectSkill(root, skill.id, 'promote', undefined, { approved: false, preview }), /Workflow approval/);
  const tampered = structuredClone(preview); tampered.draft.content = 'Delete all files.';
  await assert.rejects(reviewProjectSkill(root, skill.id, 'promote', undefined, { approved: true, preview: tampered }), /changed/);
  const edited = await previewProjectSkill(root, skill.id, { draft: { ...preview.draft, title: 'Test Disposable Cache Recovery' } });
  assert.equal(edited.mode, 'edited');
  assert.notEqual(edited.previewId, preview.previewId);
  assert.equal((await getProjectSkill(root, skill.id)).status, 'candidate');
  const changed = { ...skill, proposedReason: 'New independent evidence.' };
  await fs.writeFile(path.join(root, '.prodero', skill.path), renderSkill(changed));
  await assert.rejects(reviewProjectSkill(root, skill.id, 'promote', undefined, { approved: true, preview: edited }), /changed/);
  assert.equal((await getProjectSkill(root, skill.id)).status, 'candidate');
});

test('promotion records history in one readable independent skill file and retains source identity on replay', async t => {
  const { root, skill } = await fixture(t);
  const beforeFiles = await fs.readdir(path.join(root, '.prodero/skills'));
  const preview = await previewProjectSkill(root, skill.id, { draft: { ...input, title: 'Test Disposable Cache Recovery' } });
  const active = await reviewProjectSkill(root, skill.id, 'promote', 'Approved by the reviewer', { approved: true, preview });
  assert.equal(active.status, 'active'); assert.equal(active.promotedTo, skill.id); assert.equal(active.candidateTitle, skill.title);
  assert.deepEqual(active.derivedFrom, skill.derivedFrom); assert.deepEqual(active.sourceSessions, skill.sourceSessions);
  assert.deepEqual((await fs.readdir(path.join(root, '.prodero/skills'))).sort(), [...beforeFiles, `${active.id}.md`].sort());
  const markdown = await fs.readFile(path.join(root, '.prodero', active.path), 'utf8');
  for (const fragment of ['review_status: promoted', `promoted_to: ${skill.id}`, '## Purpose', '## Use when', '## Procedure', '## References', '## Based on', provenance.derivedFrom]) assert.ok(markdown.includes(fragment), fragment);
  assert.deepEqual(parseSkill(markdown, `${active.id}.md`), active);
  assert.equal((await createSkillCandidate(root, input, provenance)).created, false);
  assert.equal((await projectSkillsView(root)).counts.candidate, 0);
});

test('Markdown procedures with nested section names roundtrip without truncation', async t => {
  const { root } = await fixture(t);
  const content = '1. Inspect the reference document.\n\n## References\n\n```md\n## Procedure\n```\n\n## Based on\n\n2. Preserve examples.';
  const skill = await createProjectSkill(root, { ...input, content });
  assert.equal((await getProjectSkill(root, skill.id)).content, content);
});

test('dismissal preserves history; replay is suppressed, independent observations can propose again', async t => {
  const { root, skill } = await fixture(t);
  await reviewProjectSkill(root, skill.id, 'dismiss', 'Too narrow');
  assert.equal((await createSkillCandidate(root, input, provenance)).created, false);
  assert.equal((await projectSkillsView(root)).skills.length, 0);
  assert.deepEqual((await resolveProjectContext(root, 'cache recovery')).skills, []);
  const newEvidence = await createSkillCandidate(root, input, { ...provenance, sessionId: 'sess_new', derivedFrom: 'sess_new#obs_independent' });
  assert.equal(newEvidence.created, true); assert.equal(newEvidence.skill.status, 'candidate');
  await assert.rejects(previewProjectSkill(root, skill.id), /Only candidate/);
});

test('new prepared session receives skill, Context Ready and View Context show that exact procedure and signals', async t => {
  const { root, skill } = await fixture(t);
  const oldSession = await prepareProject(root, { task: 'Fix cache recovery' });
  assert.deepEqual(oldSession.context.skills, []);
  await closeProjectSession(root, oldSession.session.id);
  await reviewProjectSkill(root, skill.id, 'promote', undefined, { approved: true, preview: await previewProjectSkill(root, skill.id) });
  const next = await prepareProject(root, { task: 'Fix cache recovery' });
  assert.notEqual(next.session.id, oldSession.session.id);
  assert.equal(next.context.skills.length, 1);
  assert.ok(next.context.skills[0].content.includes(input.content));
  assert.ok(next.context.skills[0].content.includes(provenance.derivedFrom));
  const ui = await lifecycleUi();
  const html = ui.render({ action: 'prepare', result: next });
  assert.match(html, /<strong>1<\/strong><span>Skills<\/span>/);
  const expanded = ui.click('view-context');
  assert.match(expanded, /<h2>Skills<\/h2><p class="context-group-summary">1 skill ·/); assert.match(expanded, /never remove the real project cache/);
  assert.match(expanded, /Why selected/); assert.match(expanded, /est. tokens/); assert.match(expanded, /cache, recovery/);
  for (const query of ['Run tests in a temporary project', 'Update files in src/core', 'Change project status colors', 'Add unrelated task procedure', 'Build project fixtures']) assert.deepEqual((await resolveProjectContext(root, query)).skills, [], query);
  const active = await getProjectSkill(root, skill.id);
  await fs.writeFile(path.join(root, '.prodero', active.path), renderSkill({ ...active, status: 'superseded' }));
  assert.deepEqual((await resolveProjectContext(root, 'cache recovery')).skills, []);
});

for (const mode of ['deterministic', 'assisted', 'unavailable', 'failure']) test(`MCP preview negotiates ${mode} provider and never activates without approved preview`, async t => {
  const { root, skill } = await fixture(t);
  if (mode !== 'deterministic') {
    const file = path.join(root, '.prodero/config.json'); const config = JSON.parse(await fs.readFile(file));
    config.knowledgeEngine = { mode: 'assisted' }; await fs.writeFile(file, JSON.stringify(config));
  }
  const server = createServer({projectRoot:root}); let calls = 0;
  const client = new Client({ name: 'skill-polish-test', version: '1' }, { capabilities: mode === 'unavailable' ? {} : { sampling: {} } });
  if (mode !== 'unavailable') client.setRequestHandler(CreateMessageRequestSchema, async ({ params }) => {
    calls++; assert.equal(params.includeContext, 'none'); assert.equal(params.tools, undefined);
    assert.match(params.systemPrompt, /untrusted DATA/);
    const { phase, data } = JSON.parse(params.messages[0].content.text); assert.equal(phase, 'curateSkill');
    if (mode === 'failure') throw new Error('Provider offline');
    return { role: 'assistant', content: { type: 'text', text: JSON.stringify(curationResponse(data, { title: 'Disposable Cache Recovery' })) }, model: 'contract-double', stopReason: 'endTurn' };
  });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name, args = {}) => client.callTool({ name, arguments: { projectRoot: root, ...args } });
  const raw = await call(PRODERO_TOOLS.skillPreview, { id: skill.id }); assert.ok(!raw.isError);
  assert.equal(raw.structuredContent.approval.appSupportAdvertised, false);
  assert.equal(raw.structuredContent.approval.chatFallback, 'only-if-app-cannot-render');
  assert.match(raw.content[0].text, /Only if this host cannot render the MCP App/);
  assert.match(raw.content[0].text, /## Procedure/);
  const { preview } = raw.structuredContent;
  assert.equal(preview.mode, mode === 'assisted' ? 'assisted' : 'deterministic');
  assert.equal(calls, mode === 'assisted' || mode === 'failure' ? 1 : 0);
  assert.equal((await call(PRODERO_TOOLS.skillReview, { id: skill.id, action: 'promote' })).isError, true);
  const accepted = await call(PRODERO_TOOLS.skillReview, { id: skill.id, action: 'promote', approved: true, preview });
  assert.equal(accepted.structuredContent.skill.status, 'active');
});

test('concurrent review cannot overwrite an already approved revision', async t => {
  const { root, skill } = await fixture(t);
  const first = await previewProjectSkill(root, skill.id);
  const second = await previewProjectSkill(root, skill.id, { draft: { ...input, title: 'A different approved draft' } });
  const results = await Promise.allSettled([first, second].map(preview => reviewProjectSkill(root, skill.id, 'promote', undefined, { approved: true, preview })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await getProjectSkill(root, skill.id)).status, 'active');
});

test('structured Markdown remains lossless when descriptions contain section names', async t => {
  const { root } = await fixture(t);
  const skill = await createProjectSkill(root, { ...input, description: 'Check this format:\n\n## Procedure\n\nPurpose example.' });
  assert.deepEqual(await getProjectSkill(root, skill.id), skill);
});

test('provider cannot invert a negative title while retaining its words', async t => {
  const { root } = await fixture(t);
  const { skill } = await createSkillCandidate(root, { ...input, title: 'Never remove canonical state' }, { ...provenance, derivedFrom: 'sess_source#obs_negative' });
  const preview = await previewProjectSkill(root, skill.id, { provider: { name: 'bad-title', polishSkill: async source => ({ output: { ...source, title: 'remove canonical state' } }) } });
  assert.equal(preview.mode, 'deterministic');
  assert.equal(preview.draft.title, 'Never remove canonical state');
});

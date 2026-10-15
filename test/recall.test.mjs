import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, PRODERO_TOOLS, PRODERO_MCP_INSTRUCTIONS } from '../dist/server.js';
import { initializeProject, recallProject, prepareProject, resolveProjectContext, closeProjectSession, recordProjectSession } from '../dist/core/project.js';
import { prepareContext } from '../dist/core/context.js';
import { writeKnowledge } from '../dist/core/memory.js';

const stamp = '2026-09-01T00:00:00.000Z';
const knowledge = (id, extra = {}) => ({ id, scope: 'module', scopeRef: 'routing', category: 'decision', priority: 'important', status: 'active', title: `Routing ${id}`, content: `Routing architecture uses explicit project boundaries. ${id}`, createdAt: stamp, updatedAt: stamp, sourceSessions: [], derivedFrom: [], supersedes: [], related: [], ...extra });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-recall-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  await initializeProject(root);
  await writeKnowledge(root, knowledge('rule', { scope: 'global', scopeRef: null, category: 'instruction', kind: 'instruction', enforcement: 'required', priority: 'critical', content: 'Always preserve explicit repository boundaries.' }));
  for (const [id, category] of [['decision','decision'],['lesson','lesson'],['state','state'],['implementation','constraint']]) await writeKnowledge(root, knowledge(id, { category }));
  await writeKnowledge(root, knowledge('unrelated', { title: 'Orchard', content: 'Pear trees need water.', scopeRef: 'orchard' }));
  return root;
}
async function snapshot(root) {
  const result = {};
  async function visit(relative) {
    const target = path.join(root, relative);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      result[relative + '/'] = 'directory';
      for (const name of (await fs.readdir(target)).sort()) await visit(path.join(relative, name));
    } else result[relative] = { content: (await fs.readFile(target)).toString('base64'), mtime: stat.mtimeMs };
  }
  await visit('');
  return result;
}
function selection(context) {
  return { required: context.required, relevant: context.relevant, skills: context.skills, selection: context.selection, metrics: context.metrics, limits: context.limits };
}

test('recall retrieves required rules and relevant history with no writes, even with missing or corrupt caches', async t => {
  const root = await fixture(t);
  const cache = path.join(root, '.prodero/.cache');
  for (const mode of ['missing', 'invalid', 'warm']) {
    if (mode === 'missing') await fs.rm(cache, { recursive: true, force: true });
    if (mode === 'invalid') {
      await fs.mkdir(cache, { recursive: true });
      await fs.writeFile(path.join(cache, 'memory-index.json'), '{broken');
      await fs.writeFile(path.join(cache, 'knowledge-graph.json'), '{broken');
    }
    if (mode === 'warm') await prepareProject(root, { task: 'routing' });
    const before = await snapshot(root);
    const context = await recallProject(root, 'routing architecture');
    assert.equal(context.snapshot.sessionId, null);
    assert.ok(context.required.some(item => item.id === 'rule'));
    assert.ok(context.relevant.some(item => item.id === 'decision'));
    assert.ok(!context.relevant.some(item => item.id === 'unrelated'));
    assert.deepEqual(await snapshot(root), before, mode);
  }
});

test('prepare, recall and legacy context use identical engine selection and budgets for the same purpose', async t => {
  const root = await fixture(t);
  const configPath = path.join(root, '.prodero/config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.context = { max_tokens: 110, required_max_tokens: 35, max_items: 2 };
  await fs.writeFile(configPath, JSON.stringify(config));
  for (const purpose of ['work', 'explain', 'review', 'debug']) {
    const direct = await prepareContext(root, { query: 'routing', purpose });
    const recall = await recallProject(root, 'routing', purpose);
    const prepared = await prepareProject(root, { task: 'routing', purpose });
    assert.deepEqual(selection(recall), selection(direct));
    assert.deepEqual(selection(prepared.context), selection(direct));
    assert.ok(recall.metrics.contextTokens <= 110);
    assert.ok(recall.required.some(item => item.id === 'rule'));
    assert.equal(prepared.context.snapshot.sessionId, prepared.session.id);
    if (purpose === 'work') assert.deepEqual(selection(await resolveProjectContext(root, 'routing')), selection(direct));
  }
});

test('explain changes only explicit ranking policy and preserves required instruction budgeting', async t => {
  const root = await fixture(t);
  const work = await recallProject(root, 'routing', 'work');
  const explain = await recallProject(root, 'routing');
  assert.deepEqual(work.required, explain.required);
  assert.deepEqual(work.selection.required, explain.selection.required);
  assert.deepEqual(work.limits, explain.limits);
  for (const id of ['decision', 'lesson', 'state', 'implementation']) {
    assert.equal(explain.selection.relevant[id].score - work.selection.relevant[id].score, id === 'implementation' ? 0 : 2);
  }
});

test('recall leaves closed pending sessions untouched; prepare still syncs, records, closes and resumes work', async t => {
  const root = await fixture(t);
  const initial = await prepareProject(root, { task: 'routing' });
  await recordProjectSession(root, initial.session.id, [{ type: 'decision', title: 'Quasar routing decision', content: 'Quasar routing uses a dedicated queue to preserve event ordering.' }]);
  await closeProjectSession(root, initial.session.id, [], false);
  const before = await snapshot(root);
  await recallProject(root, 'quasar routing');
  assert.deepEqual(await snapshot(root), before);
  const work = await prepareProject(root, { task: 'quasar routing' });
  assert.notEqual(work.session.id, initial.session.id);
  assert.ok(work.automaticSync.sessionsProcessed >= 1);
  assert.ok(work.context.relevant.some(item => item.content.includes('Quasar')));
  const recall = await recallProject(root, 'quasar routing');
  assert.ok(recall.relevant.some(item => item.sourceSessions.includes(initial.session.id)));
  const resumed = await prepareProject(root, { task: 'routing', sessionId: work.session.id });
  assert.equal(resumed.session.id, work.session.id);
  await closeProjectSession(root, work.session.id);
});

test('recall does not initialize projects or migrate legacy config, and rejects blank queries', async t => {
  const root = await fixture(t);
  await assert.rejects(recallProject(root, '   '), /empty/);
  const target = path.join(root, '.prodero/config.json');
  const config = JSON.parse(await fs.readFile(target, 'utf8'));
  config.schemaVersion = 4;
  config.context = { budgetTokens: 140, requiredBudgetTokens: 50 };
  await fs.writeFile(target, JSON.stringify(config));
  const before = await snapshot(root);
  const result = await recallProject(root, 'routing');
  assert.equal(result.limits.contextBudgetTokens, 140);
  assert.deepEqual(await snapshot(root), before);
  await fs.rm(path.join(root, '.prodero'), { recursive: true });
  const empty = await snapshot(root);
  await assert.rejects(recallProject(root, 'routing'), /not initialized/);
  assert.deepEqual(await snapshot(root), empty);
});

test('MCP recall has a read-only contract and full text/structured context without a lifecycle App', async t => {
  const root = await fixture(t);
  const server = createServer({ projectRoot: root });
  const client = new Client({ name: 'recall-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const tool = (await client.listTools()).tools.find(tool => tool.name === PRODERO_TOOLS.recall);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool._meta?.ui, undefined);
  assert.match(PRODERO_MCP_INSTRUCTIONS, /call prodero_recall/);
  const before = await snapshot(root);
  const response = await client.callTool({ name: PRODERO_TOOLS.recall, arguments: { query: 'routing' } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  assert.equal(response.structuredContent.result.snapshot.sessionId, null);
  assert.ok(response.structuredContent.result.required.length);
  assert.deepEqual(await snapshot(root), before);
  const prepared = await client.callTool({ name: PRODERO_TOOLS.prepare, arguments: { task: 'routing', purpose: 'explain' } });
  assert.deepEqual(selection(prepared.structuredContent.result.context), selection(response.structuredContent.result));
});

test('CLI recall exposes the same read-only context engine', async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const { stdout } = await promisify(execFile)(process.execPath, ['dist/cli.js', 'recall', 'routing', '--root', root]);
  const result = JSON.parse(stdout);
  assert.equal(result.snapshot.sessionId, null);
  assert.deepEqual(selection(result), selection(await recallProject(root, 'routing')));
  assert.deepEqual(await snapshot(root), before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer, PRODERO_TOOLS } from '../dist/server.js';
import { initializeProject, prepareProject, closeProjectSession } from '../dist/core/project.js';
import { writeKnowledge } from '../dist/core/memory.js';
import { buildViewModel } from '../dist/presentation.js';
import { lifecycleUi } from './helpers/lifecycle-ui.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-coherent-ui-'));
  // A failed parallel status read can finish its disposable cache write during teardown.
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  await fs.mkdir(path.join(root, '.git'));
  await initializeProject(root);
  const stamp = '2026-09-01T00:00:00.000Z';
  for (const id of ['one', 'two']) await writeKnowledge(root, { id, scope:'global', scopeRef:null, category:'instruction', priority:'critical', status:'active', title:`Routing ${id}`, content:`Always retain explicit routing boundaries ${id}.`, createdAt:stamp, updatedAt:stamp, sourceSessions:[], derivedFrom:[], supersedes:[], related:[] });
  const session = await prepareProject(root, { task: 'routing' });
  await closeProjectSession(root, session.session.id);
  const timings = [];
  const server = createServer({ instrument: timing => timings.push(timing.phase) });
  const client = new Client({ name:'coherent-ui', version:'1' }, { capabilities:{ roots:{listChanged:false}, extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    await options.onRoots?.();
    return { roots:[{ uri:pathToFileURL(root).href, name:'fixture' }] };
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return { root, client, timings, call:(name, args={}) => client.callTool({name, arguments:args}) };
}
async function snapshot(root) {
  const files = {};
  async function walk(relative) {
    const target = path.join(root, relative);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      files[relative + '/'] = true;
      for (const name of (await fs.readdir(target)).sort()) await walk(path.join(relative, name));
    } else files[relative] = { data:(await fs.readFile(target)).toString('base64'), mtime:stat.mtimeMs };
  }
  await walk('.prodero'); return files;
}
for (const cacheState of ['missing','invalid']) {
  test(`open returns one completed UI snapshot after ${cacheState} cache recovery`, async t => {
    const { root, call, timings } = await fixture(t);
    const cache = path.join(root, '.prodero/.cache');
    await fs.rm(cache, { recursive:true, force:true });
    if (cacheState === 'invalid') {
      await fs.mkdir(cache);
      for (const file of ['memory-index.json','session-index.json','knowledge-graph.json']) await fs.writeFile(path.join(cache,file), '{broken');
    }
    const calls = [];
    const ui = await lifecycleUi({callServerTool:async request => { calls.push(request); throw new Error('Automatic follow-up'); }});
    assert.deepEqual(ui.renders, []);
    const response = await call(PRODERO_TOOLS.open);
    assert.equal(response.isError, undefined);
    const payload = response.structuredContent;
    assert.equal(payload.phase, 'ready');
    assert.equal(payload.hydrationRequired, false);
    assert.equal(payload.project.initialized, true);
    assert.equal(payload.project.knowledgeCount, 2);
    assert.equal(payload.project.sessionCount, 1);
    for (const key of ['skillCount','checkpointCount','pendingSessionCount','conflictCount']) assert.equal(typeof payload.project[key], 'number');
    assert.equal(payload.bootstrap.instructions.length, 2);
    assert.equal(payload.update.status, 'not-checked');
    assert.ok(timings.indexOf('detailed-status') < timings.indexOf('first-tool-response'));
    assert.equal(timings.filter(p => p === 'first-tool-response').length, 1);
    ui.render(payload);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.renders.length, 1);
    assert.equal(calls.length, 0);
    assert.match(ui.html, /<strong>2<\/strong><span>current memories/);
    assert.match(ui.html, /Not checked/);
    assert.doesNotMatch(ui.html, /Not initialized|Initialize Prodero|Preparing…|Checking…/);
    const text = await call(PRODERO_TOOLS.text, { tool:PRODERO_TOOLS.open });
    assert.deepEqual(buildViewModel(text.structuredContent), buildViewModel(payload));
    assert.equal(text.structuredContent.phase, 'ready');
    assert.match(text.content[0].text, /Memory  2/);
  });
}
test('root resolution and pending prepare never paint onboarding before the final context-ready result', async t => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { call } = await fixture(t, { onRoots:async () => { entered(); await gate; } });
  const ui = await lifecycleUi();
  let finished = false;
  const pending = call(PRODERO_TOOLS.prepare, {task:'routing'}).then(result => { finished=true;return result; });
  await started;
  assert.equal(finished, false);
  assert.deepEqual(ui.renders, []);
  assert.doesNotMatch(ui.html, /Not initialized|Initialize Prodero|0/);
  release();
  const response = await pending;
  assert.equal(response.structuredContent.result.project.initialized, true);
  assert.equal(response.structuredContent.result.project.knowledgeCount, 2);
  assert.equal(response.structuredContent.result.context.snapshot.sessionId, response.structuredContent.result.session.id);
  ui.render(response.structuredContent);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.renders.length, 1);
  assert.match(ui.html, /PRODERO · CONTEXT READY/);
  assert.doesNotMatch(ui.html, /Not initialized|Initialize Prodero/);
});
test('fast status is non-renderable and side-effect-free in both UI and text routing', async t => {
  const { root, call, client } = await fixture(t);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(t => t.name === PRODERO_TOOLS.status)._meta?.ui, undefined);
  assert.equal(tools.find(t => t.name === PRODERO_TOOLS.statusDetails)._meta?.ui, undefined);
  await fs.rm(path.join(root,'.prodero/.cache'), {recursive:true,force:true});
  const before = await snapshot(root);
  for (const request of [[PRODERO_TOOLS.status,{presentation:'ui'}],[PRODERO_TOOLS.text,{tool:PRODERO_TOOLS.status}]]) {
    const response = await call(...request);
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.hydrationRequired, false);
    assert.equal(response.structuredContent.project.knowledgeCount, undefined);
    assert.equal(response.structuredContent.project.initialized, true);
    assert.deepEqual(await snapshot(root), before);
  }
});
test('failed detailed state returns an error, never a successful initial or onboarding snapshot', async t => {
  const { root, call } = await fixture(t);
  await fs.writeFile(path.join(root,'.prodero/checkpoints/broken.json'), '{invalid');
  for (const [name,args] of [[PRODERO_TOOLS.open,{}],[PRODERO_TOOLS.text,{tool:PRODERO_TOOLS.open}]]) {
    const response = await call(name,args);
    assert.equal(response.isError,true);
    assert.notEqual(response.structuredContent?.phase,'initial');
    assert.notEqual(response.structuredContent?.project?.initialized,false);
    assert.doesNotMatch(response.content[0].text,/not initialized|ready to initialize/i);
  }
});
test('unknown state is distinct from a verified uninitialized repository', () => {
  const unknown = buildViewModel({action:'open',project:{}});
  assert.match(unknown.notices.join(' '),/not available yet/);
  assert.ok(!unknown.actions.some(a => a.tool === PRODERO_TOOLS.initialize));
  const absent = buildViewModel({action:'open',project:{initialized:false}});
  assert.ok(absent.actions.some(a => a.tool === PRODERO_TOOLS.initialize));
});

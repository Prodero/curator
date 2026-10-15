import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { PluginRegistry, pluginManifestSchema } from '../dist/plugins/registry.js';
import { createPluginContext } from '../dist/plugins/context.js';

async function temporary(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-plugins-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
const manifest = id => ({ manifest_version: 1, api_version: 1, id, name: id, version: '1.0.0', description: 'Synthetic plugin', capabilities: ['example'], entrypoint: 'index.cjs' });
async function fixture(root, id, overrides = {}, code = `exports.actions = { greet: {title:'Hello',description:'Greet',readOnly:true,async run(ctx,input){return {hello:input.name}}} };`) {
  const dir = path.join(root, id); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ ...manifest(id), ...overrides })); await fs.writeFile(path.join(dir, 'index.cjs'), code); return dir;
}
test('versioned manifests reject incompatible, malformed and escaping resources', () => {
  assert.equal(pluginManifestSchema.parse(manifest('hello')).id, 'hello');
  for (const patch of [{ api_version: 2 }, { manifest_version: 2 }, { entrypoint: '../index.cjs' }, { entrypoint: '/tmp/x.cjs' }, { ui: { resource: 'ui/../secret', action: 'greet' } }, { id: 'bad-id' }]) assert.equal(pluginManifestSchema.safeParse({ ...manifest('hello'), ...patch }).success, false);
});
test('addability: multiple synthetic plugins expose actions and UI without Core edits; failures isolate', async t => {
  const root = await temporary(t);
  const uiDir = await fixture(root, 'synthetic', { ui: { resource: 'ui.html', action: 'greet' } }); await fs.writeFile(path.join(uiDir, 'ui.html'), '<html>synthetic UI</html>');
  await fixture(root, 'second'); await fixture(root, 'incompatible', { api_version: 99 }); await fixture(root, 'broken', {}, 'throw new Error("broken")');
  await fixture(root, 'malformed'); await fs.writeFile(path.join(root, 'malformed/plugin.json'), '{');
  await fixture(root, 'missing_ui', { ui: { resource: 'absent.html', action: 'greet' } });
  await fixture(root, 'action_error', {}, `exports.actions={fail:{title:'fail',description:'fail',readOnly:true,async run(){throw new Error('Action failed')}}}`);
  const registry = new PluginRegistry(root);
  assert.deepEqual(registry.list().map(p => p.id), ['action_error', 'second', 'synthetic']);
  assert.equal(registry.diagnostics.length, 4);
  assert.match(registry.resource('synthetic'), /synthetic UI/);
  assert.deepEqual(await registry.dispatch('synthetic', 'greet', createPluginContext(registry, 'synthetic', root), { name: 'Ada' }), { hello: 'Ada' });
  await assert.rejects(registry.dispatch('action_error', 'fail', createPluginContext(registry, 'action_error', root), {}), /action_error\/fail/);
  assert.equal(registry.has('second'), true);
  await assert.rejects(registry.dispatch('synthetic', 'constructor', {}, {}), /unavailable/);
});
test('read-only plugin actions cannot access the durable apply service', async t => {
  const root = await temporary(t); await fixture(root, 'readonly', {}, `exports.actions={audit:{title:'Audit',description:'Read only',readOnly:true,async run(ctx){return ctx.state.apply({})}}}`);
  const registry = new PluginRegistry(root); await assert.rejects(registry.dispatch('readonly', 'audit', createPluginContext(registry, 'readonly', root), {}), /Read-only/);
});
test('removal: absent installation root keeps MCP initialize/status/prepare/record/close/sync healthy', async t => {
  const root = await temporary(t); await fs.mkdir(path.join(root, '.git'));
  const server = createServer({ projectRoot:root, pluginRoot: path.join(root, 'absent-plugins') }); const client = new Client({ name: 'removal', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a); t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: { projectRoot: root, ...args } }); assert.notEqual(r.isError, true, JSON.stringify(r)); return r.structuredContent; };
  assert.deepEqual((await client.callTool({ name: 'prodero_plugins', arguments: {} })).structuredContent.plugins, []);
  assert.ok(!(await client.listResources()).resources.some(r => r.uri.includes('/plugins/')));
  await call('prodero_initialize'); assert.equal((await call('prodero_status')).project.initialized, true);
  const prepared = await call('prodero_prepare', { task: 'isolation' });
  await call('prodero_session_record', { sessionId: prepared.result.session.id, entries: [{ type: 'decision', title: 'Boundary', content: 'Optional capabilities are independent of the project memory lifecycle.' }] });
  assert.equal((await call('prodero_session_close', { sessionId: prepared.result.session.id })).result.synchronization.sessions, 1);
  assert.equal((await call('prodero_sync')).result.recovery.sessions, 0);
  assert.equal((await call('prodero_prepare', { task: 'isolation again' })).result.automaticSync.sessions, 0);
  assert.equal((await call('prodero_status_details')).project.knowledgeCount, 1);
});

test('synthetic UI and action are registered over MCP, then disappear after fixture removal',async t=>{
  const root=await temporary(t);const plugins=path.join(root,'installation');const directory=await fixture(plugins,'new_capability',{ui:{resource:'ui.html',action:'greet'}});await fs.writeFile(path.join(directory,'ui.html'),'<html>Independent contribution</html>');
  for(const present of [true,false]) {
    if(!present)await fs.rm(directory,{recursive:true});
    const server=createServer({projectRoot:root,pluginRoot:plugins});const client=new Client({name:'add-remove',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
    try {
      const list=await client.callTool({name:'prodero_plugins',arguments:{}});assert.equal(list.structuredContent.plugins.length,present?1:0);
      const tool=(await client.listTools()).tools.find(t=>t.name==='prodero_plugin_new_capability');assert.equal(Boolean(tool),present);
      assert.equal((await client.listResources()).resources.some(r=>r.uri.includes('/plugins/new_capability')),present);
      if(present) {const resource=await client.readResource({uri:tool._meta.ui.resourceUri});assert.match(resource.contents[0].text,/Independent contribution/);const response=await client.callTool({name:tool.name,arguments:{projectRoot:root,input:{name:'Ada'}}});assert.deepEqual(response.structuredContent.result,{hello:'Ada'});}
      const status=await client.callTool({name:'prodero_status',arguments:{projectRoot:root}});assert.notEqual(status.isError,true);
    } finally {await client.close();await server.close();}
  }
});

test('core, MCP infrastructure and generic UI contain no concrete plugin coupling',async()=>{
  const root=new URL('../src/',import.meta.url);
  async function scan(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=new URL(`${entry.name}${entry.isDirectory()?'/':''}`,dir);if(entry.isDirectory())await scan(file);else if(/\.(ts|css|html)$/.test(entry.name))assert.doesNotMatch(await fs.readFile(file,'utf8'),/migrate_ai_studio|AI Studio Migration|\.ai-studio/,file.pathname);}}
  await scan(root);
});

test('a plugin UI tool-name collision is isolated before MCP registration',async t=>{
  const root=await temporary(t);const dir=await fixture(root,'action',{ui:{resource:'ui.html',action:'greet'}});await fs.writeFile(path.join(dir,'ui.html'),'<html>Collision fixture</html>');
  const registry=new PluginRegistry(root);assert.equal(registry.has('action'),false);assert.match(registry.diagnostics[0].message,/conflicts with a Core tool/);
  const server=createServer({pluginRoot:root});await server.close();
});

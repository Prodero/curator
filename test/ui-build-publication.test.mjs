import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {build} from 'vite';
import {viteSingleFile} from 'vite-plugin-singlefile';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {publishSingleFileUi} from '../scripts/publish-ui.mjs';

const publisher = new URL('../scripts/publish-ui.mjs', import.meta.url).href;
const html = marker => `<html><body>${marker}</body></html>`;
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-ui-publish-')));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const plugins=path.join(root,'plugins'),plugin=path.join(plugins,'fixture_ui'),ui=path.join(plugin,'ui'),out=path.join(ui,'dist');
  const a=path.join(root,'A'),b=path.join(root,'B');
  await Promise.all([fs.mkdir(a),fs.mkdir(b),fs.mkdir(out,{recursive:true})]);
  await fs.writeFile(path.join(plugin,'plugin.json'),JSON.stringify({manifest_version:1,api_version:1,id:'fixture_ui',name:'UI fixture',version:'1.0.0',description:'Disposable plugin',capabilities:[],entrypoint:'index.cjs',ui:{resource:'ui/dist/index.html',action:'detect'}}));
  await fs.writeFile(path.join(plugin,'index.cjs'),`exports.actions={detect:{title:'Detect',description:'Read fixture',readOnly:true,async run(){return {ok:true}}},apply:{title:'Apply',description:'Write fixture',readOnly:false,async run(){throw Error('Foreign workspace must never reach the handler')}}};`);
  await fs.writeFile(path.join(out,'index.html'),html('old-complete'));
  return {root,plugins,ui,out,a,b};
}
async function checkMcp(f,marker) {
  const server=createServer({projectRoot:f.a,pluginRoot:f.plugins});
  const client=new Client({name:'codex-mcp-client',version:'ui-publication'});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  try {
    const plugins=(await client.callTool({name:'prodero_plugins',arguments:{}})).structuredContent;
    const names=(await client.listTools()).tools.map(tool=>tool.name);
    assert.ok(names.includes('prodero_plugin_fixture_ui_apply'),JSON.stringify(plugins.diagnostics));
    assert.deepEqual(plugins.diagnostics,[]);
    const resource=await client.readResource({uri:'ui://prodero/plugins/fixture_ui-1.0.0.html'});
    assert.match(resource.contents[0].text,new RegExp(marker));
    const denied=await client.callTool({name:'prodero_plugin_fixture_ui_apply',arguments:{projectRoot:f.b,input:{}}});
    assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/PRODERO_ROOT_UNAUTHORIZED/);
    assert.deepEqual(await fs.readdir(f.b),[]);
  } finally {await client.close();await server.close();}
}

test('a paused Vite rebuild keeps the plugin registered and foreign workspaces denied',async t=>{
  const f=await fixture(t),reached=Promise.withResolvers(),release=Promise.withResolvers();
  await fs.writeFile(path.join(f.ui,'index.html'),'<html><body>new-complete<script type="module" src="./main.js"></script></body></html>');
  await fs.writeFile(path.join(f.ui,'main.js'),'globalThis.uiFixture=true;');
  const rebuilding=publishSingleFileUi(f.out,outDir=>build({configFile:false,root:f.ui,logLevel:'silent',plugins:[viteSingleFile(),{name:'publication-barrier',async generateBundle(){reached.resolve();await release.promise;}}],build:{outDir,emptyOutDir:true}}));
  try {
    // Vite has cleared its output directory but has not written the bundle.
    await Promise.race([reached.promise,rebuilding.then(()=>{throw Error('Build missed the barrier');})]);
    await checkMcp(f,'old-complete');
    release.resolve();await rebuilding;
    await checkMcp(f,'new-complete');
    assert.deepEqual(await fs.readdir(f.out),['index.html']);
  } finally {release.resolve();await rebuilding.catch(()=>{});}
});

const writer = `
import fs from 'node:fs/promises';
import path from 'node:path';
const [module,out,marker]=process.argv.slice(1);
const {publishSingleFileUi}=await import(module);
await publishSingleFileUi(out,async stage=>{
  const ready=new Promise(resolve=>process.once('message',resolve));
  await fs.writeFile(path.join(stage,'index.html'),'<html><body>partial');
  process.send('partial-written');await ready;
  await fs.writeFile(path.join(stage,'index.html'),'<html><body>'+marker+'</body></html>');
});
process.disconnect();
`;
function startWriter(out,marker) {
  const child=spawn(process.execPath,['--input-type=module','-e',writer,publisher,out,marker],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(stderr||`Writer exited ${code}`)));});
  const ready=Promise.race([new Promise(resolve=>child.once('message',resolve)),completed.then(()=>{throw Error('Writer missed the barrier');})]);
  return {ready,completed,release(){if(child.connected)child.send('finish');}};
}
test('independent build processes publish only whole resources and never clean up another writer',async t=>{
  const f=await fixture(t),a=startWriter(f.out,'complete-A'),b=startWriter(f.out,'complete-B');
  try {
    await Promise.all([a.ready,b.ready]);await checkMcp(f,'old-complete');
    a.release();await a.completed;await checkMcp(f,'complete-A');
    b.release();await b.completed;await checkMcp(f,'complete-B');
    assert.deepEqual(await fs.readdir(f.out),['index.html']);
  } finally {a.release();b.release();await Promise.allSettled([a.completed,b.completed]);}
});

test('a failed UI build preserves the last complete resource and cleans only its private output',async t=>{
  const f=await fixture(t);
  await assert.rejects(publishSingleFileUi(f.out,async stage=>{
    await fs.writeFile(path.join(stage,'index.html'),'partial');throw Error('fixture build failure');
  }),/fixture build failure/);
  await checkMcp(f,'old-complete');assert.deepEqual(await fs.readdir(f.out),['index.html']);
});

test('an incomplete or multi-file UI build cannot replace the standalone MCP resource',async t=>{
  const f=await fixture(t);
  for(const files of [[],['index.html','unbundled.js']]) {
    await assert.rejects(publishSingleFileUi(f.out,async stage=>{
      for(const name of files)await fs.writeFile(path.join(stage,name),'incomplete');
    }),/only a regular index.html/);
    assert.equal(await fs.readFile(path.join(f.out,'index.html'),'utf8'),html('old-complete'));
  }
  assert.deepEqual(await fs.readdir(f.out),['index.html']);
});

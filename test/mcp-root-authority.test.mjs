import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ListRootsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createServer} from '../dist/server.js';
import {initializeProject, rememberProjectKnowledge} from '../dist/core/project.js';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-root-authority-')));
  t.after(() => fs.rm(base, {recursive:true, force:true}));
  const a = path.join(base, 'project'), b = path.join(base, 'project-other');
  for (const root of [a,b]) { await fs.mkdir(root); await fs.mkdir(path.join(root,'.git')); }
  return {base,a,b};
}
async function connect(t, configured, roots) {
  const server = createServer({projectRoot:configured});
  const client = new Client({name:'root-authority-regression',version:'1'}, {capabilities: roots === undefined ? {} : {roots:{listChanged:true}}});
  if (roots !== undefined) client.setRequestHandler(ListRootsRequestSchema, async () => ({roots: (typeof roots === 'function' ? roots() : roots).map(root => ({uri:pathToFileURL(root).href}))}));
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => {await client.close();await server.close();});
  return (name, args={}) => client.callTool({name:'prodero_'+name, arguments:args});
}
async function snapshot(root) {
  const result = {};
  async function walk(dir, prefix='') {
    for (const e of await fs.readdir(dir,{withFileTypes:true})) {
      const rel=prefix+e.name;
      if(e.isDirectory()) {result[rel+'/']='directory';await walk(path.join(dir,e.name),rel+'/');}
      else result[rel]=await fs.readFile(path.join(dir,e.name),'utf8');
    }
  }
  await walk(root);return result;
}
const rejected = response => {assert.equal(response.isError,true);assert.match(JSON.stringify(response),/PRODERO_ROOT_UNAUTHORIZED/);assert.doesNotMatch(JSON.stringify(response),/Private sibling sentinel/);};

for (const authority of ['configured','host']) for (const initialized of [false,true]) {
  test(`F01 ${authority}: reject cross-project reads, writes, text and plugins (${initialized?'existing':'uninitialized'} victim)`, async t => {
    const {a,b}=await fixture(t);
    if(initialized) {await initializeProject(b);await rememberProjectKnowledge(b,{content:'Private sibling sentinel must remain private.',kind:'fact',scope:'project'});}
    await fs.mkdir(path.join(b,'.ai-studio'));await fs.writeFile(path.join(b,'.ai-studio','private.md'),'Private sibling sentinel');
    const before=await snapshot(b);
    // Even host authorization for B cannot widen an explicitly configured A.
    const call=await connect(t,authority==='configured'?a:undefined,authority==='configured'?[b]:[a]);
    for (const [name,args] of [
      ['status',{}],['config_get',{}],['knowledge',{}],['recall',{query:'Private sibling sentinel'}],
      ['initialize',{}],['remember',{content:'An injected agent wrote this observation.',kind:'fact'}],
      ['text',{tool:'prodero_status',arguments:{projectRoot:b}}],
      ['text',{tool:'prodero_initialize',arguments:{projectRoot:b}}],
      ['plugin_action',{pluginId:'migrate_ai_studio',action:'detect'}],
      ['plugin_migrate_ai_studio',{action:'audit'}],
      ['plugin_migrate_ai_studio_detect',{}],
      ['plugin_migrate_ai_studio_apply',{input:{}}],
    ]) {
      rejected(await call(name,{projectRoot:b,...args}));
      assert.deepEqual(await snapshot(b),before,name+' touched unauthorized files');
    }
    assert.equal((await call('status')).structuredContent.project.root,a);
    assert.deepEqual(await fs.readdir(a),['.git']);
  });
}

test('F01 canonical aliases retain authorized core, text, initialize and plugin workflows',async t=>{
  const {a,base}=await fixture(t),alias=path.join(base,'alias');await fs.symlink(a,alias,'dir');
  for(const configured of [true,false]) {
    const call=await connect(t,configured?alias:undefined,configured?undefined:[alias]);
    for(const projectRoot of [a,alias,path.join(a,'..',path.basename(a))]) {
      assert.equal((await call('status',{projectRoot})).structuredContent.project.root,alias);
      assert.equal((await call('text',{tool:'prodero_initialize',arguments:{projectRoot}})).isError,undefined);
      assert.equal((await call('plugin_migrate_ai_studio',{projectRoot,action:'detect'})).structuredContent.projectRoot,alias);
    }
  }
});

test('F01 explicit arguments cannot self-authorize when host roots are absent, empty or unavailable',async t=>{
  const {a}=await fixture(t);
  for(const roots of [undefined,[],()=>{throw new Error('Unavailable');}]) {
    const call=await connect(t,undefined,roots);
    for(const [name,args] of [['initialize',{}],['status',{}],['text',{tool:'prodero_initialize',arguments:{projectRoot:a}}],['plugin_action',{pluginId:'migrate_ai_studio',action:'detect'}]]) {
      const response=await call(name,{projectRoot:a,...args});assert.equal(response.isError,true);assert.match(JSON.stringify(response),/workspace (?:root|context)/i);
    }
  }
  assert.deepEqual(await fs.readdir(a),['.git']);
});

test('F01 multiple host roots allow explicit exact selection, not an ancestor, sibling or nested independent project',async t=>{
  const {a,b,base}=await fixture(t),nested=path.join(a,'nested');await fs.mkdir(nested);await fs.mkdir(path.join(nested,'.git'));
  const call=await connect(t,undefined,[a,b]);
  assert.match(JSON.stringify(await call('status')),/ambiguous/);
  for(const root of [a,b])assert.equal((await call('status',{projectRoot:root})).structuredContent.project.root,root);
  for(const root of [base,nested])rejected(await call('initialize',{projectRoot:root}));
  const explicitNested=await connect(t,undefined,[a,nested]);
  assert.equal((await explicitNested('initialize',{projectRoot:nested})).isError,undefined);
});

test('F01 symlinks and traversal cannot disguise an outside root; configured alias stays pinned',async t=>{
  const {a,b,base}=await fixture(t),alias=path.join(base,'launch-alias'),escape=path.join(a,'escape');
  await fs.symlink(a,alias,'dir');await fs.symlink(b,escape,'dir');
  const call=await connect(t,alias);
  rejected(await call('initialize',{projectRoot:escape}));
  rejected(await call('initialize',{projectRoot:a+'/../project-other'}));
  await fs.unlink(alias);await fs.symlink(b,alias,'dir');
  rejected(await call('initialize',{projectRoot:alias}));
  rejected(await call('status'));
  assert.deepEqual(await fs.readdir(b),['.git']);
});

test('F01 host root changes revoke former authorization; aliases are deduplicated',async t=>{
  const {a,b,base}=await fixture(t),alias=path.join(base,'alias');await fs.symlink(a,alias,'dir');
  let roots=[a,alias];const call=await connect(t,undefined,()=>roots);
  assert.equal((await call('status')).structuredContent.project.root,a);
  roots=[b];rejected(await call('status',{projectRoot:a}));
  assert.equal((await call('status')).structuredContent.project.root,b);
});

test('F01 canonical configured directory replacement fails closed',async t=>{
  const {a,b}=await fixture(t),call=await connect(t,a);
  await fs.rename(a,a+'-moved');await fs.symlink(b,a,'dir');
  rejected(await call('initialize'));
  assert.deepEqual(await fs.readdir(b),['.git']);
});


test('F01 CLI --root rejects an agent override across a real stdio connection',async t=>{
  const {a,b}=await fixture(t),client=new Client({name:'stdio-root-attack',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/cli.js',import.meta.url)),'mcp','--root',a],stderr:'pipe'});
  await client.connect(transport);t.after(()=>client.close());
  for(const name of ['prodero_status','prodero_initialize','prodero_plugin_migrate_ai_studio_detect']) rejected(await client.callTool({name,arguments:{projectRoot:b}}));
  assert.equal((await client.callTool({name:'prodero_initialize',arguments:{projectRoot:a}})).isError,undefined);
  assert.deepEqual(await fs.readdir(b),['.git']);
});

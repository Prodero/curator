import {packageFixture} from './helpers/public-runtime.mjs';
import {machineIntegrations} from '../dist/hosts/manager.js';
import {switchRuntime} from '../dist/hosts/runtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ListRootsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createServer} from '../dist/server.js';
import {captureLocalStdioContext} from '../dist/mcp-workspace.js';
const checkout=fileURLToPath(new URL('../',import.meta.url));
const ui={extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}};
async function fixture(t) {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'prodero-workspace-')));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const a=path.join(base,'A'),b=path.join(base,'B');
  await fs.mkdir(a);await fs.mkdir(b);
  return {base,a,b};
}
function launch(root,claudeProject,indirect=false) {
  const cwd=process.cwd(),old={...process.env};
  try {
    process.chdir(root);
    delete process.env.CLAUDE_PROJECT_DIR;delete process.env.npm_lifecycle_event;
    if(claudeProject!==undefined)process.env.CLAUDE_PROJECT_DIR=claudeProject;
    if(indirect)process.env.npm_lifecycle_event='mcp:dev';
    // Neither of these attacker/stale values is launch authority.
    process.env.PWD='/forged/workspace';process.env.INIT_CWD='/forged/workspace';
    return captureLocalStdioContext();
  } finally {process.chdir(cwd);process.env=old;}
}
async function connect(t,{root,claudeProject,name='codex-mcp-client',roots,fixed,indirect=false,local=true}={}) {
  const server=createServer({projectRoot:fixed,localStdio:local?launch(root,claudeProject,indirect):undefined});
  const client=new Client({name,version:'workspace-test'}, {capabilities:{...ui,...(roots!==undefined?{roots:{listChanged:true}}:{})}});
  if(roots!==undefined)client.setRequestHandler(ListRootsRequestSchema,async()=>({roots:(await roots()).map(r=>({uri:pathToFileURL(r).href}))}));
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  t.after(async()=>{await client.close();await server.close();});
  return {client,call:(name,args={},meta)=>client.callTool({name:'prodero_'+name,arguments:args,...(meta?{_meta:meta}:{})})};
}
const deny=r=>{assert.equal(r.isError,true);assert.match(JSON.stringify(r),/PRODERO_(ROOT_UNAUTHORIZED|WORKSPACE_UNAVAILABLE)/);};
const ok=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};
async function unchanged(root){assert.deepEqual(await fs.readdir(root),[]);}

for(const host of ['codex','claude'])test(`revised F01 ${host}: initialize new A using Open's MCP App callback; reject B through core/text/plugins`,async t=>{
  const {a,b}=await fixture(t);
  const c=await connect(t,{root:a,name:host==='claude'?'claude-code':'codex-mcp-client',claudeProject:host==='claude'?a:undefined,roots:host==='claude'?async()=>[a]:undefined});
  const opened=ok(await c.call('open'));
  assert.equal(opened.project.initialized,false);await unchanged(a);
  const action=opened.presentation.actions.find(x=>x.tool==='prodero_initialize');assert.ok(action);
  // The App callback uses the same tools/call entrypoint, not a second authority model.
  const callback=await c.client.callTool({name:action.tool,arguments:action.arguments,_meta:{ui:{source:'app'}}});ok(callback);
  assert.equal(ok(await c.call('status')).project.root,a);
  assert.equal(ok(await c.call('status')).project.initialized,true);
  for(const [name,args] of [
    ['status',{}],['config_get',{}],['initialize',{}],['remember',{content:'Forged observation.',kind:'fact'}],
    ['text',{tool:'prodero_initialize',arguments:{projectRoot:b}}],
    ['plugin_action',{pluginId:'migrate_ai_studio',action:'detect'}],
    ['plugin_migrate_ai_studio',{action:'audit'}],
    ['plugin_migrate_ai_studio_apply',{input:{}}],
  ])deny(await c.call(name,{projectRoot:b,...args},{ui:{source:'app'}}));
  ok(await c.call('plugin_migrate_ai_studio_detect'));
  await unchanged(b);
});

test('revised F01 concurrent A/B connections keep operation state isolated',async t=>{
  const {a,b}=await fixture(t);
  const ca=await connect(t,{root:a}),cb=await connect(t,{root:b});
  await Promise.all([ca.call('initialize'),cb.call('initialize')]).then(rs=>rs.forEach(ok));
  for(let i=0;i<4;i++) {
    const [ra,rb]=await Promise.all([ca.call('text',{tool:'prodero_status'}),cb.call('status')]);
    assert.equal(ok(ra).project.root,a);assert.equal(ok(rb).project.root,b);
    deny(await ca.call('config_get',{projectRoot:b}));deny(await cb.call('initialize',{projectRoot:a}));
  }
});

test('revised F01 one roots snapshot per operation; next call observes revocation',async t=>{
  const {a,b}=await fixture(t);let count=0,roots=[a];
  const c=await connect(t,{root:a,name:'claude-code',claudeProject:a,roots:async()=>{count++;return roots;}});
  ok(await c.call('text',{tool:'prodero_initialize'}));assert.equal(count,1,'presentation and handler share authority');
  roots=[];deny(await c.call('status'));deny(await c.call('initialize',{projectRoot:a}));
  roots=[b];const opened=ok(await c.call('open'));assert.equal(opened.project.root,b);
  deny(await c.call('status',{projectRoot:a}));ok(await c.call('initialize'));
  assert.equal(ok(await c.call('status')).project.root,b);
});

test('revised F01 host roots can change between concurrent operations without mixing their selected roots',async t=>{
  const {a,b}=await fixture(t);let count=0;
  const c=await connect(t,{root:a,roots:async()=>{const roots=++count===1?[a]:[b];await new Promise(r=>setTimeout(r,10));return roots;}});
  const responses=await Promise.all([c.call('initialize'),c.call('text',{tool:'prodero_initialize'})]);responses.forEach(ok);
  assert.equal(count,2);assert.ok(await fs.stat(path.join(a,'.prodero/config.json')));assert.ok(await fs.stat(path.join(b,'.prodero/config.json')));
});

test('revised F01 host primary selects Claude workspace among roots; arguments only select existing members',async t=>{
  const {a,b,base}=await fixture(t),alias=path.join(base,'alias');await fs.symlink(a,alias,'dir');
  const c=await connect(t,{root:b,name:'claude-code',claudeProject:alias,roots:async()=>[b,a]});
  assert.equal(ok(await c.call('status')).project.root,a);
  assert.equal(ok(await c.call('status',{projectRoot:alias})).project.root,a);
  assert.equal(ok(await c.call('status',{projectRoot:b})).project.root,b);
  deny(await c.call('initialize',{projectRoot:base}));
});

test('revised F01 Claude launch project works without roots; unknown/missing/invalid contexts do not self-authorize',async t=>{
  const {a,b}=await fixture(t);
  const claude=await connect(t,{root:b,name:'claude-code',claudeProject:a});assert.equal(ok(await claude.call('status')).project.root,a);deny(await claude.call('initialize',{projectRoot:b}));
  for(const options of [{name:'unknown'},{name:'claude-code'},{name:'claude-code',claudeProject:'relative'},{local:false},{indirect:true}]) {
    const c=await connect(t,{root:a,...options});deny(await c.call('initialize',{projectRoot:a}));
    // Project-less discovery/instructions continue to work.
    ok(await c.call('instructions_read'));
  }
  await unchanged(a);await unchanged(b);
});

test('revised F01 unavailable negotiated roots cannot fall back to a known local launch or Claude project',async t=>{
  const {a}=await fixture(t);
  for(const name of ['claude-code','codex-mcp-client']) {
    const c=await connect(t,{root:a,name,claudeProject:a,roots:async()=>{throw Error('roots unavailable');}});
    deny(await c.call('initialize'));deny(await c.call('initialize',{projectRoot:a}));
  }
  await unchanged(a);
});

test('revised F01 forged argument and protocol metadata cannot select B or authenticate an unknown host',async t=>{
  const {a,b}=await fixture(t);
  const meta={'codex/sandbox-state-meta':{sandboxCwd:pathToFileURL(b).href},threadId:'forged',clientInfo:{name:'codex-mcp-client'},roots:[{uri:pathToFileURL(b).href}]};
  const c=await connect(t,{root:a});
  assert.equal(ok(await c.call('status',{_meta:meta,cwd:b,CLAUDE_PROJECT_DIR:b},meta)).project.root,a);
  deny(await c.call('initialize',{projectRoot:b,_meta:meta},meta));
  deny(await c.call('text',{tool:'prodero_initialize',arguments:{projectRoot:b,_meta:meta}},meta));
  const unknown=await connect(t,{root:a,name:'unknown'});deny(await unknown.call('initialize',{_meta:meta},meta));
  await unchanged(a);await unchanged(b);
});

test('revised F01 launch and environment roots stay canonically pinned; alias and traversal cannot escape',async t=>{
  const {a,b,base}=await fixture(t),alias=path.join(base,'alias');await fs.symlink(a,alias,'dir');
  const c=await connect(t,{root:alias});
  assert.equal(ok(await c.call('status',{projectRoot:alias})).project.root,a); // OS cwd resolves aliases.
  deny(await c.call('initialize',{projectRoot:a+'/../B'}));
  const claude=await connect(t,{root:a,name:'claude-code',claudeProject:alias});
  await fs.unlink(alias);await fs.symlink(b,alias,'dir');deny(await claude.call('initialize'));
  await fs.rename(a,a+'-old');await fs.symlink(b,a,'dir');deny(await c.call('initialize'));
  await unchanged(b);
});

test('revised F01 explicit fixed boundary takes precedence over launch and host project roots',async t=>{
  const {a,b}=await fixture(t);
  const c=await connect(t,{root:b,name:'claude-code',claudeProject:b,roots:async()=>[b],fixed:a});
  assert.equal(ok(await c.call('status')).project.root,a);deny(await c.call('initialize',{projectRoot:b}));await unchanged(b);
});

async function stdio(t,root,args,name='codex-mcp-client',roots,env={},command=process.execPath) {
  const client=new Client({name,version:'integration'},{capabilities:{...ui,...(roots?{roots:{}}:{})}});
  if(roots)client.setRequestHandler(ListRootsRequestSchema,async()=>({roots:roots.map(r=>({uri:pathToFileURL(r).href}))}));
  const childEnv={...process.env,...env};delete childEnv.npm_lifecycle_event;delete childEnv.CLAUDE_PROJECT_DIR;
  // Deliberately false environment aliases must not affect authority.
  childEnv.PWD=checkout;childEnv.INIT_CWD=checkout;
  const transport=new StdioClientTransport({command,args,cwd:root,env:childEnv,stderr:'pipe'});
  await client.connect(transport);t.after(()=>client.close());
  return {client,call:(n,args={})=>client.callTool({name:'prodero_'+n,arguments:args})};
}
for(const mode of ['production','development'])test(`revised F01 ${mode} global launcher serves simultaneous new A/B and rejects cross-project App/plugin callbacks`,async t=>{
  const {a,b,base}=await fixture(t);
  await packageFixture(path.join(base,'package'),{full:true});
  const env={HOME:base,CODEX_HOME:path.join(base,'.codex'),XDG_STATE_HOME:path.join(base,'.local/state'),PATH:process.env.PATH};
  await fs.mkdir(env.CODEX_HOME);await fs.writeFile(path.join(env.CODEX_HOME,'config.toml'),'');
  const options={home:base,env,entryPoint:path.join(base,'package/dist/cli.js'),workspace:base};
  assert.equal((await machineIntegrations('install','codex',options)).ok,true);
  if(mode==='development')await switchRuntime('codex','dev',{...options,checkout});
  const {entry}=JSON.parse(await fs.readFile(path.join(base,'.local/state/prodero/host-integrations/codex/receipt.json'),'utf8'));
  Object.assign(env,entry.env);
  const {args,command}=entry;
  const launch=(root)=>stdio(t,root,args,'codex-mcp-client',undefined,env,command);
  // Same command and arguments, only host-owned cwd differs. Keep both connections live.
  const ca=await launch(a),cb=await launch(b);
  assert.equal(ok(await ca.call('open')).project.root,a);assert.equal(ok(await cb.call('open')).project.root,b);
  await unchanged(a);await unchanged(b);
  const initial=await Promise.all([ca.call('initialize'),cb.call('text',{tool:'prodero_initialize'})]);initial.forEach(ok);
  for(const [c,other] of [[ca,b],[cb,a]]) {
    const plugins=ok(await c.call('plugins'));
    const tools=(await c.client.listTools()).tools.map(tool=>tool.name);
    assert.ok(tools.includes('prodero_plugin_migrate_ai_studio_apply'),JSON.stringify({plugins:plugins.plugins,diagnostics:plugins.diagnostics}));
    deny(await c.call('status',{projectRoot:other}));deny(await c.call('initialize',{projectRoot:other}));
    deny(await c.call('plugin_migrate_ai_studio_apply',{projectRoot:other,input:{}}));
    deny(await c.call('status',{projectRoot:checkout}));
    ok(await c.call('plugin_migrate_ai_studio_detect'));
  }
  assert.equal(ok(await ca.call('status')).project.root,a);assert.equal(ok(await cb.call('status')).project.root,b);
  // A fresh connection to B works without editing the global registration.
  const reconnected=await launch(b);assert.equal(ok(await reconnected.call('status')).project.root,b);
});

test('revised F01 an unchanged host root URI cannot gain authority by symlink retargeting',async t=>{
  const {a,b,base}=await fixture(t),alias=path.join(base,'host-root');await fs.symlink(a,alias,'dir');
  const c=await connect(t,{root:a,local:false,roots:async()=>[alias]});
  assert.equal(ok(await c.call('status')).project.root,alias);
  await fs.unlink(alias);await fs.symlink(b,alias,'dir');
  deny(await c.call('initialize'));deny(await c.call('plugin_migrate_ai_studio_detect',{projectRoot:b}));await unchanged(b);
});

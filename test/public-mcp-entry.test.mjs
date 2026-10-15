// Invented toy-project fixtures; no real project incidents or operational records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ListRootsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {machineIntegrations} from '../dist/hosts/manager.js';
import {switchRuntime} from '../dist/hosts/runtime.js';
import {packageFixture,curatorCheckout} from './helpers/public-runtime.mjs';
const exec=promisify(execFile);
async function fixture(t) {
  const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'prodero-public-')));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const pkg=path.join(home,'package'),bin=await packageFixture(pkg,{full:true});
  for(const d of ['A','B','.codex','.claude'])await fs.mkdir(path.join(home,d));
  await fs.writeFile(path.join(home,'.codex/config.toml'),'');await fs.writeFile(path.join(home,'.claude.json'),'{}');
  const env={...process.env,HOME:home,CODEX_HOME:path.join(home,'.codex'),XDG_STATE_HOME:path.join(home,'.local/state')};
  delete env.CLAUDE_CONFIG_DIR;delete env.CLAUDE_PROJECT_DIR;delete env.npm_lifecycle_event;
  const options={home,env,entryPoint:path.join(pkg,'dist/cli.js'),workspace:home};
  const receipt=host=>path.join(home,'.local/state/prodero/host-integrations',host,'receipt.json');
  async function install(host,mode) {
    assert.equal((await machineIntegrations('install',host,options)).ok,true);
    if(mode==='dev')await switchRuntime(host,'dev',{...options,checkout:curatorCheckout});
    return JSON.parse(await fs.readFile(receipt(host),'utf8')).entry;
  }
  return {home,pkg,bin,env,options,receipt,install,a:path.join(home,'A'),b:path.join(home,'B')};
}
async function connect(t,f,entry,root,host='codex',roots) {
  const env={...f.env,...entry.env,PWD:curatorCheckout,INIT_CWD:curatorCheckout};
  if(host==='claude')env.CLAUDE_PROJECT_DIR=root;
  const client=new Client({name:host==='claude'?'claude-code':'codex-mcp-client',version:'public-entry-test'},{capabilities:roots?{roots:{listChanged:true}}:{}});
  if(roots)client.setRequestHandler(ListRootsRequestSchema,async()=>({roots:roots().map(r=>({uri:pathToFileURL(r).href}))}));
  const transport=new StdioClientTransport({command:entry.command,args:entry.args,cwd:root,env,stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',c=>stderr+=c);
  try {await client.connect(transport);}catch(e){throw new Error(`${e.message}\n${stderr}`);}
  t.after(()=>client.close());
  return (tool,args={},meta)=>client.callTool({name:'prodero_'+tool,arguments:args,...(meta?{_meta:meta}:{})});
}
const ok=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};
const denied=r=>{assert.equal(r.isError,true);assert.match(JSON.stringify(r),/PRODERO_(ROOT_UNAUTHORIZED|WORKSPACE_UNAVAILABLE)/);};
for(const mode of ['package','dev']) test(`public ${mode}: Claude roots, App init, metadata forgery, revocation and plugin boundary`,async t=>{
  const f=await fixture(t),entry=await f.install('claude',mode);let roots=[f.a];
  assert.equal(entry.command,f.bin);assert.deepEqual(entry.args,mode==='dev'?['mcp','--dev']:['mcp']);
  const call=await connect(t,f,entry,f.a,'claude',()=>roots);
  const opened=ok(await call('open'));assert.equal(opened.project.initialized,false);
  const action=opened.presentation.actions.find(a=>a.tool==='prodero_initialize');assert.ok(action);
  ok(await call('initialize',action.arguments,{ui:{source:'app'}}));
  const forged={'codex/sandbox-state-meta':{sandboxCwd:pathToFileURL(f.b).href},roots:[{uri:pathToFileURL(f.b).href}]};
  for(const tool of ['status','initialize','plugin_migrate_ai_studio_apply'])denied(await call(tool,{projectRoot:f.b,input:{}},forged));
  assert.equal(ok(await call('status',{cwd:f.b,_meta:forged},forged)).project.root,f.a);
  roots=[];denied(await call('status'));denied(await call('initialize',{projectRoot:f.a}));
  assert.deepEqual(await fs.readdir(f.b),[]);
});
test('public package: no npm, no receipt, minimal GUI PATH and installed-bin alias',async t=>{
  const f=await fixture(t),entry=await f.install('codex','package');
  const nodeOnly=path.join(f.home,'node-only');await fs.mkdir(nodeOnly);await fs.symlink(process.execPath,path.join(nodeOnly,'node'));
  const alias=path.join(f.home,'prodero');await fs.symlink(f.bin,alias);
  const saved=await fs.readFile(f.receipt('codex'),'utf8');
  await fs.writeFile(f.receipt('codex'),'broken receipt must not affect production');
  const call=await connect(t,f,{...entry,command:alias,env:{PATH:nodeOnly}},f.a);
  ok(await call('initialize'));assert.equal(ok(await call('status')).project.root,f.a);
  await assert.rejects(exec('npm',['--version'],{env:{PATH:nodeOnly}}),e=>e.code==='ENOENT');
  await fs.writeFile(f.receipt('codex'),saved);
  // Managed env resolves Node when the GUI parent has no Node on PATH.
  const child=await exec(entry.command,['--version'],{env:{...f.env,PATH:'/usr/bin:/bin',...entry.env}});assert.match(child.stdout,/0\.1\.0/);
});
test('public dev: checkout is code only; Curator workspace and unrelated synthetic ToyGrid workspace',async t=>{
  const f=await fixture(t),entry=await f.install('codex','dev');
  const toyWorkspace=await connect(t,f,entry,f.a),curator=await connect(t,f,entry,curatorCheckout);
  ok(await toyWorkspace('initialize'));assert.equal(ok(await toyWorkspace('status')).project.root,f.a);
  assert.equal(ok(await curator('status')).project.root,await fs.realpath(curatorCheckout));
  denied(await toyWorkspace('status',{projectRoot:curatorCheckout}));denied(await curator('initialize',{projectRoot:f.a}));
});
test('public dev: missing, corrupt and symlinked receipts never fall back to cwd',async t=>{
  const f=await fixture(t),entry=await f.install('codex','dev'),receipt=f.receipt('codex');
  const saved=await fs.readFile(receipt,'utf8');
  const run=()=>exec(entry.command,['mcp','--dev'],{cwd:f.a,env:{...f.env,...entry.env},timeout:5000});
  await fs.rm(receipt);await assert.rejects(run(),/No managed development checkout/);
  await fs.writeFile(receipt,'{');await assert.rejects(run(),/Invalid integration receipt/);
  await fs.rm(receipt);const outside=path.join(f.home,'receipt-copy');await fs.writeFile(outside,saved);await fs.symlink(outside,receipt);
  await assert.rejects(run(),/Symlink|configuration path/);assert.deepEqual(await fs.readdir(f.a),[]);
});
test('public dev: saved checkout retargeting rejected; ordinary checkout aliases canonicalize during switch',async t=>{
  const f=await fixture(t);await f.install('codex','package');
  const alias=path.join(f.home,'checkout-alias');await fs.symlink(curatorCheckout,alias,'dir');
  await switchRuntime('codex','dev',{...f.options,checkout:alias});
  const receipt=JSON.parse(await fs.readFile(f.receipt('codex'),'utf8'));
  assert.equal(receipt.runtime.devRoot,await fs.realpath(curatorCheckout));
  receipt.runtime.devRoot=alias;await fs.writeFile(f.receipt('codex'),JSON.stringify(receipt));
  await assert.rejects(exec(f.bin,['mcp','--dev'],{cwd:f.a,env:{...f.env,...receipt.entry.env},timeout:5000}),/moved or replaced/);
});
test('public dev: separate host checkouts use an explicit code selector without changing the other registration',async t=>{
  const f=await fixture(t),codex=await f.install('codex','dev');await f.install('claude','package');
  const other=path.join(f.home,'other-checkout');await fs.mkdir(other);
  for(const part of ['src','scripts','node_modules'])await fs.symlink(path.join(curatorCheckout,part),path.join(other,part),'dir');
  await fs.copyFile(path.join(curatorCheckout,'package.json'),path.join(other,'package.json'));
  await switchRuntime('claude','dev',{...f.options,checkout:other});
  const claude=JSON.parse(await fs.readFile(f.receipt('claude'),'utf8')).entry;
  assert.deepEqual(claude.args,['mcp','--dev','--checkout',other]);
  assert.deepEqual(JSON.parse(await fs.readFile(f.receipt('codex'),'utf8')).entry,codex);
  const call=await connect(t,f,codex,f.a);assert.equal(ok(await call('status')).project.root,f.a);
});

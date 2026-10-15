import {packageFixture} from './helpers/public-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {machineIntegrations} from '../dist/hosts/manager.js';
import {LAUNCHER} from '../dist/hosts/adapters.js';
import {transact} from '../dist/hosts/files.js';
const exec=promisify(execFile);
async function fixture(t,names=['codex','claude']){const home=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-hosts-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const bin=path.join(home,'bin');await fs.mkdir(bin);for(const name of names)await fs.writeFile(path.join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o700});await packageFixture(path.join(home,'package'));const entryPoint=path.join(home,'package/dist/cli.js');const options={home,env:{HOME:home,PATH:bin},entryPoint};return {home,bin,options,run:(action,selection)=>machineIntegrations(action,selection,options)};}
async function tree(root){const out={};async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.isFile())out[path.relative(root,p)]=await fs.readFile(p,'utf8');}}await walk(root);return out;}
const row=(r,id)=>r.hosts.find(h=>h.id===id);
for(const host of ['codex','claude'])test(host+' clean install, inspection, idempotency and exact uninstall',async t=>{
 const f=await fixture(t,[host]);assert.equal(row(await f.run('status'),host).state,'not-configured');const before=await tree(f.home);
 assert.equal(row(await f.run('install',host),host).state,'installed');const installed=await tree(f.home);const config=path.join(f.home,host==='codex'?'.codex/config.toml':'.claude.json');const timestamp=(await fs.stat(config)).mtimeMs;
 assert.equal(row(await f.run('install',host),host).state,'installed');assert.equal((await fs.stat(config)).mtimeMs,timestamp);assert.deepEqual(await tree(f.home),installed);assert.equal(row(await f.run('status'),host).launcherInstalled,true);
 assert.equal((await f.run('uninstall',host)).ok,true);assert.equal(row(await f.run('status'),host).mcpConfigured,false);const after=await tree(f.home);for(const [p,v]of Object.entries(before))assert.equal(after[p],v);assert.equal(after[path.relative(f.home,config)],undefined);assert.equal((await f.run('uninstall',host)).ok,true);
 for(const p of Object.keys(after).filter(p=>p.includes('backup-')))assert.equal((await fs.stat(path.join(f.home,p))).mode&0o777,0o600);
});

test('default and --all discover newly installed hosts without changing existing integration',async t=>{
 const f=await fixture(t,['codex']);let r=await f.run('install');assert.equal(row(r,'codex').state,'installed');assert.equal(row(r,'claude').state,'not-detected');const before=await fs.readFile(path.join(f.home,'.codex/config.toml'),'utf8');await fs.writeFile(path.join(f.bin,'claude'),'#!/bin/sh\n',{mode:0o700});r=await f.run('install','all');assert.equal(row(r,'claude').state,'installed');assert.equal(await fs.readFile(path.join(f.home,'.codex/config.toml'),'utf8'),before);assert.equal((await f.run('uninstall','all')).ok,true);
});
for(const host of ['codex','claude'])test(host+' preserves unrelated config and custom instructions, even with later user edits',async t=>{
 const f=await fixture(t);const config=path.join(f.home,host==='codex'?'.codex/config.toml':'.claude.json'),instructions=path.join(f.home,host==='codex'?'.codex/AGENTS.md':'.claude/CLAUDE.md');await fs.mkdir(path.dirname(instructions),{recursive:true});const initial=host==='codex'?'# Personal configuration\nmodel = "fixture"\n[mcp_servers.other]\ncommand = "other"\n':'{ "personal": "keep", "mcpServers": {"other":{"command":"other"}} }\n';await fs.writeFile(config,initial);await fs.writeFile(instructions,'Custom instructions remain exactly here.\n');assert.equal((await f.run('install',host)).ok,true);await fs.appendFile(instructions,'Later custom instructions.\n');if(host==='codex')await fs.appendFile(config,'\n[extra]\nkeep = true\n');else{const v=JSON.parse(await fs.readFile(config,'utf8'));v.extra=true;await fs.writeFile(config,JSON.stringify(v));}assert.equal((await f.run('uninstall',host)).ok,true);const text=await fs.readFile(instructions,'utf8');assert.match(text,/Custom instructions remain exactly here/);assert.match(text,/Later custom instructions/);assert.doesNotMatch(text,/prodero:global/);const cfg=await fs.readFile(config,'utf8');assert.match(cfg,/other/);assert.match(cfg,/extra/);assert.doesNotMatch(cfg,/"prodero"|mcp_servers.prodero/);
});

test('outdated owned launcher and relocated runtime update; modified blocks conflict',async t=>{
 const f=await fixture(t,['codex']);await f.run('install','codex');const receiptPath=path.join(f.home,'.local/state/prodero/host-integrations/codex/receipt.json'),launcher=path.join(f.home,'.codex/AGENTS.md');const receipt=JSON.parse(await fs.readFile(receiptPath,'utf8'));const old=LAUNCHER.replace('immediately call','invoke');receipt.launcher=old;receipt.installedLauncher=receipt.installedLauncher.replace(LAUNCHER,old);await fs.writeFile(receiptPath,JSON.stringify(receipt));await fs.writeFile(launcher,receipt.installedLauncher);assert.equal(row(await f.run('status'),'codex').state,'outdated');assert.equal((await f.run('install','codex')).ok,true);assert.match(await fs.readFile(launcher,'utf8'),/immediately call/);
 await packageFixture(path.join(f.home,'other-package')); const relocated={...f.options,entryPoint:path.join(f.home,'other-package/dist/cli.js')};assert.equal(row(await machineIntegrations('status','codex',relocated),'codex').state,'outdated');assert.equal((await machineIntegrations('install','codex',relocated)).ok,true);
 await fs.writeFile(launcher,(await fs.readFile(launcher,'utf8')).replace('immediately call','never invoke'));const before=await tree(f.home);assert.equal(row(await f.run('install','codex'),'codex').state,'conflicted');assert.equal((await f.run('uninstall','codex')).ok,false);assert.deepEqual(await tree(f.home),before);
});
for(const host of ['codex','claude'])test(host+' unowned entry, corrupt config and synthetic secrets never overwritten or exposed',async t=>{
 const f=await fixture(t,[host]),config=path.join(f.home,host==='codex'?'.codex/config.toml':'.claude.json');await fs.mkdir(path.dirname(config),{recursive:true});const secret='sk-proj-'+'SYNTHETIC_ONLY_'.repeat(4);
 for(const content of [host==='codex'?'[mcp_servers.prodero]\ncommand="custom"\n':'{"mcpServers":{"prodero":{"command":"custom"}}}',secret,host==='codex'?'x=1\nx=2\n':'{"x":1,"x":2}']){await fs.writeFile(config,content);const before=await tree(f.home);const r=await f.run('install',host);assert.equal(r.ok,false);assert.ok(!JSON.stringify(r).includes(secret));assert.deepEqual(await tree(f.home),before);}
});

test('Codex active global override is used; later shadowing is reported and safely removable',async t=>{
 const f=await fixture(t,['codex']);await fs.mkdir(path.join(f.home,'.codex'));await fs.writeFile(path.join(f.home,'.codex/AGENTS.override.md'),'Override preferences.\n');assert.equal((await f.run('install','codex')).ok,true);assert.match(await fs.readFile(path.join(f.home,'.codex/AGENTS.override.md'),'utf8'),/prodero:global/);assert.equal(await fs.stat(path.join(f.home,'.codex/AGENTS.md')).catch(()=>null),null);await f.run('uninstall','codex');
});

test('missing hosts, individual selection, Cursor unsupported and unknown host',async t=>{
 const f=await fixture(t,[]);assert.equal((await f.run('install','codex')).ok,false);assert.equal((await f.run('install','all')).ok,true);assert.equal(row(await f.run('status'),'claude').detected,false);assert.equal((await f.run('install','cursor')).ok,false);await assert.rejects(f.run('install','unknown'),/HOST_UNKNOWN/);assert.ok(!Object.keys(await tree(f.home)).some(p=>p.includes('.codex')||p.includes('.claude')));
});

test('symlink/hardlink settings and duplicate managed blocks fail safely',async t=>{
 const f=await fixture(t,['codex']);await fs.mkdir(path.join(f.home,'.codex'));const config=path.join(f.home,'.codex/config.toml'),sentinel=path.join(f.home,'sentinel');await fs.writeFile(sentinel,'model="keep"\n');await fs.symlink(sentinel,config);assert.equal((await f.run('install','codex')).ok,false);assert.equal(await fs.readFile(sentinel,'utf8'),'model="keep"\n');await fs.rm(config);await fs.link(sentinel,config);assert.equal((await f.run('install','codex')).ok,false);await fs.rm(config);await fs.writeFile(path.join(f.home,'.codex/AGENTS.md'),LAUNCHER+'\n'+LAUNCHER);assert.equal((await f.run('install','codex')).ok,false);
});

test('managed MCP modifications and receipt corruption are never silently repaired',async t=>{
 const f=await fixture(t,['claude']);await f.run('install','claude');const config=path.join(f.home,'.claude.json');const value=JSON.parse(await fs.readFile(config,'utf8'));value.mcpServers.prodero.args.push('custom');await fs.writeFile(config,JSON.stringify(value));const before=await tree(f.home);assert.equal(row(await f.run('status'),'claude').state,'conflicted');assert.equal((await f.run('uninstall','claude')).ok,false);assert.deepEqual(await tree(f.home),before);
});

test('journal rollback preserves files on write failure; unresolved journal blocks new writes',async t=>{
 const f=await fixture(t,[]),target=path.join(f.home,'config'),state=path.join(f.home,'state');await fs.writeFile(target,'before');const rename=fs.rename;fs.rename=async(a,b)=>{if(b===target)throw Error('synthetic write failure');return rename(a,b);};try{await assert.rejects(transact(f.home,state,[{path:target,before:'before',after:'after'}]));}finally{fs.rename=rename;}assert.equal(await fs.readFile(target,'utf8'),'before');assert.equal(await fs.stat(path.join(state,'pending.json')).catch(()=>null),null);
 await f.run('install','codex');const pending=path.join(f.home,'.local/state/prodero/host-integrations/codex/pending.json');await fs.mkdir(path.dirname(pending),{recursive:true});await fs.writeFile(pending,'{}');assert.equal(row(await f.run('status'),'codex').state,'recovery-required');
});

test('machine operations never create project memory or change Git; status outside a project is read-only',async t=>{
 const f=await fixture(t);const project=path.join(f.home,'project');await fs.mkdir(project);await exec('git',['init','-q',project]);await fs.writeFile(path.join(project,'sentinel'),'untouched');const before=await tree(project);await f.run('install');await f.run('status');await f.run('uninstall');assert.deepEqual(await tree(project),before);
 const {stdout}=await exec(process.execPath,[fileURLToPath(new URL('../dist/cli.js',import.meta.url)),'status'],{cwd:project,env:{...process.env,HOME:f.home,CODEX_HOME:path.join(f.home,'.codex'),CLAUDE_CONFIG_DIR:path.join(f.home,'.claude'),XDG_STATE_HOME:path.join(f.home,'.local/state')}});assert.equal(JSON.parse(stdout).scope,'machine');assert.deepEqual(await tree(project),before);
});

test('new Codex override conflicts on install but uninstall preserves the overriding file',async t=>{
 const f=await fixture(t,['codex']);await f.run('install','codex');const override=path.join(f.home,'.codex/AGENTS.override.md');await fs.writeFile(override,'New user override.\n');assert.equal(row(await f.run('install','codex'),'codex').state,'conflicted');assert.equal((await f.run('uninstall','codex')).ok,true);assert.equal(await fs.readFile(override,'utf8'),'New user override.\n');assert.equal((await f.run('install','codex')).ok,true);assert.match(await fs.readFile(override,'utf8'),/prodero:global/);
});

test('native HOME overrides stay isolated; paths outside HOME are rejected',async t=>{
 const f=await fixture(t,['codex','claude']);const options={...f.options,env:{...f.options.env,CODEX_HOME:path.join(f.home,'custom-codex'),CLAUDE_CONFIG_DIR:path.join(f.home,'custom-claude'),XDG_STATE_HOME:path.join(f.home,'custom-state')}};assert.equal((await machineIntegrations('install','all',options)).ok,true);assert.ok(await fs.stat(path.join(f.home,'custom-codex/config.toml')));assert.ok(await fs.stat(path.join(f.home,'custom-claude/.claude.json')));assert.equal(await fs.stat(path.join(f.home,'.claude.json')).catch(()=>null),null);
 const outside={...f.options,env:{...f.options.env,CODEX_HOME:path.dirname(f.home)}};assert.equal((await machineIntegrations('install','codex',outside)).ok,false);
});

test('removed host executable is not detected just because installation left empty directories',async t=>{
 const f=await fixture(t,['codex']);await f.run('install','codex');await fs.rm(path.join(f.bin,'codex'));assert.equal((await f.run('uninstall','codex')).ok,true);assert.equal(row(await f.run('status'),'codex').detected,false);
});

test('corrupt ownership receipt is private and cannot authorize arbitrary target writes',async t=>{
 const f=await fixture(t,['codex']);await f.run('install','codex');const receipt=path.join(f.home,'.local/state/prodero/host-integrations/codex/receipt.json');await fs.writeFile(receipt,'password=synthetic_receipt_fixture');const before=await tree(f.home);const r=await f.run('uninstall','codex');assert.equal(r.ok,false);assert.ok(!JSON.stringify(r).includes('synthetic_receipt_fixture'));assert.deepEqual(await tree(f.home),before);
});

test('CLI selectors validate before writes and cannot register a development checkout',async t=>{
 const f=await fixture(t);const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));const env={...process.env,HOME:f.home,CODEX_HOME:path.join(f.home,'.codex'),CLAUDE_CONFIG_DIR:path.join(f.home,'.claude'),XDG_STATE_HOME:path.join(f.home,'.local/state')};
 for(const args of [['install','codex','--all'],['uninstall','--root',f.home],['status','--all'],['install','unknown'],['install','codex']])await assert.rejects(exec(process.execPath,[cli,...args],{env}));assert.equal(await fs.stat(path.join(f.home,'.codex')).catch(()=>null),null);
 await assert.rejects(machineIntegrations('install','codex',{...f.options,entryPoint:undefined}),/HOST_UNPACKAGED_RUNTIME/);
});


test('a corrupt native config still detects a host without a PATH executable',async t=>{
 const f=await fixture(t,[]);await fs.mkdir(path.join(f.home,'.codex'));await fs.writeFile(path.join(f.home,'.codex/config.toml'),'broken = [');
 const status=row(await f.run('status'),'codex');assert.equal(status.detected,true);assert.equal(status.state,'unsupported-configuration');assert.equal(status.mcpConfigured,null);assert.equal(status.launcherInstalled,null);
});

for(const key of ['HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','XDG_STATE_HOME'])test(key+' relative override cannot target the current repository',async t=>{
 const f=await fixture(t);const options={...f.options,env:{...f.options.env,[key]:'relative-settings'}};
 if(key==='HOME')delete options.home;
 const before=await tree(f.home);
 for(const action of ['status','install','uninstall'])await assert.rejects(machineIntegrations(action,undefined,options),/HOST_UNSUPPORTED_PATH/);
 assert.deepEqual(await tree(f.home),before);
});

test('Codex inactive global launcher is a conflict, never duplicated or deleted',async t=>{
 const f=await fixture(t,['codex']);const dir=path.join(f.home,'.codex');await fs.mkdir(dir);
 await fs.writeFile(path.join(dir,'AGENTS.md'),LAUNCHER+'\n');await fs.writeFile(path.join(dir,'AGENTS.override.md'),'Custom override.\n');
 const before=await tree(f.home);assert.equal(row(await f.run('install','codex'),'codex').state,'conflicted');assert.deepEqual(await tree(f.home),before);
});

test('owned Codex uninstall preserves a later launcher in the inactive global file',async t=>{
 const f=await fixture(t,['codex']);const dir=path.join(f.home,'.codex');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'AGENTS.override.md'),'Custom override.\n');
 await f.run('install','codex');await fs.writeFile(path.join(dir,'AGENTS.md'),LAUNCHER+'\n');assert.equal(row(await f.run('status'),'codex').state,'conflicted');
 assert.equal((await f.run('uninstall','codex')).ok,true);assert.equal(await fs.readFile(path.join(dir,'AGENTS.md'),'utf8'),LAUNCHER+'\n');assert.equal(await fs.readFile(path.join(dir,'AGENTS.override.md'),'utf8'),'Custom override.\n');
});

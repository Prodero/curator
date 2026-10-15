import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {digestTree,snapshotFiles,snapshotImportState} from '../dist/core/plugin-files.js';
import {INTEGRITY_LIMITS} from '../dist/core/integrity-files.js';
import {fixture as importerFixture} from './helpers/migrate-ai-studio.mjs';
const exec=promisify(execFile);
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'prodero-f08-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await exec('git',['init','-q',root]);return root;}
async function put(root,rel,content='ordinary source'){const target=path.join(root,rel);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,content);return target;}

test('F08: external digests and snapshots do not open sensitive, private or Git-ignored files',async t=>{
 const root=await fixture(t);
 await put(root,'.gitignore','ignored/\n*.db\n');await put(root,'nested/.gitignore','private.txt\n!public.txt\n');
 const excluded=['.npmrc','.git-credentials','.ssh/config','.aws/credentials','service-account.json','.env.local','ignored/data.txt','store.db','nested/private.txt','.prodero/local/memory/record.md'];
 for(const rel of excluded)await put(root,rel,'private fixture bytes');
 await exec('git',['-C',root,'add','-f','store.db']);
 await put(root,'nested/public.txt');await put(root,'src/main.ts');
 const open=fs.open,opened=[];fs.open=async(p,...args)=>{opened.push(String(p));return open(p,...args);};
 let before,files;
 try{before=await digestTree(root,'.');files=await snapshotFiles(root,'.');}finally{fs.open=open;}
 for(const rel of excluded){assert.ok(!opened.includes(path.join(root,rel)),rel);assert.equal(files[rel],undefined);}
 assert.ok(files['nested/public.txt']);assert.ok(files['src/main.ts']);
 for(const rel of excluded)await fs.appendFile(path.join(root,rel),' changed');
 assert.deepEqual(await digestTree(root,'.'),before);
 await fs.appendFile(path.join(root,'src/main.ts'),' changed');assert.notEqual((await digestTree(root,'.')).sha256,before.sha256);
 assert.equal((await digestTree(root,'.prodero/local')).files,0);
});

for(const api of [digestTree,snapshotFiles])test(`F08: ${api.name} rejects each resource limit and cancellation without partial results`,async t=>{
 const root=await fixture(t);await put(root,'a.txt','12345');await put(root,'b.txt','12345');
 await assert.rejects(api(root,'.',{limits:{files:1}}),/file-count/);
 await assert.rejects(api(root,'.',{limits:{bytes:9}}),/total-byte/);
 await assert.rejects(api(root,'.',{limits:{entries:1}}),/entry-count/);
 await put(root,'one/two/three.txt');await assert.rejects(api(root,'.',{limits:{depth:2}}),/traversal-depth/);
 const controller=new AbortController();controller.abort();await assert.rejects(api(root,'.',{signal:controller.signal}),/INTEGRITY_CANCELLED/);
 await assert.rejects(api(root,'.',{limits:{timeoutMs:1}}),/INTEGRITY_CANCELLED|INTEGRITY_GIT|AbortError/);
 await assert.rejects(api(root,'.',{limits:{bytes:INTEGRITY_LIMITS.bytes+1}}),/may only be lowered/);
});

test('F08: default byte/depth ceilings fail before opening an oversized file; streaming detects changes',async t=>{
 const root=await fixture(t),big=await put(root,'large.bin','');await fs.truncate(big,INTEGRITY_LIMITS.bytes+1);
 const open=fs.open;let opened=false;fs.open=async(p,...args)=>{if(String(p)===big)opened=true;return open(p,...args);};
 try{await assert.rejects(digestTree(root,'.'),/total-byte/);assert.equal(opened,false);}finally{fs.open=open;}
 await fs.rm(big);await put(root,Array(33).fill('d').join('/')+'/file');await assert.rejects(digestTree(root,'.'),/traversal-depth/);await fs.rm(path.join(root,'d'),{recursive:true});
 const file=await put(root,'value.bin','x'.repeat(200000));let injected=false;
 fs.open=async(p,...args)=>{const h=await open(p,...args);if(String(p)===file){const stream=h.createReadStream.bind(h);h.createReadStream=async function*(opts){for await(const chunk of stream(opts)){if(!injected){injected=true;await fs.appendFile(file,'changed');}yield chunk;}};}return h;};
 try{await assert.rejects(digestTree(root,'.'),/changed while/);}finally{fs.open=open;}
});

test('F08: included symlinks and special entries are rejected; ordinary digests are deterministic',async t=>{
 const root=await fixture(t);await put(root,'z.txt');await put(root,'a/note.md');
 const first=await digestTree(root,'.');assert.equal(first.algorithm,'sha256-tree-v2');assert.deepEqual(await digestTree(root,'.'),first);
 await fs.symlink(path.join(root,'z.txt'),path.join(root,'link'));await assert.rejects(digestTree(root,'.'),/Symlink/);await assert.rejects(snapshotFiles(root,'.'),/Symlink/);await fs.rm(path.join(root,'link'));
 if(process.platform!=='win32'){await exec('mkfifo',[path.join(root,'pipe')]);await assert.rejects(digestTree(root,'.'),/Special/);await assert.rejects(snapshotFiles(root,'.'),/Special/);}
});

test('F08: canonical snapshot deliberately includes private canonical state but excludes runtime/backup trees',async t=>{
 const f=await importerFixture(t);await exec('git',['init','-q',f.root]);
 for(const rel of ['local/memory/mem_fixture.md','sessions/sess_fixture.md','checkpoints/chk_fixture.json','local/curation-reviews/private.json','.backups/private.json','.migrations/private.json','local/memory/mem_fixture.md.tmp-123-abc','sessions/session.md.tmp-123-abc'])await put(f.root,'.prodero/'+rel);
 const hashes=await snapshotImportState(f.root);
 for(const rel of ['local/memory/mem_fixture.md','sessions/sess_fixture.md','checkpoints/chk_fixture.json'])assert.ok(hashes['.prodero/'+rel]);
 for(const rel of ['local/curation-reviews/private.json','.backups/private.json','.migrations/private.json','local/memory/mem_fixture.md.tmp-123-abc','sessions/session.md.tmp-123-abc'])assert.equal(hashes['.prodero/'+rel],undefined);
});

test('F08: real MCP estimate/audit/verify fail safely on bounds; ignored selected evidence retains exact verification',async t=>{
 const f=await importerFixture(t);await exec('git',['init','-q',f.root]);await fs.appendFile(path.join(f.root,'.gitignore'),'\n.ai-studio/\n');
 const server=createServer({projectRoot:f.root}),client=new Client({name:'f08-integrity',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const call=(action,input={})=>client.callTool({name:'prodero_plugin_migrate_ai_studio',arguments:{projectRoot:f.root,action,input}});
 const audit=await call('audit');assert.notEqual(audit.isError,true,JSON.stringify(audit));const plan=audit.structuredContent.result.plan;
 const reviewed=(await call('review',{plan,decisions:plan.items.map(i=>({id:i.id,include:i.include,activateSkill:false}))})).structuredContent.result.plan;
 const applied=(await call('apply',{plan:reviewed,approvedPlanId:reviewed.planId})).structuredContent.result;
 assert.equal((await call('verify',{plan:reviewed,receipt:applied.receipt})).structuredContent.result.valid,true);
 const evidence=reviewed.items.find(i=>i.include).source[0].path;await fs.appendFile(path.join(f.root,evidence),'\nchanged');
 assert.equal((await call('verify',{plan:reviewed,receipt:applied.receipt})).structuredContent.result.valid,false);
 const before=await snapshotImportState(f.root),big=await put(f.root,'large.bin','');await fs.truncate(big,INTEGRITY_LIMITS.bytes+1);
 for(const action of ['estimate','audit','verify']){
  const result=await call(action,action==='verify'?{plan:reviewed,receipt:applied.receipt}:{});
  assert.equal(result.isError,true,action);assert.match(JSON.stringify(result),/total-byte/);assert.equal(result.structuredContent?.result?.valid,undefined);
 }
 assert.deepEqual(await snapshotImportState(f.root),before);
});

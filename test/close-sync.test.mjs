import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeProject, prepareProject, recordProjectSession, closeProjectSession, syncProject } from '../dist/core/project.js';
import { listKnowledge, writeKnowledge } from '../dist/core/memory.js';
import { readSession } from '../dist/core/sessions.js';
import { discoverSessions } from '../dist/core/session-index.js';
import { listCheckpoints } from '../dist/core/storage.js';

const entry = (content = 'Cache snapshots remain local.', extra = {}) => ({type:'decision',title:'Cache snapshots',content,scopeHint:'global',...extra});
async function fixture(t) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-close-sync-'));
 t.after(() => fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.git')); await initializeProject(root);
 return root;
}
const pending = async root => (await discoverSessions(root)).sessions.filter(s=>s.pending);

test('default close synchronizes only its own session; repeated final batch and next prepare are idempotent after cache loss', async t=>{
 const root=await fixture(t), first=await prepareProject(root), other=await prepareProject(root);
 await recordProjectSession(root,other.session.id,[entry('Other observations stay pending.')]);
 const result=await closeProjectSession(root,first.session.id,[entry()]);
 assert.equal(result.learned.syncState,'synchronized'); assert.equal(result.synchronization.observationsProcessed,1);
 assert.equal((await listKnowledge(root)).length,1); assert.equal((await pending(root))[0].id,other.session.id);
 await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true,force:true});
 const retry=await closeProjectSession(root,first.session.id,[entry()]);
 assert.equal(retry.alreadyClosed,true);assert.equal(retry.synchronization.sessionsProcessed,0);
 await assert.rejects(closeProjectSession(root,first.session.id,[entry('Different final batch.')]),/closed/);
 const next=await prepareProject(root,{sessionId:other.session.id});assert.equal(next.automaticSync.sessionsProcessed,0);
 assert.equal((await listKnowledge(root)).length,1);assert.equal((await listCheckpoints(root)).length,1);
 assert.deepEqual((await fs.readdir(path.join(root,'.prodero/memory'))).filter(n=>n.endsWith('.md')),[]);
});

test('prepare recovers unclosed snapshots and only processes newly appended observations on close',async t=>{
 const root=await fixture(t), first=await prepareProject(root);
 await recordProjectSession(root,first.session.id,[entry()]);
 const next=await prepareProject(root);assert.equal(next.automaticSync.observationsProcessed,1);
 assert.equal((await readSession(root,first.session.id)).status,'active');
 const closed=await closeProjectSession(root,first.session.id,[entry('Recovery checkpoints preserve evidence.',{title:'Recovery'})]);
 assert.equal(closed.synchronization.observationsProcessed,1);assert.equal((await listKnowledge(root)).length,2);
 assert.equal((await prepareProject(root)).automaticSync.observationsProcessed,0);
});

test('prepare recovers legacy deferred close',async t=>{
 const root=await fixture(t), p=await prepareProject(root);
 await closeProjectSession(root,p.session.id,[entry()],false);
 assert.equal((await listKnowledge(root)).length,0);
 assert.equal((await prepareProject(root,{sessionId:p.session.id})).automaticSync.observationsProcessed,1);
 assert.equal((await prepareProject(root)).automaticSync.sessionsProcessed,0);
});

for(const recover of ['close','prepare']) test(`partial Sync write failure preserves journal and observations for ${recover} recovery`,async t=>{
 const root=await fixture(t), p=await prepareProject(root);
 const rename=fs.rename;
 const stub=t.mock.method(fs,'rename',async (from,to)=>{
   if(String(to).includes('/checkpoints/chk_')) throw new Error('Injected checkpoint write failure');
   return rename(from,to);
 });
 await assert.rejects(closeProjectSession(root,p.session.id,[entry()]),/Injected checkpoint/);
 stub.mock.restore();
 assert.equal((await readSession(root,p.session.id)).sections.Decisions.length,1);
 assert.equal((await pending(root)).length,1);assert.equal((await listCheckpoints(root)).length,0);
 assert.ok(await fs.readFile(path.join(root,'.prodero/.transactions/pending.json'),'utf8'));
 if(recover==='close') await closeProjectSession(root,p.session.id,[entry()]); else await prepareProject(root);
 assert.equal((await listKnowledge(root)).length,1);assert.equal((await listCheckpoints(root)).length,1);
 assert.equal((await pending(root)).length,0);
 assert.equal((await syncProject(root)).observationsProcessed,0);
});

test('failed validation leaves final observations pending and a corrected external target allows recovery',async t=>{
 const root=await fixture(t), p=await prepareProject(root);
 await assert.rejects(closeProjectSession(root,p.session.id,[entry('Cache now uses snapshots.',{supersedes:['mem_old']})]),/supersedes target/);
 assert.equal((await pending(root)).length,1);assert.equal((await listKnowledge(root)).length,0);
 await writeKnowledge(root,{id:'mem_old',scope:'global',scopeRef:null,category:'decision',priority:'normal',status:'active',title:'Old cache',content:'Cache uses shared state.',createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[]},false,'versioned');
 const before=await fs.readFile(path.join(root,'.prodero/memory/mem_old.md'),'utf8');
 const recovery=await prepareProject(root);assert.equal(recovery.automaticSync.observationsProcessed,1);
 const current=(await listKnowledge(root)).find(m=>m.id!=='mem_old');assert.deepEqual(current.supersedes,['mem_old']);
 assert.equal(await fs.readFile(path.join(root,'.prodero/memory/mem_old.md'),'utf8'),before);
 assert.deepEqual((await fs.readdir(path.join(root,'.prodero/memory'))).filter(n=>n.endsWith('.md')),['mem_old.md']);
});

test('recovery followed by close does not reapply explicit supersedes to a historical target',async t=>{
 const root=await fixture(t), p=await prepareProject(root);
 await closeProjectSession(root,p.session.id,[entry()]);
 const old=(await listKnowledge(root))[0]; const next=await prepareProject(root);
 await recordProjectSession(root,next.session.id,[entry('Cache snapshots now expire.',{supersedes:[old.id]})]);
 await prepareProject(root);
 const closed=await closeProjectSession(root,next.session.id);
 assert.equal(closed.synchronization.observationsProcessed,0);
 assert.equal((await listKnowledge(root)).length,2);
});

test('close and recovery remain deterministic even with assisted config and a supplied provider',async t=>{
 const root=await fixture(t), p=await prepareProject(root);
 const file=path.join(root,'.prodero/config.json'), config=JSON.parse(await fs.readFile(file));
 config.knowledgeEngine={mode:'assisted'};await fs.writeFile(file,JSON.stringify(config));
 const provider=new Proxy({}, {get(){throw new Error('Provider must not be accessed');}});
 const result=await closeProjectSession(root,p.session.id,[entry()],true,provider);
 assert.equal(result.synchronization.consolidation,'deterministic-v1');assert.equal(result.synchronization.intelligence.provider,null);
 const next=await prepareProject(root);await recordProjectSession(root,next.session.id,[entry()]);
 const recovery=await prepareProject(root);assert.equal(recovery.automaticSync.duplicates,1);
 assert.equal((await listKnowledge(root)).length,1);
});

for(const [name, content, expected] of [
 ['exact duplicate','Cache snapshots remain local.',{duplicates:1,consolidated:0,created:0}],
 ['safe sentence extension','Cache snapshots remain local. Cache snapshots preserve provenance.',{duplicates:0,consolidated:1,created:0}],
 ['changed claim','Cache snapshots are shared.',{duplicates:0,consolidated:0,created:1}],
]) test(`close preserves manual deterministic reconciliation: ${name}`,async t=>{
 const results=[];
 for(const immediate of [true,false]) {
  const root=await fixture(t), seed=await prepareProject(root);
  await closeProjectSession(root,seed.session.id,[entry()]);
  const p=await prepareProject(root);
  const closed=await closeProjectSession(root,p.session.id,[entry(content)],immediate);
  const sync=closed.synchronization??await syncProject(root);
  const summary=Object.fromEntries(Object.keys(expected).map(key=>[key,sync[key]]));
  assert.deepEqual(summary,expected);
  results.push((await listKnowledge(root)).map(({content,status,scope,category})=>({content,status,scope,category})).sort((a,b)=>a.content.localeCompare(b.content)));
 }
 assert.deepEqual(results[0],results[1]);
});

test('failure rebuilding cache after checkpoint commit is safe to retry',async t=>{
 const root=await fixture(t), p=await prepareProject(root);
 let committed=false;const rename=fs.rename;
 const stub=t.mock.method(fs,'rename',async(from,to)=>{
  if(committed&&String(to).endsWith('/session-index.json')) throw new Error('Injected cache failure');
  await rename(from,to);if(String(to).includes('/checkpoints/chk_'))committed=true;
 });
 await assert.rejects(closeProjectSession(root,p.session.id,[entry()]),/Injected cache/);stub.mock.restore();
 assert.equal((await listCheckpoints(root)).length,1);
 const result=await closeProjectSession(root,p.session.id,[entry()]);
 assert.equal(result.synchronization.observationsProcessed,0);assert.equal((await listKnowledge(root)).length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, PRODERO_TOOLS as T } from '../dist/server.js';
import { readSession } from '../dist/core/sessions.js';
import { sessionCandidates } from '../dist/core/consolidation.js';
import { writeKnowledge, listKnowledge } from '../dist/core/memory.js';
import { searchMemory } from '../dist/core/memory-operations.js';
import { getContext } from '../dist/core/context.js';
import { listCheckpoints } from '../dist/core/storage.js';

const original={id:'mem_original',scope:'global',scopeRef:null,category:'state',priority:'normal',status:'active',title:'Steering',content:'Steering supports sustained slides.',createdAt:'2020-01-01T00:00:00Z',updatedAt:'2099-01-01T00:00:00Z',sourceSessions:[],derivedFrom:[],related:[],supersedes:[]};
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-supersedes-'));await fs.mkdir(path.join(root,'.git'));
 const server=createServer({projectRoot:root}),client=new Client({name:'offline-supersedes',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true,maxRetries:3});});
 const call=(name,args={})=>client.callTool({name,arguments:{projectRoot:root,...args}});
 await call(T.initialize);return {root,call};
}
const entry=(extra={})=>({type:'state_change',title:'Current steering',content:'Steering applies spinout drag.',scopeHint:'global',supersedes:['mem_original'],...extra});

for(const layer of ['local','versioned'])for(const route of ['record','close'])test(`offline ${route} → close → automatic Sync preserves explicit ${layer} supersession and history`,async t=>{
 const {root,call}=await fixture(t);await writeKnowledge(root,original,false,layer);
 const oldPath=path.join(root,'.prodero',layer==='local'?'local/memory':'memory','mem_original.md');
 const oldBytes=await fs.readFile(oldPath,'utf8');
 const start=(await call(T.prepare)).structuredContent.result.session.id;
 if(route==='record')assert.ok(!(await call(T.sessionRecord,{sessionId:start,entries:[entry()]})).isError);
 const closed=await call(T.sessionClose,{sessionId:start,...(route==='close'?{finalEntries:[entry()]}:{})});assert.ok(!closed.isError);
 assert.equal(closed.structuredContent.result.learned.syncState,'synchronized');
 assert.ok((await listKnowledge(root)).some(m=>m.supersedes.includes('mem_original')), 'supersession is applied before close returns');
 const raw=await readSession(root,start);assert.equal(raw.status,'closed');
 assert.deepEqual(sessionCandidates(raw)[0].supersedes,['mem_original']);
 const next=(await call(T.prepare,{task:'steering'})).structuredContent.result;
 assert.equal(next.automaticSync.consolidation,'deterministic-v1');assert.equal(next.automaticSync.intelligence.provider,null);
 let all=await listKnowledge(root);const current=all.find(m=>m.id!=='mem_original');
 assert.deepEqual(current.supersedes,['mem_original']);assert.ok(current.sourceSessions.includes(start));
 assert.ok(current.derivedFrom.some(id=>id===sessionCandidates(raw)[0].derivedFrom));
 assert.equal(all.find(m=>m.id==='mem_original').status,layer==='local'?'superseded':'active');
 assert.equal(all.find(m=>m.id==='mem_original').content,original.content);
 if(layer==='versioned')assert.equal(await fs.readFile(oldPath,'utf8'),oldBytes);
 assert.deepEqual(next.context.relevant.map(m=>m.id),[current.id]);
 assert.deepEqual((await searchMemory(root,'steering')).map(m=>m.id),[current.id]);
 assert.ok((await searchMemory(root,'steering',{includeHistorical:true})).some(m=>m.id==='mem_original'));
 // A second explicit replacement inherits the original edge; old shared state cannot reappear.
 const second=next.session.id;
 await call(T.sessionClose,{sessionId:second,finalEntries:[entry({content:'Steering limits angular velocity.',supersedes:[current.id]})]});
 const latest=(await call(T.prepare,{task:'steering'})).structuredContent.result;
 const successor=latest.context.relevant[0];assert.notEqual(successor.id,current.id);
 assert.deepEqual(new Set(successor.supersedes),new Set([current.id,'mem_original']));
 await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true,force:true});
 assert.deepEqual((await getContext(root,'steering')).relevant.map(m=>m.id),[successor.id]);
 assert.equal((await searchMemory(root,'steering',{includeHistorical:true})).length,3);
});

for(const route of ['record','close'])test(`${route} rejects malformed supersedes without partially changing the session`,async t=>{
 const {root,call}=await fixture(t);const start=(await call(T.prepare)).structuredContent.result.session.id;
 const before=await readSession(root,start);
 const response=await call(route==='record'?T.sessionRecord:T.sessionClose,{sessionId:start,[route==='record'?'entries':'finalEntries']:[entry({supersedes:['../escape']})]});
 assert.ok(response.isError);assert.deepEqual(await readSession(root,start),before);
});

for(const status of ['missing','superseded'])test(`Sync rejects a ${status} explicit target instead of dropping supersedes`,async t=>{
 const {root,call}=await fixture(t);
 if(status!=='missing')await writeKnowledge(root,{...original,status},false,'local');
 const start=(await call(T.prepare)).structuredContent.result.session.id;
 const before=await listKnowledge(root);const checkpoints=(await listCheckpoints(root)).length;
 const response=await call(T.sessionClose,{sessionId:start,finalEntries:[entry({supersedes:[],content:'Steering diagnostics record angular velocity.'}),entry()],sync:true});
 assert.ok(response.isError);assert.match(JSON.stringify(response),/supersedes target is missing or no longer current/);
 assert.deepEqual(await listKnowledge(root),before);assert.equal((await listCheckpoints(root)).length,checkpoints);
 assert.equal((await readSession(root,start)).status,'closed');
 assert.deepEqual(sessionCandidates(await readSession(root,start)).at(-1).supersedes,['mem_original']);
});

test('remember replaceId reuses the same offline replacement pipeline',async t=>{
 const {root,call}=await fixture(t);
 const saved=(await call(T.remember,{title:'Steering',content:original.content,scope:'project',kind:'fact'})).structuredContent.result.item;
 const result=await call(T.remember,{content:'Steering applies spinout drag.',replaceId:saved.id});assert.ok(!result.isError);
 const current=result.structuredContent.result.item;
 assert.deepEqual(current.supersedes,[saved.id]);
 assert.deepEqual((await getContext(root,'steering')).relevant.map(m=>m.id),[current.id]);
 assert.equal((await listKnowledge(root)).find(m=>m.id===saved.id).status,'superseded');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {MemoryCatalog} from '../dist/core/memory-index.js';
import {listKnowledge} from '../dist/core/memory.js';
import {readSession} from '../dist/core/sessions.js';
import {listCheckpoints,sha256} from '../dist/core/storage.js';

const entries=[
 {type:'decision',title:'Harbor chat boundary',content:'Harbor uses native Markdown in chat and retains its terminal fallback.',scopeHint:'global'},
 {type:'state_change',title:'Harbor check result',content:'Harbor rendering was verified with disposable fixtures.',scopeHint:'global'},
];
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-close-diagnostics-'));
 const server=createServer({projectRoot:root}),client=new Client({name:'close-diagnostics-fixture',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
 const call=async(name,args={})=>{const response=await client.callTool({name,arguments:args});assert.notEqual(response.isError,true,JSON.stringify(response));return response;};
 await call('prodero_instructions_read');await call('prodero_initialize',{projectRoot:root});
 const text=(tool,args={})=>call('prodero_text',{tool,arguments:{projectRoot:root,...args}});
 const prepared=await text('prodero_prepare',{task:'Inspect Harbor rendering',taskContext:{paths:['src/rendering']}}),sessionId=prepared.structuredContent.result.session.id;
 await call('prodero_session_record',{projectRoot:root,sessionId,entries});
 return {root,sessionId,text,call};
}
async function snapshot(root){return Promise.all((await listKnowledge(root)).map(async item=>({id:item.id,content:item.content,hash:sha256(await fs.readFile(path.join(root,'.prodero/local/memory',item.id+'.md'),'utf8'))})));}
async function refreshedInspection(f){
 const before=await snapshot(f.root),checkpoints=(await listCheckpoints(f.root)).length;
 const prepared=await f.text('prodero_prepare',{task:'Recall Harbor rendering results',taskContext:{paths:['src/rendering']}});
 assert.equal(prepared.structuredContent.presentation.operational.blocking,false);
 assert.doesNotMatch(prepared.content[0].text,/Knowledge changed after context selection|Session diagnostics unavailable/);
 const inspection=await f.text('prodero_session_review',{sessionId:f.sessionId});
 assert.equal(inspection.structuredContent.result.consolidated,true);
 assert.equal(inspection.structuredContent.result.items.length,2);
 assert.equal(inspection.structuredContent.result.error,undefined);
 assert.deepEqual(await snapshot(f.root),before);
 assert.equal((await listCheckpoints(f.root)).length,checkpoints,'refresh must not duplicate the synchronized batch');
 await f.text('prodero_session_close',{sessionId:prepared.structuredContent.result.session.id});
}

test('ordinary native Close saves both records and fresh Prepare has no stale diagnostic',async t=>{
 const f=await fixture(t),response=await f.text('prodero_session_close',{sessionId:f.sessionId}),closed=response.structuredContent.result;
 assert.equal(closed.learned.syncState,'synchronized');assert.equal(closed.review.error,undefined);assert.equal((await snapshot(f.root)).length,2);
 assert.match(response.content[0].text,/Saved/);assert.doesNotMatch(response.content[0].text,/diagnostics unavailable|retry/);
 await refreshedInspection(f);
});

for(const mutation of ['metadata','content'])test(`${mutation} change inside Close inspection keeps Saved and the stale-read warning; Prepare safely refreshes`,async t=>{
 const f=await fixture(t),load=MemoryCatalog.prototype.load;
 let injected=false,beforeHash,afterHash,changedId;
 MemoryCatalog.prototype.load=async function(id){
  if(!injected&&new Error().stack.includes('/session-review.js')){
   injected=true;changedId=id;
   const target=path.join(f.root,'.prodero/local/memory',id+'.md'),before=await fs.readFile(target,'utf8');beforeHash=sha256(before);
   // Deliberately emulate an external filesystem editor after selection. All
   // paths belong to this disposable fixture, never the owner's memory store.
   if(mutation==='metadata'){const stat=await fs.stat(target);await fs.utimes(target,stat.atime,new Date(stat.mtimeMs+2000));}
   else await fs.appendFile(target,'\nConcurrent fixture editor retained this extra evidence.\n');
   afterHash=sha256(await fs.readFile(target,'utf8'));
  }
  return load.call(this,id);
 };
 let response;
 try{response=await f.text('prodero_session_close',{sessionId:f.sessionId});}
 finally{MemoryCatalog.prototype.load=load;}
 assert.equal(injected,true);
 const closed=response.structuredContent.result;
 assert.equal(closed.learned.syncState,'synchronized');assert.ok(closed.synchronization.checkpoint);
 assert.match(closed.review.error,/Knowledge changed after context selection; retry/);
 assert.match(response.content[0].text,/Saved/);assert.match(response.content[0].text,/Session diagnostics unavailable.*Knowledge changed after context selection/);
 const saved=await snapshot(f.root);assert.equal(saved.length,2);for(const entry of entries)assert.ok(saved.some(item=>item.content.includes(entry.content)));
 assert.equal((await readSession(f.root,f.sessionId)).status,'closed');
 assert.equal(mutation==='metadata',beforeHash===afterHash);
 if(mutation==='content')assert.ok(saved.find(item=>item.id===changedId).content.includes('Concurrent fixture editor retained this extra evidence.'));
 await refreshedInspection(f);
});

test('a real inspection read failure stays visible after successful saving and cannot become a false save failure',async t=>{
 const f=await fixture(t),load=MemoryCatalog.prototype.load;
 let injected=false;
 MemoryCatalog.prototype.load=async function(id){
  if(new Error().stack.includes('/session-review.js')){injected=true;throw Object.assign(new Error('Fixture canonical read denied.'),{code:'EACCES'});}
  return load.call(this,id);
 };
 let response;
 try{response=await f.text('prodero_session_close',{sessionId:f.sessionId});}
 finally{MemoryCatalog.prototype.load=load;}
 assert.equal(injected,true);assert.equal(response.structuredContent.result.learned.syncState,'synchronized');
 assert.match(response.content[0].text,/Saved/);assert.match(response.content[0].text,/Session diagnostics unavailable: Fixture canonical read denied/);
 assert.equal((await snapshot(f.root)).length,2);
 await refreshedInspection(f);
});

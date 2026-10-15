import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, PRODERO_TOOLS as T } from '../dist/server.js';
import { writeKnowledge, listKnowledge } from '../dist/core/memory.js';
import { readSession } from '../dist/core/sessions.js';
import { reviewSessionKnowledge, mutateSessionKnowledge } from '../dist/core/session-review.js';
import { knowledgeUi } from './helpers/knowledge-ui.mjs';
async function fixture(t,entries=[{type:'discovery',title:'Portal sending',content:'Portal sending is disabled.',scopeHint:'global'}]) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-session-review-'));await fs.mkdir(path.join(root,'.git'));
 const server=createServer({projectRoot:root}),client=new Client({name:'session-review-test',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
 const call=(name,args={})=>client.callTool({name,arguments:{projectRoot:root,...args}});
 await call(T.initialize);const p=(await call(T.prepare)).structuredContent.result;
 await call(T.sessionRecord,{sessionId:p.session.id,entries});
 const close=await call(T.sessionClose,{sync:false,sessionId:p.session.id});assert.ok(!close.isError);
 return {root,call,close,sessionId:p.session.id};
}
test('explicit deferred close stays compact, review exposes exact pending observations',async t=>{
 const f=await fixture(t);const r=f.close.structuredContent.result;
 assert.equal(r.learned.observations,1);assert.equal(r.review.total,1);assert.equal(r.learned.syncState,'pending-auto-sync');
 const view=await reviewSessionKnowledge(f.root,f.sessionId);assert.equal(view.editable,true);assert.equal(view.items[0].content,'Portal sending is disabled.');
 const ui=await knowledgeUi(req=>f.call(req.name,req.arguments));ui.render(f.close);
 assert.match(ui.html,/Review knowledge/);assert.doesNotMatch(ui.html,/Portal sending is disabled/);
 const next=await f.call(T.prepare,{task:'portal'});assert.equal(next.structuredContent.result.automaticSync.sessions,1);
 assert.equal((await listKnowledge(f.root)).length,1);
});
test('production review form edits persist through later automatic consolidation',async t=>{
 const f=await fixture(t);const ui=await knowledgeUi(req=>f.call(req.name,req.arguments));ui.render(f.close);
 await ui.session('open');assert.match(ui.html,/No action means keep/);
 const view=await reviewSessionKnowledge(f.root,f.sessionId);await ui.session('edit',view.items[0].id);
 await ui.submit('session-edit-form',{title:'Portal sending',content:'Portal compose and sending are implemented.',type:'state_change',scope:'module',scopeRef:'src/portal',scopeKind:'path'});
 assert.match(ui.html,/Saved/);
 const corrected=await reviewSessionKnowledge(f.root,f.sessionId);
 assert.equal(corrected.items[0].type,'state_change');assert.equal(corrected.items[0].scopeKind,'path');assert.equal(corrected.items[0].scopeRef,'src/portal');
 await ui.session('back');assert.match(ui.html,/Project change/);
 await f.call(T.prepare,{task:'src/portal'});const memories=await listKnowledge(f.root);
 assert.equal(memories.length,1);assert.equal(memories[0].content,'Portal compose and sending are implemented.');assert.equal(memories[0].scopeRef,'src/portal');
});
test('discard and discard-all prevent consolidation without removing the session',async t=>{
 const f=await fixture(t,[{type:'lesson',content:'First lesson.'},{type:'decision',content:'Second decision.'}]);
 let view=await reviewSessionKnowledge(f.root,f.sessionId);
 view=await mutateSessionKnowledge(f.root,{sessionId:f.sessionId,revision:view.revision,action:'discard',id:view.items[0].id});assert.equal(view.items.length,1);
 view=await mutateSessionKnowledge(f.root,{sessionId:f.sessionId,revision:view.revision,action:'discard-all'});assert.equal(view.items.length,0);
 assert.equal((await readSession(f.root,f.sessionId)).status,'closed');
 await fs.rm(path.join(f.root,'.prodero/.cache'),{recursive:true,force:true});
 await f.call(T.prepare);assert.equal((await listKnowledge(f.root)).length,0);
});
test('invalid, stale and synchronized edits are rejected with original evidence intact',async t=>{
 const f=await fixture(t);let view=await reviewSessionKnowledge(f.root,f.sessionId);const item=view.items[0];
 const args={sessionId:f.sessionId,revision:view.revision,id:item.id,action:'edit',content:'Corrected portal knowledge.'};
 const file=path.join(f.root,'.prodero/sessions',f.sessionId+'.md');const before=await fs.readFile(file,'utf8');
 for(const patch of [{content:''},{type:'invalid'},{scope:'invalid'},{scope:'module',scopeRef:'../escape',scopeKind:'path'},{scope:'module',scopeRef:''},{content:'Не сохранять это.'}])await assert.rejects(mutateSessionKnowledge(f.root,{...args,...patch}));
 assert.equal(await fs.readFile(file,'utf8'),before);
 await mutateSessionKnowledge(f.root,args);await assert.rejects(mutateSessionKnowledge(f.root,args),/changed/);
 view=await reviewSessionKnowledge(f.root,f.sessionId);await f.call(T.prepare);
 await assert.rejects(mutateSessionKnowledge(f.root,{...args,revision:view.revision}),/synchronized/);
 const synced=await reviewSessionKnowledge(f.root,f.sessionId);assert.equal(synced.editable,false);assert.equal(synced.items[0].outputs.length,1);
});
test('shared reconciliation signals keep evolution informational and prioritize instruction review',async t=>{
 const f=await fixture(t,[{type:'lesson',content:'Independent lesson.'},{type:'discovery',title:'Portal sending',content:'Portal sending is disabled.',scopeHint:'global'},{type:'state_change',title:'New portal state',content:'Portal sending is implemented. Replaces mem_existing.',scopeHint:'global',supersedes:['mem_existing']},{type:'global_instruction_candidate',content:'Always validate message recipients.'}]);
 await writeKnowledge(f.root,{id:'mem_existing',scope:'global',scopeRef:null,category:'state',priority:'normal',status:'active',title:'Portal sending',content:'Portal sending is implemented.',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',sourceSessions:[],derivedFrom:[],related:[],supersedes:[]});
 const v=await reviewSessionKnowledge(f.root,f.sessionId);const kinds=v.items.flatMap(i=>i.signals.map(s=>s.kind));
 assert.ok(kinds.includes('unresolved'));assert.ok(kinds.includes('state_transition'));assert.ok(kinds.includes('instruction-candidate'));
 assert.equal(v.items[0].type,'global_instruction_candidate');
 assert.equal(v.summary.needsReview,1);
});
test('failed UI saves retain drafts and report server validation errors',async t=>{
 const f=await fixture(t);const ui=await knowledgeUi(req=>f.call(req.name,req.arguments));ui.render(f.close);await ui.session('open');
 const view=await reviewSessionKnowledge(f.root,f.sessionId);await ui.session('edit',view.items[0].id);
 await ui.submit('session-edit-form',{content:'Draft still here.',scope:'module',scopeRef:'../escape',scopeKind:'path'});
 assert.match(ui.html,/Draft still here/);assert.match(ui.html,/Invalid repository path scope/);
});

test('duplicate signals and candidate type changes reuse normal consolidation lifecycle',async t=>{
 const f=await fixture(t,[{type:'lesson',title:'Recipient validation',content:'Validate message recipients.'}]);
 let view=await reviewSessionKnowledge(f.root,f.sessionId);
 view=await mutateSessionKnowledge(f.root,{sessionId:f.sessionId,revision:view.revision,action:'edit',id:view.items[0].id,content:'Validate all message recipients.'});
 assert.equal(view.items[0].scope,'task');
 view=await mutateSessionKnowledge(f.root,{sessionId:f.sessionId,revision:view.revision,action:'edit',id:view.items[0].id,content:'Validate all message recipients.',type:'global_instruction_candidate'});
 assert.equal(view.items[0].scope,'global');assert.ok(view.items[0].signals.some(s=>s.kind==='instruction-candidate'));
 await f.call(T.prepare);assert.equal((await listKnowledge(f.root)).length,0,'instruction proposals must not become active rules');
 const other=await fixture(t);
 await writeKnowledge(other.root,{id:'mem_duplicate',scope:'global',scopeRef:null,category:'state',priority:'normal',status:'active',title:'Portal sending',content:'Portal sending is disabled.',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',sourceSessions:[],derivedFrom:[],related:[],supersedes:[]});
 assert.ok((await reviewSessionKnowledge(other.root,other.sessionId)).items[0].signals.some(s=>s.kind==='duplicate'));
});
test('Sync while a review is open protects history, including discard-all',async t=>{
 const f=await fixture(t);const view=await reviewSessionKnowledge(f.root,f.sessionId);
 await f.call(T.sync);
 const file=path.join(f.root,'.prodero/sessions',f.sessionId+'.md');const before=await fs.readFile(file,'utf8');
 await fs.rm(path.join(f.root,'.prodero/.cache'),{recursive:true,force:true});
 await assert.rejects(mutateSessionKnowledge(f.root,{sessionId:f.sessionId,revision:view.revision,action:'discard-all'}),/synchronized/);
 assert.equal(await fs.readFile(file,'utf8'),before);assert.equal((await listKnowledge(f.root)).length,1);
 const closed=(await f.call(T.sessionClose,{sync:false,sessionId:f.sessionId})).structuredContent.result;
 assert.equal(closed.alreadyClosed,true);assert.equal(closed.learned.syncState,'synchronized');
});
test('discard-all UI requires only its own action, preserves the session and updates the compact card',async t=>{
 const f=await fixture(t);const ui=await knowledgeUi(req=>f.call(req.name,req.arguments));ui.render(f.close);await ui.session('open');
 await ui.session('discard-all');assert.match(ui.html,/The session remains stored/);assert.equal((await reviewSessionKnowledge(f.root,f.sessionId)).items.length,1);
 await ui.session('confirm-discard-all');assert.match(ui.html,/No observations remain/);await ui.session('back');
 assert.match(ui.html,/No durable project updates recorded/);assert.equal((await readSession(f.root,f.sessionId)).status,'closed');
});

test('different titles and polarity alone remain neutral pending semantic reconciliation',async t=>{
 const f=await fixture(t,[{type:'discovery',title:'Email sending',content:'Email sending is disabled.',scopeHint:'global'}]);
 await writeKnowledge(f.root,{id:'mem_current',scope:'global',scopeRef:null,category:'state',priority:'normal',status:'active',title:'Portal messaging',content:'Compose and sending are implemented.',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',sourceSessions:[],derivedFrom:[],related:[],supersedes:[]});
 const view=await reviewSessionKnowledge(f.root,f.sessionId);
 assert.ok(view.items[0].signals.some(s=>s.kind==='unresolved'&&s.memory.id==='mem_current'));
 assert.equal((await listKnowledge(f.root))[0].status,'active','review signals do not decide semantic replacement');
});

test('unavailable optional review does not turn a successfully closed session into a failed close',async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.root,'.prodero/memory/mem_broken.md'),'---\nid: mem_broken\n---\nBroken metadata');
 const response=await f.call(T.sessionClose,{sync:false,sessionId:f.sessionId});assert.ok(!response.isError);
 assert.ok(response.structuredContent.result.review.error);assert.equal((await readSession(f.root,f.sessionId)).status,'closed');
 const ui=await knowledgeUi(req=>f.call(req.name,req.arguments));ui.render(response);assert.match(ui.html,/Knowledge review is unavailable/);
});

test('remember artifacts belong to the active session without copying observations or durable records',async t=>{
 const f=await fixture(t,[]);
 const started=(await f.call(T.prepare)).structuredContent.result.session.id;
 const ids=[];
 for(let i=0;i<12;i++) {
  const response=await f.call(T.remember,{title:`Migration topic ${i}`,content:`Subsystem ${i} uses migration policy number ${i}.`,scope:'path',path:`src/subsystem${i}`,kind:'decision'});
  assert.ok(!response.isError,JSON.stringify(response));ids.push(response.structuredContent.result.item.id);
 }
 await f.call(T.sessionRecord,{sessionId:started,entries:[{type:'state_change',content:'Imported twelve consolidated topic records through prodero_remember.'}]});
 const close=await f.call(T.sessionClose,{sync:false,sessionId:started});
 assert.equal(close.structuredContent.result.review.total,13);
 const view=await reviewSessionKnowledge(f.root,started);
 assert.equal(view.items.length,1);assert.equal(view.knowledge.length,12);
 assert.deepEqual(view.knowledge.map(i=>i.id).sort(),ids.sort());
 assert.equal((await listKnowledge(f.root)).length,12);
 const ui=await knowledgeUi(req=>f.call(req.name,req.arguments));ui.render(close);
 assert.match(ui.html,/12<\/strong> Local Knowledge/);
 await ui.session('open');assert.match(ui.html,/Migration topic 11/);assert.match(ui.html,/State change/);
 await ui.session('knowledge',ids[0]);assert.match(ui.html,/Migration topic/);
 await fs.rm(path.join(f.root,'.prodero/.cache'),{recursive:true,force:true});
 assert.deepEqual((await reviewSessionKnowledge(f.root,started)).knowledge.map(i=>i.id).sort(),ids);
 await f.call(T.prepare);
 const synced=await reviewSessionKnowledge(f.root,started);
 assert.equal(synced.summary.total,13);assert.equal((await listKnowledge(f.root)).length,13);
});

test('remember provenance is explicit under ambiguity and isolated between MCP connections',async t=>{
 const f=await fixture(t,[]);
 const a=(await f.call(T.prepare)).structuredContent.result.session.id;
 const b=(await f.call(T.prepare)).structuredContent.result.session.id;
 const input={content:'Use isolated migration topics.',kind:'decision',scope:'global'};
 const ambiguous=await f.call(T.remember,input);assert.ok(ambiguous.isError);assert.match(JSON.stringify(ambiguous),/Multiple active/);
 assert.equal((await listKnowledge(f.root)).length,0);
 const saved=await f.call(T.remember,{...input,sessionId:a});assert.ok(!saved.isError);
 assert.equal(saved.structuredContent.result.parentSessionId,a);
 assert.equal((await reviewSessionKnowledge(f.root,a)).knowledge.length,1);
 assert.equal((await reviewSessionKnowledge(f.root,b)).knowledge.length,0);
 const server=createServer({projectRoot:f.root}),client=new Client({name:'other-connection',version:'1'});
 const [x,y]=InMemoryTransport.createLinkedPair();await server.connect(y);await client.connect(x);
 t.after(async()=>{await client.close();await server.close();});
 const standalone=await client.callTool({name:T.remember,arguments:{projectRoot:f.root,content:'The standalone connector stores an independent lesson.',kind:'lesson'}});
 assert.ok(!standalone.isError);assert.equal(standalone.structuredContent.result.parentSessionId,null);
 assert.equal((await reviewSessionKnowledge(f.root,a)).knowledge.length,1);
 assert.equal((await reviewSessionKnowledge(f.root,b)).knowledge.length,0);
 await f.call(T.sessionClose,{sync:false,sessionId:a});
 const before=(await fs.readdir(path.join(f.root,'.prodero/sessions'))).sort();
 for(const sessionId of [a,'sess_missing',saved.structuredContent.result.sessionId]) {
  assert.ok((await f.call(T.remember,{...input,sessionId})).isError);
 }
 assert.deepEqual((await fs.readdir(path.join(f.root,'.prodero/sessions'))).sort(),before);
});

test('durable review uses existing validated maintenance and discard-all only clears pending observations',async t=>{
 const f=await fixture(t,[]);const sessionId=(await f.call(T.prepare)).structuredContent.result.session.id;
 const input={content:'Portal drafts persist across reloads.',title:'Draft persistence',scope:'global',kind:'fact'};
 const saved=(await f.call(T.remember,input)).structuredContent.result.item;
 await f.call(T.remember,input);
 await f.call(T.sessionRecord,{sessionId,entries:[{type:'state_change',content:'Verified draft persistence.'}]});
 await f.call(T.sessionClose,{sync:false,sessionId});
 let view=await reviewSessionKnowledge(f.root,sessionId);
 assert.equal(view.knowledge.length,1);assert.equal((await listKnowledge(f.root)).length,1);
 await assert.rejects(mutateSessionKnowledge(f.root,{sessionId,revision:view.revision,action:'edit',id:saved.id,content:'Wrong mutation path.'}),/observation was not found/);
 const {knowledgeView,mutateKnowledge}=await import('../dist/core/knowledge-management.js');
 let detail=(await knowledgeView(f.root,{},saved.id)).detail;
 await mutateKnowledge(f.root,{id:saved.id,revision:detail.revision,approved:true,action:'edit',title:detail.title,content:'Portal drafts persist across reloads for authenticated users.'});
 view=await reviewSessionKnowledge(f.root,sessionId);assert.match(view.knowledge[0].content,/authenticated/);
 view=await mutateSessionKnowledge(f.root,{sessionId,revision:view.revision,action:'discard-all'});
 assert.equal(view.items.length,0);assert.equal(view.knowledge.length,1);assert.equal(view.summary.total,1);
 detail=(await knowledgeView(f.root,{},saved.id)).detail;
 await mutateKnowledge(f.root,{id:saved.id,revision:detail.revision,approved:true,action:'retire'});
 assert.equal((await reviewSessionKnowledge(f.root,sessionId)).knowledge[0].status,'deprecated');
 await f.call(T.prepare);assert.equal((await listKnowledge(f.root)).length,1);
 assert.equal((await readSession(f.root,sessionId)).status,'closed');
});

test('remember supersession remains inspectable and parent provenance validates on cache rebuild',async t=>{
 const f=await fixture(t,[]);const sessionId=(await f.call(T.prepare)).structuredContent.result.session.id;
 const first=(await f.call(T.remember,{content:'Portal messages are display-only.',title:'Portal capability',scope:'global',kind:'fact'})).structuredContent.result;
 const second=await f.call(T.remember,{content:'Portal compose and sending are implemented.',title:'Portal capability',scope:'global',kind:'fact',replaceId:first.item.id});assert.ok(!second.isError);
 await f.call(T.sessionClose,{sync:false,sessionId});
 let view=await reviewSessionKnowledge(f.root,sessionId);
 assert.equal(view.knowledge.length,2);assert.ok(view.knowledge.some(i=>i.status==='superseded'));
 assert.ok(view.knowledge.some(i=>i.signals.some(s=>s.kind==='state_transition'&&s.memory.id===first.item.id)));
 await fs.writeFile(path.join(f.root,'.prodero/.cache/session-index.json'),'{broken');
 assert.equal((await reviewSessionKnowledge(f.root,sessionId)).knowledge.length,2);
 const child=path.join(f.root,'.prodero/sessions',first.sessionId+'.md');
 const raw=await fs.readFile(child,'utf8');
 await fs.writeFile(child,raw.replace(sessionId,'../invalid'));
 await assert.rejects(reviewSessionKnowledge(f.root,sessionId),/invalid parent_session_id/);
});

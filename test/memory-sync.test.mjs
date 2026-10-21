import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer,PRODERO_TOOLS as T} from '../dist/server.js';
import {runMemorySync as run,MEMORY_SYNC_LIMITS} from '../dist/core/memory-sync.js';
import {createMemoryBundleFixture,fixtureItem,observeFixture} from './helpers/memory-bundle-fixtures.mjs';
import {fixtureProposal} from './helpers/memory-proposal-fixtures.mjs';
import {readKnowledgeInventory} from '../dist/core/knowledge-provenance.js';
import {writeKnowledge,listKnowledge} from '../dist/core/memory.js';
import {getMemoryIntelligencePlan} from '../dist/core/memory-intelligence.js';
import {listCheckpoints} from '../dist/core/storage.js';
import {prepareProject,recordProjectSession,closeProjectSession} from '../dist/core/project.js';
import {knowledgeUi} from './helpers/knowledge-ui.mjs';
const file=(f,p)=>path.join(f.root,'.prodero',p);
async function fixture(t,scenario='fragmentation'){const f=await createMemoryBundleFixture(scenario);t.after(f.cleanup);return f;}
async function action(f,w,action,extra={}){return run(f.root,{action,workflowId:w.id,revision:w.revision,...extra});}
async function selected(f,reviewPromotion=false){let w=await run(f.root,{action:'start'});return action(f,w,'select',{candidateIds:w.jobs.map(j=>j.id),reviewPromotion});}
async function propose(f,w,scenario='fragmentation',edit){w=await action(f,w,'prepare',{candidateId:w.next.candidateId});const p=fixtureProposal(w.semantic.bundle,scenario);if(edit)edit(p);return action(f,w,'propose',{candidateId:w.next.candidateId,proposal:p});}
async function review(f,w){return action(f,w,'approve',{reviewId:w.review.reviewId,approved:true});}
const inspect=(f,w)=>run(f.root,{action:'inspect',workflowId:w.id});
const keep=b=>({...fixtureProposal(b,'protected'),records:[]});

test('start analyzes planner and promotion without changing knowledge/sessions/checkpoints; selection is empty',async t=>{
 const f=await fixture(t),before=await readKnowledgeInventory(f.root),checkpoints=await listCheckpoints(f.root);const w=await run(f.root,{action:'start'});assert.equal(w.state,'awaiting_selection');assert.equal(w.health.transformationCandidates,1);assert.equal(w.health.contextPressureCandidates,1);assert.equal(w.health.localPromotionCandidates,4);assert.ok(w.jobs.every(j=>!j.selected));assert.equal(w.promotionEnabled,false);assert.deepEqual(await readKnowledgeInventory(f.root),before);assert.deepEqual(await listCheckpoints(f.root),checkpoints);assert.equal((await run(f.root,{action:'start'})).id,w.id);assert.ok((await fs.stat(file(f,'local/memory-sync.json'))).size<MEMORY_SYNC_LIMITS.bytes);
});
test('start recovers pending deterministic observations, once, without semantic work',async t=>{
 const f=await fixture(t);const prepared=await prepareProject(f.root,{task:'Recovery fixture'});await recordProjectSession(f.root,prepared.session.id,[{type:'discovery',title:'Recovery fact',content:'The fixture uses a separate bounded recovery queue.'}]);let w=await run(f.root,{action:'start'});assert.equal(w.recovery.sessions,1);assert.equal(w.state,'awaiting_selection');const inv=await readKnowledgeInventory(f.root);assert.ok(inv.some(r=>r.item.content.includes('separate bounded recovery queue')));assert.equal(inv.filter(r=>r.storage==='archive').length,0);await run(f.root,{action:'start'});assert.deepEqual(await readKnowledgeInventory(f.root),inv);
});
test('session_close saves observations but never creates a Curate Memory workflow',async t=>{
 const f=await fixture(t),p=await prepareProject(f.root,{task:'No semantic maintenance'});await recordProjectSession(f.root,p.session.id,[{type:'discovery',content:'Session close retains a deterministic save boundary.'}]);await closeProjectSession(f.root,p.session.id);await assert.rejects(fs.access(file(f,'local/memory-sync.json')),{code:'ENOENT'});assert.equal((await readKnowledgeInventory(f.root)).filter(r=>r.storage==='archive').length,0);
});
test('Local clean selection processes exact candidate and produces actual completion totals; old pressure does not reappear',async t=>{
 const f=await fixture(t);let w=await selected(f);assert.equal(w.next.action,'semantic_work_required');w=await propose(f,w);assert.equal(w.state,'completed');assert.deepEqual(w.summary.estimatedTokens,{scope:'transformed_areas',before:142,after:131});assert.equal(w.summary.sourcesBefore,4);assert.equal(w.summary.currentAfter,2);assert.equal(w.summary.archived,4);assert.equal((await getMemoryIntelligencePlan(f.root)).candidateCount,0);assert.deepEqual((await inspect(f,w)).summary,w.summary);assert.equal((await listCheckpoints(f.root)).length,1);
});
test('empty selection cannot authorize transformation; unknown or duplicate IDs and stale revisions fail',async t=>{
 const f=await fixture(t);const w=await run(f.root,{action:'start'});await assert.rejects(action(f,w,'select',{candidateIds:['area_'+'0'.repeat(20)]}));await assert.rejects(action(f,w,'select',{candidateIds:[w.jobs[0].id,w.jobs[0].id]}));let done=await action(f,w,'select',{candidateIds:[]});assert.equal(done.state,'completed');await assert.rejects(action(f,w,'prepare',{candidateId:w.jobs[0].id}),/Stale/);await assert.rejects(action(f,done,'prepare',{candidateId:w.jobs[0].id}),/next selected/);assert.equal((await listKnowledge(f.root)).length,4);
});
for(const kind of ['warnings','unresolved','omitted'])test(`${kind} stops automatic Local apply until review`,async t=>{
 const f=await fixture(t);let w=await selected(f);w=await propose(f,w,'fragmentation',p=>{if(kind==='warnings')p.warnings=['Semantic qualification remains.'];else if(kind==='omitted')p.dispositions[0].omittedAsRedundant=['Repeated detail'];else{p.records=[];for(const d of p.dispositions){d.action='keep';d.proposedKeys=[];}p.dispositions[0].action='unresolved';p.dispositions[0].unresolvedInformation=['Need more evidence.'];}});assert.equal(w.state,'awaiting_review');assert.equal((await listKnowledge(f.root)).length,4);assert.equal(w.review.preview.requiresSemanticReview,true);await assert.rejects(action(f,w,'approve',{approved:true,reviewId:'wrong'}));w=await review(f,w);assert.equal(w.state,'completed');if(kind==='unresolved'){assert.equal(w.summary.unresolved,1);assert.equal(w.summary.archived,0);}
});
test('Mixed workflow waits for exact review, is resumable, and never applies Local half',async t=>{
 const f=await fixture(t,'mixed');let w=await selected(f);const before=await readKnowledgeInventory(f.root);w=await propose(f,w,'mixed');assert.equal(w.state,'awaiting_review');assert.equal(w.review.preview.requiresVersionedReview,true);assert.deepEqual(await readKnowledgeInventory(f.root),before);const resumed=await inspect(f,w);assert.equal(resumed.review.reviewId,w.review.reviewId);w=await review(f,resumed);assert.equal(w.state,'completed');assert.equal(w.summary.versionedCreated,2);assert.equal(w.summary.archived,4);
});
test('external Versioned change invalidates review and cannot be approved',async t=>{
 const f=await fixture(t,'mixed');let w=await propose(f,await selected(f),'mixed');await fs.appendFile(file(f,'memory/mem_driving_00.md'),'\nExternal team change.');const before=await readKnowledgeInventory(f.root);await assert.rejects(review(f,w),/changed|fresh workflow/);w=await inspect(f,w);assert.equal(w.state,'stale');assert.deepEqual(await readKnowledgeInventory(f.root),before);
});
test('transformation precedes promotion selection; promotion is distinct and explicitly selected',async t=>{
 const f=await fixture(t);let w=await selected(f,true);await assert.rejects(action(f,w,'promotions',{ids:f.ids}),/Finish selected/);w=await propose(f,w);assert.equal(w.state,'awaiting_promotion_selection');assert.equal(w.promotionCandidates.length,2);assert.ok(w.promotionCandidates.every(c=>!f.ids.includes(c.id)));await assert.rejects(action(f,w,'promotions',{ids:[]}),/specific current/);
 w=await action(f,w,'promotions',{ids:w.promotionCandidates.map(c=>c.id)});assert.equal(w.review.kind,'promotion');assert.equal((await listKnowledge(f.root,'versioned')).length,0);w=await review(f,w);assert.equal(w.state,'completed');assert.equal(w.summary.promoted,2);assert.equal(w.summary.archived,4);assert.equal((await listKnowledge(f.root,'versioned')).length,2);
});
test('independent candidates survive a failed proposal and retry uses fresh bundle binding',async t=>{
 const f=await fixture(t);const ids=Array.from({length:4},(_,i)=>`mem_billing_${i}`);for(const id of ids)await writeKnowledge(f.root,fixtureItem(id,{scopeRef:'src/billing',title:'Billing processing',content:'Billing queues preserve invoice ordering.'}),false,'local');await observeFixture(f.root,ids,3);await observeFixture(f.root,ids,4);
 let w=await selected(f);assert.equal(w.jobs.length,2);w=await action(f,w,'prepare',{candidateId:w.next.candidateId});const failedId=w.next.candidateId;let p=keep(w.semantic.bundle);p.dispositions.pop();w=await action(f,w,'propose',{candidateId:failedId,proposal:p});assert.equal(w.state,'semantic_work');assert.equal(w.jobs.find(j=>j.id===failedId).status,'failed');w=await action(f,w,'prepare',{candidateId:w.next.candidateId});p=keep(w.semantic.bundle);w=await action(f,w,'propose',{candidateId:w.next.candidateId,proposal:p});assert.equal(w.state,'completed');assert.equal(w.summary.areasFailed,1);w=await action(f,w,'retry',{candidateId:failedId});w=await action(f,w,'prepare',{candidateId:failedId});w=await action(f,w,'propose',{candidateId:failedId,proposal:keep(w.semantic.bundle)});assert.equal(w.summary.areasProcessed,2);assert.equal(w.summary.areasFailed,0);
});
for(const kind of ['transformation','promotion'])test(`interruption after ${kind} commit resumes from exact receipt without duplicate effects`,async t=>{
 const f=await fixture(t);let w=await selected(f,kind==='promotion');if(kind==='promotion'){w=await propose(f,w);w=await action(f,w,'promotions',{ids:w.promotionCandidates.map(c=>c.id)});}else w=await propose(f,w,'fragmentation',p=>p.warnings=['Review fixture.']);
 const rename=fs.rename;let failure=false;fs.rename=async(from,to)=>{if(String(to).endsWith('/local/memory-sync.json')&&(await fs.readFile(from,'utf8')).includes('"state":"completed"')){failure=true;throw new Error('Injected workflow checkpoint failure');}return rename(from,to);};try{await assert.rejects(review(f,w),/Injected/);}finally{fs.rename=rename;}assert.ok(failure);const inventory=await readKnowledgeInventory(f.root);w=await inspect(f,w);assert.equal(w.state,'completed');assert.deepEqual(await readKnowledgeInventory(f.root),inventory);assert.equal(w.summary.areasProcessed,1);if(kind==='promotion')assert.equal(w.summary.promoted,2);
});
test('interrupted atomic mixed apply recovers only previously approved effects',async t=>{
 const f=await fixture(t,'mixed');let w=await propose(f,await selected(f),'mixed');const rename=fs.rename;let failed=false;fs.rename=async(from,to)=>{if(!failed&&String(to).includes('/archive/')){failed=true;throw new Error('Injected archive interruption');}return rename(from,to);};try{await assert.rejects(review(f,w),/Injected/);}finally{fs.rename=rename;}await assert.rejects(listKnowledge(f.root),/pending/);w=await inspect(f,w);assert.equal(w.state,'completed');assert.equal(w.summary.archived,4);assert.equal((await listCheckpoints(f.root)).length,1);
});
test('workflow storage stays bounded and replacement invalidates previous IDs',async t=>{
 const f=await fixture(t),w=await run(f.root,{action:'start'});const next=await run(f.root,{action:'start',restart:true});await assert.rejects(inspect(f,w),/replaced/);assert.notEqual(next.id,w.id);assert.ok((await fs.stat(file(f,'local/memory-sync.json'))).size<MEMORY_SYNC_LIMITS.bytes);const raw=await fs.readFile(file(f,'local/memory-sync.json'),'utf8');assert.equal(raw.includes('sourceMarkdown'),false);
});
async function mcp(t,f){const server=createServer({projectRoot:f.root}),client=new Client({name:'memory-sync-test',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});return (name,args={})=>client.callTool({name,arguments:{projectRoot:f.root,...args}});}
test('only Curate Memory launcher attaches an App; repeated continuation preserves the workflow without new cards',async t=>{
 const f=await fixture(t),server=createServer({projectRoot:f.root}),client=new Client({name:'sync-card-test',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}});
 const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const tools=(await client.listTools()).tools;
 assert.equal(tools.find(tool=>tool.name===T.sync)._meta?.ui?.resourceUri,'ui://prodero/status.html');
 const continuation=tools.find(tool=>tool.name===T.memorySync);
 assert.equal(continuation._meta?.ui?.resourceUri,undefined);
 assert.equal(continuation._meta?.['openai/outputTemplate'],undefined);
 const args={projectRoot:f.root,presentationGroup:'sync-single-window'};
 const opened=await client.callTool({name:T.sync,arguments:args});
 assert.ok(opened.structuredContent.presentation.card);
 const id=opened.structuredContent.result.id;
 for(let i=0;i<3;i++){
  const response=await client.callTool({name:T.memorySync,arguments:{...args,request:{action:'inspect',workflowId:id}}});
  assert.equal(response.isError,undefined);
  assert.equal(response.structuredContent.result.id,id);
  assert.equal(response.structuredContent.presentation.card,undefined);
 }
});
test('MCP start/semantic continuation and text review share the persisted protocol',async t=>{
 const f=await fixture(t,'mixed'),call=await mcp(t,f);let response=await call(T.sync);assert.equal(response.structuredContent.action,'memory-sync');let w=response.structuredContent.result;
 const send=async(action,extra={})=>{const r=await call(T.memorySync,{request:{action,workflowId:w.id,revision:w.revision,...extra}});assert.equal(r.isError,undefined,JSON.stringify(r));w=r.structuredContent.result;return r;};await send('select',{candidateIds:w.jobs.map(j=>j.id)});await send('prepare',{candidateId:w.next.candidateId});assert.match(w.semantic.instructions,/Core checks structure/);await send('propose',{candidateId:w.next.candidateId,proposal:fixtureProposal(w.semantic.bundle,'mixed')});assert.equal(w.next.action,'human_review_required');const text=await call(T.text,{tool:T.memorySync,arguments:{projectRoot:f.root,request:{action:'inspect',workflowId:w.id}}});assert.match(text.content[0].text,/Review required/);assert.match(text.content[0].text,/Review the proposed changes/);const full=await call(T.text,{tool:T.memorySync,arguments:{projectRoot:f.root,request:{action:"inspect",workflowId:w.id},details:true}});assert.match(full.content[0].text,/Review shared-memory changes/);assert.match(full.content[0].text,/Versioned|versioned/);assert.equal(text.structuredContent.presentation.operational.continuation.arguments.request.action,"inspect");assert.equal(text.structuredContent.presentation.operational.continuation.approval,undefined);const approval=full.structuredContent.presentation.operational.continuation;assert.equal(approval.approval,true);assert.equal(approval.arguments.request.reviewId,w.review.reviewId);assert.equal(approval.arguments.request.revision,w.revision);for(const record of w.review.preview.proposal.records)assert.ok(full.content[0].text.includes(record.body));assert.match(full.content[0].text,/Approve these exact changes\?$/);assert.equal((await listKnowledge(f.root)).length,4);
});
test('human handoff reopens exact promotion selection without restarting or publishing',async t=>{
 const f=await fixture(t),call=await mcp(t,f);
 let w=(await call(T.sync)).structuredContent.result;
 w=(await call(T.memorySync,{request:{action:'select',workflowId:w.id,revision:w.revision,improve:false,share:true}})).structuredContent.result;
 assert.equal(w.state,'awaiting_promotion_selection');
 assert.equal(w.next.tool,T.sync);
 assert.deepEqual(w.next.arguments,{projectRoot:w.root,workflowId:w.id});
 const inventory=await readKnowledgeInventory(f.root),revision=w.revision;
 const reopened=await call(w.next.tool,w.next.arguments);
 assert.equal(reopened.isError,undefined);
 assert.equal(reopened.structuredContent.result.id,w.id);
 assert.equal(reopened.structuredContent.result.revision,revision);
 const ui=await knowledgeUi();ui.render(reopened);
 assert.match(ui.html,/Select Local knowledge to move to Versioned Knowledge/);
 assert.deepEqual(await readKnowledgeInventory(f.root),inventory);
 const invalid=await call(T.sync,{workflowId:'00000000-0000-4000-8000-000000000000'});
 assert.equal(invalid.isError,true);
 assert.equal((await inspect(f,w)).id,w.id);
});
test('promotion selection defaults to all and preserves individual and bulk choices without publishing',async t=>{
 const f=await fixture(t);let w=await run(f.root,{action:'start'});
 w=await action(f,w,'select',{improve:false,share:true});
 const call=await mcp(t,f),calls=[];
 const ui=await knowledgeUi(req=>{calls.push(req);return call(req.name,req.arguments);});
 const payload={structuredContent:{ok:true,action:'memory-sync',result:w}};
 ui.render(payload);
 const checked=()=>ui.host.querySelectorAll('[data-sync-promotion]').filter(e=>e.checked).map(e=>e.dataset.syncPromotion);
 const ids=w.promotionCandidates.map(c=>c.id);assert.ok(ids.length>1);
 assert.deepEqual(checked(),ids);
 await ui.sync('promotions-none');assert.deepEqual(checked(),[]);
 assert.equal(ui.host.querySelector('[data-memory-sync="promotions"]').disabled,true);
 await ui.sync('promotions');assert.equal(calls.length,0);
 await ui.sync('promotions-all');assert.deepEqual(checked(),ids);
 ui.check(`[data-sync-promotion="${ids[0]}"]`,false);
 ui.render(payload);
 assert.deepEqual(checked(),ids.slice(1));assert.equal(calls.length,0);
 await ui.sync('promotions');
 assert.deepEqual(Array.from(calls[0].arguments.request.ids),ids.slice(1));
 assert.equal(calls.some(c=>c.arguments.request.action==='approve'),false);
 assert.equal((await listKnowledge(f.root,'versioned')).length,0);
});
test('minimal production UI explicitly selects operations, requests the current agent and never self-approves',async t=>{
 const f=await fixture(t,'mixed'),call=await mcp(t,f),calls=[],messages=[];const ui=await knowledgeUi(async req=>{calls.push(req);return call(req.name,req.arguments);},message=>{messages.push(message);return {};});ui.render(await call(T.sync));assert.match(ui.html,/Curate Memory/);assert.doesNotMatch(ui.html,/data-action="promotion"/);assert.equal(ui.host.querySelector('#sync-improve-choice').checked,true);await ui.sync('select');assert.equal(messages.length,1);assert.match(messages[0].content[0].text,/never approve/);assert.equal(calls.some(c=>c.arguments.request?.action==='approve'),false);
 let w=await run(f.root,{action:'start',restart:true});w=await action(f,w,'select',{candidateIds:w.jobs.map(j=>j.id),reviewPromotion:false});w=await propose(f,w,'mixed');ui.render({structuredContent:{ok:true,action:'memory-sync',result:w}});assert.match(ui.html,/Approve reviewed changes/);assert.equal((await listKnowledge(f.root)).length,4);await ui.sync('approve');assert.equal((await listKnowledge(f.root,'versioned')).filter(i=>i.status==='active').length,2);assert.match(ui.html,/Memory curated/);
});
test('two real independent transformations use fresh per-candidate bundles after each commit',async t=>{
 const f=await fixture(t),ids=Array.from({length:4},(_,i)=>`mem_billing_${i}`);for(const id of ids)await writeKnowledge(f.root,fixtureItem(id,{scopeRef:'src/billing',title:'Billing processing',content:'Billing queues preserve invoice ordering.'}),false,'local');await observeFixture(f.root,ids,3);await observeFixture(f.root,ids,4);let w=await selected(f);
 while(w.state==='semantic_work'){w=await action(f,w,'prepare',{candidateId:w.next.candidateId});const b=w.semantic.bundle;let p=b.sourceIds[0].startsWith('mem_billing')?keep(b):fixtureProposal(b,'fragmentation');if(b.sourceIds[0].startsWith('mem_billing')){p={...keep(b),records:[{key:'draft_billing',category:'state',scope:'path',path:'src/billing',priority:'normal',title:'Billing queue ordering',body:'Billing queues preserve invoice ordering.',sourceIds:b.sourceIds}],dispositions:b.sourceIds.map(sourceId=>({sourceId,action:'consolidate',proposedKeys:['draft_billing'],rationale:'One shared invariant statement is repeated verbatim across State evidence.',coverage:'Invoice ordering is preserved.',omittedAsRedundant:[],unresolvedInformation:[]}))};}w=await action(f,w,'propose',{candidateId:w.next.candidateId,proposal:p});}
 assert.equal(w.state,'completed');assert.equal(w.summary.areasProcessed,2);assert.equal(w.summary.sourcesBefore,8);assert.equal(w.summary.currentAfter,3);assert.equal(w.summary.archived,8);assert.equal((await getMemoryIntelligencePlan(f.root)).candidateCount,0);
});
test('a promotion review is invalidated by external Versioned changes',async t=>{
 const f=await fixture(t);let w=await propose(f,await selected(f,true));w=await action(f,w,'promotions',{ids:w.promotionCandidates.map(c=>c.id)});await writeKnowledge(f.root,fixtureItem('mem_external',{scopeRef:'billing'}),false,'versioned');const before=await readKnowledgeInventory(f.root);await assert.rejects(review(f,w),/changed/);assert.deepEqual(await readKnowledgeInventory(f.root),before);assert.equal((await inspect(f,w)).state,'stale');
});
test('resume does not adopt external changes after a committed transformation checkpoint',async t=>{
 const f=await fixture(t);let w=await propose(f,await selected(f),'fragmentation',p=>p.warnings=['Review required.']);const rename=fs.rename;fs.rename=async(from,to)=>{if(String(to).endsWith('/local/memory-sync.json')&&(await fs.readFile(from,'utf8')).includes('"state":"completed"'))throw new Error('Persist failure');return rename(from,to);};try{await assert.rejects(review(f,w),/Persist/);}finally{fs.rename=rename;}await writeKnowledge(f.root,fixtureItem('mem_external'),false,'local');w=await inspect(f,w);assert.equal(w.state,'stale');assert.equal(w.summary.areasProcessed,1);assert.equal((await listCheckpoints(f.root)).length,1);
});
test('skipping a reviewed unresolved proposal preserves its unresolved diagnostics and knowledge',async t=>{
 const f=await fixture(t);let w=await propose(f,await selected(f),'fragmentation',p=>{p.records=[];for(const d of p.dispositions){d.action='unresolved';d.proposedKeys=[];d.unresolvedInformation=['Insufficient evidence.'];}});w=await action(f,w,'skip',{candidateId:w.jobs[0].id});assert.equal(w.state,'completed');assert.equal(w.summary.unresolved,4);assert.equal(w.summary.areasSkipped,1);assert.equal((await listKnowledge(f.root)).length,4);
});
test('workflow checkpoint is Git-ignored and never a knowledge record',async t=>{
 const f=await fixture(t);const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);await exec('git',['init','-q'],{cwd:f.root});await run(f.root,{action:'start'});await exec('git',['check-ignore','--quiet','.prodero/local/memory-sync.json'],{cwd:f.root});assert.equal((await listKnowledge(f.root)).length,4);
});

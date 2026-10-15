// Invented toy-project fixtures; no real project incidents or operational records.
import {curationApplyBinding,curationOperationId} from '../dist/core/curation-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initializeProject} from '../dist/core/project.js';
import {writeKnowledge,listKnowledge} from '../dist/core/memory.js';
import {sha256,listCheckpoints} from '../dist/core/storage.js';
import {planKnowledgeCuration,curationRecommendation,deferKnowledgeCuration,renderCurationText} from '../dist/core/knowledge-curation.js';
import {createCurationReview,loadCurationReview,stageCurationDecisions,controlCurationReview,curationReviewView,projectCurationReview,reviewUnitBasis,REVIEW_RETENTION,selectedCurationProposals} from '../dist/core/curation-review.js';
import {clarificationStateSchema} from '../dist/core/curation-review-state.js';
import {executeCurationReview} from '../dist/curation-review-adapter.js';
import {buildViewModel,renderText} from '../dist/presentation.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer,PRODERO_TOOLS} from '../dist/server.js';
import {lifecycleUi} from './helpers/lifecycle-ui.mjs';
const exec=promisify(execFile);
const item=(id,content)=>({version:3,id,category:'instruction',contextPolicy:'required',authority:'legacy_inherited',applicability:{kind:'legacy'},scope:'global',scopeRef:null,priority:'normal',status:['sync','conflict'].includes(id)?'disputed':'active',title:id,content,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[],relations:id==='sync'?[{type:'contradicts',target:'deployment'}]:[]});
const three=()=>[item('sync','Decision:\nOrbitUI must rotate puzzle tiles by a quarter turn.'),item('deployment','Never rotate puzzle tiles; preserve the initial orientation.'),item('quality','Always preserve compatibility.')];
const safe=()=>item('tests','Decision:\nCedarAPI tests must isolate exports.\n\nImpact:\nNever call real exports.');
async function fixture(t,items=three()) {const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-state-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await initializeProject(root);for(const i of items)await writeKnowledge(root,i);return root;}
const identity=r=>({reviewId:r.snapshot.reviewId,planHash:r.snapshot.planHash,decisionRevision:r.state.revision});
const issue=r=>r.snapshot.units.find(u=>r.state.items[u.id].outcome==='unresolved');
const proposal=r=>r.snapshot.units.find(u=>r.state.items[u.id].outcome==='proposed');
const view=async(root,r)=>(await curationReviewView(root,r.snapshot.plan,r)).projection;
const stateFile=(root,r)=>path.join(root,'.prodero/local/curation-reviews',r.snapshot.reviewId+'.state.json');
const bytes=async root=>JSON.stringify(await listKnowledge(root));
const choose=(root,r,unit,choice)=>stageCurationDecisions(root,{...identity(r),decisions:{[unit.id]:choice}});
const defer=(root,r)=>controlCurationReview(root,{...identity(r),action:'defer_issue',unitId:issue(r).id});
async function client(t,root,apps=true) {const server=createServer({projectRoot:root}),client=new Client({name:'phase-one-test',version:'1'},{capabilities:apps?{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}:{}});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});return client;}
function counts(p){return {analyzed:p.analyzedSourceCount,ready:p.readyChangeGroups,input:p.needsInputNow,deferred:p.deferredQuestions,unchanged:p.unchanged,unresolved:p.unresolved};}
const deferredCounts={analyzed:3,ready:0,input:0,deferred:1,unchanged:2,unresolved:1};

test('three-record semantic conflict: defer removes attention everywhere without resolving or changing knowledge',async t=>{
 const root=await fixture(t),before=await bytes(root);let r=await createCurationReview(root);
 assert.deepEqual(counts(await view(root,r)),{...deferredCounts,input:1,deferred:0});
 r=await defer(root,r);const projection=await view(root,r);
 assert.deepEqual(counts(projection),deferredCounts);
 assert.equal(r.state.items[issue(r).id].outcome,'unresolved');assert.equal(r.state.items[issue(r).id].issue.state,'deferred');
 assert.equal(projection.paused,false);assert.equal((await curationRecommendation(root)).prominent,false);
 assert.deepEqual(counts((await curationRecommendation(root)).projection),deferredCounts);
 assert.equal(await bytes(root),before);assert.equal((await listCheckpoints(root)).filter(c=>c.curation).length,0);
 const resumed=await loadCurationReview(root,r.snapshot.reviewId);assert.deepEqual(resumed,r);
 const c=await client(t,root);const payload=(await c.callTool({name:PRODERO_TOOLS.curation,arguments:{action:'plan'}})).structuredContent;
 assert.deepEqual(counts(payload.projection),deferredCounts);assert.deepEqual(payload.review.state,r.state);
 const ui=await lifecycleUi({callServerTool:call=>c.callTool(call)});ui.render(payload);
 const summary='0 need your input · 1 deferred questions';assert.ok(ui.html.includes(summary));
 await ui.clickAsync('review-all');assert.ok(ui.html.includes(summary));assert.match(ui.html,/Deferred clarification|Already current/);
 await ui.clickAsync('review-summary');assert.ok(ui.html.includes(summary));
 assert.deepEqual(payload.projection.attentionUnitIds,[]);
 const reopened=await lifecycleUi({callServerTool:call=>c.callTool(call)});reopened.render(payload);assert.doesNotMatch(reopened.html,/Knowledge 1 of/);
 const textResponse=await c.callTool({name:PRODERO_TOOLS.text,arguments:{tool:PRODERO_TOOLS.curation,arguments:{action:'plan'}}});
 assert.ok(textResponse.content[0].text.includes('0 need your input'));assert.ok(textResponse.content[0].text.includes('1 deferred questions'));
 const dash=(await c.callTool({name:PRODERO_TOOLS.open,arguments:{}})).structuredContent;
 assert.deepEqual(counts(dash.curation.projection),deferredCounts);ui.render(dash);assert.match(ui.html,/Review saved decisions/);
 assert.ok(renderText(buildViewModel(payload)).includes('0 need your input'));
 assert.ok(renderCurationText(r.snapshot.plan,projection).includes('0 need your input'));
});
test('deferred issue survives an actual Node process restart',async t=>{
 const root=await fixture(t);let r=await createCurationReview(root);r=await defer(root,r);
 const module=new URL('../dist/core/knowledge-curation.js',import.meta.url).href;
 const {stdout}=await exec(process.execPath,['--input-type=module','-e',`const {curationRecommendation}=await import(${JSON.stringify(module)});process.stdout.write(JSON.stringify(await curationRecommendation(process.argv[1])));`,root]);
 assert.deepEqual(counts(JSON.parse(stdout).projection),deferredCounts);
});
test('outcome, disposition and execution are independent; Current is not Later',async t=>{
 const root=await fixture(t,[...three(),safe()]);let r=await createCurationReview(root);const p=proposal(r),u=issue(r),unchanged=r.snapshot.units.find(v=>r.state.items[v.id].outcome==='unchanged');
 r=await choose(root,r,p,'suggested');assert.equal(r.state.items[p.id].outcome,'proposed');assert.equal(r.state.items[p.id].disposition,'included');assert.equal(r.state.items[p.id].execution,'not_applied');
 r=await controlCurationReview(root,{...identity(r),action:'defer_change',unitId:p.id});assert.equal(r.state.items[p.id].outcome,'proposed');assert.equal((await view(root,r)).deferredChanges,1);
 r=await choose(root,r,p,'current');assert.equal((await view(root,r)).deferredChanges,0);assert.equal(r.state.items[p.id].disposition,'keep_current');
 r=await choose(root,r,u,'current');assert.equal(r.state.items[u.id].outcome,'unresolved');assert.equal(r.state.items[u.id].issue.state,'open');assert.equal((await view(root,r)).needsInputNow,0);assert.equal((await view(root,r)).deferredQuestions,0);
 r=await choose(root,r,unchanged,'deferred');assert.equal(r.state.items[unchanged.id].outcome,'unchanged');assert.equal(r.state.items[unchanged.id].issue,undefined);assert.equal((await view(root,r)).deferredQuestions,0);
 await assert.rejects(controlCurationReview(root,{...identity(r),action:'defer_issue',unitId:p.id}),e=>e.code==='invalid_selection');
 await assert.rejects(controlCurationReview(root,{...identity(r),action:'defer_change',unitId:u.id}),e=>e.code==='invalid_selection');
});
test('pause review, defer issue and defer change persist as distinct events; resume restores only open attention',async t=>{
 const root=await fixture(t,[...three(),safe()]);let r=await createCurationReview(root);const p=proposal(r);
 r=await choose(root,r,p,'suggested');r=await controlCurationReview(root,{...identity(r),action:'pause'});
 assert.equal((await view(root,r)).lifecycle,'paused');assert.equal((await view(root,r)).needsInputNow,0);assert.equal((await view(root,r)).deferredQuestions,0);
 await assert.rejects(executeCurationReview(root,{...identity(r),...curationApplyBinding(r,p.proposalIds),selectedIds:p.proposalIds}),e=>e.code==='review_paused');
 r=await controlCurationReview(root,{...identity(r),action:'resume'});assert.equal((await view(root,r)).needsInputNow,1);
 r=await defer(root,r);r=await controlCurationReview(root,{...identity(r),action:'defer_change',unitId:p.id});
 assert.equal((await view(root,r)).paused,false);assert.equal((await view(root,r)).deferredQuestions,1);assert.equal((await view(root,r)).deferredChanges,1);
 const journal=JSON.parse(await fs.readFile(stateFile(root,r),'utf8'));assert.deepEqual(journal.events.map(e=>e.kind),['decide','pause_review','resume_review','defer_issue','defer_change']);
});
test('same basis preserves deferral across recalculation, unrelated sources and display wording; changed conflict counterpart reopens',async t=>{
 const root=await fixture(t);let r=await createCurationReview(root);r=await defer(root,r);const oldBasis=reviewUnitBasis(r.snapshot.plan,issue(r));
 const changed=structuredClone(r.snapshot.plan);changed.proposals.find(p=>p.attention.length).attention=['Different presentation wording'];changed.proposals.find(p=>p.attention.length).investigation.explanation='Reworded presentation';
 assert.equal(reviewUnitBasis(changed,issue(r)),oldBasis);
 await writeKnowledge(root,item('unrelated','Always retain migration backups.'));
 const recommendation=await curationRecommendation(root);assert.equal(recommendation.projection.needsInputNow,0);assert.equal(recommendation.projection.deferredQuestions,1);
 const fresh=await createCurationReview(root);assert.equal((await view(root,fresh)).deferredQuestions,1);assert.equal(fresh.state.items[issue(fresh).id].issue.id,r.state.items[issue(r).id].issue.id);
 await writeKnowledge(root,item('deployment','Never rotate puzzle tiles; preserve the marked starting orientation.'));
 assert.equal((await curationRecommendation(root)).projection.needsInputNow,1);assert.equal((await curationRecommendation(root)).projection.deferredQuestions,0);
});
test('changed user choice appends history and stale CAS loses without overwriting; concurrent updates serialize',async t=>{
 const root=await fixture(t);const r=await createCurationReview(root);
 const changes=await Promise.allSettled([defer(root,r),choose(root,r,issue(r),'current')]);
 assert.equal(changes.filter(c=>c.status==='fulfilled').length,1);assert.equal(changes.find(c=>c.status==='rejected').reason.code,'review_changed');
 let current=await loadCurationReview(root,r.snapshot.reviewId);const first=JSON.parse(await fs.readFile(stateFile(root,current),'utf8'));
 current=await choose(root,current,issue(current),'current');const second=JSON.parse(await fs.readFile(stateFile(root,current),'utf8'));
 assert.deepEqual(second.events.slice(0,first.events.length),first.events);assert.equal(current.state.revision,2);
 // Tampering with an earlier event is detected even when the latest decision is valid.
 second.events[0].decisions={};await fs.writeFile(stateFile(root,current),JSON.stringify(second));await assert.rejects(loadCurationReview(root,current.snapshot.reviewId),e=>e.code==='invalid_review');
});
test('legacy v1 choices remain readable and missing choices are not included; first update retains legacy baseline',async t=>{
 const root=await fixture(t,[...three(),safe()]);let r=await createCurationReview(root);const u=issue(r),p=proposal(r),unchanged=r.snapshot.units.find(v=>r.state.items[v.id].outcome==='unchanged');
 const legacySnapshot=structuredClone(r.snapshot);delete legacySnapshot.revision;legacySnapshot.version=1;const {snapshotHash:discard,...legacyBody}=legacySnapshot;legacySnapshot.snapshotHash=sha256(JSON.stringify(legacyBody));await fs.writeFile(stateFile(root,r).replace('.state.json','.json'),JSON.stringify(legacySnapshot));r.snapshot=legacySnapshot;
 const legacy={snapshotHash:r.snapshot.snapshotHash,revision:7,decisions:{[u.id]:'deferred',[unchanged.id]:'deferred'}};
 await fs.writeFile(stateFile(root,r),JSON.stringify(legacy));r=await loadCurationReview(root,r.snapshot.reviewId);
 assert.equal((await view(root,r)).deferredQuestions,1);assert.equal(r.state.items[unchanged.id].outcome,'unchanged');assert.equal(r.state.items[p.id].disposition,null);assert.deepEqual(selectedCurationProposals(r),[]);
 r=await choose(root,r,p,'suggested');const journal=JSON.parse(await fs.readFile(stateFile(root,r),'utf8'));assert.equal(journal.version,2);assert.equal(journal.base.origin,'legacy_v1');assert.equal(journal.base.revision,7);assert.deepEqual(journal.base.decisions,legacy.decisions);assert.equal(journal.events[0].revision,8);
});
test('old full-review checkpoint pauses the whole review and explicit resume overrides it',async t=>{
 const root=await fixture(t),plan=await planKnowledgeCuration(root);await deferKnowledgeCuration(root,plan.planId);
 let r=await createCurationReview(root);assert.equal((await view(root,r)).paused,true);assert.equal((await view(root,r)).deferredQuestions,0);assert.equal((await view(root,r)).unresolved,1);
 r=await controlCurationReview(root,{...identity(r),action:'resume'});assert.equal((await curationRecommendation(root)).projection.needsInputNow,1);
 const reload=await createCurationReview(root);assert.equal((await view(root,reload)).paused,false);
});
for(const part of ['snapshot','state'])test(`unsupported future ${part} schema fails closed without replacing it`,async t=>{
 const root=await fixture(t),r=await createCurationReview(root);const file=part==='state'?stateFile(root,r):stateFile(root,r).replace('.state.json','.json');const data=JSON.parse(await fs.readFile(file,'utf8'));data.version=999;await fs.writeFile(file,JSON.stringify(data));
 const before=await fs.readFile(file,'utf8');await assert.rejects(loadCurationReview(root,r.snapshot.reviewId),e=>e.code==='unsupported_review_schema');await assert.rejects(createCurationReview(root),e=>e.code==='unsupported_review_schema');assert.equal(await fs.readFile(file,'utf8'),before);
});
test('expired decision-bearing snapshots remain inspectable and carry deferred work to fresh review',async t=>{
 const root=await fixture(t);let r=await createCurationReview(root);r=await defer(root,r);const originalNow=Date.now;
 Date.now=()=>originalNow()+REVIEW_RETENTION.maxAgeMs+1000;
 try{
  await assert.rejects(loadCurationReview(root,r.snapshot.reviewId),e=>e.code==='stale_review');
  const inspect=await loadCurationReview(root,r.snapshot.reviewId,{allowExpired:true});assert.equal((await view(root,inspect)).deferredQuestions,1);
  const fresh=await createCurationReview(root);assert.equal((await view(root,fresh)).deferredQuestions,1);assert.ok(await fs.stat(stateFile(root,r)));
 }finally{Date.now=originalNow;}
});
test('bounded retention fails visibly before deleting any decision history',async t=>{
 const root=await fixture(t);let r=await createCurationReview(root);r=await defer(root,r);const before=await fs.readFile(stateFile(root,r),'utf8');const limit=REVIEW_RETENTION.maxCount;REVIEW_RETENTION.maxCount=1;
 try{await assert.rejects(createCurationReview(root),e=>e.code==='review_retention_full');assert.equal(await fs.readFile(stateFile(root,r),'utf8'),before);}finally{REVIEW_RETENTION.maxCount=limit;}
 const events=REVIEW_RETENTION.maxEvents;REVIEW_RETENTION.maxEvents=1;
 try{await assert.rejects(choose(root,r,issue(r),'current'),e=>e.code==='review_retention_full');assert.equal(await fs.readFile(stateFile(root,r),'utf8'),before);}finally{REVIEW_RETENTION.maxEvents=events;}
});
test('execution comes from receipt; independent existing safe selection applies once and deferred conflict survives receipt/reopen',async t=>{
 const root=await fixture(t,[...three(),safe()]);let r=await createCurationReview(root);r=await defer(root,r);r=await choose(root,r,proposal(r),'suggested');
 const request={...identity(r),...curationApplyBinding(r,selectedCurationProposals(r)),selectedIds:selectedCurationProposals(r)};const result=await executeCurationReview(root,request);
 assert.equal(result.projection.applied,1);assert.equal(result.projection.deferredQuestions,1);assert.equal(result.projection.needsInputNow,0);assert.equal(result.projection.lifecycle,'partially_applied');
 assert.deepEqual((await executeCurationReview(root,request)).projection,result.projection);
 const reloaded=await loadCurationReview(root,r.snapshot.reviewId);assert.equal((await view(root,reloaded)).applied,1);assert.equal((await view(root,reloaded)).deferredQuestions,1);
});
test('new deferral controls remain App-only; state fields cannot manufacture Apply authorization',async t=>{
 const root=await fixture(t);const r=await createCurationReview(root),c=await client(t,root,false),before=await bytes(root);
 for(const action of ['pause','resume','defer_issue','defer_change'])assert.equal((await c.callTool({name:PRODERO_TOOLS.curationReview,arguments:{...identity(r),action,unitId:issue(r).id}})).isError,true);
 assert.equal((await c.callTool({name:PRODERO_TOOLS.curationApply,arguments:{...identity(r),selectedIds:issue(r).proposalIds,execution:'applied',approved:true}})).isError,true);
 assert.equal(await bytes(root),before);
});
test('state contract reserves clarification progression and all review lifecycle dimensions without exposing reasoning mutation',async t=>{
 for(const state of ['open','answered_pending_analysis','resolved','deferred','superseded'])assert.equal(clarificationStateSchema.parse(state),state);
 const root=await fixture(t,[...three(),safe()]),r=await createCurationReview(root);const s=structuredClone(r.state),project=()=>projectCurationReview(r.snapshot.plan,r.snapshot.units,s);
 assert.equal(project().lifecycle,'partially_ready');s.analysis='pending';assert.equal(project().lifecycle,'analyzing');assert.equal(project().analysisPending,1);s.analysis='failed';assert.equal(project().lifecycle,'analysis_failed');
 s.analysis='complete';assert.equal(projectCurationReview(r.snapshot.plan,r.snapshot.units,s,{stale:true}).lifecycle,'stale');
 s.items[issue(r).id].issue.state='answered_pending_analysis';assert.equal(project().analysisPending,1);assert.equal(project().canApply,false);
});

async function legacySnapshot(root,r,decisions){
 const snapshot=structuredClone(r.snapshot);delete snapshot.revision;snapshot.version=1;snapshot.plan.proposals.forEach(p=>delete p.issueBasis);
 const {planId,...body}=snapshot.plan;snapshot.plan.planId=sha256(JSON.stringify(body));snapshot.planHash=snapshot.plan.planId;
 const {snapshotHash,...snapshotBody}=snapshot;snapshot.snapshotHash=sha256(JSON.stringify(snapshotBody));
 await fs.writeFile(stateFile(root,r).replace('.state.json','.json'),JSON.stringify(snapshot));
 await fs.writeFile(stateFile(root,r),JSON.stringify({revision:3,snapshotHash:snapshot.snapshotHash,decisions}));
 return loadCurationReview(root,r.snapshot.reviewId);
}
test('real pre-foundation snapshots without issue metadata preserve Later through adaptation and unrelated recalculation',async t=>{
 const root=await fixture(t);let r=await createCurationReview(root);r=await legacySnapshot(root,r,{[issue(r).id]:'deferred'});
 assert.equal((await view(root,r)).deferredQuestions,1);
 assert.deepEqual(counts((await curationRecommendation(root)).projection),deferredCounts);
 await writeKnowledge(root,item('extra','Always retain database backups.'));
 const fresh=await createCurationReview(root);assert.equal((await view(root,fresh)).deferredQuestions,1);assert.equal((await view(root,fresh)).needsInputNow,0);
});
test('pre-foundation full-review curationDefer hash migrates without a saved review',async t=>{
 const root=await fixture(t),plan=await planKnowledgeCuration(root);plan.proposals.forEach(p=>delete p.issueBasis);const {planId,...body}=plan;
 const oldId=sha256(JSON.stringify(body)),id='chk_legacy_defer';
 await fs.writeFile(path.join(root,'.prodero/checkpoints',id+'.json'),JSON.stringify({id,createdAt:new Date().toISOString(),sessions:[],curationDefer:oldId}));
 assert.equal((await curationRecommendation(root)).projection.paused,true);
 let r=await createCurationReview(root);assert.equal((await view(root,r)).needsInputNow,0);assert.equal((await view(root,r)).deferredQuestions,0);
 r=await controlCurationReview(root,{...identity(r),action:'resume'});assert.equal((await curationRecommendation(root)).projection.needsInputNow,1);
});
test('old completed receipt remains replayable without snapshots or new basis metadata',async t=>{
 const root=await fixture(t,[safe()]);let r=await createCurationReview(root);r=await choose(root,r,proposal(r),'suggested');
 const req={...identity(r),...curationApplyBinding(r,selectedCurationProposals(r)),selectedIds:selectedCurationProposals(r)},result=await executeCurationReview(root,req);
 const checkpoint=JSON.parse(await fs.readFile(result.historyPath,'utf8'));checkpoint.curation.plan.proposals.forEach(p=>delete p.issueBasis);
 const {planId,...body}=checkpoint.curation.plan;const oldHash=sha256(JSON.stringify(body));checkpoint.curation.plan.planId=oldHash;checkpoint.curation.planId=oldHash;checkpoint.curation.review.planHash=oldHash;
 for(const key of ['reviewRevisionId','selectionHash','executionHash','reviewSnapshot','reviewState'])delete checkpoint.curation.review[key];
 checkpoint.curation.review.operationId=curationOperationId(req.reviewId,req.selectedIds);delete req.reviewRevisionId;delete req.selectionHash;
 await fs.writeFile(result.historyPath,JSON.stringify(checkpoint));await fs.rm(path.join(root,'.prodero/local/curation-reviews'),{recursive:true});
 const replay=await executeCurationReview(root,{...req,planHash:oldHash});assert.equal(replay.replayed,true);assert.equal(replay.checkpointId,result.checkpointId);assert.equal(replay.projection.applied,1);
});
test('new schema and retention failures are visible through the MCP diagnostic boundary',async t=>{
 const root=await fixture(t);let r=await createCurationReview(root);r=await defer(root,r);const c=await client(t,root);
 const limit=REVIEW_RETENTION.maxCount;REVIEW_RETENTION.maxCount=1;
 try{const result=await c.callTool({name:PRODERO_TOOLS.curationReview,arguments:{action:'create'}});assert.equal(result.isError,true);assert.equal(result.structuredContent.code,'review_retention_full');}finally{REVIEW_RETENTION.maxCount=limit;}
 const file=stateFile(root,r),data=JSON.parse(await fs.readFile(file,'utf8'));data.version=999;await fs.writeFile(file,JSON.stringify(data));
 const result=await c.callTool({name:PRODERO_TOOLS.curation,arguments:{action:'plan'}});assert.equal(result.isError,true);assert.equal(result.structuredContent.code,'unsupported_review_schema');
});

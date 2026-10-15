// Invented toy-project fixtures; no real project incidents or operational records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initializeProject} from '../dist/core/project.js';
import {writeKnowledge,listKnowledge} from '../dist/core/memory.js';
import {listCheckpoints,sha256} from '../dist/core/storage.js';
import {createCurationReview,loadCurationReview,stageCurationDecisions,controlCurationReview,curationApplyBinding,curationReviewView,resumeCurationReview,REVIEW_RETENTION,selectedCurationProposals} from '../dist/core/curation-review.js';
import {deriveDependencies,selectionProblems,validateRevision,sealRevision,curationSelectionHash,revisionHash} from '../dist/core/curation-revision.js';
import {executeCurationReview} from '../dist/curation-review-adapter.js';
import {curationRecommendation} from '../dist/core/knowledge-curation.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer,PRODERO_TOOLS} from '../dist/server.js';
const item=(id,content,extra={})=>({version:3,id,category:'instruction',contextPolicy:'required',authority:'legacy_inherited',applicability:{kind:'legacy'},scope:'global',scopeRef:null,priority:'normal',status:['sync','conflict'].includes(id)?'disputed':'active',title:id,content,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[],...extra});
const safe=(id='safe')=>item(id,`Decision:\nCedarAPI tests must preserve ${id} isolation.`);
const unresolved=()=>item('conflict','Decision:\nOrbitUI must rotate puzzle tiles by a quarter turn.');
const policy=()=>item('policy','Never rotate puzzle tiles; preserve the initial orientation.');
async function fixture(t,items=[safe(),unresolved(),policy()]){const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-revision-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await initializeProject(root);for(const i of items)await writeKnowledge(root,i);return root;}
const identity=r=>({reviewId:r.snapshot.reviewId,planHash:r.snapshot.planHash,decisionRevision:r.state.revision});
const request=(r,ids=selectedCurationProposals(r))=>({...identity(r),...curationApplyBinding(r,ids),selectedIds:ids});
const select=(root,r,ids=r.snapshot.units.filter(u=>u.applicable).map(u=>u.id))=>stageCurationDecisions(root,{...identity(r),decisions:Object.fromEntries(ids.map(id=>[id,'suggested']))});
const view=async(root,r)=>(await curationReviewView(root,r.snapshot.plan,r)).projection;
const bytes=async root=>JSON.stringify(await listKnowledge(root));
const snapshotPath=(root,r)=>path.join(root,'.prodero/local/curation-reviews',r.snapshot.reviewId+'.json');
async function defer(root,r){const unit=r.snapshot.units.find(u=>r.state.items[u.id].outcome==='unresolved');return controlCurationReview(root,{...identity(r),action:'defer_issue',unitId:unit.id});}
async function resealSnapshot(root,r,edit){const s=structuredClone(r.snapshot);edit(s.revision);const {id,...body}=s.revision;s.revision=sealRevision(body);const {snapshotHash,...body2}=s;s.snapshotHash=revisionHash(body2);await fs.writeFile(snapshotPath(root,r),JSON.stringify(s));const file=snapshotPath(root,r).replace('.json','.state.json'),journal=JSON.parse(await fs.readFile(file,'utf8'));journal.snapshotHash=s.snapshotHash;await fs.writeFile(file,JSON.stringify(journal));return s;}

test('immutable revision binds catalog, extractive validator, source/evidence, decisions and groups',async t=>{
 const root=await fixture(t),r=await createCurationReview(root),before=await fs.readFile(snapshotPath(root,r),'utf8'),rev=r.snapshot.revision;
 validateRevision(rev);assert.equal(rev.lineageId,r.snapshot.reviewId);assert.equal(rev.parentRevisionId,null);assert.equal(rev.typedPlan.kind,'extractive-v1');assert.equal(rev.baseline,r.snapshot.plan.fingerprint);assert.equal(rev.sources.length,3);assert.deepEqual(rev.groups,r.snapshot.units);assert.deepEqual(rev.decisionBinding.decisions,{});
 await defer(root,r);assert.equal(await fs.readFile(snapshotPath(root,r),'utf8'),before);assert.equal(await bytes(root),JSON.stringify(await listKnowledge(root)));
});
for(const variant of ['kind','validator','version','planVersion','dependencyVersion','dependencyEngine'])test(`unsupported revision ${variant} fails closed even after resealing`,async t=>{
 const root=await fixture(t),r=await createCurationReview(root),before=await bytes(root);
 await resealSnapshot(root,r,rev=>{if(variant==='kind')rev.typedPlan.kind='semantic-v2';if(variant==='validator')rev.typedPlan.validator='extractive-999';if(variant==='version')rev.version=999;if(variant==='planVersion')rev.typedPlan.plan.version=999;if(variant==='dependencyVersion')rev.dependencies.version=999;if(variant==='dependencyEngine')rev.dependencies.engine='client-independent';});
 await assert.rejects(loadCurationReview(root,r.snapshot.reviewId),e=>e.code==='invalid_review');assert.equal(await bytes(root),before);
});
for(const variant of ['hash','sources','evidence','manifest'])test(`revision integrity validates ${variant}`,async t=>{
 const root=await fixture(t),r=await createCurationReview(root),rev=structuredClone(r.snapshot.revision);
 if(variant==='hash'){rev.baseline='invalid';assert.throws(()=>validateRevision(rev));return;}
 if(variant==='sources')rev.sources[0].revision='f'.repeat(64);
 if(variant==='evidence')rev.evidence.push({path:'invented',revision:'f'.repeat(64)});
 if(variant==='manifest')rev.dependencies.groups[0].requires=['invented'];
 const {id,...body}=rev;assert.throws(()=>validateRevision(sealRevision(body)));
});
for(const deferred of [false,true])test(`independent atomic package applies with ${deferred?'deferred':'unresolved'} component and successor preserves it`,async t=>{
 const root=await fixture(t);let r=await createCurationReview(root);if(deferred)r=await defer(root,r);r=await select(root,r);const old=await fs.readFile(snapshotPath(root,r),'utf8'),req=request(r);
 const result=await executeCurationReview(root,req),next=result.successor;
 assert.equal(next.snapshot.revision.lineageId,r.snapshot.revision.lineageId);assert.equal(next.snapshot.revision.parentRevisionId,r.snapshot.revision.id);assert.equal(next.snapshot.revision.parentReviewId,r.snapshot.reviewId);assert.notEqual(next.snapshot.revision.baseline,r.snapshot.revision.baseline);assert.equal(await fs.readFile(snapshotPath(root,r),'utf8'),old);
 assert.equal(result.projection.applied,1);assert.equal(result.projection.lifecycle,'partially_applied');assert.equal(result.projection.unresolved,1);assert.equal(result.projection.deferredQuestions,deferred?1:0);assert.equal(result.projection.needsInputNow,deferred?0:1);
 assert.deepEqual((await curationRecommendation(root)).projection,result.projection);assert.deepEqual(await resumeCurationReview(root,r.snapshot.reviewId),next);
 const cp=JSON.parse(await fs.readFile(result.historyPath,'utf8'));assert.equal(cp.curation.review.reviewRevisionId,r.snapshot.revision.id);assert.equal(cp.curation.review.selectionHash,req.selectionHash);assert.deepEqual(cp.curation.selected,req.selectedIds);
 const replay=await executeCurationReview(root,req);assert.equal(replay.replayed,true);assert.equal(replay.checkpointId,result.checkpointId);assert.deepEqual(replay.successor,next);
});

test('explicit requested subset applies once; successor requires fresh decisions for remaining proposals',async t=>{
 const root=await fixture(t,[safe('a'),safe('b')]);let r=await select(root,await createCurationReview(root));const ids=[r.snapshot.plan.proposals[0].id],req=request(r,ids),result=await executeCurationReview(root,req);
 assert.deepEqual(result.applied,ids);assert.equal(result.projection.readyChangeGroups,1);assert.equal(result.projection.included,0);assert.equal(result.projection.canApply,false);
 await assert.rejects(executeCurationReview(root,request(r,['b'])),e=>e.code==='stale_review');
 const next=await select(root,result.successor),final=await executeCurationReview(root,request(next));assert.equal(final.projection.lifecycle,'completed');assert.equal(final.projection.applied,2);assert.equal(final.successor.snapshot.revision.parentRevisionId,next.snapshot.revision.id);
 const oldReplay=await executeCurationReview(root,req);assert.equal(oldReplay.checkpointId,result.checkpointId);
});

test('shared source, shared output and explicit relations require exact closure; no client expansion',async t=>{
 const root=await fixture(t,[safe('a'),safe('b')]),r=await createCurationReview(root),plan=r.snapshot.plan,units=r.snapshot.units;
 for(const kind of ['source','output','relation']){
  const p=structuredClone(plan);if(kind==='source')p.proposals[1].sourceId=p.proposals[0].sourceId;
  if(kind==='output')p.proposals[1].outputs[0].id=p.proposals[0].outputs[0].id;
  if(kind==='relation')p.proposals[0].before.relations=[{type:'depends_on',target:'b'}];
  const d=deriveDependencies(p,units,r.snapshot.revision.sources);assert.ok(selectionProblems(d,['a']).some(p=>p.reason==='requires'));assert.deepEqual(selectionProblems(d,['a','b']),[]);
 }
});

test('server derives explicit dependency; incomplete reviewed selection fails atomically with explanation',async t=>{
 const a=safe('a');a.relations=[{type:'depends_on',target:'b'}];const root=await fixture(t,[a,safe('b')]);let r=await select(root,await createCurationReview(root));
 const before=await bytes(root),req=request(r,['a']);await assert.rejects(executeCurationReview(root,req),e=>e.code==='dependency_blocked'&&e.details.problems.some(p=>p.reason==='requires'));
 assert.equal(await bytes(root),before);assert.equal((await listCheckpoints(root)).filter(c=>c.curation).length,0);
 const result=await executeCurationReview(root,request(r));assert.deepEqual(result.applied,['a','b']);
});

test('unresolved shared policy blocks connected proposal, including after Decide later',async t=>{
 const a=safe('a');a.relations=[{type:'depends_on',target:'conflict'}];const root=await fixture(t,[a,unresolved(),policy()]);let r=await select(root,await createCurationReview(root));
 assert.equal((await view(root,r)).blockedGroups,1);assert.equal((await view(root,r)).readyChangeGroups,0);const before=await bytes(root);
 await assert.rejects(executeCurationReview(root,request(r)),e=>e.code==='dependency_blocked');r=await defer(root,r);assert.equal((await view(root,r)).deferredQuestions,1);assert.equal((await view(root,r)).blockedGroups,1);await assert.rejects(executeCurationReview(root,request(r)),e=>e.code==='dependency_blocked');assert.equal(await bytes(root),before);
});

test('unknown dependency blocks only its component; incomplete evidence blocks independence',async t=>{
 const a=safe('a');a.relations=[{type:'depends_on',target:'missing'}];const root=await fixture(t,[a,safe('b')]),r=await select(root,await createCurationReview(root)),p=await view(root,r);
 assert.equal(p.blockedGroups,1);assert.deepEqual(p.selectedIds,['b']);await assert.rejects(executeCurationReview(root,request(r,['a'])),e=>e.code==='dependency_blocked');
 const plan={...r.snapshot.plan,evidenceTruncated:true};const d=deriveDependencies(plan,r.snapshot.units,r.snapshot.revision.sources);assert.ok(selectionProblems(d,['b']).some(p=>p.reason==='incomplete'));
 const result=await executeCurationReview(root,request(r,['b']));assert.deepEqual(result.applied,['b']);assert.equal(result.projection.blockedGroups,1);
});

test('selection hash and decision revision are exact; missing revision binding cannot downgrade',async t=>{
 const root=await fixture(t),r=await select(root,await createCurationReview(root)),req=request(r),before=await bytes(root);
 for(const changed of [{selectionHash:'f'.repeat(64)},{decisionRevision:r.state.revision+1},{reviewRevisionId:'revision_'+'f'.repeat(64)},{reviewRevisionId:undefined,selectionHash:undefined}])await assert.rejects(executeCurationReview(root,{...req,...changed}),e=>['invalid_selection','review_changed','stale_review'].includes(e.code));
 assert.equal(await bytes(root),before);
});

test('full-catalog stale validation rejects even unrelated knowledge changes atomically',async t=>{
 const root=await fixture(t,[safe('a'),safe('b')]),r=await select(root,await createCurationReview(root));await writeKnowledge(root,item('unrelated','Always preserve privacy.'));const before=await bytes(root);
 await assert.rejects(executeCurationReview(root,request(r)),e=>e.code==='stale_review');assert.equal(await bytes(root),before);assert.equal((await listCheckpoints(root)).filter(c=>c.curation).length,0);
});

test('commit-before-successor crash recovers on reopen without repeating mutation',async t=>{
 const root=await fixture(t);let r=await defer(root,await createCurationReview(root));r=await select(root,r);const req=request(r),rename=fs.rename;let failed=false;
 fs.rename=async(from,to)=>{if(!failed&&String(to).includes('/curation-reviews/')&&String(to).endsWith('.json')&&!String(to).endsWith('.state.json')){failed=true;throw new Error('crash after commit');}return rename(from,to);};
 try{await assert.rejects(executeCurationReview(root,req),/crash after commit/);}finally{fs.rename=rename;}
 const before=await bytes(root),checkpoints=(await listCheckpoints(root)).filter(c=>c.curation);assert.equal(checkpoints.length,1);
 const successor=await resumeCurationReview(root,r.snapshot.reviewId);assert.equal(successor.snapshot.revision.parentRevisionId,r.snapshot.revision.id);assert.equal((await view(root,successor)).deferredQuestions,1);assert.equal((await view(root,successor)).needsInputNow,0);assert.equal(await bytes(root),before);
 const replay=await executeCurationReview(root,req);assert.equal(replay.replayed,true);assert.equal(replay.checkpointId,checkpoints[0].id);assert.equal((await listCheckpoints(root)).filter(c=>c.curation).length,1);
});

test('recovery does not carry a deferral whose source binding changed after commit',async t=>{
 const root=await fixture(t);let r=await defer(root,await createCurationReview(root));r=await select(root,r);const req=request(r),rename=fs.rename;
 fs.rename=async(from,to)=>{if(String(to).includes('/curation-reviews/')&&String(to).endsWith('.json'))throw new Error('stop successor');return rename(from,to);};
 try{await assert.rejects(executeCurationReview(root,req),/stop successor/);}finally{fs.rename=rename;}
 const changed=unresolved();changed.content+=' Keep both workflows documented.';await writeKnowledge(root,changed);
 const next=await resumeCurationReview(root,r.snapshot.reviewId),p=await view(root,next);assert.equal(p.deferredQuestions,0);assert.equal(p.needsInputNow,1);assert.equal(next.snapshot.revision.invalidatedDecisions.length,1);
});

test('receipt-first replay still validates immutable revision integrity',async t=>{
 const root=await fixture(t),r=await select(root,await createCurationReview(root)),req=request(r),result=await executeCurationReview(root,req),cp=JSON.parse(await fs.readFile(result.historyPath,'utf8'));
 cp.curation.review.reviewSnapshot.revision.typedPlan.validator='semantic';await fs.writeFile(result.historyPath,JSON.stringify(cp));const before=await bytes(root);
 await assert.rejects(executeCurationReview(root,req),e=>e.code==='invalid_review');assert.equal(await bytes(root),before);
});

test('retention reserves successor before mutation and never evicts pending history',async t=>{
 const root=await fixture(t),r=await select(root,await createCurationReview(root)),before=await bytes(root),limit=REVIEW_RETENTION.maxCount;REVIEW_RETENTION.maxCount=1;
 try{await assert.rejects(executeCurationReview(root,request(r)),e=>e.code==='review_retention_full');}finally{REVIEW_RETENTION.maxCount=limit;}
 assert.equal(await bytes(root),before);assert.deepEqual((await loadCurationReview(root,r.snapshot.reviewId)).state.decisions,r.state.decisions);
});

test('true legacy v1 snapshot uses legacy selection and remains replayable',async t=>{
 const root=await fixture(t,[safe('a'),safe('b')]);let r=await createCurationReview(root);const snapshot=structuredClone(r.snapshot);delete snapshot.revision;snapshot.version=1;const {snapshotHash,...body}=snapshot;snapshot.snapshotHash=revisionHash(body);await fs.writeFile(snapshotPath(root,r),JSON.stringify(snapshot));await fs.writeFile(snapshotPath(root,r).replace('.json','.state.json'),JSON.stringify({revision:0,snapshotHash:snapshot.snapshotHash,decisions:{}}));
 r=await select(root,await loadCurationReview(root,r.snapshot.reviewId));const req=request(r);assert.equal(req.reviewRevisionId,undefined);await assert.rejects(executeCurationReview(root,{...req,selectedIds:['a']}),e=>e.code==='invalid_selection');
 const result=await executeCurationReview(root,req);assert.equal(result.successor,undefined);assert.equal((await executeCurationReview(root,req)).checkpointId,result.checkpointId);
});

test('App transport exposes structured missing closure and cannot accept supplied dependencies or outputs',async t=>{
 const a=safe('a');a.relations=[{type:'depends_on',target:'b'}];const root=await fixture(t,[a,safe('b')]),r=await select(root,await createCurationReview(root));
 const server=createServer({projectRoot:root}),client=new Client({name:'revision-app',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}}),[x,y]=InMemoryTransport.createLinkedPair();await server.connect(y);await client.connect(x);t.after(async()=>{await client.close();await server.close();});
 const result=await client.callTool({name:PRODERO_TOOLS.curationApply,arguments:request(r,['a'])});assert.equal(result.structuredContent.code,'dependency_blocked');assert.equal(result.structuredContent.details.problems[0].reason,'requires');
 for(const injected of [{dependencies:[]},{outputs:[]},{approved:true}])assert.equal((await client.callTool({name:PRODERO_TOOLS.curationApply,arguments:{...request(r),...injected}})).isError,true);
});

test('new snapshot cannot omit revision or masquerade as legacy v1',async t=>{
 const root=await fixture(t),r=await createCurationReview(root);assert.equal(r.snapshot.version,2);
 for(const downgrade of [false,true]){const s=structuredClone(r.snapshot);if(downgrade)s.version=1;else delete s.revision;const {snapshotHash,...body}=s;s.snapshotHash=revisionHash(body);await fs.writeFile(snapshotPath(root,r),JSON.stringify(s));await assert.rejects(loadCurationReview(root,r.snapshot.reviewId),e=>e.code==='invalid_review');}
});

test('deferring a required proposed group blocks its dependent without changing analysis outcome',async t=>{
 const a=safe('a');a.relations=[{type:'depends_on',target:'b'}];const root=await fixture(t,[a,safe('b')]);let r=await select(root,await createCurationReview(root));const unit=r.snapshot.units.find(u=>u.proposalIds.includes('b'));
 r=await controlCurationReview(root,{...identity(r),action:'defer_change',unitId:unit.id});const p=await view(root,r);assert.equal(p.readyChangeGroups,0);assert.equal(p.deferredChanges,1);assert.equal(p.items.find(i=>i.proposalIds.includes('a')).blocked,true);assert.equal(p.proposed,2);assert.equal(p.canApply,false);
 await assert.rejects(executeCurationReview(root,request(r,['a'])),e=>e.code==='dependency_blocked');
});

test('successor and shared attention projection survive a fresh Node process',async t=>{
 const root=await fixture(t);let r=await defer(root,await createCurationReview(root));r=await select(root,r);const result=await executeCurationReview(root,request(r));
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const code=`import {resumeCurationReview,curationReviewView} from ${JSON.stringify(new URL('../dist/core/curation-review.js',import.meta.url).href)};const r=await resumeCurationReview(process.argv[1],process.argv[2]);console.log(JSON.stringify({review:r,projection:(await curationReviewView(process.argv[1],r.snapshot.plan,r)).projection}));`;
 const fresh=JSON.parse((await promisify(execFile)(process.execPath,['--input-type=module','-e',code,root,r.snapshot.reviewId])).stdout);assert.deepEqual(fresh.review,result.successor);assert.deepEqual(fresh.projection,JSON.parse(JSON.stringify(result.projection)));
});

test('all selected sources are validated before any member of the transaction is changed',async t=>{
 const root=await fixture(t,[safe('a'),safe('b')]),r=await select(root,await createCurationReview(root));await writeKnowledge(root,safe('b_changed'));const before=await bytes(root);await assert.rejects(executeCurationReview(root,request(r)),e=>e.code==='stale_review');assert.equal(await bytes(root),before);
});

test('decision journal baseline remains anchored to the immutable revision',async t=>{
 const root=await fixture(t),r=await createCurationReview(root),file=snapshotPath(root,r).replace('.json','.state.json'),journal=JSON.parse(await fs.readFile(file,'utf8'));journal.base.paused=true;await fs.writeFile(file,JSON.stringify(journal));await assert.rejects(loadCurationReview(root,r.snapshot.reviewId),e=>e.code==='invalid_review');
});

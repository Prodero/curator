import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createMemoryBundleFixture,fixtureItem,observeFixture} from './helpers/memory-bundle-fixtures.mjs';
import {fixtureProposal} from './helpers/memory-proposal-fixtures.mjs';
import {getMemoryIntelligencePlan} from '../dist/core/memory-intelligence.js';
import {prepareMemoryTransformation,validateMemoryTransformationProposal} from '../dist/core/memory-transformation-proposal.js';
import {previewMemoryTransformation as preview,applyMemoryTransformation as apply} from '../dist/core/memory-transformation.js';
import {readKnowledgeInventory,getKnowledgeProvenance} from '../dist/core/knowledge-provenance.js';
import {listKnowledge,writeKnowledge,parseKnowledge} from '../dist/core/memory.js';
import {sha256,listCheckpoints} from '../dist/core/storage.js';
import {withSyncLock} from '../dist/core/sync-transaction.js';
const file=(f,p)=>path.join(f.root,'.prodero',p);
const approval=(p,extra={})=>({initiatedByUser:true,reviewedPreviewId:p.previewId,...extra});
async function snapshot(root){const files={};async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else files[p.slice(root.length)]=[sha256(await fs.readFile(p,'utf8')),(await fs.stat(p)).mtimeMs];}}await walk(path.join(root,'.prodero'));return files;}
async function setup(t,scenario='fragmentation',edit){const f=await createMemoryBundleFixture(scenario);t.after(f.cleanup);const c=(await getMemoryIntelligencePlan(f.root)).candidates[0];const {bundle}=await prepareMemoryTransformation(f.root,c.id);const proposal=fixtureProposal(bundle,scenario);if(edit)edit(proposal,bundle);const validated=await validateMemoryTransformationProposal(f.root,proposal);const p=await preview(f.root,validated);return {...f,bundle,proposal,validated,p};}
function allApproval(p){return approval(p,{approvedVersioned:true,approvedSemanticLimitations:true});}

test('translation generates stable Core IDs and exact semantics, scope, metadata and all-source evidence',async t=>{
 const f=await setup(t),p=f.p;assert.equal(p.requiresVersionedReview,false);assert.equal(p.localDirectApplyEligible,true);assert.equal(p.lifecycle.changes.length,6);assert.equal(p.summary.created.length,2);assert.equal(p.summary.archives.length,4);
 const again=await preview(f.root,f.validated);assert.deepEqual(again.draftIds,p.draftIds);
 for(const r of f.proposal.records){const created=p.lifecycle.changes.find(c=>c.id===p.draftIds[r.key]);const item=parseKnowledge(created.after,created.id+'.md');assert.match(item.id,/^mem_[a-f0-9]{40}$/);assert.equal(item.content,r.body);assert.equal(item.title,r.title);assert.equal(item.category,r.category);assert.equal(item.priority,r.priority);assert.equal(item.scope,'module');assert.equal(item.scopeKind,'path');assert.equal(item.scopeRef,r.path);assert.deepEqual(item.related,[...r.sourceIds].sort());for(const id of r.sourceIds)assert.ok(item.derivedFrom.includes(id));}
 const before=await snapshot(f.root);await preview(f.root,f.validated);assert.deepEqual(await snapshot(f.root),before);
});
test('Local fragmentation applies 4 → 2, archives in leave-current month and preserves history/provenance',async t=>{
 const f=await setup(t),prior=await readKnowledgeInventory(f.root),pressure=await fs.readFile(file(f,'local/memory-pressure.json'),'utf8');const result=await apply(f.root,f.p,approval(f.p));assert.equal(result.alreadyApplied,false);assert.deepEqual(result.summary,f.p.summary);assert.equal((await listKnowledge(f.root)).length,2);
 for(const id of f.ids){const r=await getKnowledgeProvenance(f.root,id),old=prior.find(r=>r.item.id===id).item;assert.equal(r.storage,'archive');assert.equal(r.item.status,'consolidated');assert.equal(r.superseded_by.length,0);assert.equal(r.consolidated_into.length,1);assert.equal(r.path,`local/archive/${f.p.createdAt.slice(0,7).replace('-','_')}/${id}.md`);for(const k of ['content','title','category','scope','scopeRef','priority','createdAt'])assert.deepEqual(r.item[k],old[k]);assert.deepEqual(r.item.sourceSessions,old.sourceSessions);}
 assert.equal((await readKnowledgeInventory(f.root)).length,6);assert.equal(await fs.readFile(file(f,'local/memory-pressure.json'),'utf8'),pressure);assert.equal((await getMemoryIntelligencePlan(f.root)).candidateCount,0);
 const replay=await apply(f.root,f.p,approval(f.p));assert.equal(replay.alreadyApplied,true);assert.equal(replay.checkpoint,result.checkpoint);assert.deepEqual(replay.summary,result.summary);assert.equal((await listCheckpoints(f.root)).length,1);
});
test('evolution distinguishes genuine obsolete current state from valid consolidated evidence',async t=>{
 const f=await createMemoryBundleFixture('evolution');t.after(f.cleanup);
 // Controlled current contradiction: 00 states fixed-step; 02 still records the old integrator.
 await writeKnowledge(f.root,fixtureItem(f.ids[2],{title:'Old driving integrator',content:'The driving integrator still uses variable frame delta.'}),false,'local');
 const c=(await getMemoryIntelligencePlan(f.root)).candidates[0],{bundle}=await prepareMemoryTransformation(f.root,c.id);const input=fixtureProposal(bundle,'evolution');input.records[0].body='Driving traction uses a fixed 60 Hz step. Calculate tire forces before integrating chassis velocity. The variable frame delta integrator has been replaced.';
 const obsolete=input.dispositions.find(d=>d.sourceId===f.ids[2]);obsolete.action='supersede';obsolete.rationale='The fixed-step current source replaces the obsolete variable-delta integrator.';obsolete.coverage='The obsolete integrator is preserved as superseded historical evidence.';
 const validated=await validateMemoryTransformationProposal(f.root,input),p=await preview(f.root,validated);await apply(f.root,p,allApproval(p));
 assert.equal((await getKnowledgeProvenance(f.root,f.ids[2])).item.status,'superseded');assert.equal((await getKnowledgeProvenance(f.root,f.ids[0])).item.status,'consolidated');const next=await getKnowledgeProvenance(f.root,p.draftIds.draft_physics);assert.deepEqual(next.supersedes,[f.ids[2]]);assert.deepEqual(next.consolidates,[f.ids[0]]);assert.deepEqual((await getKnowledgeProvenance(f.root,'mem_previous')).superseded_by,[f.ids[0]]);
});
test('mixed preview requires exact Versioned approval and cannot apply Local half',async t=>{
 const f=await setup(t,'mixed'),before=await snapshot(f.root);assert.equal(f.p.requiresVersionedReview,true);assert.equal(f.p.versionedEffects.length,4);assert.ok(f.p.summary.created.every(r=>r.layer==='versioned'));
 await assert.rejects(apply(f.root,f.p,approval(f.p)),/Versioned/);await assert.rejects(apply(f.root,f.p,{...allApproval(f.p),reviewedPreviewId:'0'.repeat(64)}),/exact/);assert.deepEqual(await snapshot(f.root),before);
 await apply(f.root,f.p,allApproval(f.p));assert.equal((await listKnowledge(f.root,'versioned')).length,2);assert.equal((await listKnowledge(f.root,'local')).length,0);
 assert.equal(f.p.summary.archives.filter(r=>r.layer==='versioned').length,2);for(const id of f.ids.slice(0,2))assert.match((await getKnowledgeProvenance(f.root,id)).path,/^archive\//);
});
test('each output layer follows its replacement sources, not unrelated Versioned evidence',async t=>{
 const f=await setup(t,'mixed',(p)=>{p.records[0].sourceIds=['mem_driving_00','mem_driving_01'];p.records[1].sourceIds=['mem_driving_00','mem_driving_02','mem_driving_03'];for(const d of p.dispositions)d.proposedKeys=[['mem_driving_00','mem_driving_01'].includes(d.sourceId)?'draft_physics':'draft_verification'];});
 assert.deepEqual(f.p.summary.created.map(r=>r.layer),['versioned','local']);await apply(f.root,f.p,allApproval(f.p));assert.deepEqual((await getKnowledgeProvenance(f.root,f.p.draftIds.draft_verification)).item.related,['mem_driving_00','mem_driving_02','mem_driving_03']);
});
test('protected no-op keeps sources byte-for-byte and cannot be made destructive by forging validated review',async t=>{
 const f=await setup(t,'protected'),before=await readKnowledgeInventory(f.root);assert.equal(f.p.lifecycle.changes.length,0);await apply(f.root,f.p,approval(f.p));assert.deepEqual(await readKnowledgeInventory(f.root),before);assert.equal(f.p.summary.protectedSources.length,2);
 const g=await setup(t,'protected');g.validated.proposal.records=[{key:'draft_bad',category:'state',scope:'project',priority:'normal',title:'Invalid retirement',body:'Retire policy.',sourceIds:[g.ids[0]]}];g.validated.proposal.dispositions[0].action='consolidate';g.validated.proposal.dispositions[0].proposedKeys=['draft_bad'];await assert.rejects(preview(g.root,g.validated),/Protected/);
});
test('keep and unresolved stay current unchanged; semantic limitations require review',async t=>{
 const f=await setup(t,'fragmentation',p=>{p.records=p.records.filter(r=>r.key==='draft_physics');for(const d of p.dispositions.filter(d=>d.proposedKeys[0]==='draft_verification')){d.proposedKeys=[];d.action='keep';}const d=p.dispositions.find(d=>d.sourceId==='mem_driving_03');d.action='unresolved';d.unresolvedInformation=['Need evidence about replay tolerances.'];});
 const old=await readKnowledgeInventory(f.root);assert.equal(f.p.requiresSemanticReview,true);assert.equal(f.p.localDirectApplyEligible,false);await assert.rejects(apply(f.root,f.p,approval(f.p)),/limitations/);const result=await apply(f.root,f.p,allApproval(f.p));assert.deepEqual(result.summary.unresolved,['mem_driving_03']);for(const id of [f.ids[1],f.ids[3]])assert.deepEqual((await readKnowledgeInventory(f.root)).find(r=>r.item.id===id),old.find(r=>r.item.id===id));assert.equal((await listKnowledge(f.root)).length,3);
});
test('historical provenance remains traversable and original archives are untouched',async t=>{
 const f=await setup(t,'provenance',p=>p.records[0].sourceIds.push('mem_old_lesson'));const before=(await readKnowledgeInventory(f.root)).filter(r=>r.storage==='archive');await apply(f.root,f.p,allApproval(f.p));const after=await readKnowledgeInventory(f.root);for(const r of before)assert.deepEqual(after.find(a=>a.item.id===r.item.id),r);assert.equal((await getKnowledgeProvenance(f.root,f.ids[0])).supersedes[0],'mem_old_state');assert.equal((await getKnowledgeProvenance(f.root,'mem_old_state')).supersedes[0],'mem_deeper');assert.ok((await getKnowledgeProvenance(f.root,f.p.draftIds.draft_physics)).item.related.includes('mem_old_lesson'));
});
for(const changed of ['source','history','telemetry','unrelated'])test(`changed ${changed} invalidates exact preview and Versioned approval`,async t=>{
 const f=await setup(t,changed==='history'?'provenance':'mixed');if(changed==='source')await fs.appendFile(file(f,f.bundle.activeSources[0].path),'\nChanged evidence.');else if(changed==='history')await fs.appendFile(file(f,f.bundle.historicalSources[0].path),'\nChanged historical evidence.');else if(changed==='telemetry')await observeFixture(f.root,f.ids,3);else await writeKnowledge(f.root,fixtureItem('mem_other',{scopeRef:'billing'}),false,'local');const before=await readKnowledgeInventory(f.root);await assert.rejects(apply(f.root,f.p,allApproval(f.p)),/Stale|mismatched/);assert.deepEqual(await readKnowledgeInventory(f.root),before);
});
test('explicit workflow and exact root/preview are required; altered lifecycle plan is not trusted even if rehashed',async t=>{
 const f=await setup(t),g=await setup(t);await assert.rejects(apply(f.root,f.p,{reviewedPreviewId:f.p.previewId}));await assert.rejects(apply(g.root,f.p,approval(f.p)),/another project/);
 const tampered=structuredClone(f.p);tampered.lifecycle.proposal.archive=[];const {previewId,...rest}=tampered;tampered.previewId=sha256(JSON.stringify(rest));await assert.rejects(apply(f.root,tampered,approval(tampered)),/mismatched/);
 await assert.rejects(apply(f.root,{...f.p,summary:{}},approval(f.p)),/modified/);
});
for(const stage of ['archive','create','checkpoint'])test(`interruption at ${stage} blocks reads and exact approved retry recovers one complete mixed transaction`,async t=>{
 const f=await setup(t,'mixed'),rename=fs.rename;let failed=false;
 fs.rename=async(from,to)=>{if(!failed&&(stage==='archive'?String(to).includes('/archive/'):stage==='create'?String(to).endsWith('/'+f.p.summary.created[1].id+'.md'):String(to).includes('/checkpoints/'))){failed=true;throw new Error('Injected transformation failure');}return rename(from,to);};
 try{await assert.rejects(apply(f.root,f.p,allApproval(f.p)),/Injected/);}finally{fs.rename=rename;}
 assert.ok(failed);await assert.rejects(listKnowledge(f.root),/pending recovery/);await assert.rejects(getMemoryIntelligencePlan(f.root),/pending/);await assert.rejects(preview(f.root,f.validated),/pending/);
 const result=await apply(f.root,f.p,allApproval(f.p));assert.equal(result.alreadyApplied,true);const inv=await readKnowledgeInventory(f.root);assert.equal(inv.length,6);assert.equal(inv.filter(r=>r.storage==='current').length,2);assert.equal(inv.filter(r=>r.storage==='archive').length,4);assert.equal((await listCheckpoints(f.root)).length,1);assert.deepEqual((await apply(f.root,f.p,allApproval(f.p))).summary,result.summary);
});
test('unrelated async caller cannot use another operation writer capability',async t=>{
 const f=await setup(t);let entered,release;const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r);const writer=withSyncLock(f.root,async()=>{entered();await hold;});await ready;try{await assert.rejects(getMemoryIntelligencePlan(f.root),/storage writer/);}finally{release();await writer;}assert.ok((await getMemoryIntelligencePlan(f.root)).candidateCount);
});
test('scope and content mapping cannot silently change semantic meaning',async t=>{
 for(const [scope,priority] of [['project','normal'],['global','important']]){const f=await setup(t,'fragmentation',p=>{for(const r of p.records){r.scope=scope;r.priority=priority;delete r.path;}});await apply(f.root,f.p,approval(f.p));for(const i of await listKnowledge(f.root)){const original=(await readKnowledgeInventory(f.root)).find(r=>i.related.includes(r.item.id)).item;assert.equal(i.scope,original.scope);assert.equal(i.scopeKind,original.scopeKind);assert.equal(i.scopeRef,original.scopeRef);assert.equal(i.priority,priority);}}
 const f=await setup(t);const v=structuredClone(f.validated);v.proposal.records[0].title='Multi\nline title';const checked=await validateMemoryTransformationProposal(f.root,v.proposal);await assert.rejects(preview(f.root,checked),/alter semantic content/);
});
test('a read straddling a completed transaction fails instead of returning a mixed graph',async t=>{
 const f=await setup(t),read=fs.readFile;let triggered=false;
 fs.readFile=async(target,...args)=>{const body=await read(target,...args);if(!triggered&&String(target)===file(f,`local/memory/${f.ids.at(-1)}.md`)){triggered=true;await apply(f.root,f.p,approval(f.p));}return body;};
 try{await assert.rejects(listKnowledge(f.root),/committed during read/);}finally{fs.readFile=read;}
 assert.ok(triggered);assert.equal((await listKnowledge(f.root)).length,2);
});
test('Versioned supporting evidence kept unchanged does not force Local draft publication',async t=>{
 const f=await setup(t,'mixed',p=>{p.records=[{...p.records[0],sourceIds:['mem_driving_00','mem_driving_02','mem_driving_03']}];for(const d of p.dispositions){if(['mem_driving_00','mem_driving_01'].includes(d.sourceId)){d.action='keep';d.proposedKeys=[];}else d.proposedKeys=['draft_physics'];}});
 const before=(await readKnowledgeInventory(f.root)).filter(r=>r.layer==='versioned');assert.equal(f.p.requiresVersionedReview,false);assert.equal(f.p.summary.created[0].layer,'local');await apply(f.root,f.p,approval(f.p));assert.deepEqual((await readKnowledgeInventory(f.root)).filter(r=>r.layer==='versioned'),before);
});
test('one source may contribute to several drafts without duplicate archive moves',async t=>{
 const f=await setup(t,'fragmentation',p=>{p.dispositions[0].proposedKeys.push('draft_verification');p.records[1].sourceIds.push(p.dispositions[0].sourceId);});await apply(f.root,f.p,approval(f.p));assert.equal((await getKnowledgeProvenance(f.root,f.ids[0])).consolidated_into.length,2);assert.equal(f.p.summary.archives.length,4);
});
test('stale validated proposal cannot receive a new preview; old approval cannot approve a fresh preview',async t=>{
 const f=await setup(t,'mixed');const newer=await preview(f.root,f.validated);assert.notEqual(newer.previewId,f.p.previewId);await assert.rejects(apply(f.root,newer,allApproval(f.p)),/exact/);await fs.appendFile(file(f,f.bundle.activeSources[0].path),'\nUpdated after validation');await assert.rejects(preview(f.root,f.validated),/Stale/);
});
test('priority is independent of applicability; semantic omissions still require review',async t=>{
 const f=await setup(t);let input=structuredClone(f.proposal);input.records[0].scope='project';input.records[0].priority='critical';delete input.records[0].path;let validated=await validateMemoryTransformationProposal(f.root,input);const safe=await preview(f.root,validated);const created=safe.lifecycle.changes.filter(c=>!c.from);assert.ok(created.length);assert.ok(created.every(c=>parseKnowledge(c.after,c.id+'.md').priority!=='critical'));
 input=structuredClone(f.proposal);input.dispositions[0].omittedAsRedundant=['Repeated fixed-step explanation.'];validated=await validateMemoryTransformationProposal(f.root,input);const p=await preview(f.root,validated);assert.equal(p.requiresSemanticReview,true);await assert.rejects(apply(f.root,p,approval(p)),/limitations/);await apply(f.root,p,allApproval(p));
});

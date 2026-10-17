// Invented toy-project fixtures; no real project incidents or operational records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { PluginRegistry } from '../dist/plugins/registry.js';
import { createPluginContext } from '../dist/plugins/context.js';
import { initializeProject, getDetailedProjectStatus } from '../dist/core/project.js';
import { readImportState, applyImport } from '../dist/core/imports.js';
import { digestTree, hasSecret, snapshotFiles } from '../dist/core/plugin-files.js';
import { listKnowledge, writeKnowledge } from '../dist/core/memory.js';
import { listProjectSkills } from '../dist/core/skills.js';
const S = createRequire(import.meta.url)('../plugins/migrate_ai_studio/schema.cjs');
const hash = v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const seal = p=>{const {planId,...body}=p;return {...body,planId:hash(body)};};
const pluginId='migrate_ai_studio';
import { fixture, analysisFor } from './helpers/migrate-ai-studio.mjs';
async function planned(f) {const audited=await f.call('audit',{semantic:true,repositoryPaths:['README.md','src/store.ts']});const analysis=analysisFor(audited.auditPackage);return {audited,analysis,...await f.call('plan',{auditPackage:audited.auditPackage,analysis})};}
async function reviewed(f,plan,activate=false) {return (await f.call('review',{plan,decisions:plan.items.map(i=>({id:i.id,include:i.include,activateSkill:activate&&i.classification==='skill_candidate'}))})).plan;}

test('detection is optional, bounded and read-only; audit excludes secrets and supplies instructions without sampling',async t=>{
  const f=await fixture(t);const before=await snapshotFiles(f.root,'.prodero');const source=await snapshotFiles(f.root,'.ai-studio');
  const result=await f.call('detect');assert.equal(result.detected,true);assert.equal(result.files,5);
  const estimate=await f.call('estimate',{repositoryPaths:['README.md','src/store.ts']});assert.equal(estimate.stage,'estimate');assert.match(estimate.notice,/No model call/);assert.equal(estimate.costEstimate.estimatedTotalTokens,0);
  const audit=await f.call('audit',{repositoryPaths:['README.md','src/store.ts']});assert.equal(audit.stage,'review');assert.equal(audit.extractionMode,'deterministic-memory-v1');
  assert.equal(audit.plan.costEstimate.method,'estimated-utf8-bytes-div-4-v1');assert.equal(audit.plan.costEstimate.estimatedTotalTokens,0);assert.equal(audit.plan.costEstimate.sourceFiles,4);
  assert.equal(audit.plan.items.length,1);assert.equal(audit.plan.items[0].include,true);assert.match(audit.plan.items[0].content,/Decision:[\s\S]*atomic writes/);
  assert.ok(!JSON.stringify(audit).includes('sk-fake'));assert.deepEqual(await snapshotFiles(f.root,'.prodero'),before);assert.deepEqual(await snapshotFiles(f.root,'.ai-studio'),source);
  await fs.rename(path.join(f.root,'.ai-studio'),path.join(f.root,'legacy-disabled'));assert.equal((await f.call('detect')).detected,false);
});

test('secret screening does not combine harmless words and assignments across lines',()=>{
  assert.equal(hasSecret('Keep passwords out of logs.\nmode = production'),false);
  assert.equal(hasSecret(JSON.stringify('Privacy and authorization:\nAutomatic matching requires one exact sender.')),false);
  assert.equal(hasSecret('password = actual-secret-value'),true);
});

test('default local audit extracts and imports structured project memory without a model',async t=>{
  const f=await fixture(t);const result=await f.call('audit');assert.equal(result.plan.extractionMode,'deterministic-memory-v1');assert.equal(result.plan.items.length,1);
  assert.doesNotMatch(result.plan.items[0].content,/\b(?:TASK|EPIC)[-_ ]?\d+|\.ai-studio\//i);
  const plan=(await f.call('review',{planId:result.plan.planId,decisions:result.plan.items.map(i=>({id:i.id,include:i.include,activateSkill:false}))})).plan;
  const applied=await f.call('apply',{planId:plan.planId,approvedPlanId:plan.planId});assert.equal(applied.imported,1);
  const knowledge=await listKnowledge(f.root);assert.equal(knowledge.length,1);assert.ok(knowledge.some(i=>/Never bypass the atomic writer/.test(i.content)));
  assert.doesNotMatch(knowledge[0].content,/\b(?:TASK|EPIC)[-_ ]?\d+|\.ai-studio\//i);assert.ok(knowledge[0].evidence.length);
  assert.ok(knowledge[0].derivedFrom.includes(`plugin:migrate_ai_studio@1.7.0/plan:${plan.planId}`));
  assert.equal((await f.call('verify',{planId:plan.planId,receipt:applied.receipt})).valid,true);
});

test('end-to-end audit/plan/review/apply/verify preserves source, respects classification and replay is idempotent',async t=>{
  const f=await fixture(t);const sourceBefore=await snapshotFiles(f.root,'.ai-studio');const repoBefore=await snapshotFiles(f.root,'.');
  const {plan,analysis}=await planned(f);assert.equal(S.analysis.safeParse(analysis).success,true);
  assert.equal(plan.items.filter(i=>!i.include).length,4);
  await assert.rejects(f.call('apply',{plan,approvedPlanId:plan.planId}),/reviewed/);
  const approved=await reviewed(f,plan,true);
  const applied=await f.call('apply',{plan:approved,approvedPlanId:approved.planId});assert.equal(applied.imported,3);assert.equal(applied.skipped,4);
  const knowledge=await listKnowledge(f.root);assert.equal(knowledge.length,2);assert.ok(knowledge.some(k=>k.category==='instruction'));assert.ok(knowledge.every(k=>k.contextPolicy==='relevant'&&k.authority==='imported'));
  assert.ok(knowledge.every(k=>k.derivedFrom.some(r=>r.includes('plugin:migrate_ai_studio@1.7.0'))&&k.evidence.some(e=>e.ref.includes('.ai-studio/'))));
  assert.equal((await listProjectSkills(f.root))[0].status,'active');
  const verified=await f.call('verify',{plan:approved,receipt:applied.receipt});assert.equal(verified.valid,true,JSON.stringify(verified));
  assert.deepEqual(await snapshotFiles(f.root,'.ai-studio'),sourceBefore);assert.deepEqual(await snapshotFiles(f.root,'.'),repoBefore);
  const canonical=await snapshotFiles(f.root,'.prodero');
  const replay=await f.call('apply',{plan:approved,approvedPlanId:approved.planId});assert.deepEqual(replay.receipt,applied.receipt);assert.deepEqual(await snapshotFiles(f.root,'.prodero'),canonical);
  assert.equal((await getDetailedProjectStatus(f.root)).memoryHealth.status,'healthy');
  // Canonical state remains valid when the optional installation registry is empty.
  assert.equal(new PluginRegistry(path.join(f.root,'absent')).has(pluginId),false);assert.equal((await getDetailedProjectStatus(f.root)).skillCount,1);
});

test('skills remain candidates by default; exact duplicates are preserved without silent activation',async t=>{
  const f=await fixture(t);const first=await planned(f);const plan=await reviewed(f,first.plan);
  const applied=await f.call('apply',{plan,approvedPlanId:plan.planId});assert.equal((await listProjectSkills(f.root))[0].status,'candidate');
  const second=await planned(f);const next=await reviewed(f,second.plan,true);
  const again=await f.call('apply',{plan:next,approvedPlanId:next.planId});assert.equal(again.imported,0);assert.equal(again.duplicates,3);assert.equal((await listProjectSkills(f.root))[0].status,'candidate');
  assert.equal((await f.call('verify',{plan:next,receipt:again.receipt})).valid,true);
  assert.equal(applied.receipt.created.length,3);
});

test('plan validates evidence, schemas, source changes, inclusion boundaries and approval',async t=>{
  const f=await fixture(t);const {plan,audited,analysis}=await planned(f);
  const stale=structuredClone(plan);stale.pluginVersion='1.5.0';await assert.rejects(f.call('review',{plan:stale,decisions:[]}),/older migration plan[\s\S]*Run Audit again/);
  const bad=structuredClone(analysis);bad.migrate.items[0].source[0].path='../outside';bad.classify.items[0].source[0].path='../outside';
  await assert.rejects(f.call('plan',{auditPackage:audited.auditPackage,analysis:bad}),/evidence/);
  const wrong=structuredClone(plan);wrong.items[0].content='tampered';await assert.rejects(f.call('review',{plan:wrong,decisions:[]}),/digest/);
  await assert.rejects(f.call('review',{plan,decisions:plan.items.map(i=>({id:i.id,include:true,activateSkill:false}))}),/cannot be included/);
  const approved=await reviewed(f,plan);await assert.rejects(f.call('apply',{plan:approved,approvedPlanId:'0'.repeat(64)}),/approved/);
  const unsafe=seal({...approved,items:approved.items.map((i,n)=>n?i:{...i,destination:'../../bad'})});await assert.rejects(f.call('apply',{plan:unsafe,approvedPlanId:unsafe.planId}),/structured/);
  await fs.appendFile(path.join(f.root,'.ai-studio/runtime/memory/project-memory.md'),'source changed\n');
  await assert.rejects(f.call('apply',{plan:approved,approvedPlanId:approved.planId}),/changed since audit/);
  assert.equal((await listKnowledge(f.root)).length,0);
});

test('changed canonical state blocks apply and verification detects later source and unrelated edits',async t=>{
  const f=await fixture(t);const {plan}=await planned(f);const approved=await reviewed(f,plan);
  await fs.writeFile(path.join(f.root,'.prodero/sessions/new-note.md'),'# New independent state\n');
  await assert.rejects(f.call('apply',{plan:approved,approvedPlanId:approved.planId}),/state changed/);
  await fs.rm(path.join(f.root,'.prodero/sessions/new-note.md'));
  const applied=await f.call('apply',{plan:approved,approvedPlanId:approved.planId});
  await fs.appendFile(path.join(f.root,'README.md'),'later repository edit\n');
  // Verify must report drift, not fail while validating old evidence.
  const result=await f.call('verify',{plan:approved,receipt:applied.receipt});assert.equal(result.valid,false);assert.ok(result.issues.some(i=>/repository/.test(i)));
});

test('two bounded LLM calls create a stable staged plan; apply makes no semantic call',async t=>{
  const f=await fixture(t);const calls=[];let analysis;
  const llm={async json(instructions,input,schema){assert.ok(schema.type==='object');assert.ok(!JSON.stringify(input).includes('sk-fake'));const phase=instructions.startsWith('# AI Studio audit')?'audit':'analysis';calls.push(phase);if(phase==='audit')return {version:1,findings:[],inspectPaths:['src/store.ts'],warnings:[]};analysis??=analysisFor({input});return {classify:analysis.classify,migrate:analysis.migrate,verify:analysis.verify};}};
  const ctx=createPluginContext(f.registry,pluginId,f.root,llm);
  const audited=await f.call('audit',{semantic:true},ctx);assert.deepEqual(calls,['audit','analysis']);
  assert.equal(audited.plan.costEstimate.basis,'measured-payloads');assert.ok(audited.plan.costEstimate.estimatedTotalTokens>0);
  const plan=await reviewed(f,audited.plan);await f.call('apply',{plan,approvedPlanId:plan.planId},ctx);assert.equal(calls.length,2);
});


test('core rejects traversal, symlinks, forged secrets and oversized durable items before canonical writes',async t=>{
  const f=await fixture(t);const state=await readImportState(f.root);const text=await f.ctx.files.read('README.md');
  const item={key:'one',destination:'knowledge',title:'Atomic storage',content:'The store uses atomic writes.',scope:'global',scopeRef:null,category:'decision',evidence:[{path:'README.md',sha256:text.sha256,startLine:1,endLine:1}],reason:'Current code.',skill:null,activateSkill:false};
  const batch={version:1,planId:'a'.repeat(64),approvedPlanId:'a'.repeat(64),stateFingerprint:state.fingerprint,items:[item]};
  for(const patch of [{destination:'../../outside'},{content:'я'.repeat(5000)},{content:'api_key = sk-fake012345678901234567890123456789'},{evidence:[{...item.evidence[0],path:'../outside'}]}])await assert.rejects(applyImport(f.root,{id:pluginId,version:'1.0.0'},{...batch,items:[{...item,...patch}]}));
  await fs.symlink(path.join(f.root,'README.md'),path.join(f.root,'link.md'));await assert.rejects(f.ctx.files.read('link.md'),/Symlink/);
  await fs.symlink(path.join(f.root,'README.md'),path.join(f.root,'.prodero/memory/linked.md'));await assert.rejects(applyImport(f.root,{id:pluginId,version:'1.0.0'},batch),/Symlink/);
  assert.equal((await fs.readdir(path.join(f.root,'.prodero/checkpoints'))).filter(f=>f.endsWith('.json')).length,0);
});

test('invalid or failed LLM output leaves canonical state untouched and conflicts cannot be imported',async t=>{
  const f=await fixture(t);const before=await snapshotFiles(f.root,'.prodero');
  for(const json of [async()=>{throw new Error('Model unavailable');},async()=>({wrong:'schema'})]) {
    const ctx=createPluginContext(f.registry,pluginId,f.root,{json});await assert.rejects(f.call('audit',{semantic:true},ctx));
    assert.deepEqual(await snapshotFiles(f.root,'.prodero'),before);
  }
  const {audited,analysis}=await planned(f);analysis.verify.issues=[{itemId:'item-0',severity:'conflict',message:'Repository contradicts this proposed fact.'}];
  const {plan}=await f.call('plan',{auditPackage:audited.auditPackage,analysis});assert.equal(plan.items[0].include,false);
  await assert.rejects(f.call('review',{plan,decisions:plan.items.map(i=>({id:i.id,include:i.id==='item-0'?true:i.include,activateSkill:false}))}),/conflict/);
  assert.deepEqual(await snapshotFiles(f.root,'.prodero'),before);
});

test('migration rejects non-English durable knowledge before review or writes',async t=>{
  const f=await fixture(t);const {audited,analysis}=await planned(f);const before=await snapshotFiles(f.root,'.prodero');
  analysis.migrate.items[0].title='Атомарное хранилище';analysis.migrate.items[0].content='Хранилище использует атомарную запись.';
  await assert.rejects(f.call('plan',{auditPackage:audited.auditPackage,analysis}),/must be written in English/);
  assert.deepEqual(await snapshotFiles(f.root,'.prodero'),before);
});

test('disposable cache recovery preserves imported canonical provenance without a plugin',async t=>{
  const f=await fixture(t);const {plan:p}=await planned(f);const plan=await reviewed(f,p);
  await f.call('apply',{plan,approvedPlanId:plan.planId});const before=await snapshotFiles(f.root,'.prodero');
  await fs.rm(path.join(f.root,'.prodero/.cache'),{recursive:true,force:true});
  assert.equal((await getDetailedProjectStatus(f.root)).memoryHealth.missingProvenanceItems,0);
  assert.deepEqual(await snapshotFiles(f.root,'.prodero'),before);
  await fs.writeFile(path.join(f.root,'.prodero/.cache/memory-index.json'),'{');
  assert.equal((await getDetailedProjectStatus(f.root)).knowledgeCount,2);assert.deepEqual(await snapshotFiles(f.root,'.prodero'),before);
});

test('skill identity includes applicability scope and a pending import journal recovers on replay',async t=>{
  const f=await fixture(t);const {plan:initial}=await planned(f);const plan=await reviewed(f,initial);
  const applied=await f.call('apply',{plan,approvedPlanId:plan.planId});
  const original=await snapshotFiles(f.root,'.prodero');
  const checkpointPath=`.prodero/checkpoints/${applied.receipt.checkpoint}.json`;
  const writes=[];
  for(const item of applied.receipt.created)writes.push({path:item.path.replace('.prodero/',''),before:null,after:await fs.readFile(path.join(f.root,item.path),'utf8')});
  writes.push({path:checkpointPath.replace('.prodero/',''),before:null,after:await fs.readFile(path.join(f.root,checkpointPath),'utf8')});
  // Simulate interruption after one durable write, preserving the real recoverable journal format.
  for(const write of writes.slice(1))await fs.rm(path.join(f.root,'.prodero',write.path));
  await fs.writeFile(path.join(f.root,'.prodero/.transactions/pending.json'),JSON.stringify({version:1,writes}));
  const resumed=await f.call('apply',{plan,approvedPlanId:plan.planId});assert.deepEqual(resumed.receipt,applied.receipt);assert.deepEqual(await snapshotFiles(f.root,'.prodero'),original);
  assert.equal((await f.call('verify',{plan,receipt:resumed.receipt})).valid,true);
  const next=await planned(f);const candidate=next.analysis.migrate.items.find(i=>i.classification==='skill_candidate');candidate.skill.scope='a different storage boundary';
  const replanned=await f.call('plan',{auditPackage:next.audited.auditPackage,analysis:next.analysis});const reviewedPlan=await reviewed(f,replanned.plan);
  const imported=await f.call('apply',{plan:reviewedPlan,approvedPlanId:reviewedPlan.planId});assert.equal(imported.imported,1);assert.equal((await listProjectSkills(f.root)).length,2);
});

test('import checkpoints preserve normal lifecycle ordering and stale classification stays excluded',async t=>{
  const f=await fixture(t);const {audited,analysis}=await planned(f);
  analysis.classify.items[3].classification='stale';analysis.migrate.items[3].classification='stale';
  const {plan:raw}=await f.call('plan',{auditPackage:audited.auditPackage,analysis});assert.equal(raw.items[3].include,false);
  const plan=await reviewed(f,raw);const applied=await f.call('apply',{plan,approvedPlanId:plan.planId});assert.match(applied.receipt.checkpoint,/^chk_[0-9]{17}_[a-f0-9]{12}$/);
  const {prepareProject,recordProjectSession,closeProjectSession,syncProject}=await import('../dist/core/project.js');
  const session=await prepareProject(f.root,{task:'post-import lifecycle'});
  await recordProjectSession(f.root,session.session.id,[{type:'decision',content:'Separate lifecycle observations remain checkpointed after imports.'}]);const closed=await closeProjectSession(f.root,session.session.id);
  const sync=closed.synchronization;assert.equal((await syncProject(f.root)).sessions,0);const checkpoint=JSON.parse(await fs.readFile(path.join(f.root,'.prodero/checkpoints',`${sync.checkpoint}.json`),'utf8'));
  assert.equal(checkpoint.previousCheckpoint,applied.receipt.checkpoint);assert.equal((await prepareProject(f.root)).automaticSync.sessions,0);
});

test('v2 historical ToyGrid import uses semantic category and narrow relevant policy; replay uses receipts',async t=>{
 const f=await fixture(t);const file=path.join(f.root,'.ai-studio/runtime/memory/durable.md');
 await fs.writeFile(file,'# Memory\n\n## ToyGrid\nDecision:\nToyGrid tests must never shuffle the seeded tile bag.\n\nWorkflow Note:\nRun the toy tile tests.\n\nState:\nSynthetic runner currently fails on an intentionally malformed tile.\n');
 // State is part of durable history, not discarded execution noise.
 const audit=await f.call('audit');assert.equal(audit.summary.required,0);assert.ok(audit.plan.items.every(i=>i.applicability.kind==='scoped'));
 const approved=await reviewed(f,audit.plan);await f.call('apply',{plan:approved,approvedPlanId:approved.planId});
 const memory=await listKnowledge(f.root);assert.ok(memory.every(i=>i.contextPolicy==='relevant'&&i.authority==='imported'));assert.ok(memory.some(i=>i.category==='instruction'));
 const replay=await f.call('audit');assert.ok(replay.plan.items.every(i=>!i.include));
 await fs.appendFile(file,'\nImpact:\nNew source information.\n');const updated=await f.call('audit');assert.ok(updated.plan.items.every(i=>!i.include));assert.ok(updated.plan.items.some(i=>i.classification==='uncertain'));
});
test('legacy receipt keys survive canonical edits and missing historical source fields',async t=>{
 const f=await fixture(t);const initial=await f.call('audit');const approved=await reviewed(f,initial.plan);const applied=await f.call('apply',{plan:approved,approvedPlanId:approved.planId});
 const receiptFile=path.join(f.root,'.prodero/checkpoints',applied.receipt.checkpoint+'.json');const checkpoint=JSON.parse(await fs.readFile(receiptFile,'utf8'));for(const i of checkpoint.importReceipt.created){i.key=i.key.replace(/-\d+$/,'');delete i.source;}await fs.writeFile(receiptFile,JSON.stringify(checkpoint));
 const knowledge=await listKnowledge(f.root);await writeKnowledge(f.root,{...knowledge[0],content:'Canonically edited after import.'});
 const repeat=await f.call('audit');assert.ok(repeat.plan.items.every(i=>!i.include));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deterministicClassification, reconcileCandidate, reconciliationSignal, normalizeReconciliation } from '../dist/core/reconciliation.js';
import { initializeProject, prepareProject, recordProjectSession, closeProjectSession, syncProject } from '../dist/core/project.js';
import { writeKnowledge, listKnowledge } from '../dist/core/memory.js';
import { reviewSessionKnowledge } from '../dist/core/session-review.js';
import { listCheckpoints } from '../dist/core/storage.js';
import { fakeProvider, canonical } from './helpers/intelligence-provider.mjs';
import { knowledgeUi } from './helpers/knowledge-ui.mjs';
const old = {id:'mem_previous',scope:'global',scopeRef:null,category:'state',priority:'normal',status:'active',title:'Steering behavior',content:'Progressive drift uses speed-sensitive countersteering.',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[]};
const cases = [
 {name:'clear state transition',classification:'state_transition',action:'SUPERSEDE',before:'Steering assistance is disabled.',content:'Steering assistance is now enabled.'},
 {name:'refinement',classification:'refinement',action:'MERGE',content:old.content+' Countersteering sensitivity increases with speed.'},
 {name:'genuine contradiction',classification:'potential_conflict',action:'CONFLICT',before:'In the current build steering assistance is always enabled.',content:'In the current build steering assistance is never enabled.'},
 {name:'duplicate evidence',classification:'duplicate',action:'NO_CHANGE',content:old.content},
 {name:'supporting evidence',classification:'supporting',action:'NO_CHANGE',before:old.content+' Countersteering is tunable.',content:old.content},
 {name:'new implementation supersedes old tested behavior',classification:'state_transition',action:'SUPERSEDE',before:'Tests confirm sustained high-slip turns maintain speed.',content:'Sustained high-slip turns now lose speed and may stop. Old tests were adapted because spinout behavior intentionally changed.'},
 {name:'partial evolution retains complementary drift knowledge',classification:'state_transition',action:'LINK',content:'Spinout behavior now slows sustained high-slip turns to a stop. Old tests were adapted to the intentionally changed behavior.'},
];
for(const scenario of cases) test(`shared review and consolidation: ${scenario.name}`,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-classification-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.git'));await initializeProject(root);
 const previous={...old,content:scenario.before??old.content};await writeKnowledge(root,previous,false,'local');
 const session=(await prepareProject(root)).session.id;
 await recordProjectSession(root,session,[{type:'state_change',title:old.title,content:scenario.content,scopeHint:'global'}]);await closeProjectSession(root,session,[],false);
 const configPath=path.join(root,'.prodero/config.json');const config=JSON.parse(await fs.readFile(configPath));config.knowledgeEngine={mode:'assisted'};await fs.writeFile(configPath,JSON.stringify(config));
 const provider=fakeProvider({reconcile:({candidate,related})=>({actions:[{action:scenario.action,classification:scenario.classification,sources:[candidate.id,related[0].id],canonical:scenario.action==='MERGE'?canonical(candidate):null,reason:scenario.name,...(scenario.action==='SUPERSEDE'?{replacements:[{target:related[0].id,previousQuote:related[0].content,replacementQuote:candidate.content,transitionQuote:candidate.content,sameFact:true,completeReplacement:true,basis:'explicit_transition'}]}:{})}]})});
 const view=await reviewSessionKnowledge(root,session,provider);
 assert.equal(view.items[0].signals[0].kind,scenario.classification);
 assert.equal(view.summary.needsReview,scenario.classification==='potential_conflict'?1:0);
 assert.equal((await listKnowledge(root))[0].status,'active','review never mutates');
 const ui=await knowledgeUi(()=>{});ui.render({structuredContent:{action:'session-review',result:view}});const html=ui.html;
 assert.match(html,new RegExp(reconciliationSignal(scenario.classification).detail));
 if(scenario.classification==='potential_conflict') assert.match(html,/session-review-notice session-review-warning/);
 else {assert.doesNotMatch(html,/session-review-notice session-review-warning|needs-review/);assert.doesNotMatch(html,/Possible conflict|Potential conflict/);}
 const result=await syncProject(root,{provider});
 assert.equal(result.conflicts,scenario.classification==='potential_conflict'?1:0);
 const items=await listKnowledge(root);
 if(scenario.action==='SUPERSEDE') {assert.equal(items.find(m=>m.id===old.id).status,'superseded');assert.equal(items.find(m=>m.id!==old.id).status,'active');}
 if(scenario.action==='LINK') assert.ok(items.every(m=>m.status==='active'));
 const cp=(await listCheckpoints(root)).at(-1);
 assert.equal(cp.reasoning[0].classification,scenario.classification);
});

test('offline proof distinguishes evolution, refinement, duplicate and support; polarity alone stays unresolved',()=>{
 assert.equal(deterministicClassification({content:'Replacement.',supersedes:[old.id]},old),'state_transition');
 assert.equal(deterministicClassification({content:old.content,supersedes:[]},old),'duplicate');
 assert.equal(deterministicClassification({content:old.content+' More detail.',supersedes:[]},old),'refinement');
 assert.equal(deterministicClassification({content:old.content,supersedes:[]},{...old,content:old.content+' More detail.'}),'supporting');
 assert.equal(deterministicClassification({content:'Countersteering is not supported.',supersedes:[]},old),'unresolved');
});

test('legacy uncertainty and non-conflicting classifications preserve evidence without disputed status',()=>{
 for(const classification of [undefined,'state_transition','refinement','unresolved']) {
  const result=normalizeReconciliation({action:'UNCERTAIN',sources:['candidate_a',old.id],canonical:null,reason:'Incomplete replacement proof.',...(classification?{classification}:{})});
  assert.equal(result.action,'LINK');assert.equal(reconciliationSignal(result.classification).severity,'info');
 }
 assert.equal(normalizeReconciliation({action:'CONFLICT',sources:['candidate_a',old.id],canonical:null,reason:'Legacy contradiction.'}).classification,'potential_conflict');
});

test('semantic review rejects invented targets and conflict without competing evidence',async()=>{
 const candidate={...canonical(old),id:'candidate_a',kind:'knowledge',sources:['obs_a'],evidence:[{source:'obs_a',quote:old.content}],content:old.content,supersedes:[]};
 for(const sources of [['candidate_a','mem_unknown'],['candidate_a']]) {
  const provider=fakeProvider({reconcile:()=>({actions:[{action:'CONFLICT',classification:'potential_conflict',sources,canonical:null,reason:'Invalid evidence.'}]})});
  await assert.rejects(reconcileCandidate(candidate,[old],provider));
 }
});

test('classification cannot mislabel destructive replacement or evidence disposal',()=>{
 const base={sources:['candidate_a',old.id],canonical:null,reason:'Inconsistent semantic decision.'};
 assert.throws(()=>normalizeReconciliation({...base,action:'SUPERSEDE',classification:'refinement'}));
 assert.throws(()=>normalizeReconciliation({...base,action:'NO_CHANGE',classification:'state_transition'}));
 assert.throws(()=>normalizeReconciliation({...base,action:'LINK',classification:'potential_conflict'}));
 assert.throws(()=>normalizeReconciliation({...base,action:'CONFLICT',sources:[old.id]} ,false));
});

test('legacy disputed knowledge remains readable and warns; unavailable review provider stays neutral',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-legacy-reconciliation-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.git'));await initializeProject(root);
 await writeKnowledge(root,old,false,'local');
 const session=(await prepareProject(root)).session.id;
 await recordProjectSession(root,session,[{type:'state_change',title:old.title,content:'Progressive drift now includes spinout slowdown.',scopeHint:'global'}]);
 await closeProjectSession(root,session,[],false);
 const configPath=path.join(root,'.prodero/config.json');const config=JSON.parse(await fs.readFile(configPath));config.knowledgeEngine={mode:'assisted'};await fs.writeFile(configPath,JSON.stringify(config));
 const view=await reviewSessionKnowledge(root,session,fakeProvider({reconcile:()=>{throw Error('Unavailable');}}));
 assert.equal(view.summary.needsReview,0);assert.ok(view.items[0].signals.every(s=>s.severity==='info'));
 await writeKnowledge(root,{...old,status:'disputed',sourceSessions:[session],derivedFrom:[view.items[0].id]},false,'local');
 await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true,force:true});
 const legacy=await listKnowledge(root);assert.equal(legacy[0].status,'disputed');
 const reviewed=await reviewSessionKnowledge(root,session);
 assert.equal(reviewed.knowledge[0].signals[0].kind,'potential_conflict');
 assert.equal(reviewed.knowledge[0].signals[0].severity,'warning');
 assert.equal(reviewed.summary.needsReview,1);
});

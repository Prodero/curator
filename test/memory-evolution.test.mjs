import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeProject, prepareProject, recordProjectSession, closeProjectSession } from '../dist/core/project.js';
import { writeKnowledge, listKnowledge } from '../dist/core/memory.js';
import { getContext } from '../dist/core/context.js';
import { searchMemory } from '../dist/core/memory-operations.js';
import { fakeProvider } from './helpers/intelligence-provider.mjs';

async function fixture(t) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-evolution-'));
 t.after(() => fs.rm(root, {recursive:true, force:true}));
 await fs.mkdir(path.join(root,'.git')); await initializeProject(root);
 return root;
}
const item = (id, extra={}) => ({id,scope:'global',scopeRef:null,category:'state',priority:'normal',status:'active',title:'Portal messages',content:'Portal can only display messages; sending is not implemented.',createdAt:'2026-09-08T00:00:00Z',updatedAt:'2026-09-08T00:00:00Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[],...extra});

test('task relevance beats unrelated global priority across both storage layers', async t => {
 const root=await fixture(t);
 for(let i=0;i<12;i++) await writeKnowledge(root,item(`legacy_${i}`,{category:'decision',priority:'critical',title:`Architecture rule ${i}`,content:'Use isolated background workers.'}));
 await writeKnowledge(root,item('local_portal',{content:'Portal compose, drafts and sending are now implemented.'}),false,'local');
 const prepared=await prepareProject(root,{task:'portal compose drafts sending'});
 assert.equal(prepared.context.relevant[0]?.id,'local_portal');
 const ids=prepared.context.relevant.map(x=>x.id);
 await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true,force:true});
 assert.deepEqual((await getContext(root,'portal compose drafts sending')).relevant.map(x=>x.id),ids);
});

test('many small required policies fit without the old ordinary item stop', async t => {
 const root=await fixture(t);
 for(let i=0;i<35;i++) await writeKnowledge(root,item(`rule_${i}`,{category:'instruction',priority:'important',title:`Alphabetical policy ${i}`,content:'Always preserve invoice formatting.'}));
 await writeKnowledge(root,item('portal_policy',{category:'instruction',title:'Portal sending policy',content:'Always validate portal drafts before sending.'}),false,'local');
 const prepared=await prepareProject(root,{task:'portal drafts sending'});
 assert.ok(prepared.context.required.some(x=>x.id==='portal_policy'));
 assert.equal(prepared.context.metrics.requiredGlobalExcludedItems,0);
 assert.equal(prepared.context.required.length,36);
 assert.deepEqual(prepared.context.attention,[]);
 assert.equal(prepared.uiState.view,'context-ready');
});

async function pending(root, content, extra={}) {
 const p=await prepareProject(root);
 await recordProjectSession(root,p.session.id,[{type:'state_change',title:'Portal messages',content,scopeHint:'global',...extra}]);
 await closeProjectSession(root,p.session.id,[],false);
 const configFile=path.join(root,'.prodero/config.json');
 const config=JSON.parse(await fs.readFile(configFile));config.knowledgeEngine={mode:'assisted'};
 await fs.writeFile(configFile,JSON.stringify(config));
}
const replacementProvider = (mutate=x=>x) => fakeProvider({reconcile:({candidate,related})=>({actions:[mutate({action:'SUPERSEDE',sources:[candidate.id,related[0].id],canonical:null,reason:'Explicit feature implementation replaces the earlier unsupported state.',replacements:[{target:related[0].id,previousQuote:related[0].content,replacementQuote:candidate.content,transitionQuote:candidate.content,sameFact:true,completeReplacement:true,basis:'explicit_transition'}]})]})});
for(const layer of ['local','versioned']) test(`fresh prepare reconciles ${layer} state and preserves history across cache rebuild`,async t=>{
 const root=await fixture(t);
 await writeKnowledge(root,item('old_portal'),false,layer);
 await pending(root,'Portal compose, drafts and sending are now implemented.');
 const p=await prepareProject(root,{task:'portal compose drafts sending',provider:replacementProvider()});
 assert.equal(p.automaticSync.intelligence.reconciliation.actions.SUPERSEDE,1);
 assert.equal(p.context.relevant.length,1);
 assert.match(p.context.relevant[0].content,/now implemented/);
 const all=await listKnowledge(root);
 assert.equal(all.length,2);
 assert.equal(all.find(x=>x.id==='old_portal').status,layer==='local'?'superseded':'active');
 assert.ok(p.context.relevant[0].supersedes.includes('old_portal'));
 assert.ok(!(await searchMemory(root,'portal')).some(x=>x.id==='old_portal'));
 assert.ok((await searchMemory(root,'portal',{includeHistorical:true})).some(x=>x.id==='old_portal'));
 await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true,force:true});
 assert.deepEqual((await getContext(root,'portal compose drafts sending')).relevant.map(x=>x.id),p.context.relevant.map(x=>x.id));
});
for(const action of ['LINK','CONFLICT','UNCERTAIN']) test(`${action} preserves later independent or ambiguous evidence`,async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('old_portal'),false,'local');
 await pending(root,action==='LINK'?'Portal sending benchmark completed.':'Portal sending is supported.');
 const provider=fakeProvider({reconcile:({candidate,related})=>({actions:[{action,sources:[candidate.id,related[0].id],canonical:null,reason:'No proof of complete replacement.'}]})});
 const p=await prepareProject(root,{task:'portal sending',provider});
 const all=await listKnowledge(root);
 assert.equal(all.length,2);assert.ok(all.every(x=>!x.supersedes.length));
 assert.ok(all.every(x=>x.status===(action==='CONFLICT'?'disputed':'active')));
 if(action==='CONFLICT')assert.ok(p.context.attention.some(x=>x.kind==='conflict'));
});
test('storage recency and fabricated transition quotes cannot authorize replacement',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('old_portal'),false,'local');
 await pending(root,'Portal sending is supported.');
 await assert.rejects(prepareProject(root,{task:'portal',provider:replacementProvider()}),/supersession lacks/);
 assert.equal((await listKnowledge(root)).length,1);
 await assert.rejects(prepareProject(root,{task:'portal',provider:replacementProvider(a=>({...a,replacements:a.replacements.map(r=>({...r,transitionQuote:'Sending is now implemented.'}))}))}),/supersession lacks/);
});
test('critical instructions reserve priority, while oversized critical omission remains actionable',async t=>{
 const root=await fixture(t);
 for(let i=0;i<25;i++)await writeKnowledge(root,item(`normal_${i}`,{category:'instruction',title:`Portal ${i}`,content:'Always validate portal sending.'}));
 await writeKnowledge(root,item('critical',{category:'instruction',priority:'critical',title:'Compatibility invariant',content:'Never change the public wire protocol.'}));
 let c=await getContext(root,'portal sending');assert.equal(c.required[0].id,'critical');assert.equal(c.attention.length,0);
 c=await getContext(root,'portal sending',{contextBudgetTokens:1,requiredContextBudgetTokens:1});assert.ok(c.attention.some(x=>x.kind==='context-budget'));
});

test('budget selection reaches a fitting local fact beyond an oversized early top-K window',async t=>{
 const root=await fixture(t);
 for(let i=0;i<40;i++)await writeKnowledge(root,item(`oversized_${i}`,{title:`Portal compose drafts sending ${i}`,content:'Portal compose drafts sending. '.repeat(100)}));
 await writeKnowledge(root,item('fits',{title:'Portal',content:'Portal sending works.'}),false,'local');
 const c=await getContext(root,'portal compose drafts sending',{contextBudgetTokens:40,maxContextItems:1});
 assert.deepEqual(c.relevant.map(x=>x.id),['fits']);
});

test('successive replacements retain the imported ancestor shadow',async t=>{
 const root=await fixture(t);
 await writeKnowledge(root,item('imported'));
 await writeKnowledge(root,item('middle',{supersedes:['imported'],content:'Portal sending is implemented.'}),false,'local');
 await pending(root,'Portal compose, drafts and sending are now implemented.');
 const p=await prepareProject(root,{task:'portal sending',provider:replacementProvider()});
 assert.ok(p.context.relevant[0].supersedes.includes('imported'));
 assert.ok(!(await searchMemory(root,'portal')).some(x=>['imported','middle'].includes(x.id)));
});

test('new inferred clauses remain relevant while an existing required instruction is preserved',async t=>{
 const root=await fixture(t);
 await writeKnowledge(root,item('policy',{category:'instruction',priority:'important',content:'Always validate portal drafts.'}),false,'local');
 await pending(root,'Always validate portal recipients.',{type:'decision',categoryHint:'instruction',importanceHint:'important'});
 const provider=fakeProvider({reconcile:({candidate,related})=>({actions:[{action:'MERGE',sources:[candidate.id,related[0].id],canonical:{title:'Portal validation policy',content:`${related[0].content} ${candidate.content}`,scope:candidate.scope,scopeRef:candidate.scopeRef,category:candidate.category,priority:candidate.priority},reason:'Compact related mandatory clauses without deleting either.'}]})});
 const p=await prepareProject(root,{task:'portal',provider});
 assert.equal(p.context.required.length,1);
 assert.equal(p.context.required[0].content,'Always validate portal drafts.');
 assert.ok(p.context.relevant.some(i=>i.content.includes('Always validate portal recipients.')&&i.contextPolicy==='relevant'&&i.authority==='inferred'));
 assert.equal(p.automaticSync.policyTransitions.blocking,false);
});

test('offline same-topic differences preserve evidence without guessing conflict or replacement',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('old_portal'),false,'local');
 await pending(root,'Portal sending is implemented.');
 const p=await prepareProject(root,{task:'portal sending'});
 assert.equal(p.automaticSync.intelligence.mode,'deterministic');
 const all=await listKnowledge(root);assert.equal(all.length,2);
 assert.ok(all.every(x=>x.status==='active'&&!x.supersedes.length));
 assert.ok(!p.context.attention.some(x=>x.kind==='conflict'));
});

test('partial old-body evidence cannot discard architectural constraints',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('old_portal',{content:'Portal only displays messages. Portal uses the shared message API.'}),false,'local');
 await pending(root,'Portal compose, drafts and sending are now implemented.');
 await assert.rejects(prepareProject(root,{task:'portal',provider:replacementProvider(a=>({...a,replacements:a.replacements.map(r=>({...r,previousQuote:'Portal only displays messages.'}))}))}),/supersession lacks/);
 assert.equal((await listKnowledge(root)).length,1);
});

test('unrelated staged candidates cannot hide a stored local reconciliation target',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('local_target',{content:'Portal sending has not been implemented.'}),false,'local');
 const p=await prepareProject(root);
 await recordProjectSession(root,p.session.id,[...Array.from({length:14},(_,i)=>({type:'state_change',scopeHint:'global',title:`Invoice ${i}`,content:`Invoice benchmark ${i} completed.`})),{type:'state_change',scopeHint:'global',title:'Portal messages',content:'Portal sending is now implemented.'}]);
 await closeProjectSession(root,p.session.id,[],false);
 const configFile=path.join(root,'.prodero/config.json');const config=JSON.parse(await fs.readFile(configFile));config.knowledgeEngine={mode:'assisted'};await fs.writeFile(configFile,JSON.stringify(config));
 const provider=fakeProvider({reconcile:({candidate,related})=>{
   if(candidate.title==='Portal messages')assert.ok(related.some(x=>x.id==='local_target'));
   return {actions:[{action:'CREATE',sources:[candidate.id],canonical:null,reason:'Preserve separate evidence for this selection test.'}]};
 }});
 await prepareProject(root,{task:'portal',provider});
 assert.ok(provider.calls.some(x=>x.phase==='reconcile'&&x.input.candidate.title==='Portal messages'));
});

test('storage freshness breaks relevance ties without declaring a state transition',async t=>{
 const root=await fixture(t);
 const a=item('a',{title:'Portal alpha',content:'Portal sending uses the message API.',updatedAt:'2024-01-01T00:00:00Z'});
 const b=item('b',{title:'Portal beta',content:'Portal sending uses a draft queue.'});
 await writeKnowledge(root,a,false,'local');await writeKnowledge(root,b);
 const before=await getContext(root,'portal sending',{now:new Date('2026-09-15T00:00:00Z')});
 await writeKnowledge(root,{...a,updatedAt:'2027-01-01T00:00:00Z'},false,'local');
 await writeKnowledge(root,{...b,updatedAt:'2023-01-01T00:00:00Z'});
 const after=await getContext(root,'portal sending',{now:new Date('2026-09-15T00:00:00Z')});
 assert.deepEqual(before.relevant.map(x=>x.id),['b','a']);
 assert.deepEqual(after.relevant.map(x=>x.id),['a','b']);
 assert.ok(after.relevant.every(x=>x.status==='active'&&!x.supersedes.length));
 assert.equal(after.attention.length,0);
});

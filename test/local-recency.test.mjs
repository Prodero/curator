import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeProject } from '../dist/core/project.js';
import { getContext } from '../dist/core/context.js';
import { writeKnowledge } from '../dist/core/memory.js';

const now = new Date('2026-09-15T12:00:00Z');
const recent = '2026-09-15T00:00:00Z';
const ancient = '2020-01-01T00:00:00Z';
const memory = (id, extra={}) => ({id,scope:'global',scopeRef:null,category:'state',priority:'normal',status:'active',title:'Handling',content:'Sustained slides remain controllable.',createdAt:ancient,updatedAt:ancient,sourceSessions:[],derivedFrom:[],related:[],supersedes:[],...extra});
async function fixture(t, items) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-recency-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:3}));
 await fs.mkdir(path.join(root,'.git'));await initializeProject(root);
 for(const item of items) await writeKnowledge(root,item,false,'local');
 return root;
}
const context=(root,opts={})=>getContext(root,'sustained slides',{now,...opts});
const freshness=(view,id)=>view.selection.relevant[id].signals.find(s=>s.kind==='recency').score;
const pair = () => [
 memory('mem_older',{title:'Alpha handling',content:'Progressive drift supports controllable sustained slides.'}),
 memory('mem_newer',{title:'Zulu handling',content:'Spinout behavior causes sustained slides to lose speed and potentially stop.',updatedAt:recent}),
];

test('equally relevant evolving states prefer fresh storage evidence before title and ID',async t=>{
 const root=await fixture(t,pair());const result=await context(root,{maxContextItems:1});
 assert.deepEqual(result.relevant.map(m=>m.id),['mem_newer']);
 assert.equal(freshness(result,'mem_newer'),0.5);
 assert.ok(result.selection.omittedRelevant.some(m=>m.id==='mem_older'&&m.signals.some(s=>s.kind==='recency')));
 assert.ok(result.relevant.every(m=>m.status==='active'&&!m.supersedes.length));
});

test('much more relevant older evidence beats weakly relevant fresh evidence',async t=>{
 const root=await fixture(t,[memory('mem_old',{title:'Sustained slides',content:'Sustained slides use progressive drift.'}),memory('mem_new',{title:'Spinout',content:'Slides can stop.',updatedAt:recent})]);
 assert.equal((await context(root,{maxContextItems:1})).relevant[0].id,'mem_old');
});

test('even one point of importance beats the maximum recency advantage',async t=>{
 const root=await fixture(t,[memory('mem_old',{title:'Zulu handling'}),memory('mem_new',{title:'Alpha handling',priority:'contextual',updatedAt:recent})]);
 assert.equal((await context(root,{maxContextItems:1})).relevant[0].id,'mem_old');
});

test('path relevance remains stronger than recency',async t=>{
 const root=await fixture(t,[memory('mem_scoped',{scope:'module',scopeRef:'src/physics',scopeKind:'path'}),memory('mem_new',{updatedAt:recent})]);
 const result=await getContext(root,'src/physics sustained slides',{now,maxContextItems:1});
 assert.equal(result.relevant[0].id,'mem_scoped');
});

test('freshness is bounded, halves at thirty UTC days, and future dates gain no extra authority',async t=>{
 const root=await fixture(t,[memory('mem_today',{updatedAt:recent}),memory('mem_month',{updatedAt:'2026-08-16T23:59:59Z'}),memory('mem_future',{updatedAt:'2099-01-01T00:00:00Z'})]);
 const result=await context(root);
 assert.equal(freshness(result,'mem_today'),0.5);assert.equal(freshness(result,'mem_month'),0.25);assert.equal(freshness(result,'mem_future'),0.5);
 const late=await context(root,{now:new Date('2026-09-15T23:59:59Z')});assert.deepEqual(result.selection,late.selection);
});

test('required critical policies keep their reservation and receive no recency score',async t=>{
 const root=await fixture(t,[memory('mem_critical',{category:'instruction',priority:'critical',title:'Safety',content:'Always validate steering inputs.'}),memory('mem_fresh_rule',{category:'instruction',title:'Sustained slides',updatedAt:recent}),...pair()]);
 const full=await context(root);
 const budget=full.selection.required.mem_critical.estimatedTokens;
 const result=await context(root,{requiredContextBudgetTokens:budget,contextBudgetTokens:budget});
 assert.deepEqual(result.required.map(m=>m.id),['mem_critical']);assert.equal(result.relevant.length,0);
 assert.ok(result.selection.required.mem_critical.signals.every(s=>s.kind!=='recency'));
});

test('required equal-priority ordering remains authoritative and unchanged by recency',async t=>{
 const root=await fixture(t,[memory('mem_alpha',{category:'instruction',title:'Alpha'}),memory('mem_zulu',{category:'instruction',title:'Zulu',updatedAt:recent})]);
 const result=await context(root);
 assert.deepEqual(result.required.map(m=>m.id),['mem_alpha','mem_zulu']);
 assert.ok(Object.values(result.selection.required).every(s=>s.signals.every(x=>x.kind!=='recency')));
});

test('tight token budget admits the newer of two equally relevant fitting records',async t=>{
 const root=await fixture(t,pair());const full=await context(root);
 const sizes=Object.values(full.selection.relevant).map(s=>s.estimatedTokens);
 const result=await context(root,{contextBudgetTokens:Math.max(...sizes)});
 assert.deepEqual(result.relevant.map(m=>m.id),['mem_newer']);
 assert.ok(result.selection.omittedRelevant.some(m=>m.id==='mem_older'&&m.reason==='budget'));
 assert.ok(result.metrics.contextTokens<=Math.max(...sizes));
});

test('oversized recent evidence does not prevent older fitting evidence from being selected',async t=>{
 const [old,newer]=pair();newer.content+=' Extended handling details.'.repeat(60);
 const root=await fixture(t,[old,newer]);const full=await context(root);
 const result=await context(root,{contextBudgetTokens:full.selection.relevant.mem_older.estimatedTokens});
 assert.deepEqual(result.relevant.map(m=>m.id),['mem_older']);
 assert.ok(result.selection.omittedRelevant.some(m=>m.id==='mem_newer'&&m.reason==='budget'));
});

test('unrelated newer knowledge cannot displace a durable decision',async t=>{
 const root=await fixture(t,[memory('mem_decision',{category:'decision',content:'Sustained slides must remain controllable.'}),memory('mem_recent',{content:'Invoices use sequential numbering.',updatedAt:recent})]);
 const result=await context(root,{maxContextItems:1});assert.equal(result.relevant[0].id,'mem_decision');
 assert.equal(result.selection.omittedRelevant.length,0,'freshness cannot introduce an unrelated candidate');
});

for(const category of ['state','decision','lesson','constraint','principle','invariant']) test(`one explainable recency rule for contextual ${category}`,async t=>{
 const root=await fixture(t,pair().map(m=>({...m,category})));
 assert.equal((await context(root,{maxContextItems:1})).relevant[0].id,'mem_newer');
});

test('fresh timestamps cannot resurrect explicitly superseded history',async t=>{
 const root=await fixture(t,[memory('mem_old',{updatedAt:recent,title:'Sustained slides'}),memory('mem_current',{supersedes:['mem_old']})]);
 const result=await context(root);assert.deepEqual(result.relevant.map(m=>m.id),['mem_current']);
});

test('deterministic title/ID ties and cache rebuilds retain identical daily ordering',async t=>{
 const root=await fixture(t,[memory('mem_z',{updatedAt:recent}),memory('mem_a',{updatedAt:recent}),memory('mem_b',{title:'Alpha',updatedAt:recent})]);
 const baseline=await context(root);assert.deepEqual(baseline.relevant.map(m=>m.id),['mem_b','mem_a','mem_z']);
 const canonical=await fs.readFile(path.join(root,'.prodero/local/memory/mem_a.md'),'utf8');
 for(const state of ['warm','missing','corrupt']) {
  if(state==='missing')await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true,force:true});
  if(state==='corrupt')await fs.writeFile(path.join(root,'.prodero/.cache/memory-index.json'),'{broken');
  const result=await context(root);assert.deepEqual(result.selection,baseline.selection,state);
 }
 assert.equal(await fs.readFile(path.join(root,'.prodero/local/memory/mem_a.md'),'utf8'),canonical);
});

test('equally relevant updates within one UTC day prefer the later update before title/ID',async t=>{
 const [old,newer]=pair();old.updatedAt='2026-09-15T08:00:00Z';newer.updatedAt='2026-09-15T09:00:00Z';
 const root=await fixture(t,[old,newer]);const result=await context(root);
 assert.equal(freshness(result,'mem_older'),freshness(result,'mem_newer'));
 assert.deepEqual(result.relevant.map(m=>m.id),['mem_newer','mem_older']);
});

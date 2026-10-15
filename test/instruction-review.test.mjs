import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, PRODERO_TOOLS as T } from '../dist/server.js';
import { writeKnowledge } from '../dist/core/memory.js';
import { knowledgeUi } from './helpers/knowledge-ui.mjs';
async function fixture(t,{count=20,critical=false,budget=2000,contents}={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-instruction-review-'));await fs.mkdir(path.join(root,'.git'));
 const server=createServer({projectRoot:root}),client=new Client({name:'instruction-review-test',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
 const call=(name,args={})=>client.callTool({name,arguments:{projectRoot:root,...args}});
 await call(T.initialize);
 const configPath=path.join(root,'.prodero/config.json'),config=JSON.parse(await fs.readFile(configPath,'utf8'));config.context={max_tokens:6000,max_items:8,required_max_tokens:budget};await fs.writeFile(configPath,JSON.stringify(config));
 for(let i=0;i<count;i++)await writeKnowledge(root,{id:`mem_policy_${i}`,title:`Portal policy ${i}`,content:contents?.(i)??`Always validate portal requests using policy ${i}.`,category:'instruction',priority:critical?'critical':'normal',scope:'global',scopeRef:null,status:'active',createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[]},false,'local');
 // Force genuine total-capacity omissions, not the retired 16-item stop.
 const {listKnowledge}=await import('../dist/core/memory.js');
 const {estimateTokens,knowledgeText}=await import('../dist/core/telemetry.js');
 const records=(await listKnowledge(root)).sort((a,b)=>a.title.localeCompare(b.title));
 config.context.max_tokens=budget===2000?records.slice(0,16).reduce((n,i)=>n+estimateTokens(knowledgeText(i)),0):budget;
 await fs.writeFile(configPath,JSON.stringify(config));
 const prepared=await call(T.prepare,{task:'portal'});assert.ok(!prepared.isError);
 return {root,call,prepared};
}
test('normal required omissions are blocking and offer exact review',async t=>{
 const f=await fixture(t);const ui=await knowledgeUi(r=>f.call(r.name,r.arguments));ui.render(f.prepared);
 assert.match(ui.html,/Required context incomplete/);assert.doesNotMatch(ui.html,/Required context truncated — review needed/);
 assert.match(ui.html,/4 normal instructions omitted/);assert.match(ui.html,/0 critical omitted/);
});

test('Review pages actual omitted records including entries beyond bounded prepare metadata',async t=>{
 const f=await fixture(t,{count:65});const context=f.prepared.structuredContent.result.context,reviewId=context.snapshot.reviewId;
 const expected=new Set(Array.from({length:65},(_,i)=>`mem_policy_${i}`).filter(id=>!context.required.some(m=>m.id===id)));
 const found=[];let offset=0;
 do {const raw=await f.call(T.instructionReview,{reviewId,offset});assert.ok(!raw.isError);const page=raw.structuredContent.result;
 assert.deepEqual(page.counts,{normal:49,critical:0});for(const row of page.items){assert.ok(row.item.content);assert.equal(row.selection.reason,'budget');assert.equal(row.item.id,row.selection.id);found.push(row.item.id);}offset=page.nextOffset;
 }while(offset!==null);
 assert.deepEqual(new Set(found),expected);assert.equal(found.length,49);
 const ui=await knowledgeUi(r=>f.call(r.name,r.arguments));ui.render(f.prepared);await ui.instruction('review');
 assert.match(ui.html,/Always validate portal requests/);assert.match(ui.html,/Normal at prepare/);assert.match(ui.html,/Edit \/ classify \/ remove/);
 await ui.instruction('next');assert.match(ui.html,/Previous/);
 const expired=await f.call(T.instructionReview,{reviewId:'00000000-0000-4000-8000-000000000000'});assert.ok(expired.isError);
});
test('critical omissions retain attention and Review critical uses exact critical count',async t=>{
 const f=await fixture(t,{count:18,critical:true});const result=f.prepared.structuredContent.result;
 assert.equal(result.context.metrics.requiredCriticalOmitted,2);assert.equal(result.context.metrics.requiredNormalOmitted,0);
 const ui=await knowledgeUi(r=>f.call(r.name,r.arguments));ui.render(f.prepared);assert.match(ui.html,/required context incomplete/i);assert.match(ui.html,/2 critical omitted/);
 await ui.instruction('critical');assert.match(ui.html,/Critical at prepare/);assert.doesNotMatch(ui.html,/Normal at prepare/);
});
test('model-callable editor approval cannot change required semantics or criticality',async t=>{
 const f=await fixture(t);const ui=await knowledgeUi(r=>f.call(r.name,r.arguments));ui.render(f.prepared);await ui.instruction('review');
 const id=f.prepared.structuredContent.result.context.selection.omittedRequired[0].id;
 const {knowledgeView}=await import('../dist/core/knowledge-management.js');const before=(await knowledgeView(f.root,{},id)).detail;
 await ui.instruction('knowledge',id);await ui.click('edit');
 await ui.submit('knowledge-edit-form',{title:'Portal request invariant',content:'Always validate portal request boundaries.',priority:'critical',scope:'global',scopeRef:'',scopeKind:''});
 await ui.click('confirm');assert.match(ui.html,/POLICY_REVIEW_REQUIRED/);
 assert.equal((await knowledgeView(f.root,{},id)).detail.revision,before.revision);
});
test('invalid instruction edits and stale revisions fail without changing canonical content',async t=>{
 const f=await fixture(t);const {knowledgeView,mutateKnowledge}=await import('../dist/core/knowledge-management.js');
 const detail=(await knowledgeView(f.root,{},'mem_policy_0')).detail;
 const input={id:detail.id,revision:detail.revision,approved:true,action:'edit',title:detail.title,content:detail.content};
 for(const patch of [{priority:'urgent'},{scope:'module',scopeRef:'../escape',scopeKind:'path'},{scope:'module',scopeRef:null},{content:''},{revision:'0'.repeat(64)}])await assert.rejects(mutateKnowledge(f.root,{...input,...patch}));
 assert.equal((await knowledgeView(f.root,{},detail.id)).detail.revision,detail.revision);
});
test('Optimize previews exact duplicate collapse, requires approval and reduces pressure without deleting history',async t=>{
 const f=await fixture(t,{contents:()=> 'Always validate portal request boundaries.'});const context=f.prepared.structuredContent.result.context;
 const ui=await knowledgeUi(r=>f.call(r.name,r.arguments));ui.render(f.prepared);await ui.instruction('optimize');
 assert.match(ui.html,/Review optimization/);assert.match(ui.html,/15 fewer instructions/);
 const before=(await f.call(T.context,{task:'portal'})).structuredContent.result;assert.equal(before.metrics.requiredGlobalExcludedItems,4);
 const raw=await f.call(T.instructionOptimize,{reviewId:context.snapshot.reviewId});const preview=raw.structuredContent.result;
 assert.ok((await f.call(T.instructionOptimize,{reviewId:context.snapshot.reviewId,action:'apply',previewId:preview.previewId})).isError);
 await ui.instruction('apply-optimization');assert.match(ui.html,/Consolidation saved/);
 const next=(await f.call(T.context,{task:'portal'})).structuredContent.result;assert.equal(next.metrics.requiredGlobalExcludedItems,0);assert.equal(next.required.length,5);
 const {listKnowledge}=await import('../dist/core/memory.js');const all=await listKnowledge(f.root);assert.equal(all.length,20);assert.equal(all.filter(i=>i.status==='duplicate').length,15);
 await fs.rm(path.join(f.root,'.prodero/.cache'),{recursive:true,force:true});
 assert.equal((await f.call(T.context,{task:'portal'})).structuredContent.result.required.length,5);
 assert.ok((await f.call(T.instructionOptimize,{reviewId:context.snapshot.reviewId,action:'apply',previewId:preview.previewId,approved:true})).isError);
});
test('assisted policy consolidation preserves clauses and rejects semantic or classification loss',async t=>{
 const f=await fixture(t,{count:2,budget:20,contents:i=>'Always validate portal requests. '+(i?'Check permissions.':'Check schemas.')});
 const context=f.prepared.structuredContent.result.context;
 const selection={root:f.root,sessionId:context.snapshot.sessionId,task:context.query,omitted:context.selection.omittedRequired,selectedIds:context.required.map(i=>i.id)};
 const {previewInstructionOptimization,applyInstructionOptimization}=await import('../dist/core/instruction-review.js');
 const provider=(patch={})=>({name:'synthetic',distill:async()=>{throw Error('not used');},reconcile:async()=>{throw Error('not used');},audit:async({items})=>({output:{status:'changes_proposed',issues:[],actions:[{action:'MERGE',sources:items.map(i=>i.id),canonical:{title:'Portal request policy',content:'Always validate portal requests. Check schemas. Check permissions.',scope:'global',scopeRef:null,category:'instruction',priority:'normal',...patch},reason:'Related request validation requirements retain every clause.'}]}})});
 for(const patch of [{content:'Always validate portal requests.'},{priority:'critical'},{scope:'module',scopeRef:'portal'}])await assert.rejects(previewInstructionOptimization(selection,provider(patch)));
 const preview=await previewInstructionOptimization(selection,provider());assert.equal(preview.view.reducedBy,1);assert.ok(preview.view.afterTokens<=preview.view.beforeTokens);
 await applyInstructionOptimization(preview);
 const next=(await f.call(T.context,{task:'portal'})).structuredContent.result;
 assert.equal(next.metrics.requiredGlobalCandidateTokens,preview.view.afterTokens);
 await assert.rejects(applyInstructionOptimization(preview),/changed/);
});

test('old prepare snapshots remain inspectable; unverified retirement preserves required instructions',async t=>{
 const f=await fixture(t);const old=structuredClone(f.prepared);delete old.structuredContent.result.context.snapshot.reviewId;
 const ui=await knowledgeUi(r=>f.call(r.name,r.arguments));ui.render(old);await ui.instruction('review');assert.match(ui.html,/older prepare/);
 const id=old.structuredContent.result.context.selection.omittedRequired[0].id;
 await ui.instruction('knowledge',id);await ui.click('retire');await ui.click('confirm');assert.match(ui.html,/POLICY_REVIEW_REQUIRED/);
 const next=(await f.call(T.context,{task:'portal'})).structuredContent.result;assert.equal(next.metrics.requiredGlobalExcludedItems,4);
 assert.ok(!next.required.some(i=>i.id===id));
});
test('mixed criticality is counted independently and conflict-bearing policies are never optimized',async t=>{
 const f=await fixture(t,{count:18});
 const {knowledgeView,mutateKnowledge}=await import('../dist/core/knowledge-management.js');
 const item=(await knowledgeView(f.root,{},'mem_policy_0')).detail;
 const all=await (await import('../dist/core/memory.js')).listKnowledge(f.root);
 await writeKnowledge(f.root,{...all.find(i=>i.id===item.id),content:'Always preserve this critical invariant. '.repeat(90),priority:'critical'},false,'local');
 const cfg=JSON.parse(await fs.readFile(path.join(f.root,'.prodero/config.json'),'utf8'));cfg.context.max_tokens=6000;await fs.writeFile(path.join(f.root,'.prodero/config.json'),JSON.stringify(cfg));
 const p=(await f.call(T.prepare,{task:'portal'})).structuredContent.result;
 assert.equal(p.context.metrics.requiredCriticalOmitted,0);
 // A tighter fixture exercises critical+normal omissions at once.
 const g=await fixture(t,{count:18,budget:10});
 const row=(await knowledgeView(g.root,{},'mem_policy_0')).detail;
 const allG=await (await import('../dist/core/memory.js')).listKnowledge(g.root);
 await writeKnowledge(g.root,{...allG.find(i=>i.id===row.id),priority:'critical'},false,'local');
 const mixed=(await g.call(T.prepare,{task:'portal'})).structuredContent.result.context;
 assert.equal(mixed.metrics.requiredCriticalOmitted,1);assert.equal(mixed.metrics.requiredNormalOmitted,17);
 const {previewInstructionOptimization}=await import('../dist/core/instruction-review.js');
 const {listKnowledge}=await import('../dist/core/memory.js');
 const memories=await listKnowledge(g.root);
 for(const m of memories)await writeKnowledge(g.root,{...m,status:'disputed'},false,'local');
 const preview=await previewInstructionOptimization({root:g.root,sessionId:mixed.snapshot.sessionId,task:'portal',omitted:mixed.selection.omittedRequired,selectedIds:[]});
 assert.equal(preview.plan.writes.length,0);
});

test('Versioned optimization previews repository changes and preserves the publication layer and source preimages',async t=>{
 const f=await fixture(t,{count:2,budget:20,contents:()=> 'Always validate portal request boundaries.'});
 for(const id of ['mem_policy_0','mem_policy_1'])await fs.rename(path.join(f.root,'.prodero/local/memory',id+'.md'),path.join(f.root,'.prodero/memory',id+'.md'));
 const prepared=(await f.call(T.prepare,{task:'portal'})).structuredContent.result.context;
 const raw=await f.call(T.instructionOptimize,{reviewId:prepared.snapshot.reviewId});assert.ok(!raw.isError);
 const preview=raw.structuredContent.result;assert.equal(preview.repository,true);
 const ui=await knowledgeUi(r=>f.call(r.name,r.arguments));ui.render(raw);assert.match(ui.html,/Apply repository consolidation/);assert.match(ui.html,/Git-tracked Versioned Knowledge/);
 await ui.instruction('apply-optimization');assert.match(ui.html,/Consolidation saved/);
 assert.equal((await fs.readdir(path.join(f.root,'.prodero/local/memory'))).filter(n=>n.endsWith('.md')).length,0);
 const {listCheckpoints}=await import('../dist/core/storage.js');const checkpoint=(await listCheckpoints(f.root)).at(-1);
 assert.equal(checkpoint.knowledgeBefore.length,2);assert.equal(checkpoint.knowledgeBefore[0].status,'active');
});

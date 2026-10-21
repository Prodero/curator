// Invented toy-project fixtures; no real project incidents or operational records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ContextAllocation,marginalValue} from '../dist/core/context-allocation.js';
import {getContext} from '../dist/core/context.js';
import {prepareProject} from '../dist/core/project.js';
import {writeKnowledge} from '../dist/core/memory.js';
import {createProjectSkill} from '../dist/core/skills.js';
import {emptyProject,record,phase3cFixture,tasks,requiredTotals} from './helpers/context-v2-fixture.mjs';

test('one allocator protects whole records, total capacity, and independent safety ceilings',()=>{
 const a=new ContextAllocation(6000,2000);assert.equal(a.take('required',2357),null);assert.equal(a.take('skill',1000),null);assert.equal(a.take('relevant',3000),'total-capacity');assert.equal(a.used,3357);
 const b=new ContextAllocation(40000,2000);assert.equal(b.take('required',16001),'required-token-ceiling');assert.equal(b.used,0);for(let i=0;i<128;i++)assert.equal(b.take('required',1),null);assert.equal(b.take('required',1),'required-item-ceiling');
 for(let i=0;i<128;i++)assert.equal(b.take('relevant',1),null);assert.equal(b.take('relevant',1),'relevant-item-ceiling');
 const c=new ContextAllocation(6000,2000);assert.equal(c.take('skill',1501),'skill-token-ceiling');for(let i=0;i<4;i++)assert.equal(c.take('skill',10),null);assert.equal(c.take('skill',1),'skill-item-ceiling');
});
test('marginal continuation requires both ranking strength and novel information',()=>{
 const q=new Set(['toygrid']),seen=new Set(['fixture','seeding','cleanup']);
 assert.equal(marginalValue(['toygrid','fixture','seeding','cleanup'],q,seen,80,90).useful,false);
 assert.equal(marginalValue(['toygrid','transaction','rollback','atomicity'],q,seen,80,90).useful,true);
 assert.equal(marginalValue(['toygrid','transaction','rollback','atomicity'],q,seen,10,90).useful,false);
});
test('Synthetic fixed-budget fixtures preserve exact demand, borrow for ToyGrid, and leave compact tasks compact',async t=>{
 const root=await phase3cFixture(t);const results=[];
 for(const [i,task]of tasks.entries()){
  const c=await getContext(root,task);results.push(c);
  assert.equal(c.allocation.required.demandTokens,requiredTotals[i]);assert.equal(c.allocation.required.selectedTokens,requiredTotals[i]);assert.equal(c.allocation.required.complete,true);assert.equal(c.policyReadiness.state,'ready');assert.equal(c.selection.omittedRequired.length,0);assert.ok(c.metrics.contextTokens<=6000);
 }
 assert.equal(results[0].metrics.contextTokens,233);assert.equal(results[0].relevant.length,0);
 const lead=results[2];assert.equal(lead.allocation.required.borrowedTokens,357);assert.equal(lead.required.length,14);assert.equal(lead.allocation.relevant.candidates,27);assert.ok(lead.relevant.length>8);assert.ok(lead.relevant.length<27);assert.equal(lead.allocation.relevant.stopReason,'marginal-value');assert.equal(lead.skills.length,1);assert.ok(lead.metrics.contextTokens<6000);
 assert.deepEqual((await getContext(root,tasks[2])).allocation,lead.allocation);
 t.diagnostic(JSON.stringify(results.map((c,i)=>({task:tasks[i],allocation:c.allocation,total:c.metrics.contextTokens}))));
});
test('many tiny Required use safety ceiling, any omission is explicit blocking readiness',async t=>{
 const root=await emptyProject(t);for(let i=0;i<130;i++)await writeKnowledge(root,record('small_'+i,{kind:'project'},'required',20));
 const c=await prepareProject(root,{task:'Update README documentation'});assert.equal(c.context.required.length,128);assert.equal(c.context.metrics.requiredGlobalExcludedItems,2);assert.equal(c.context.policyReadiness.state,'required-incomplete');assert.equal(c.context.policyReadiness.blocking,true);assert.equal(c.uiState.view,'attention');assert.ok(c.context.selection.omittedRequired.every(i=>i.constraint==='required-item-ceiling'));
});
test('one oversized Required is never split or silently downgraded; reserve is not a ceiling',async t=>{
 const root=await emptyProject(t);await writeKnowledge(root,record('oversized',{kind:'project'},'required',6001));
 let c=await getContext(root,'work');assert.equal(c.required.length,0);assert.equal(c.policyReadiness.state,'required-incomplete');assert.equal(c.selection.omittedRequired[0].constraint,'total-capacity');assert.equal(c.relevant.length,0);
 c=await getContext(root,'work',{contextBudgetTokens:10000});assert.equal(c.required.length,1);assert.equal(c.allocation.required.borrowedTokens,4001);
 await writeKnowledge(root,record('oversized',{kind:'project'},'required',16001));c=await getContext(root,'work',{contextBudgetTokens:30000});assert.equal(c.selection.omittedRequired[0].constraint,'required-token-ceiling');
});
test('strong skill receives capacity before heavy Relevant competition',async t=>{
 const root=await emptyProject(t);await writeKnowledge(root,record('ToyGrid_rule',{kind:'project'},'required',100));
 for(let i=0;i<20;i++)await writeKnowledge(root,record('ToyGrid_tests_'+i,{kind:'project'},'relevant',180,'ToyGrid tests fixtures testing procedure.'));
 await createProjectSkill(root,{title:'ToyGrid tests',description:'ToyGrid testing',scope:'ToyGrid',triggers:['ToyGrid'],content:'Verify the captured output. '.repeat(20)});
 const c=await getContext(root,'ToyGrid tests',{contextBudgetTokens:600});assert.equal(c.skills.length,1);assert.ok(c.allocation.skills.protectedTokens>0);assert.ok(c.allocation.relevant.omissions.capacity>0);assert.ok(c.metrics.contextTokens<=600);
});
test('weak repetitive matches stop without filling capacity',async t=>{
 const root=await emptyProject(t);for(let i=0;i<50;i++)await writeKnowledge(root,record('ToyGrid_note_'+i,{kind:'project'},'relevant',60,'ToyGrid supporting fixtures historical note.'));
 const c=await getContext(root,'ToyGrid');assert.equal(c.relevant.length,8);assert.equal(c.allocation.relevant.omissions.marginalValue,42);assert.equal(c.allocation.unusedTokens,5520);
});

test('strong distinct Relevant can reach the safety ceiling; capacity omissions remain precise',async t=>{
 const root=await emptyProject(t);const query='ToyGrid testing exports request response transport database transaction validation authentication migration deployment serialization';
 for(let i=0;i<132;i++)await writeKnowledge(root,record(query.replaceAll(' ','_')+'_'+i,{kind:'scoped',subsystems:['partition'+i,'ToyGrid']},'relevant',110,`Topic evidencealpha${i} evidencebeta${i} evidencegamma${i} evidencedelta${i}.`));
 let c=await getContext(root,query,{contextBudgetTokens:30000});assert.equal(c.relevant.length,128);assert.equal(c.allocation.relevant.omissions.safety,4);assert.equal(c.allocation.relevant.stopReason,'safety-ceiling');
 c=await getContext(root,query,{contextBudgetTokens:1000});assert.equal(c.relevant.length,9);assert.equal(c.allocation.relevant.omissions.capacity,123);assert.equal(c.allocation.relevant.stopReason,'capacity');assert.ok(c.selection.omittedRelevant.every(i=>i.constraint==='total-capacity'));
});
test('unknown applicability and required conflict keep precedence over allocation failures',async t=>{
 const root=await emptyProject(t);await writeKnowledge(root,record('huge',{kind:'project'},'required',6001));await writeKnowledge(root,record('Scoped_boundary',{kind:'scoped',paths:['src/grid/**']},'required',30));
 let c=await getContext(root,'Investigate problem');assert.equal(c.policyReadiness.state,'context-needed');assert.equal(c.allocation.required.complete,false);assert.equal(c.applicability.unknownRequired,1);
 await writeKnowledge(root,{...record('dispute',{kind:'project'},'required',30),status:'disputed'});c=await getContext(root,'Investigate problem');assert.equal(c.policyReadiness.state,'review-required');assert.equal(c.allocation.required.complete,false);
});
test('MCP, text and View Context preserve exact allocator diagnostics without re-selection',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');const {createServer}=await import('../dist/server.js');const {buildViewModel,renderText}=await import('../dist/presentation.js');const {knowledgeUi}=await import('./helpers/knowledge-ui.mjs');
 const root=await phase3cFixture(t),server=createServer({projectRoot:root}),client=new Client({name:'allocator-test',version:'1'},{capabilities:{}});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const response=await client.callTool({name:'prodero_text',arguments:{tool:'prodero_prepare',arguments:{projectRoot:root,task:tasks[2]}}});assert.equal(response.isError,undefined);const payload=response.structuredContent;assert.equal(payload.result.context.allocation.required.borrowedTokens,357);assert.equal(payload.result.context.snapshot.sessionId,payload.result.session.id);
 const model=buildViewModel(payload);assert.ok(model.diagnostics.some(d=>d.title==='Context allocation'));assert.match(renderText(model),/required/);
 const ui=await knowledgeUi(()=>{throw Error('View Context must not rerun retrieval');});ui.render({structuredContent:{...payload,presentation:{resolved:'ui'}}});const button=ui.host.querySelector('button[data-action="view-context"]');assert.ok(button);button.listeners.click({currentTarget:button});assert.match(ui.html,/Allocation details/);assert.match(ui.html,/borrowed: 357/);assert.match(ui.html,/Additional matches · 11/);
 await writeKnowledge(root,record('oversized_extra',{kind:'project'},'required',6001));const blocked=await client.callTool({name:'prodero_text',arguments:{tool:'prodero_prepare',arguments:{projectRoot:root,task:tasks[2]}}});assert.equal(blocked.structuredContent.result.context.policyReadiness.state,'required-incomplete');assert.match(blocked.content[0].text,/Required context incomplete/);
});

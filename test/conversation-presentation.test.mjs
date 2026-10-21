import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {buildViewModel,renderText} from '../dist/presentation.js';
import {conversationOperation} from '../dist/conversation-presentation.js';
import {createMemoryBundleFixture} from './helpers/memory-bundle-fixtures.mjs';
import {runMemorySync} from '../dist/core/memory-sync.js';
import {writeKnowledge} from '../dist/core/memory.js';
import {record} from './helpers/context-v2-fixture.mjs';
async function clientFor(t,root){
 const server=createServer({projectRoot:root}),client=new Client({name:'conversation-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();});
 const call=(name,args={})=>client.callTool({name,arguments:args});
 const text=(tool,args={})=>call('prodero_text',{tool,arguments:args});
 return {call,text};
}
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-conversation-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,...await clientFor(t,root)};}
const operation=r=>JSON.parse(r.content[1].text).proderoOperation;
test('initialization, quiet Open and session lifecycle retain exact state without a dashboard dump',async t=>{
 const f=await fixture(t);let r=await f.text('prodero_open');
 assert.match(r.content[0].text,/Not initialized/);assert.equal(operation(r).continuation.tool,'prodero_initialize');
 r=await f.text('prodero_initialize');assert.equal(r.isError,undefined);assert.match(r.content[0].text,/Initialized/);
 r=await f.text('prodero_open');assert.match(r.content[0].text,/none active/);assert.ok(r.content[0].text.split('\n').filter(Boolean).length<40);
 assert.doesNotMatch(r.content[0].text,/Required instructions:/);
 assert.ok(r.structuredContent.presentation.actions.every(a=>!a.approval));
 assert.deepEqual(operation(r).bootstrap,r.structuredContent.bootstrap);
 const prepared=await f.text('prodero_prepare',{task:'Document conversation presentation'});
 assert.equal(operation(prepared).blocking,false);assert.ok(!operation(prepared).availableActions.some(a=>a.tool==='prodero_instruction_review'));assert.deepEqual(operation(prepared).context,prepared.structuredContent.result.context);
 r=await f.text('prodero_open');assert.match(r.content[0].text,/active \(1\)/);
 await f.text('prodero_session_close',{sessionId:prepared.structuredContent.result.session.id});
 r=await f.text('prodero_open');assert.match(r.content[0].text,/none active/);assert.equal(r.structuredContent.project.sessionCount,1);
});
test('View Context and Prepare keep omitted required context blocking, with exact review binding',async t=>{
 const f=await fixture(t);await f.call('prodero_initialize');await writeKnowledge(f.root,record('oversized',{kind:'project'},'required',6001));
 const p=await f.text('prodero_prepare',{task:'Review project documentation'});
 assert.equal(operation(p).blocking,true);assert.equal(operation(p).contextComplete,false);
 assert.equal(operation(p).continuation.arguments.reviewId,p.structuredContent.result.context.snapshot.reviewId);
 const c=await f.text('prodero_context',{task:'Review project documentation'});
 assert.match(c.content[0].text,/Do not continue/);assert.equal(operation(c).blocking,true);assert.equal(operation(c).contextComplete,false);
 assert.deepEqual(operation(c).context.selection,c.structuredContent.result.selection);
});
test('explicit details retain content; diagnostics are separately requested',async t=>{
 const f=await fixture(t);await f.call('prodero_initialize');
 const plain=await f.text('prodero_status_details');assert.doesNotMatch(plain.content[0].text,/Memory diagnostics:/);
 const diagnostic=await f.text('prodero_status_details',{diagnostics:true});assert.match(diagnostic.content[0].text,/Memory diagnostics:/);assert.equal(operation(diagnostic).kind,'diagnostic');
 assert.deepEqual(plain.structuredContent.project,diagnostic.structuredContent.project);
});
test('Open attention preserves Core signals, and stale continuation explicitly reanalyzes',()=>{
 const payload={action:'open',project:{name:'fixture',initialized:true,knowledgeCount:4,memoryOverview:{available:true,areas:[{signals:['context_pressure'],recordCount:4}],workflow:{id:'saved',state:'stale'}}}};
 const v=buildViewModel(payload);assert.match(renderText(v),/has not fit/);assert.doesNotMatch(renderText(v),/No attention needed/);
 assert.deepEqual(v.conversation.continuation.arguments.request,{action:'start',restart:true});
 const conflict=buildViewModel({...payload,project:{...payload.project,conflictCount:1,memoryOverview:{available:true,areas:[]}}});
 assert.equal(conflict.conversation.continuation.arguments.status,undefined);
});
test('conflict without omissions never routes to the omissions-only instruction review',()=>{
 const context={query:'Review',required:[],relevant:[],skills:[],metrics:{contextTokens:0,contextBudgetTokens:6000},policyReadiness:{state:'review-required',blocking:true}};
 const vm=buildViewModel({action:'prepare',result:{context}});assert.equal(vm.conversation.continuation,undefined);assert.equal(vm.conversation.detailSource,'context');assert.equal(vm.conversation.blocking,true);
});
test('prepared default Sync carries the bounded curation job in assistant-visible content',async t=>{
 const f=await createMemoryBundleFixture();t.after(f.cleanup);const client=await clientFor(t,f.root);
 let w=await runMemorySync(f.root,{action:'start'});
 w=await runMemorySync(f.root,{action:'select',workflowId:w.id,revision:w.revision,improve:true,share:false});
 const response=await client.text('prodero_memory_sync',{request:{action:'prepare',workflowId:w.id,revision:w.revision,candidateId:w.next.candidateId}});
 assert.equal(response.isError,undefined);assert.ok(response.structuredContent.result.curation);
 assert.deepEqual(operation(response).workflow.curation,JSON.parse(JSON.stringify(response.structuredContent.result.curation)));
 assert.equal(operation(response).continuation,undefined);
 assert.match(operation(response).workflow.next.instructions,/curation_reasoning/);
});
test('deferred session saving is never reported as saved',()=>{
 const vm=buildViewModel({action:'session-close',result:{session:{id:'session'},learned:{observations:1,rawSessionTokens:20,syncState:'pending-auto-sync'}}});
 assert.match(renderText(vm),/Saving deferred/);assert.doesNotMatch(renderText(vm),/✓ Saved/);
});
test('migration decision details include the actual plan and recovery before approval',()=>{
 const payload={action:'migration',root:'/tmp/example',plan:{state:'available',safeToApply:true,planId:'plan-exact',current:{project:1,knowledge:1},target:{project:2,knowledge:2},migrations:[{domain:'knowledge',from:1,to:2,description:'Preserve explicit applicability while normalizing old records.',kind:'structural',affectedStores:['memory']}],backup:{path:'.prodero/backups/example'},recovery:'Restore the exact backup before retrying.'}};
 const vm=buildViewModel(payload),summary=renderText(vm),detail=renderText(vm,false,true);
 assert.doesNotMatch(summary,/normalizing old records/);assert.match(detail.replace(/\n│ ?/g,' '),/normalizing old records/);assert.match(detail,/Restore the exact backup/);
 assert.equal(conversationOperation(payload,vm).continuation.arguments.action,'status');
 const approval=conversationOperation(payload,vm,true).continuation;assert.equal(approval.approval,true);assert.equal(approval.arguments.planId,'plan-exact');
});
test('Open offers three conversational requests with valid bindings and keeps the attention question last',async t=>{
 const f=await fixture(t);let r=await f.text('prodero_open');assert.match(r.content[0].text,/1 > Initialize Prodero/);
 assert.equal(operation(r).numberedActions[0].tool,'prodero_initialize');
 await f.text('prodero_initialize');r=await f.text('prodero_open');
 assert.match(r.content[0].text,/1 > Curate Memory[\s\S]*2 > Explore knowledge[\s\S]*3 > Show settings/);
 assert.doesNotMatch(r.content[0].text,/prodero_[a-z_]+/);assert.ok(r.content[0].text.split('\n').filter(Boolean).length<40);
 const suggestions=operation(r).suggestions;assert.equal(suggestions.length,3);
 const numbered=operation(r).numberedActions;
 assert.deepEqual(numbered,suggestions.map((a,i)=>({...a,number:i+1})));
 assert.equal(numbered.find(a=>a.number===2).tool,'prodero_knowledge');
 const selected=numbered.find(a=>a.number===2);
 const knowledge=await f.text(selected.tool,selected.arguments);assert.equal(knowledge.isError,undefined);
 const settings=await f.call(suggestions[2].tool,suggestions[2].arguments);assert.equal(settings.isError,undefined);
 const sync=await f.text(suggestions[0].tool,suggestions[0].arguments);assert.equal(sync.isError,undefined);
 r=await f.text('prodero_open');const resume=operation(r).suggestions[0];
 assert.equal(resume.label,'Continue curation');assert.equal(resume.arguments.workflowId,sync.structuredContent.result.id);
 assert.match(r.content[0].text,/Continue curation\?/);
 const stale=buildViewModel({action:'open',project:{root:f.root,name:'fixture',initialized:true,memoryOverview:{available:true,areas:[],workflow:{id:'saved',state:'stale'}}}});
 assert.deepEqual(stale.conversation.suggestions[0].arguments.request,{action:'start',restart:true});
 assert.equal(buildViewModel({action:'status',project:{initialized:true}}).conversation.suggestions,undefined);
});


test('numbered menus match visible actions in compact and detailed views and retain approval guards', () => {
 const payload={action:'migration',root:'/tmp/numbered-project',plan:{state:'available',safeToApply:true,planId:'exact-plan',current:{project:1,knowledge:1},target:{project:2,knowledge:2},migrations:[],backup:{path:'.prodero/backups/example'},recovery:'Restore backup.'}};
 const vm=buildViewModel(payload);
 for(const expanded of [false,true]) {
  const text=renderText(vm,false,expanded),op=conversationOperation(payload,vm,expanded);
  for(const action of op.numberedActions) assert.ok(text.includes(`  ${action.number} > ${action.label}`));
  assert.deepEqual(op.numberedActions.map(a=>a.number),op.numberedActions.map((_,i)=>i+1));
  assert.match(text,/Reply with a number or the command name/);
 }
 const compact=conversationOperation(payload,vm);
 assert.equal(compact.numberedActions.length,1);
 assert.equal(compact.numberedActions[0].arguments.action,'status');
 const detailed=conversationOperation(payload,vm,true);
 const apply=detailed.numberedActions.find(a=>a.approval);
 assert.ok(apply);assert.equal(apply.arguments.planId,'exact-plan');
 assert.match(renderText(vm,false,true),/Explicit approval required/);
 assert.match(detailed.instructions,/menu number.*never approval/);
 assert.match(detailed.instructions,/missing\/out-of-range bindings/);
 assert.match(detailed.instructions,/latest displayed screen in this conversation and project/);
 assert.match(detailed.instructions,/question expecting a numeric value/);
 const noMenu=buildViewModel({action:'status',project:{initialized:true,conflictCount:0}});
 assert.deepEqual(conversationOperation({action:'status'},noMenu).numberedActions,[]);
 assert.doesNotMatch(renderText(noMenu),/Reply with a number/);
});

test('Skill Preview projection reports review without synthesizing approval and covered drafts need no promotion',()=>{
 for(const disposition of ['new','update','covered']) {
  const payload={ok:true,action:'skill-preview',preview:{disposition:{action:disposition}},result:{skills:[]}};
  const operation=conversationOperation(payload,buildViewModel(payload));
  assert.equal(operation.reviewRequired,disposition!=='covered');
  assert.deepEqual(operation.numberedActions,[]);
 }
});

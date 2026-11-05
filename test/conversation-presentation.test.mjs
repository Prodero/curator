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
 r=await f.text('prodero_initialize');assert.equal(r.isError,undefined);assert.match(r.content[0].text,/initialized/i);
 r=await f.text('prodero_open');assert.doesNotMatch(r.content[0].text,/ATTENTION|active|review improvements/i);assert.ok(r.content[0].text.split('\n').filter(Boolean).length<40);
 assert.doesNotMatch(r.content[0].text,/Required instructions:/);
 assert.ok(r.structuredContent.presentation.actions.every(a=>!a.approval));
 assert.deepEqual(operation(r).bootstrap,r.structuredContent.bootstrap);
 const prepared=await f.text('prodero_prepare',{task:'Document conversation presentation'});
 assert.equal(operation(prepared).blocking,false);assert.ok(!operation(prepared).availableActions.some(a=>a.tool==='prodero_instruction_review'));assert.deepEqual(operation(prepared).context,prepared.structuredContent.result.context);
 r=await f.text('prodero_open');assert.doesNotMatch(r.content[0].text,/ATTENTION|active \(1\)/);assert.equal(r.structuredContent.project.activeSessionCount,1);
 await f.text('prodero_session_close',{sessionId:prepared.structuredContent.result.session.id});
 r=await f.text('prodero_open');assert.doesNotMatch(r.content[0].text,/ATTENTION|active|review improvements/i);assert.equal(r.structuredContent.project.sessionCount,1);
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
 const plain=await f.text('prodero_status_details');assert.doesNotMatch(plain.content[0].text,/Memory diagnostics/);
 const diagnostic=await f.text('prodero_status_details',{diagnostics:true});assert.match(diagnostic.content[0].text,/Memory diagnostics/);assert.equal(operation(diagnostic).kind,'diagnostic');
 assert.deepEqual(plain.structuredContent.project,diagnostic.structuredContent.project);
});
test('Open preserves maintenance evidence without a moderator prompt or queue',()=>{
 const payload={action:'open',project:{name:'fixture',initialized:true,knowledgeCount:4,activeSessionCount:1,conflictCount:2,memoryOverview:{available:true,areas:[{id:'area',label:'queue',signals:['context_pressure'],recordCount:4}],workflow:{id:'saved',state:'stale'}}},curation:{prominent:true,projection:{analyzedSourceCount:3,readyChangeGroups:4,deferredQuestions:2,needsInputNow:1}}};
 const before=structuredClone(payload),vm=buildViewModel(payload),text=renderText(vm),details=renderText(vm,false,true),diagnostics=renderText(vm,true);
 assert.doesNotMatch(text,/ATTENTION|memory improvements|deferred questions|unapplied|active session|Continue curation|Review these/i);
 assert.doesNotMatch(details,/Review cleanup|Pause review|Review saved decisions|Continue curation|proposed change groups/i);
 assert.equal(vm.conversation.continuation,undefined);assert.deepEqual(payload,before);
 assert.match(diagnostics,/context_pressure/);assert.match(diagnostics,/readyChangeGroups/);assert.match(diagnostics,/activeSessions/);
 assert.ok(vm.actions.every(a=>!['prodero_sync','prodero_memory_sync'].includes(a.tool)));
});
test('real overview, recovery and required failures stay visible without housekeeping questions',()=>{
 const project={initialized:true,name:'fixture',knowledgeCount:1,memoryOverview:{available:false,areas:[],diagnostic:{code:'PRODERO_STORAGE_FAILED',cause:'Cannot read saved workflow.',recovery:'Inspect the preserved journal.'},workflow:{id:'saved',state:'applying'}}};
 const vm=buildViewModel({action:'open',project,bootstrap:{instructions:[],warnings:['Required startup guidance could not be loaded.']}}),text=renderText(vm).replace(/\n│ ?/g,' ');
 assert.doesNotMatch(text,/ATTENTION/);assert.match(text,/PRODERO_STORAGE_FAILED/);assert.match(text,/Cannot read saved workflow/);assert.match(text,/pending|verification/);assert.match(text,/Required startup guidance/);
 assert.equal(vm.conversation.prompt,undefined);assert.equal(vm.conversation.blocking,false);
 const missingHistory=buildViewModel({action:'open',project:{...project,memoryOverview:{available:false,areas:[]}}});assert.deepEqual(missingHistory.conversation.attention,[]);
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
 const vm=buildViewModel({action:'session-close',result:{session:{id:'session',status:'closed'},learned:{observations:1,rawSessionTokens:20,syncState:'pending-auto-sync'}}});
 assert.match(renderText(vm),/Saving deferred/);assert.doesNotMatch(renderText(vm),/✓ Saved/);
});
test('migration decision details include the actual plan and recovery before approval',()=>{
 const payload={action:'migration',root:'/tmp/example',plan:{state:'available',safeToApply:true,planId:'plan-exact',current:{project:1,knowledge:1},target:{project:2,knowledge:2},migrations:[{domain:'knowledge',from:1,to:2,description:'Preserve explicit applicability while normalizing old records.',kind:'structural',affectedStores:['memory']}],backup:{path:'.prodero/backups/example'},recovery:'Restore the exact backup before retrying.'}};
 const vm=buildViewModel(payload),summary=renderText(vm),detail=renderText(vm,false,true);
 assert.doesNotMatch(summary,/normalizing old records/);assert.match(detail.replace(/\n│ ?/g,' '),/normalizing old records/);assert.match(detail,/Restore the exact backup/);
 assert.equal(conversationOperation(payload,vm).continuation.arguments.action,'status');
 const approval=conversationOperation(payload,vm,true).continuation;assert.equal(approval.approval,true);assert.equal(approval.arguments.planId,'plan-exact');
});
test('Open offers knowledge and settings while legacy maintenance stays technical',async t=>{
 const f=await fixture(t);let r=await f.text('prodero_open');assert.match(r.content[0].text,/Initialize Prodero for this project/);
 assert.equal(operation(r).availableActions[0].tool,'prodero_initialize');assert.deepEqual(operation(r).numberedActions,[]);
 await f.text('prodero_initialize');r=await f.text('prodero_open');
 assert.match(r.content[0].text,/View memory/);assert.doesNotMatch(r.content[0].text,/1 >|2 >|Reply with a number/);
 assert.doesNotMatch(r.content[0].text,/Review cleanup|Continue curation|prodero_[a-z_]+/);
 const suggestions=operation(r).suggestions;assert.equal(suggestions.length,4);
 assert.deepEqual(operation(r).numberedActions.map(a=>a.number),[1,2,3,4]);assert.ok(operation(r).availableActions.some(a=>a.tool===suggestions[0].tool));
 assert.equal((await f.text(suggestions[0].tool,suggestions[0].arguments)).isError,undefined);
 assert.equal((await f.call(suggestions[3].tool,suggestions[3].arguments)).isError,undefined);
 const sync=await f.text('prodero_sync');assert.equal(sync.isError,undefined);
 assert.match(sync.content[0].text,/Memory maintenance is handled/);assert.deepEqual(operation(sync).numberedActions,[]);assert.equal(operation(sync).reviewRequired,false);
 r=await f.text('prodero_open');assert.deepEqual(operation(r).suggestions,suggestions);assert.equal(operation(r).continuation,undefined);
 assert.doesNotMatch(r.content[0].text,/curation|deferred|review changes/i);
 assert.equal(buildViewModel({action:'status',project:{initialized:true}}).conversation.suggestions,undefined);
});

test('named actions retain exact bindings and approval guards in compact and detailed chat', () => {
 const payload={action:'migration',root:'/tmp/numbered-project',plan:{state:'available',safeToApply:true,planId:'exact-plan',current:{project:1,knowledge:1},target:{project:2,knowledge:2},migrations:[],backup:{path:'.prodero/backups/example'},recovery:'Restore backup.'}};
 const vm=buildViewModel(payload);
 for(const expanded of [false,true]) {
  const text=renderText(vm,false,expanded),op=conversationOperation(payload,vm,expanded);
  for(const action of op.availableActions.filter(a=>!a.label.includes("details"))) assert.ok(text.includes(action.label));
  assert.deepEqual(op.numberedActions,[]);
  assert.doesNotMatch(text,/Reply with a number or the command name/);
 }
 const compact=conversationOperation(payload,vm);
 assert.deepEqual(compact.numberedActions,[]);
 assert.equal(compact.continuation.arguments.action,'status');
 const detailed=conversationOperation(payload,vm,true);
 const apply=detailed.availableActions.find(a=>a.approval);
 assert.ok(apply);assert.equal(apply.arguments.planId,'exact-plan');
 assert.match(renderText(vm,false,true),/Explicit approval required/);
 assert.match(detailed.instructions,/Selecting an action is never approval/);
 assert.match(detailed.instructions,/clarify duplicate titles/);
 assert.match(detailed.instructions,/latest displayed view and project/);
 assert.match(detailed.instructions,/Pending answers take precedence/);
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

test('successful Close keeps optional review in technical evidence without a moderator action',()=>{
 const payload={action:'session-close',result:{session:{id:'session',status:'closed'},learned:{observations:2,rawSessionTokens:20,syncState:'synchronized'},review:{needsReview:2,localKnowledge:2}}};
 const vm=buildViewModel(payload),text=renderText(vm),details=renderText(vm,false,true);
 assert.match(text,/Saved/);assert.doesNotMatch(text,/ATTENTION|review|question/i);assert.deepEqual(vm.conversation.attention,[]);
 assert.ok(vm.actions.every(a=>a.tool!=='prodero_session_review'));assert.doesNotMatch(details,/Needs review|Review session knowledge/);
 assert.match(renderText(vm,true),/needsReview/);
 payload.result.review.error='PRODERO_REVIEW_FAILED: Saved catalogue cannot be read.';
 const failed=renderText(buildViewModel(payload)).replace(/\n│ ?/g,' ');assert.match(failed,/Saved/);assert.match(failed,/PRODERO_REVIEW_FAILED/);assert.doesNotMatch(failed,/Review session knowledge\?/);
});
test('direct sharing retains exact reviewed wording and an explicit approval binding',()=>{
 const preview={actions:[{localIds:['mem_fixture'],disposition:'new',reason:'Selected by the user.',draft:{title:'Shared convention',content:'Exact wording preserved for user-directed sharing.'}}]};
 const payload={action:'promotion-preview',preview},vm=buildViewModel(payload),text=renderText(vm,false,true),op=conversationOperation(payload,vm,true);
 assert.ok(text.indexOf(preview.actions[0].draft.content)<text.indexOf('Explicit approval required'));
 const apply=op.availableActions.find(a=>a.approval);assert.equal(apply.tool,'prodero_promote');assert.deepEqual(apply.arguments.preview,preview);
});

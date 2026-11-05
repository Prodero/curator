import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {memoryUxFixtures} from './helpers/memory-ux-fixtures.mjs';
import {createMemoryBundleFixture} from './helpers/memory-bundle-fixtures.mjs';
import {runMemorySync,getMemorySyncOverview} from '../dist/core/memory-sync.js';
import {buildViewModel,renderText,memoryOpenPresentation} from '../dist/presentation.js';
import {conversationOperation} from '../dist/conversation-presentation.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
let states;test.before(async()=>{states=await memoryUxFixtures();});
const flat=text=>text.replace(/\n│ ?/g,' ');

test('ordinary Open and its details have no maintenance queues or moderator calls to action',()=>{
 for(const name of ['noHistory','twoAreas','interrupted']) {
  const payload=states[name],before=structuredClone(payload),vm=buildViewModel(payload);
  for(const expanded of [false,true]) {
   const text=renderText(vm,false,expanded);
   assert.doesNotMatch(text,/Review cleanup|Pause review|Review saved decisions|Continue curation|deferred questions|unapplied change|areas? can be improved|Not enough usage history/i,name);
  }
  assert.ok(vm.actions.some(a=>a.tool==='prodero_curation'&&a.arguments.fresh));assert.equal(vm.conversation.prompt,undefined);assert.equal(vm.conversation.continuation,undefined);
  assert.ok(vm.actions.every(a=>!['prodero_sync','prodero_memory_sync'].includes(a.tool)));
  assert.deepEqual(payload,before);
 }
 assert.equal(states.twoAreas.project.memoryOverview.areas.length,2);
 const diagnostic=renderText(buildViewModel(states.twoAreas),true);assert.match(diagnostic,/context_pressure|fragmentation/);
});

test('normal memory copy is neutral while technical source evidence remains available',()=>{
 const project=states.twoAreas.project,before=structuredClone(project),view=memoryOpenPresentation(project);
 assert.deepEqual(Object.keys(view).sort(),['headline','notes']);
 assert.match(view.headline,/automatically/);assert.equal(project.memoryOverview.areas.length,2);assert.deepEqual(project,before);
});

test('legacy maintenance text does not produce choices, questions, retries or approval menus',()=>{
 for(const [name,payload] of Object.entries(states).filter(([,p])=>p.action==='memory-sync')) {
  const before=structuredClone(payload),vm=buildViewModel(payload);
  for(const expanded of [false,true]) {
   const text=flat(renderText(vm,false,expanded)),operation=conversationOperation(payload,vm,expanded);
   assert.match(text,/Memory maintenance is handled during work/,name);
   assert.match(text,/Original records are retained/,name);
   assert.doesNotMatch(text,/Available actions|Start curation|Continue curation|Revisit|Approve reviewed|Share reviewed|Choose an answer|Has queue v2 deployed|Your input is needed|questions? deferred|Review remaining/i,name);
   assert.deepEqual(operation.numberedActions,[],name);assert.deepEqual(operation.availableActions,[],name);assert.equal(operation.answerInputs,undefined,name);assert.equal(operation.reviewRequired,false,name);
   assert.equal(operation.continuation,undefined,name);assert.deepEqual(operation.workflow.review,payload.result.review,name);
  }
  assert.deepEqual(payload,before,name);
 }
});

test('legacy shared preview and unresolved originals remain raw technical evidence without acceptance',()=>{
 const before=structuredClone(states.versionedReview.result.review),vm=buildViewModel(states.versionedReview),op=conversationOperation(states.versionedReview,vm,true);
 assert.equal(before.preview.requiresVersionedReview,true);assert.deepEqual(op.workflow.review,before);assert.deepEqual(vm.actions,[]);
 assert.ok(before.preview.proposal.records.every(record=>record.body));
 const question=states.question.result.clarification.graphical.questions[0];assert.equal(question.needsInput,true);
 assert.deepEqual(conversationOperation(states.question,buildViewModel(states.question)).workflow.clarification,states.question.result.clarification);
});

test('legacy unknown outcomes and real failures remain visible without replay or retry controls',()=>{
 const applying={action:'memory-sync',result:{...structuredClone(states.progress.result),state:'applying',error:'PRODERO_CHECKPOINT_FAILED: Completion checkpoint could not be saved.'}};
 const vm=buildViewModel(applying),text=flat(renderText(vm));assert.match(text,/outcome is unknown/);assert.match(text,/PRODERO_CHECKPOINT_FAILED/);assert.deepEqual(vm.actions,[]);
 assert.doesNotMatch(text,/successfully applied|Saved\n|Approve reviewed|Available actions/);
 const failure={action:'curation-review-error',error:'PRODERO_REVIEW_FAILED: Preserved review cannot be read.'};
 assert.match(flat(renderText(buildViewModel(failure))),/PRODERO_REVIEW_FAILED/);
 const unsafe={action:'curation-review-error',error:'password=synthetic_transport_credential'};
 assert.doesNotMatch(renderText(buildViewModel(unsafe)),/synthetic_transport_credential/);
});

test('read-only overview neither resumes nor persists a workflow and preserves stale evidence',async t=>{
 const f=await createMemoryBundleFixture();t.after(f.cleanup);
 await getMemorySyncOverview(f.root);await assert.rejects(fs.access(path.join(f.root,'.prodero/local/memory-sync.json')),{code:'ENOENT'});
 const w=await runMemorySync(f.root,{action:'start'}),file=path.join(f.root,'.prodero/local/memory-sync.json'),before=await fs.readFile(file,'utf8');
 assert.equal((await getMemorySyncOverview(f.root)).workflow.id,w.id);
 await fs.appendFile(path.join(f.root,'.prodero/local/memory/mem_driving_00.md'),'\nExternal change.');
 assert.equal((await getMemorySyncOverview(f.root)).workflow.state,'stale');assert.equal(await fs.readFile(file,'utf8'),before);
});

test('text gateway retains backend workflow and proposal data while retiring the moderator surface',async t=>{
 const f=await createMemoryBundleFixture();t.after(f.cleanup);const server=createServer({projectRoot:f.root}),client=new Client({name:'quiet-ux-text',version:'1'});
 const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const call=(tool,args={})=>client.callTool({name:'prodero_text',arguments:{tool,arguments:{projectRoot:f.root,...args}}});
 const response=await call('prodero_sync');assert.equal(response.isError,undefined);
 assert.equal(response.structuredContent.result.state,'awaiting_selection');assert.ok(response.structuredContent.result.jobs.length);
 assert.match(flat(response.content[0].text),/Memory maintenance is handled during work/);assert.doesNotMatch(response.content[0].text,/Start curation|Share knowledge|Improve memory/);
 assert.deepEqual(response.structuredContent.presentation.operational.numberedActions,[]);
 const workflow=response.structuredContent.result;
 const inspected=await call('prodero_memory_sync',{request:{action:'inspect',workflowId:workflow.id},diagnostics:true});
 assert.equal(inspected.structuredContent.result.id,workflow.id);assert.deepEqual(inspected.structuredContent.result.jobs,workflow.jobs);
 assert.deepEqual(inspected.structuredContent.presentation.operational.numberedActions,[]);
});

test('empty and unknown-count projects do not invent knowledge or assert memory health',()=>{
 const payload={action:'open',project:{root:'/tmp/fixture',name:'New project',initialized:true,knowledgeCount:0,localKnowledgeCount:0,versionedKnowledgeCount:0,memoryOverview:{available:true,sessions:0,areas:[],workflow:null}}};
 let text=flat(renderText(buildViewModel(payload),false,true));assert.match(text,/No current memories yet/);assert.doesNotMatch(text,/healthy|Not enough usage history/i);
 delete payload.project.knowledgeCount;text=renderText(buildViewModel(payload),false,true);assert.doesNotMatch(text,/No current memories yet/);
});

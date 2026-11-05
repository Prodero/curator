import test from 'node:test';
import assert from 'node:assert/strict';
import {lifecycleUi} from './helpers/lifecycle-ui.mjs';

const status=(overrides={})=>({product:'Prodero',action:'open',phase:'ready',hydrationRequired:false,
  project:{root:'/tmp/quiet-visual',name:'quiet-visual',initialized:true,git:true,agentsFile:true,
    knowledgeCount:6,localKnowledgeCount:4,versionedKnowledgeCount:2,skillCount:1,activeSessionCount:1,
    conflictCount:2,promotionRecommendedCount:4,memoryOverview:{available:true,sessions:3,areas:[{id:'area_fixture',label:'Queue',recordCount:2,layers:{local:2,versioned:0},signals:['potential_conflict','context_pressure']}],workflow:{id:'saved-work',state:'awaiting_clarification'}},...overrides},
  update:{current:'0.2.1',available:false,status:'not-checked'}});
const primary=html=>html.split('<details')[0];
const moderator=/data-(?:memory-sync|sync-|review|curation|session-action)|data-action="(?:sync|curation|curation-later)"/;

test('normal visual dashboard has no moderation cards or controls, including its closed details',async()=>{
  const calls=[],ui=await lifecycleUi({callServerTool:request=>{calls.push(request);throw new Error('Unexpected call');}});
  for(const state of ['awaiting_selection','semantic_work','awaiting_clarification','awaiting_review','completed','stale']){
    const payload=status();payload.project.memoryOverview.workflow.state=state;
    payload.curation={prominent:true,planId:'saved-plan',projection:{analyzedSourceCount:3,readyChangeGroups:2,needsInputNow:1,deferredQuestions:0,deferredChanges:0,unchanged:0}};
    const before=JSON.stringify(payload),html=ui.render(payload);
    assert.match(primary(html),/data-action="knowledge" class="primary"/);
    assert.match(primary(html),/data-action="skills"/);
    assert.doesNotMatch(html,moderator);
    assert.doesNotMatch(primary(html),/Memory areas to review|Review memory|Legacy knowledge|ready for review|available for sharing|Continue curation|Re-analyze memory|area needs review/);
    assert.match(html,/Project details/);assert.doesNotMatch(html,/saved-work|saved-plan/);assert.equal(payload.project.memoryOverview.workflow.id,'saved-work');
    assert.equal(JSON.stringify(payload),before);
  }
  assert.deepEqual(calls,[]);
});

test('empty visual dashboard stays useful without suggesting maintenance',async()=>{
  const ui=await lifecycleUi(),html=ui.render(status({knowledgeCount:0,localKnowledgeCount:0,versionedKnowledgeCount:0,promotionRecommendedCount:0,conflictCount:0,memoryOverview:{available:true,sessions:0,areas:[],workflow:null}}));
  assert.match(html,/0<\/strong><span>current memories/);
  assert.match(html,/Memory saves|automatically/);
  assert.doesNotMatch(html,moderator);
  assert.doesNotMatch(primary(html),/review|curation|improvement|warning/i);
});

test('visual dashboard shares actual failure and recovery notices without repair approval controls',async()=>{
  const ui=await lifecycleUi();
  let payload=status({memoryOverview:{available:false,sessions:0,areas:[],diagnostic:{code:'MEMORY_OVERVIEW_UNAVAILABLE',cause:'Checkpoint read failed.',recovery:'Inspect the saved journal.'}}});
  let html=ui.render(payload);assert.match(primary(html),/role="alert"/);assert.match(primary(html),/Checkpoint read failed/);assert.match(primary(html),/Inspect the saved journal/);
  payload=status();payload.curation={state:'unavailable',message:'Saved maintenance review cannot be read.'};
  html=ui.render(payload);assert.match(primary(html),/Saved maintenance review cannot be read/);
  payload=status({memoryOverview:{available:true,sessions:1,areas:[],workflow:{id:'pending-save',state:'applying'}}});
  html=ui.render(payload);assert.match(primary(html),/recover|pending|outcome|verification/i);assert.doesNotMatch(html,moderator);
});

test('legacy visual maintenance payloads never recreate a queue, dispatch reasoning, answer or approve',async()=>{
  const calls=[],messages=[],ui=await lifecycleUi({callServerTool:r=>{calls.push(r);throw new Error('Unexpected call');},sendMessage:r=>{messages.push(r);throw new Error('Unexpected handoff');},setTimeout:()=>{throw new Error('Unexpected polling');}});
  for(const action of ['memory-sync','curation','curation-question','curation-reasoning','curation-applied','session-review']){
    for(const state of ['awaiting_selection','semantic_work','awaiting_clarification','awaiting_review','completed','stale']){
      const payload={ok:true,action,result:{id:'saved-work',state,revision:7,summary:{questionsDeferred:1},review:{reviewId:'exact-preview',kind:'promotion',preview:{}}}},before=JSON.stringify(payload);
      const html=ui.render(payload);assert.match(html,/Memory maintenance is handled during work/);assert.doesNotMatch(html,/<button|<input|<textarea|<form/);assert.doesNotMatch(html,moderator);assert.equal(JSON.stringify(payload),before);
    }
  }
  assert.deepEqual(calls,[]);assert.deepEqual(messages,[]);
});

test('legacy error and pending recovery surfaces remain honest and non-actionable',async()=>{
  const ui=await lifecycleUi();
  const error=ui.render({action:'curation-review-error',message:'Saved journal <unreadable>. Restore its original backup.'});
  assert.match(error,/role="alert"/);assert.match(error,/Saved journal &lt;unreadable&gt;/);assert.match(error,/Restore its original backup/);assert.doesNotMatch(error,/<button|data-review|data-curation/);
  const pending=ui.render({action:'memory-sync',result:{id:'pending',state:'applying'}});
  assert.match(pending,/pending verification/);assert.match(pending,/outcome is unknown/);assert.doesNotMatch(pending,/Saved successfully|<button/);
});

test('session saved receipt has no review queue, while saved failures and deferred synchronization remain visible',async()=>{
  const ui=await lifecycleUi(),payload={action:'session-close',result:{session:{id:'sess_quiet'},review:{total:2,needsReview:2},learned:{byType:{discovery:2},observations:2,rawSessionTokens:100,syncState:'synchronized',synchronization:{sessionsProcessed:1,canonicalTokensAdded:80,conflicts:2,intelligence:{audit:{triggered:true,status:'attention'}}}}}};
  const before=JSON.stringify(payload),html=ui.render(payload);
  assert.doesNotMatch(html,moderator);assert.doesNotMatch(primary(html),/Needs review|Review affected knowledge|Conflicts|Audit/);
  assert.match(html,/Session details/);assert.match(html,/&quot;conflicts&quot;: 2/);assert.equal(JSON.stringify(payload),before);
  payload.result.review.error='Stored review metadata is unreadable.';
  assert.match(primary(ui.render(payload)),/Stored review metadata is unreadable/);
  payload.result.learned.syncState='pending-auto-sync';payload.result.learned.synchronization=null;
  assert.match(primary(ui.render(payload)),/Saving was deferred/);
});

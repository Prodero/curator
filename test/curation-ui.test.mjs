import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleUi } from './helpers/lifecycle-ui.mjs';
import { buildViewModel } from '../dist/presentation.js';
const proposal={before:{title:'Export testing',content:'Keep exports isolated.',contextPolicy:'required',scope:'global'},outputs:[{content:'Keep exports isolated in export tests.',contextPolicy:'required',category:'instruction',scope:'project'}],changes:['applicability-narrowing'],attention:[],group:'Export tests',evidence:['Existing test policy'],id:'mem_test',sourceId:'mem_test',revision:'abc'};
const cleanup=()=>({projection:{analyzedSourceCount:1,readyChangeGroups:1,needsInputNow:0,deferredQuestions:0,deferredChanges:0,unchanged:0,paused:false,items:[{proposalIds:['mem_test'],outcome:'proposed',needsInput:false}]},action:'curation',root:'/tmp/cleanup',trustedReviewAvailable:false,plan:{planId:'plan',accountedSources:1,summary:{safe:1,attention:0,before:{projectWideRequired:1},proposed:{projectWideRequired:0}},proposals:[proposal]}});
const dashboard={action:'open',project:{root:'/tmp/cleanup',name:'cleanup',initialized:true,git:true,agentsFile:true,knowledgeCount:1,localKnowledgeCount:1,versionedKnowledgeCount:0,skillCount:0,sessionCount:0,pendingSessionCount:0,conflictCount:0}};
const index=(payload,action)=>buildViewModel(payload).actions.findIndex(a=>a.arguments.action===action||a.tool===action);
const result=payload=>({structuredContent:payload});
test('cleanup exposes comparisons and preview-only guidance without nested disclosure',async()=>{
 const ui=await lifecycleUi(),html=ui.render(cleanup());
 assert.match(html,/supports preview only/);assert.match(html,/Current knowledge/);assert.match(html,/Keep exports isolated in export tests/);
 assert.equal((html.match(/<details/g)||[]).length,1);assert.match(html,/Sources and analysis/);assert.doesNotMatch(html,/Apply safe suggestions/);
});
test('preview shows progress and visible results without changing knowledge',async()=>{
 const p=cleanup(),calls=[];let resolve;
 const ui=await lifecycleUi({callServerTool:r=>{calls.push(r);return new Promise(done=>resolve=done);}});
 ui.render(p);const running=ui.clickAsync(`curation-${index(p,'simulate')}`);
 assert.match(ui.html,/Calculating the effect/);assert.match(ui.html,/disabled/);
 resolve(result({...p,result:[{task:'Update export tests',before:{requiredCandidateTokens:120,requiredOmissions:0},after:{requiredCandidateTokens:60,requiredOmissions:0}}]}));await running;
 assert.match(ui.html,/Preview ready/);assert.match(ui.html,/Preview results/);assert.match(ui.html,/120 → 60/);assert.equal(calls[0].arguments.action,'simulate');
});
test('Later defers the exact plan and returns to dashboard with confirmation',async()=>{
 const p=cleanup(),calls=[];const ui=await lifecycleUi({callServerTool:async r=>{calls.push(r);return result(r.name==='prodero_open'?dashboard:{...p,deferred:true});}});
 ui.render(p);await ui.clickAsync(`curation-${index(p,'defer')}`);
 assert.deepEqual(calls.map(r=>r.name),['prodero_curation','prodero_open']);assert.equal(calls[0].arguments.planId,'plan');
 assert.match(ui.html,/open-dashboard/);assert.match(ui.html,/Cleanup postponed/);assert.doesNotMatch(ui.html,/curation-shell/);
});
test('Back clears a prior lifecycle screen and accepts text-only tool envelopes',async()=>{
 const p=cleanup(),ui=await lifecycleUi({callServerTool:async()=>({content:[{type:'text',text:JSON.stringify(dashboard)}]})});
 ui.render({action:'session-close',result:{learned:{byType:{},observations:0,rawSessionTokens:0,syncState:'pending-auto-sync',synchronization:null}}});
 ui.render(p);await ui.clickAsync(`curation-${index(p,'prodero_open')}`);assert.match(ui.html,/open-dashboard/);
});
test('errors stay visible and restore enabled cleanup actions',async()=>{
 const p=cleanup(),ui=await lifecycleUi({callServerTool:async()=>({isError:true,content:[{type:'text',text:'Curation plan changed. Review the current proposal.'}]})});
 ui.render(p);await ui.clickAsync(`curation-${index(p,'simulate')}`);
 assert.match(ui.html,/Curation plan changed/);assert.match(ui.html,/curation-shell/);assert.doesNotMatch(ui.html,/disabled/);
});
test('empty cleanup offers only return and no ineffective preview',async()=>{
 const p=cleanup();p.plan.proposals=[];p.plan.summary.safe=0;p.projection={...p.projection,analyzedSourceCount:0,readyChangeGroups:0,items:[]};
 const ui=await lifecycleUi();const html=ui.render(p);
 assert.match(html,/No cleanup is needed/);assert.deepEqual(buildViewModel(p).actions.map(a=>a.tool),['prodero_open']);
});
test('legacy UI never offers apply even with a caller availability flag',async()=>{
 const p=cleanup();p.trustedReviewAvailable=true;const ui=await lifecycleUi();ui.render(p);assert.doesNotMatch(ui.html,/data-curation="-1"|Apply safe suggestions/);assert.ok(!buildViewModel(p).actions.some(a=>a.arguments.action==='apply'));
});
test('attention records explain why they remain unchanged without offering apply',async()=>{
 const p=cleanup();p.plan.proposals=[{...proposal,attention:['Conflicting policy needs a decision.']}];p.plan.summary.safe=0;p.plan.summary.attention=1;p.projection={...p.projection,readyChangeGroups:0,needsInputNow:1,items:[{proposalIds:['mem_test'],outcome:'unresolved',needsInput:true}]};
 const ui=await lifecycleUi(),html=ui.render(p);
 assert.match(html,/Kept unchanged/);assert.match(html,/Conflicting policy needs a decision/);assert.match(html,/Proposal · not ready to apply/);assert.doesNotMatch(html,/Preview context impact/);
});

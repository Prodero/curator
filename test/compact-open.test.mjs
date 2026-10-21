import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryOpenPresentation,buildViewModel,renderText} from '../dist/presentation.js';
import {memoryAreaLabel,memorySyncPresentation} from '../dist/memory-presentation.js';
import {lifecycleUi} from './helpers/lifecycle-ui.mjs';
const label='A very long knowledge title describing an implementation decision that should never become a dashboard heading';
const areas=Array.from({length:20},(_,i)=>({id:`area_${String(i).padStart(20,'0')}`,label:label+i,recordCount:4,layers:{local:3,versioned:1},signals:['context_pressure','recent_evolution'],counts:{budgetOmissionSessions:3}}));
const payload={product:'Prodero',action:'open',project:{root:'/tmp/compact',name:'compact',initialized:true,git:true,agentsFile:true,knowledgeCount:80,localKnowledgeCount:60,versionedKnowledgeCount:20,skillCount:2,memoryOverview:{available:true,sessions:3,areas,workflow:null}}};
const primary=s=>s.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g,'');
test('Open shows a bounded neutral summary without any candidate titles or bodies; text discloses detail on request',async()=>{
 const ui=await lifecycleUi();ui.render(payload);const html=primary(ui.html);
 assert.match(html,/Memory can be improved/);assert.match(html,/20 areas identified/);assert.match(html,/60 Local memories available for sharing review/);assert.match(html,/Relevant knowledge has not fit into recent task context/);
 assert.doesNotMatch(html,/very long knowledge title|related memories|knowledge-warning|20 areas can be improved|Knowledge has evolved|Sessions save useful knowledge/);
 assert.match(html,/Memory saves automatically/);assert.match(html,/data-action="sync" class="primary"/);
 const vm=buildViewModel(payload);assert.equal(vm.sections.find(s=>s.title==='Memory').items.length,20);assert.doesNotMatch(renderText(vm),/very long knowledge title/);assert.match(renderText(vm,false,true),/very long knowledge title/);assert.ok(vm.diagnostics.length);
});
test('only genuine conflicts warn; resume and stale instructions remain visible in compact Open',()=>{
 let p=structuredClone(payload.project);assert.equal(memoryOpenPresentation(p).conflicts,0);p.memoryOverview.areas[0].signals=['potential_conflict'];assert.equal(memoryOpenPresentation(p).conflicts,1);
 p.memoryOverview.workflow={state:'semantic_work'};assert.match(memoryOpenPresentation(p).dashboard.workflowNotice,/in progress/);
 p.memoryOverview.workflow.state='stale';assert.match(memoryOpenPresentation(p).dashboard.workflowNotice,/Re-analyze/);
});
test('graphical area labels use deterministic paths or IDs, never inferred knowledge-title topics',()=>{
 assert.equal(memoryAreaLabel({id:'area_abcdef123456',label}),'Area abcdef12');assert.equal(memoryAreaLabel({id:'area_xyz',label:'src/driving'}),'src/driving');
 const path='src/'+('long_component/').repeat(6)+'driving';assert.ok(memoryAreaLabel({label:path}).length<=48);
 const w={state:'semantic_work',jobs:[{...areas[0],status:'semantic_work'}],next:{candidateId:areas[0].id},summary:{}};const m=memorySyncPresentation(w);assert.equal(m.areas[0].title,areas[0].label);assert.doesNotMatch(m.graphicalHeadline,/knowledge title/);assert.equal(m.headline,'Analysis queued');
});
test('no-history graphical summary remains uncertain without copying the whole text report',()=>{
 const p=structuredClone(payload.project);p.memoryOverview={available:true,sessions:0,areas:[]};const m=memoryOpenPresentation(p);assert.match(m.dashboard.signal,/Not enough usage history/);assert.doesNotMatch(m.dashboard.headline,/healthy/i);assert.ok(m.notes.length>1);
});

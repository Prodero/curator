import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryOpenPresentation,buildViewModel,renderText} from '../dist/presentation.js';
import {lifecycleUi} from './helpers/lifecycle-ui.mjs';
const label='A very long knowledge title describing an implementation decision that should never become a dashboard heading';
const areas=Array.from({length:20},(_,i)=>({id:`area_${String(i).padStart(20,'0')}`,label:label+i,recordCount:4,layers:{local:3,versioned:1},signals:['context_pressure','recent_evolution'],counts:{budgetOmissionSessions:3}}));
const payload={product:'Prodero',action:'open',project:{root:'/tmp/compact',name:'compact',initialized:true,git:true,agentsFile:true,knowledgeCount:80,localKnowledgeCount:60,versionedKnowledgeCount:20,skillCount:2,activeSessionCount:1,memoryOverview:{available:true,sessions:3,areas,workflow:null}}};
const primary=html=>html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g,'');
const flat=text=>text.replace(/\n│ ?/g,' ');
const moderator=/Review cleanup|Pause review|Review saved decisions|Continue curation|Re-analyze|areas identified|sharing review|data-action="sync"|data-memory-sync|deferred questions|unapplied change/i;

test('ordinary visual and text Open have neutral knowledge access without moderation UI even in details',async()=>{
 const ui=await lifecycleUi();ui.render(payload);const vm=buildViewModel(payload);
 assert.match(primary(ui.html),/Memory saves automatically/);assert.match(primary(ui.html),/Knowledge/);assert.match(primary(ui.html),/Skills/);
 for(const output of [ui.html,renderText(vm),renderText(vm,false,true)]) {
  assert.doesNotMatch(output,moderator);assert.doesNotMatch(output,/very long knowledge title|related memories|Memory can be improved|Knowledge has evolved/);
 }
 assert.ok(vm.actions.every(action=>!['prodero_sync','prodero_memory_sync'].includes(action.tool)));
 assert.ok(vm.actions.some(action=>action.tool==='prodero_curation'&&action.arguments.fresh));assert.equal(vm.sections.some(section=>section.title==='Memory'),false);
 assert.equal(vm.conversation.prompt,undefined);assert.deepEqual(vm.conversation.attention,[]);
});

test('planner conflicts and stale work remain technical evidence without changing original state',()=>{
 const candidate=structuredClone(payload);candidate.project.conflictCount=1;candidate.project.memoryOverview.areas[0].signals=['potential_conflict'];candidate.project.memoryOverview.workflow={id:'preserved-workflow',state:'stale'};
 const before=structuredClone(candidate),vm=buildViewModel(candidate),compact=renderText(vm),technical=renderText(vm,true);
 assert.deepEqual(vm.conversation.attention,[]);assert.equal(vm.conversation.continuation,undefined);assert.doesNotMatch(compact,/ATTENTION|review cleanup|review these|stale/i);
 assert.match(technical,/potential_conflict/);assert.match(technical,/preserved-workflow/);assert.match(technical,/very long knowledge title/);
 assert.deepEqual(candidate,before);
});

test('actual unavailable diagnostics and uncertain application stay visible without a retry or approval control',async()=>{
 const candidate=structuredClone(payload);candidate.project.memoryOverview={available:false,areas:[],diagnostic:{code:'PRODERO_STORAGE_FAILED',cause:'Preserved workflow could not be read.',recovery:'Inspect the saved journal before retrying.'},workflow:{id:'interrupted',state:'applying'}};
 const ui=await lifecycleUi();ui.render(candidate);const text=flat(renderText(buildViewModel(candidate)));
 for(const output of [ui.html,text]) {
  assert.match(output,/PRODERO_STORAGE_FAILED/);assert.match(output,/Preserved workflow could not be read/);assert.match(output,/verification/);assert.doesNotMatch(output,moderator);
 }
 assert.match(primary(ui.html),/role="alert"/);assert.equal(buildViewModel(candidate).conversation.prompt,undefined);
});

test('missing history and unknown counts do not invent optimization claims or empty knowledge',async()=>{
 const candidate=structuredClone(payload);candidate.project.memoryOverview={available:false,sessions:0,areas:[]};
 const before=structuredClone(candidate.project),copy=memoryOpenPresentation(candidate.project),ui=await lifecycleUi();ui.render(candidate);
 assert.match(copy.headline,/automatically/);assert.deepEqual(Object.keys(copy).sort(),['headline','notes']);assert.deepEqual(candidate.project,before);
 assert.deepEqual(buildViewModel(candidate).conversation.attention,[]);assert.doesNotMatch(ui.html,/healthy|Not enough usage history|optimization|role="alert"/i);
 delete candidate.project.knowledgeCount;assert.doesNotMatch(renderText(buildViewModel(candidate),false,true),/No current memories yet/);
 candidate.project.knowledgeCount=0;assert.match(flat(renderText(buildViewModel(candidate),false,true)),/No current memories yet/);
});

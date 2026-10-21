import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {memoryUxFixtures} from './helpers/memory-ux-fixtures.mjs';
import {createMemoryBundleFixture} from './helpers/memory-bundle-fixtures.mjs';
import {runMemorySync,getMemorySyncOverview} from '../dist/core/memory-sync.js';
import {buildViewModel,renderText,memorySyncPresentation} from '../dist/presentation.js';
import {lifecycleUi} from './helpers/lifecycle-ui.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
let states;test.before(async()=>{states=await memoryUxFixtures();});
const text=name=>renderText(buildViewModel(states[name]),false,true).replace(/\n│ ?/g,' ');
const primary=html=>html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g,'');
test('Open details retain automatic saving, one Sync entry and no-history uncertainty',async()=>{
 const ui=await lifecycleUi();ui.render(states.noHistory);assert.match(primary(ui.html),/Memory saves automatically/);assert.match(text('noHistory'),/Sessions save useful knowledge into Local Knowledge when they close/);for(const value of [primary(ui.html),text('noHistory')]){assert.match(value,/Not enough usage history yet/);assert.doesNotMatch(value,/Memory healthy|LOCAL · HEALTHY|Review Promotion|Pending sync|Checkpoints/);assert.match(value,/Curate Memory/);}assert.equal(ui.renders.length,1);
});
test('Open retains overview while Sync entry shows only operation choices',async()=>{
 assert.equal(states.twoAreas.project.memoryOverview.areas.length,2);assert.match(text('twoAreas'),/2 areas can be improved/);
 const ui=await lifecycleUi();ui.render(states.selection);for(const value of [primary(ui.html),text('selection')]){assert.match(value,/Improve memory/);assert.match(value,/Share knowledge/);assert.match(value,/Start curation/);assert.doesNotMatch(value,/Area |areas|did not fit/);assert.doesNotMatch(value,/context_pressure|planner|semantic_work|checkpoint|candidateIds/);assert.match(value,/review the Git diff before commit\/push/);}assert.match(ui.html,/Share knowledge/);assert.doesNotMatch(ui.html,/Promote all/);
});
test('planner evolution and conflict signals remain diagnostic until agent investigation',async()=>{
 const ui=await lifecycleUi();ui.render(states.evolution);assert.doesNotMatch(primary(ui.html),/Knowledge has evolved through related updates/);assert.doesNotMatch(primary(ui.html),/knowledge-warning|incompatible|conflict/);assert.ok(states.conflict.result.jobs.some(j=>j.signals.includes('potential_conflict')));ui.render(states.conflict);assert.doesNotMatch(primary(ui.html),/class="knowledge-warning"/);assert.doesNotMatch(text('conflict'),/incompatible current knowledge/);assert.match(ui.html,/potential_conflict/);
});
test('queued progress uses product language without claiming an active worker',async()=>{
 const ui=await lifecycleUi();ui.render(states.progress);assert.match(primary(ui.html),/Analysis queued/);assert.match(text('progress'),/missing project facts/);assert.doesNotMatch(primary(ui.html),/Prepare next|semantic_work|JSON/);
});
test('shared review shows exact proposed content, Versioned archive history and workflow approval in App and expanded text',async()=>{
 const ui=await lifecycleUi();ui.render(states.versionedReview);for(const value of [primary(ui.html),text('versionedReview')]){assert.match(value,/Review shared-memory changes/);assert.match(value,/Git-shareable project state that your agent can change/);assert.match(value,/does not commit or push/);assert.match(value,/saved together after approval/);assert.match(value,/2 previous shared memories preserved in Versioned archive files/);for(const record of states.versionedReview.result.review.preview.proposal.records)assert.ok(value.includes(record.title));assert.match(value,/Approve reviewed changes/);}assert.match(ui.html,/<details class="memory-details"><summary>Details and diagnostics/);assert.doesNotMatch(primary(ui.html),/previewId|\.prodero\/archive/);
});
test('protected project knowledge remains visibly unchanged',()=>{
 assert.match(text('protected'),/1 project decision was preserved unchanged/);assert.match(text('protected'),/1 project invariant was preserved unchanged/);
});
test('completion reports actual results without whole-project or invented savings',async()=>{
 const ui=await lifecycleUi();ui.render(states.completed);for(const value of [primary(ui.html),text('completed')]){assert.match(value,/Memory curated/);assert.doesNotMatch(value,/area improved/);assert.match(value,/4 previous memories → 2 current memories/);assert.match(value,/4 previous memories preserved in history/);assert.match(value,/142 → 131 tokens/);assert.doesNotMatch(value,/savings|14\.2K/);}
});
test('interruption and stale states avoid checkpoint jargon and preserve review',()=>{
 assert.match(text('interrupted'),/Curate Memory is in progress/);assert.match(text('interrupted'),/Continue curation/);assert.deepEqual(states.resumed.result.review,states.versionedReview.result.review);assert.match(text('stale'),/Project memory changed since this curation started. Re-analyze before continuing/);assert.doesNotMatch(text('stale'),/checkpoint|revision/);
});
test('host echoes and out-of-order progress replace one card and cannot regress state',async()=>{
 const ui=await lifecycleUi();ui.render(states.progress);ui.render(states.progress);assert.equal(ui.renders.length,1);ui.render(states.completed);assert.equal(ui.renders.length,2);ui.render(states.progress);assert.equal(ui.renders.length,2);assert.match(primary(ui.html),/Memory curated/);assert.equal((ui.html.match(/<main /g)??[]).length,1);
});
test('no-op distinguishes missing history, skipped improvements and actual no-candidate usage',()=>{
 const w=structuredClone(states.completed.result);w.jobs=[];w.summary={...w.summary,areasProcessed:0,archived:0};w.usage={available:false,sessions:0};assert.match(memorySyncPresentation(w).notes.join(' '),/Not enough usage history/);w.usage={available:true,sessions:2};assert.match(memorySyncPresentation(w).notes.join(' '),/No transformation was needed based on recent usage/);w.jobs=[{...states.selection.result.jobs[0],status:'unselected'}];assert.match(memorySyncPresentation(w).notes.join(' '),/No memory improvements were selected/);
});
test('uncertainty remains prominent and is not presented as genuine conflict',()=>{
 const w=structuredClone(states.protected.result);w.review.preview.summary.unresolved=['mem_unknown'];w.review.preview.limitations.unresolved=[{information:['Need confirmation of applicability.']}];const m=memorySyncPresentation(w);assert.match(m.notes.join(' '),/could not safely determine how 1 memory/);assert.deepEqual(m.warnings,[]);
});
test('read-only Open overview neither creates nor resumes workflow and detects external changes without saving',async t=>{
 const f=await createMemoryBundleFixture();t.after(f.cleanup);await getMemorySyncOverview(f.root);await assert.rejects(fs.access(path.join(f.root,'.prodero/local/memory-sync.json')),{code:'ENOENT'});const w=await runMemorySync(f.root,{action:'start'}),file=path.join(f.root,'.prodero/local/memory-sync.json'),before=await fs.readFile(file,'utf8');const overview=await getMemorySyncOverview(f.root);assert.equal(overview.workflow.id,w.id);await fs.appendFile(path.join(f.root,'.prodero/local/memory/mem_driving_00.md'),'\nExternal change.');assert.equal((await getMemorySyncOverview(f.root)).workflow.state,'stale');assert.equal(await fs.readFile(file,'utf8'),before);
});
test('text gateway offers clean review plus opt-in exact diagnostics, preserving structured agent context',async t=>{
 const f=await createMemoryBundleFixture();t.after(f.cleanup);const server=createServer({projectRoot:f.root}),client=new Client({name:'ux-text',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});const call=(tool,args={})=>client.callTool({name:'prodero_text',arguments:{tool,arguments:{projectRoot:f.root,...args}}});
 let r=await call('prodero_sync');assert.equal(r.isError,undefined);assert.match(r.content[0].text,/Start curation/);assert.doesNotMatch(r.content[0].text,/context_pressure|checkpoint/);const w=r.structuredContent.result;r=await call('prodero_memory_sync',{request:{action:'inspect',workflowId:w.id},diagnostics:true});assert.match(r.content[0].text,/Memory diagnostics/);assert.match(r.content[0].text,/context_pressure/);
});

test('failed stale approval refreshes authoritative state without repeating approval',async()=>{
 const {knowledgeUi}=await import('./helpers/knowledge-ui.mjs');const calls=[];
 const ui=await knowledgeUi(async request=>{calls.push(request.arguments.request);return request.arguments.request.action==='approve'?{isError:true,structuredContent:{ok:false,error:'Stale revision'}}:{structuredContent:states.stale};});
 ui.render({structuredContent:states.versionedReview});await ui.sync('approve');
 assert.deepEqual(calls.map(c=>c.action),['approve','inspect']);assert.match(primary(ui.html),/Project memory changed since this curation started/);assert.match(primary(ui.html),/Stale revision/);assert.doesNotMatch(primary(ui.html),/Approve reviewed changes/);
});

test('brand-new and unknown-count projects do not imply healthy or invented empty knowledge',()=>{
 const payload={product:'Prodero',action:'open',project:{root:'/tmp/fixture',name:'New project',initialized:true,knowledgeCount:0,localKnowledgeCount:0,versionedKnowledgeCount:0,memoryOverview:{available:true,sessions:0,areas:[],workflow:null}}};
 let rendered=renderText(buildViewModel(payload),false,true);assert.match(rendered,/No current memories yet/);assert.match(rendered,/Not enough usage history/);assert.doesNotMatch(rendered,/healthy/i);
 delete payload.project.knowledgeCount;rendered=renderText(buildViewModel(payload),false,true);assert.doesNotMatch(rendered,/No current memories yet/);
});

test('completion does not call an unchanged reviewed area improved',()=>{
 const w=structuredClone(states.completed.result);w.summary.areasProcessed=2;w.jobs.push({...w.jobs[0],id:'unchanged',result:{summary:{archives:[]}}});const before=JSON.stringify(w);assert.match(memorySyncPresentation(w).notes.join(' '),/4 previous memories → 2 current memories/);assert.doesNotMatch(memorySyncPresentation(w).notes.join(' '),/2 areas improved/);assert.equal(JSON.stringify(w),before);
});

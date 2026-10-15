// Invented toy-project fixtures; no real project incidents or operational records.
import {curationApplyBinding,curationOperationId} from '../dist/core/curation-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initializeProject} from '../dist/core/project.js';
import {writeKnowledge,listKnowledge,renderKnowledge} from '../dist/core/memory.js';
import {listCheckpoints,checkedDataPath,writeFileAtomic,sha256} from '../dist/core/storage.js';
import {withSyncLock} from '../dist/core/sync-transaction.js';
import {createCurationReview,loadCurationReview,stageCurationDecisions,selectedCurationProposals,REVIEW_RETENTION} from '../dist/core/curation-review.js';
import {executeCurationReview} from '../dist/curation-review-adapter.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer,PRODERO_TOOLS} from '../dist/server.js';
const item=(id,content='Decision:\nCedarAPI tests must isolate exports.\n\nImpact:\nNever call real exports.')=>({version:3,id,category:'instruction',contextPolicy:'required',authority:'legacy_inherited',applicability:{kind:'legacy'},scope:'global',scopeRef:null,priority:'normal',status:id==='conflict'?'disputed':'active',title:`Export testing ${id}`,content,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[]});
async function fixture(t,items=[item('mem_rule')]){const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-review-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await initializeProject(root);for(const i of items)await writeKnowledge(root,i);return root;}
const identity=r=>({reviewId:r.snapshot.reviewId,planHash:r.snapshot.planHash,decisionRevision:r.state.revision});
async function choose(root,r,choice='suggested',units=r.snapshot.units.filter(u=>u.applicable)){return stageCurationDecisions(root,{...identity(r),decisions:Object.fromEntries(units.map(u=>[u.id,choice]))});}
const request=r=>({...identity(r),...curationApplyBinding(r,selectedCurationProposals(r)),selectedIds:selectedCurationProposals(r)});
async function ready(root){return choose(root,await createCurationReview(root));}
const knowledgeBytes=async root=>JSON.stringify(await listKnowledge(root));
async function mcp(t,root,apps=true){const server=createServer({projectRoot:root}),client=new Client({name:'review-app-test',version:'1'},{capabilities:apps?{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}:{}});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});return client;}
test('snapshot preserves exact plan and decisions across reload without mutating knowledge',async t=>{
 const root=await fixture(t),before=await knowledgeBytes(root),r=await createCurationReview(root);
 assert.equal(r.snapshot.planHash,r.snapshot.plan.planId);assert.equal(r.snapshot.plan.engine.length>0,true);assert.deepEqual(r.state.decisions,{});
 const chosen=await choose(root,r);assert.deepEqual(await loadCurationReview(root,r.snapshot.reviewId),chosen);assert.equal(await knowledgeBytes(root),before);assert.equal((await listCheckpoints(root)).filter(c=>c.curation).length,0);
});
test('review retention bounds count and prunes aged snapshots plus decision files',async t=>{
 const root=await fixture(t),old=await createCurationReview(root),file=path.join(root,'.prodero/local/curation-reviews',old.snapshot.reviewId+'.json');
 const age=new Date(Date.now()-REVIEW_RETENTION.maxAgeMs-10000);await fs.utimes(file,age,age);
 for(let n=0;n<REVIEW_RETENTION.maxCount+2;n++)await createCurationReview(root);
 const files=await fs.readdir(path.dirname(file));assert.equal(files.filter(f=>!f.includes('.state.')).length,REVIEW_RETENTION.maxCount);assert.equal(files.length,REVIEW_RETENTION.maxCount*2);assert.ok(!files.some(f=>f.startsWith(old.snapshot.reviewId)));
});
test('valid apply has complete history and lost-response replay survives snapshot removal',async t=>{
 const root=await fixture(t),r=await ready(root),req=request(r),first=await executeCurationReview(root,req);
 assert.equal(first.replayed,false);assert.deepEqual(first.applied,['mem_rule']);assert.equal((await listKnowledge(root))[0].applicability.kind,'scoped');
 const checkpoint=JSON.parse(await fs.readFile(first.historyPath,'utf8'));assert.equal(checkpoint.curation.review.operationId,first.operationId);assert.equal(checkpoint.curation.preimages.length,1);assert.ok(checkpoint.curation.postimages.length);for(const image of checkpoint.curation.postimages)assert.equal(await fs.readFile(path.join(root,'.prodero',image.path),'utf8'),image.content);assert.deepEqual(checkpoint.curation.plan,r.snapshot.plan);
 await fs.rm(path.join(root,'.prodero/local/curation-reviews'),{recursive:true});
 const replay=await executeCurationReview(root,req);assert.equal(replay.replayed,true);assert.equal(replay.checkpointId,first.checkpointId);
});
test('Current and Later are staged choices and never included in the executor selection',async t=>{
 const root=await fixture(t,[item('a'),item('b','Decision:\nOrbitUI tests must preserve isolated fixtures.'),item('c','Decision:\nCedarAPI tests must preserve dry runs.')]);
 let r=await createCurationReview(root);assert.equal(r.snapshot.units.length,3);
 r=await stageCurationDecisions(root,{...identity(r),decisions:{[r.snapshot.units[0].id]:'suggested',[r.snapshot.units[1].id]:'current',[r.snapshot.units[2].id]:'deferred'}});
 const before=await listKnowledge(root),result=await executeCurationReview(root,request(r)),after=await listKnowledge(root);
 assert.equal(result.applied.length,1);for(const id of result.unselected)assert.deepEqual(after.find(i=>i.id===id),before.find(i=>i.id===id));
});
test('merge group is one decision and incomplete request is rejected',async t=>{
 const root=await fixture(t,[item('a'),item('b')]),r=await ready(root);assert.equal(r.snapshot.units.length,1);assert.equal(r.snapshot.units[0].proposalIds.length,2);
 const before=await knowledgeBytes(root);await assert.rejects(executeCurationReview(root,{...request(r),selectedIds:['a']}),e=>e.code==='invalid_selection');assert.equal(await knowledgeBytes(root),before);
 const result=await executeCurationReview(root,request(r));assert.equal(result.applied.length,2);
});
test('unresolved suggestions cannot be staged or injected into apply',async t=>{
 const root=await fixture(t,[item('bad','Decision:\nSynthetic runner currently fails by design.')]),r=await createCurationReview(root);
 assert.equal(r.snapshot.units[0].applicable,false);
 await assert.rejects(choose(root,r,'suggested',r.snapshot.units),e=>e.code==='invalid_selection');
 await assert.rejects(executeCurationReview(root,{...identity(r),...curationApplyBinding(r,['bad']),selectedIds:['bad']}),e=>e.code==='invalid_selection');
});
for(const variant of ['source','catalog','evidence','dependency'])test(`stale ${variant} applies nothing`,async t=>{
 const root=await fixture(t);if(variant==='evidence'||variant==='dependency'){await fs.mkdir(path.join(root,'tests'));await fs.writeFile(path.join(root,'tests/cedarapi.ts'),'// CedarAPI tests isolate exports');}
 const r=await ready(root);
 if(variant==='source')await writeKnowledge(root,item('mem_rule','Decision:\nCedarAPI tests must retain another constraint.'));
 if(variant==='catalog')await writeKnowledge(root,item('new','Decision:\nOrbitUI tests must preserve isolation.'));
 if(variant==='evidence')await fs.writeFile(path.join(root,'tests/cedarapi.ts'),'// CedarAPI tests changed');
 if(variant==='dependency')await fs.writeFile(path.join(root,'tests/api_actions.ts'),'// TileHarness CedarAPI tests new dependency');
 const before=await knowledgeBytes(root);await assert.rejects(executeCurationReview(root,request(r)),e=>e.code==='stale_review');assert.equal(await knowledgeBytes(root),before);
});
test('project mismatch, invalid id, plan hash and supplied records fail closed',async t=>{
 const root=await fixture(t),other=await fixture(t),r=await ready(root),dir=path.join(other,'.prodero/local/curation-reviews');await fs.mkdir(dir,{recursive:true});await fs.cp(path.join(root,'.prodero/local/curation-reviews'),dir,{recursive:true});
 await assert.rejects(executeCurationReview(other,request(r)),e=>e.code==='project_mismatch');
 await assert.rejects(loadCurationReview(root,'../../other'),e=>e.code==='invalid_review');
 await assert.rejects(executeCurationReview(root,{...request(r),planHash:'a'.repeat(64)}),e=>e.code==='stale_review');
 const client=await mcp(t,root),response=await client.callTool({name:PRODERO_TOOLS.curationApply,arguments:{...request(r),outputs:[{content:'replacement'}]}});assert.equal(response.isError,true);
});
test('different decisions invalidate an older final summary; different selection after apply is stale',async t=>{
 const root=await fixture(t,[item('a'),item('b','Decision:\nOrbitUI tests must preserve isolation.')]);let r=await ready(root);const old=request(r);
 r=await choose(root,r,'current',[r.snapshot.units[1]]);await assert.rejects(executeCurationReview(root,old),e=>e.code==='review_changed');
 await executeCurationReview(root,request(r));r=await choose(root,r,'suggested',[r.snapshot.units[1]]);
 await assert.rejects(executeCurationReview(root,request(r)),e=>e.code==='stale_review');
});
test('concurrent writer is serialized before whole-plan validation',async t=>{
 const root=await fixture(t),r=await ready(root);let release,entered;const started=new Promise(resolve=>entered=resolve);
 const writer=withSyncLock(root,async()=>{entered();await new Promise(resolve=>release=resolve);await writeFileAtomic(await checkedDataPath(root,'memory/mem_rule.md'),renderKnowledge(item('mem_rule','Decision:\nCedarAPI tests must preserve changed rules.')));});
 await started;const apply=executeCurationReview(root,request(r));release();await writer;await assert.rejects(apply,e=>e.code==='stale_review');
});
test('transaction interruption recovers before replay and returns the original operation',async t=>{
 const root=await fixture(t),r=await ready(root),rename=fs.rename;let injected=false;
 fs.rename=async(from,to)=>{if(!injected&&String(to).includes('/checkpoints/')){injected=true;throw new Error('interrupted checkpoint');}return rename(from,to);};
 try{await assert.rejects(executeCurationReview(root,request(r)),/interrupted checkpoint/);}finally{fs.rename=rename;}
 const replay=await executeCurationReview(root,request(r));assert.equal(replay.replayed,true);assert.ok(await fs.stat(replay.historyPath));
});
test('pending unrelated recovery occurs before stale validation; analysis never recovers knowledge',async t=>{
 const root=await fixture(t),r=await ready(root);const file=await checkedDataPath(root,'memory/mem_rule.md'),before=await fs.readFile(file,'utf8');
 const id='chk_recovery_test';await fs.mkdir(path.join(root,'.prodero/.transactions'),{recursive:true});
 await fs.writeFile(path.join(root,'.prodero/.transactions/pending.json'),JSON.stringify({version:1,writes:[{path:'memory/mem_rule.md',before:sha256(before),after:renderKnowledge(item('mem_rule','Decision:\nCedarAPI tests must preserve recovered state.'))},{path:`checkpoints/${id}.json`,before:null,after:JSON.stringify({id,createdAt:new Date().toISOString(),sessions:[]})}]}));
 await assert.rejects(createCurationReview(root),e=>e.code==='recovery_required');assert.equal(await fs.readFile(file,'utf8'),before);
 await assert.rejects(executeCurationReview(root,request(r)),e=>e.code==='stale_review');assert.match(await fs.readFile(file,'utf8'),/recovered state/);
});
test('MCP restart reloads review; app-only metadata and legacy/text mutation paths are closed',async t=>{
 const root=await fixture(t),first=await mcp(t,root),r=(await first.callTool({name:PRODERO_TOOLS.curationReview,arguments:{action:'create'}})).structuredContent.review;
 const second=await mcp(t,root),resumed=(await second.callTool({name:PRODERO_TOOLS.curationReview,arguments:{action:'inspect',reviewId:r.snapshot.reviewId}})).structuredContent.review;assert.deepEqual(resumed,r);
 const tools=(await second.listTools()).tools;for(const name of [PRODERO_TOOLS.curationApply,PRODERO_TOOLS.curationReview])assert.deepEqual(tools.find(t=>t.name===name)._meta.ui.visibility,['app']);
 const before=await knowledgeBytes(root);
 for(const args of [{tool:PRODERO_TOOLS.curation,arguments:{action:'apply',approved:true,planId:r.snapshot.planHash,selected:['mem_rule']}},{tool:PRODERO_TOOLS.curationApply,arguments:{...identity(r),selectedIds:['mem_rule']}}])assert.equal((await second.callTool({name:PRODERO_TOOLS.text,arguments:args})).isError,true);
 assert.equal((await second.callTool({name:PRODERO_TOOLS.curation,arguments:{action:'apply',approved:true}})).isError,true);assert.equal(await knowledgeBytes(root),before);
 const staged=(await second.callTool({name:PRODERO_TOOLS.curationReview,arguments:{action:'decide',...identity(r),decisions:{[r.snapshot.units[0].id]:'suggested'}}})).structuredContent.review;
 assert.equal(await knowledgeBytes(root),before);
 const result=(await second.callTool({name:PRODERO_TOOLS.curationApply,arguments:request(staged)})).structuredContent;assert.equal(result.action,'curation-applied');
});

// Execute the production App handlers against the actual MCP server, without
// treating this transport test as proof of a graphical host's visibility policy.
import {lifecycleUi} from './helpers/lifecycle-ui.mjs';
async function appFixture(t,items){
 const root=await fixture(t,items),client=await mcp(t,root),calls=[];
 const ui=await lifecycleUi({callServerTool:async call=>{calls.push(call);return client.callTool(call);}});
 const initial=(await client.callTool({name:PRODERO_TOOLS.curation,arguments:{projectRoot:root,action:'plan'}})).structuredContent;
 ui.render(initial);return {root,client,ui,calls,initial};
}
test('production App renders, stages, previews and reloads without mutation; final Apply alone writes',async t=>{
 const {root,ui,calls,initial}=await appFixture(t),before=await knowledgeBytes(root);
 ui.render(initial);assert.equal(calls.length,0);assert.match(ui.html,/Review knowledge/);
 await ui.clickAsync('review-create');assert.match(ui.html,/Review ready/);assert.match(ui.html,/View all changes/);
 await ui.clickAsync('review-all');assert.match(ui.html,/Knowledge 1 of 1/);assert.match(ui.html,/Current · Keep current/);
 await ui.clickAsync('review-suggested');assert.match(ui.html,/Review ready/);assert.match(ui.html,/Apply 1 change/);
 await ui.clickAsync('review-preview');assert.match(ui.html,/Estimated context impact/);
 await ui.clickAsync('review-reload');assert.equal(await knowledgeBytes(root),before);assert.ok(calls.every(c=>c.name!==PRODERO_TOOLS.curationApply));
 await ui.clickAsync('review-apply');assert.match(ui.html,/Knowledge updated/);assert.notEqual(await knowledgeBytes(root),before);
 const apply=calls.filter(c=>c.name===PRODERO_TOOLS.curationApply);assert.equal(apply.length,1);assert.ok(!('approved' in apply[0].arguments));
 const replay=await (await mcp(t,root)).callTool(apply[0]);assert.equal(replay.structuredContent.result.replayed,true);
});
test('production review cards allow backtracking and changes; bulk staging preserves Current and Later',async t=>{
 const {root,ui,calls}=await appFixture(t,[item('a'),item('b','Decision:\nOrbitUI tests must preserve isolation.'),item('c','Decision:\nCedarAPI tests must preserve dry runs.')]);
 const before=await knowledgeBytes(root);await ui.clickAsync('review-create');await ui.clickAsync('review-all');
 await ui.clickAsync('review-current');assert.match(ui.html,/Knowledge 2 of 3/);
 await ui.clickAsync('review-previous');assert.match(ui.html,/Knowledge 1 of 3/);
 await ui.clickAsync('review-suggested');await ui.clickAsync('review-deferred');await ui.clickAsync('review-current');
 const latest=calls.filter(c=>c.arguments.action==='decide').at(-1),r=await loadCurationReview(root,latest.arguments.reviewId);
 assert.deepEqual(Object.values(r.state.decisions).sort(),['current','deferred','suggested']);
 // Reopen resets the presentation while retaining server decisions.
 const client=await mcp(t,root);
 const other=await lifecycleUi({callServerTool:call=>client.callTool(call)});
 other.render((await client.callTool({name:PRODERO_TOOLS.curation,arguments:{projectRoot:root,action:'plan'}})).structuredContent);
 await other.clickAsync('review-all');await other.clickAsync('review-summary');const saved=await loadCurationReview(root,r.snapshot.reviewId);
 assert.deepEqual(saved.state.decisions,r.state.decisions);assert.equal(await knowledgeBytes(root),before);
});
test('production App groups merges, disables unresolved Suggested and surfaces stale review',async t=>{
 const {root,ui,calls}=await appFixture(t,[item('a'),item('b')]);
 await ui.clickAsync('review-create');await ui.clickAsync('review-all');assert.match(ui.html,/2 linked knowledge items reviewed together/);
 await ui.clickAsync('review-suggested');await writeKnowledge(root,item('new','Decision:\nOrbitUI tests must preserve isolation.'));
 const before=await knowledgeBytes(root);await ui.clickAsync('review-apply');assert.match(ui.html,/Knowledge changed since this review/);assert.match(ui.html,/Review updated changes/);assert.equal(await knowledgeBytes(root),before);
 await ui.clickAsync('review-create');assert.ok(!/Knowledge changed since this review/.test(ui.html));
 const unresolved=await appFixture(t,[item('bad','Decision:\nSynthetic runner currently fails by design.')]);
 await unresolved.ui.clickAsync('review-create');await unresolved.ui.clickAsync('review-all');assert.doesNotMatch(unresolved.ui.html,/data-review="suggested"/);
 const count=unresolved.calls.length;await unresolved.ui.key('ArrowRight');assert.equal(unresolved.calls.length,count);
 await unresolved.ui.clickAsync('review-deferred');assert.doesNotMatch(unresolved.ui.html,/data-review="apply"/);
});
test('keyboard navigation stages semantic choices but has no apply shortcut',async t=>{
 const {root,ui,calls}=await appFixture(t,[item('a'),item('b','Decision:\nOrbitUI tests must preserve isolation.')]);const before=await knowledgeBytes(root);
 await ui.clickAsync('review-create');await ui.clickAsync('review-all');
 await ui.key('ArrowLeft');assert.match(ui.html,/Knowledge 2 of 2/);
 await ui.key('Backspace');assert.match(ui.html,/Knowledge 1 of 2/);
 await ui.key('ArrowRight');await ui.key('l');assert.match(ui.html,/Review ready/);
 await ui.key('Enter');assert.ok(calls.every(c=>c.name!==PRODERO_TOOLS.curationApply));assert.equal(await knowledgeBytes(root),before);
});

test('non-App connections cannot stage or apply even if a host ignores tool visibility',async t=>{
 const root=await fixture(t),r=await ready(root),before=await knowledgeBytes(root),client=await mcp(t,root,false);
 const plan=(await client.callTool({name:PRODERO_TOOLS.curation,arguments:{action:'plan'}})).structuredContent;assert.equal(plan.appReviewAvailable,false);
 for(const call of [{name:PRODERO_TOOLS.curationReview,arguments:{action:'create'}},{name:PRODERO_TOOLS.curationApply,arguments:request(r)}]){
  const response=await client.callTool(call);assert.equal(response.isError,true);assert.equal(response.structuredContent.code,'review_unavailable');
 }
 assert.equal(await knowledgeBytes(root),before);
});
test('structured review errors retain their code without reflecting unsafe diagnostic payloads',async t=>{
 const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js');
 const {installDiagnosticBoundary}=await import('../dist/diagnostic-boundary.js');
 const server=new McpServer({name:'diagnostic-review-test',version:'1'});installDiagnosticBoundary(server);
 server.registerTool('fixture',{inputSchema:{}},async()=>({isError:true,content:[{type:'text',text:'PRIVATE_REJECTED_INPUT'}],structuredContent:{action:'curation-review-error',code:'stale_review',error:'PRIVATE_REJECTED_INPUT',outputs:['PRIVATE_REJECTED_INPUT']}}));
 const client=new Client({name:'fixture',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const response=await client.callTool({name:'fixture',arguments:{}});assert.equal(response.isError,true);assert.equal(response.structuredContent.code,'stale_review');assert.ok(!JSON.stringify(response).includes('PRIVATE_REJECTED_INPUT'));
});

test('production App partial result and Pause control target successor and preserve deferred attention',async t=>{
 const {root,ui,calls}=await appFixture(t,[item('a'),item('conflict','Decision:\nOrbitUI must rotate puzzle tiles by a quarter turn.'),item('policy','Never rotate puzzle tiles; preserve the initial orientation.')]);
 await ui.clickAsync('review-create');await ui.clickAsync('review-all');await ui.clickAsync('review-filter:clarification');await ui.clickAsync('review-deferred');await ui.clickAsync('review-summary');assert.match(ui.html,/0 need your input/);assert.match(ui.html,/1 deferred questions/);assert.match(ui.html,/Apply 1 change/);
 await ui.clickAsync('review-apply');assert.match(ui.html,/Continue review/);assert.match(ui.html,/0 need your input/);await ui.clickAsync('review-pause');assert.match(ui.html,/Review paused/);
 const apply=calls.find(c=>c.name===PRODERO_TOOLS.curationApply),pause=calls.find(c=>c.arguments.action==='pause');assert.notEqual(pause.arguments.reviewId,apply.arguments.reviewId);const successor=await loadCurationReview(root,pause.arguments.reviewId);assert.equal(successor.snapshot.revision.parentRevisionId,apply.arguments.reviewRevisionId);assert.equal(successor.state.paused,true);
});

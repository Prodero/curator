import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createMemoryBundleFixture, fixtureItem, archiveFixture } from './helpers/memory-bundle-fixtures.mjs';
import { writeKnowledge } from '../dist/core/memory.js';
import { loadKnowledgeGraph } from '../dist/core/knowledge-graph.js';
import { readKnowledgeInventory } from '../dist/core/knowledge-provenance.js';
import { listCheckpoints } from '../dist/core/storage.js';
import { runMemorySync as run } from '../dist/core/memory-sync.js';
import { createServer, PRODERO_TOOLS as T } from '../dist/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { knowledgeUi } from './helpers/knowledge-ui.mjs';
import { buildViewModel, renderText } from '../dist/presentation.js';
const act=(f,w,action,extra={})=>run(f.root,{action,workflowId:w.id,revision:w.revision,...extra});
async function fixture(t,layer='local') {
 const f=await createMemoryBundleFixture();t.after(f.cleanup);
 await archiveFixture(f.root,'mem_archived');
 await writeKnowledge(f.root,fixtureItem('mem_links',{supersedes:['mem_missing_history'],related:['mem_missing_related',f.ids[0]],relations:[{type:'depends_on',target:'mem_missing_dependency'},{type:'related_to',target:'mem_missing_related'},{type:'implements',target:'mem_archived'}]}),false,layer);
 return f;
}
async function mcp(t,f) {
 const server=createServer({projectRoot:f.root}),client=new Client({name:'repair-test',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();});
 return (name,args={})=>client.callTool({name,arguments:{projectRoot:f.root,...args}});
}
for(const layer of ['local','versioned'])test(`${layer} links require exact review; preserve text, valid and archive links plus checkpoint history`,async t=>{
 const f=await fixture(t,layer),before=await readKnowledgeInventory(f.root);
 let w=await run(f.root,{action:'start'});assert.equal(w.brokenLinks,3);
 w=await act(f,w,'select',{improve:false,share:false});assert.equal(w.state,'awaiting_review');assert.equal(w.review.kind,'link-repair');assert.equal(w.review.preview.requiresVersionedReview,layer==='versioned');assert.equal(w.review.preview.count,3);
 assert.deepEqual(await readKnowledgeInventory(f.root),before);
 await assert.rejects(act(f,w,'approve',{approved:true,reviewId:'wrong'}),/exact review/);
 w=await act(f,w,'approve',{approved:true,reviewId:w.review.reviewId});assert.equal(w.state,'completed');assert.equal(w.summary.brokenLinksFixed,3);
 assert.equal((await loadKnowledgeGraph(f.root)).diagnostics.brokenReferences,0);
 const after=await readKnowledgeInventory(f.root),a=after.find(r=>r.item.id==='mem_links').item,b=before.find(r=>r.item.id==='mem_links').item;
 assert.equal(a.content,b.content);assert.equal(a.status,b.status);assert.deepEqual(a.supersedes,[]);assert.deepEqual(a.related,[f.ids[0]]);assert.deepEqual(a.relations,[{type:'implements',target:'mem_archived'}]);
 for(const r of before.filter(r=>r.item.id!=='mem_links'))assert.deepEqual(after.find(x=>x.item.id===r.item.id),r);
 assert.deepEqual((await listCheckpoints(f.root)).at(-1).knowledgeBefore,[b]);
 assert.equal((await run(f.root,{action:'start'})).brokenLinks,0);
});
test('deselection and skipped review preserve every link; enabled repair runs before other choices',async t=>{
 const f=await fixture(t),before=await readKnowledgeInventory(f.root);
 let w=await run(f.root,{action:'start'});
 await assert.rejects(act(f,w,'select',{improve:false,share:false,repairLinks:false}),/Select/);
 w=await act(f,w,'select',{improve:false,share:true,repairLinks:false});assert.equal(w.state,'awaiting_promotion_selection');assert.equal(w.review,undefined);
 w=await run(f.root,{action:'start',restart:true});w=await act(f,w,'select',{improve:true,share:true});assert.equal(w.review.kind,'link-repair');
 w=await act(f,w,'skip');assert.equal(w.state,'semantic_work');assert.equal(w.summary.brokenLinksFixed,0);assert.equal(w.summary.brokenLinksRemaining,3);
 assert.deepEqual(await readKnowledgeInventory(f.root),before);
});
test('restoring a target after preview invalidates approval rather than removing the now-valid link',async t=>{
 const f=await fixture(t);let w=await run(f.root,{action:'start'});w=await act(f,w,'select',{improve:false,share:false});
 await writeKnowledge(f.root,fixtureItem('mem_missing_dependency'),false,'local');
 await assert.rejects(act(f,w,'approve',{approved:true,reviewId:w.review.reviewId}),/changed/);
 assert.equal((await loadKnowledgeGraph(f.root)).diagnostics.brokenReferences,2);assert.equal((await listCheckpoints(f.root)).length,0);
});
test('link repair recovers after commit without duplicate writes or checkpoints',async t=>{
 const f=await fixture(t);let w=await run(f.root,{action:'start'});w=await act(f,w,'select',{improve:false,share:false});
 const rename=fs.rename;let interrupted=false;
 fs.rename=async(from,to)=>{if(String(to).endsWith('/local/memory-sync.json')&&(await fs.readFile(from,'utf8')).includes('"state":"completed"')){interrupted=true;throw Error('Injected completion interruption');}return rename(from,to);};
 try {await assert.rejects(act(f,w,'approve',{approved:true,reviewId:w.review.reviewId}),/Injected/);}finally{fs.rename=rename;}
 assert.ok(interrupted);const inventory=await readKnowledgeInventory(f.root);
 w=await run(f.root,{action:'inspect',workflowId:w.id});assert.equal(w.state,'completed');assert.equal(w.summary.brokenLinksFixed,3);assert.equal((await listCheckpoints(f.root)).length,1);assert.deepEqual(await readKnowledgeInventory(f.root),inventory);
});
test('Open hides broken-link diagnostics; Sync App and text show a checked, functional repair choice',async t=>{
 const f=await fixture(t),call=await mcp(t,f),opened=await call(T.open);
 assert.equal(opened.isError,undefined);assert.equal(opened.structuredContent.project.knowledgeGraph.brokenReferences,undefined);assert.doesNotMatch(JSON.stringify(opened),/brokenReferences/);
 const calls=[],ui=await knowledgeUi(req=>{calls.push(req);return call(req.name,req.arguments);});
 const start=await call(T.sync);ui.render(start);assert.equal(ui.host.querySelector('#sync-repair-links-choice').checked,true);assert.match(ui.html,/Fix 3 broken links/);
 assert.match(renderText(buildViewModel(start.structuredContent)),/Fix 3 broken links/);
 ui.check('#sync-improve-choice',false);ui.check('#sync-promotion-choice',false);assert.equal(ui.host.querySelector('[data-memory-sync="select"]').disabled,false);
 ui.check('#sync-repair-links-choice',false);assert.equal(ui.host.querySelector('[data-memory-sync="select"]').disabled,true);ui.check('#sync-repair-links-choice',true);
 await ui.sync('select');assert.equal(calls[0].arguments.request.repairLinks,true);assert.match(ui.html,/Broken links to remove/);assert.match(ui.html,/mem_missing_dependency/);
 await ui.sync('approve');assert.match(ui.html,/3 broken links fixed/);
 await ui.sync('restart');assert.equal(ui.host.querySelector('#sync-repair-links-choice'),null);
});
test('interrupted knowledge transaction recovers the approved link repair exactly once',async t=>{
 const f=await fixture(t);let w=await run(f.root,{action:'start'});w=await act(f,w,'select',{improve:false,share:false});
 const rename=fs.rename;let interrupted=false;
 fs.rename=async(from,to)=>{if(!interrupted&&String(to).endsWith('/local/memory/mem_links.md')){interrupted=true;throw Error('Injected knowledge interruption');}return rename(from,to);};
 try {await assert.rejects(act(f,w,'approve',{approved:true,reviewId:w.review.reviewId}),/Injected/);}finally{fs.rename=rename;}
 assert.ok(interrupted);
 w=await run(f.root,{action:'inspect',workflowId:w.id});assert.equal(w.state,'completed');assert.equal(w.summary.brokenLinksFixed,3);assert.equal((await listCheckpoints(f.root)).length,1);assert.equal((await loadKnowledgeGraph(f.root)).diagnostics.brokenReferences,0);
});
test('repair preserves Required instruction authority and applicability',async t=>{
 const f=await fixture(t);
 await writeKnowledge(f.root,fixtureItem('mem_required',{version:3,scope:'global',scopeRef:null,scopeKind:undefined,applicability:{kind:'project'},contextPolicy:'required',authority:'explicit_user',category:'instruction',priority:'critical',supersedes:['mem_missing_required']}),false,'versioned');
 const before=(await readKnowledgeInventory(f.root)).find(r=>r.item.id==='mem_required').item;
 let w=await run(f.root,{action:'start'});w=await act(f,w,'select',{improve:false,share:false});w=await act(f,w,'approve',{approved:true,reviewId:w.review.reviewId});assert.equal(w.state,'completed');
 const after=(await readKnowledgeInventory(f.root)).find(r=>r.item.id==='mem_required').item;
 for(const key of ['content','contextPolicy','authority','priority','applicability','status'])assert.deepEqual(after[key],before[key]);
 assert.deepEqual(after.supersedes,[]);
});

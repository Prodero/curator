import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {initializeProject} from '../dist/core/project.js';
import {writeKnowledge,listKnowledge} from '../dist/core/memory.js';
import {createCurationReview,loadCurationReview} from '../dist/core/curation-review.js';
import {sealRevision,validateRevision} from '../dist/core/curation-revision.js';
import {sha256} from '../dist/core/storage.js';
import {knowledgeUi} from './helpers/knowledge-ui.mjs';
const apps={extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}};
const item=(id,local=false)=>({version:3,id,category:local?'state':'instruction',contextPolicy:local?'relevant':'required',authority:local?'inferred':'legacy_inherited',applicability:{kind:'legacy'},scope:'global',scopeRef:null,priority:'normal',status:'active',title:local?'Harbor Local '+id:'Export testing',content:local?'Harbor '+id+' preserves its exact source evidence.':'Decision:\nCedarAPI tests must isolate exports.\n\nImpact:\nNever call real exports.',createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[]});
async function fixture(t,capabilities=apps){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-explicit-management-'));await initializeProject(root);await writeKnowledge(root,item('mem_rule'));
 const server=createServer({projectRoot:root}),client=new Client({name:'management-fixture',version:'1'},{capabilities}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
 const calls=[];const raw=async(name,args={})=>{calls.push({name,args});return client.callTool({name,arguments:args});};const call=async(name,args={})=>{const r=await raw(name,args);assert.notEqual(r.isError,true,JSON.stringify(r));return r;};
 return {root,client,calls,raw,call,text:(tool,args={})=>call('prodero_text',{tool,arguments:args})};
}
async function unsupportedReview(root){
 const old=await createCurationReview(root),file=path.join(root,'.prodero/local/curation-reviews',old.snapshot.reviewId+'.json'),snapshot=JSON.parse(await fs.readFile(file,'utf8'));
 snapshot.revision.version=99;const {snapshotHash,...body}=snapshot;snapshot.snapshotHash=sha256(JSON.stringify(body));await fs.writeFile(file,JSON.stringify(snapshot));
 return {reviewId:old.snapshot.reviewId,file,bytes:await fs.readFile(file,'utf8')};
}
const canonical=async root=>JSON.stringify(await listKnowledge(root));
async function button(ui,selector){const e=ui.host.querySelector(selector);assert.ok(e,'Missing '+selector);e.listeners.click({currentTarget:e});await ui.settle();}

test('Open does not load an unsupported saved revision, while exact historical access still fails closed',async t=>{
 const f=await fixture(t),old=await unsupportedReview(f.root),before=await canonical(f.root),opened=await f.call('prodero_open');
 assert.equal(opened.structuredContent.action,'open');assert.equal(opened.structuredContent.curation,undefined);
 const ui=await knowledgeUi(r=>f.raw(r.name,r.arguments));ui.render(opened);assert.match(ui.html,/Curate Memory/);assert.match(ui.html,/Local → Versioned/);assert.doesNotMatch(ui.html,/Review revision is invalid|deferred questions|unapplied change groups/);
 await assert.rejects(loadCurationReview(f.root,old.reviewId),e=>e.code==='invalid_review'&&e.message==='Review revision is invalid or unsupported.');
 const exact=await f.raw('prodero_curation_review',{action:'inspect',reviewId:old.reviewId});assert.equal(exact.isError,true);assert.equal(exact.structuredContent.code,'invalid_review');
 const preview=await f.text('prodero_curation',{fresh:true});assert.equal(preview.structuredContent.userInitiatedManagement,true);assert.match(preview.content[0].text,/Curate Memory/);assert.match(preview.content[0].text,/Current knowledge/);assert.match(preview.content[0].text,/Proposed knowledge/);assert.equal(preview.structuredContent.historyDiagnostics.length,1);
 assert.equal(await fs.readFile(old.file,'utf8'),old.bytes);assert.equal(await canonical(f.root),before);
 const overview=await f.text('prodero_open');assert.match(overview.content[0].text,/Review legacy instructions/);assert.match(overview.content[0].text,/Share selected memory via Git/);assert.doesNotMatch(overview.content[0].text,/1 >|Review revision is invalid/);
});

test('explicit fresh graphical curation stages no default choices, previews before Apply, preserves incompatible history',async t=>{
 const f=await fixture(t),old=await unsupportedReview(f.root),before=await canonical(f.root),ui=await knowledgeUi(r=>f.raw(r.name,r.arguments));ui.render(await f.call('prodero_open'));
 assert.equal(f.calls.some(c=>c.name==='prodero_curation_review'),false);
 await button(ui,'button[data-action="curate"]');assert.match(ui.html,/Current knowledge/);assert.match(ui.html,/older reviews are unavailable/);assert.doesNotMatch(ui.html,/data-curate-action="apply"/);assert.equal(await canonical(f.root),before);
 await button(ui,'button[data-curate-action="create"]');assert.ok(ui.host.querySelector('input[data-curate-unit]'));assert.equal(ui.host.querySelector('input[data-curate-unit]').checked,false);
 ui.check('input[data-curate-unit]',true);await ui.settle();assert.match(ui.html,/data-curate-action="preview"/);assert.doesNotMatch(ui.html,/data-curate-action="apply"/);assert.equal(await canonical(f.root),before);
 await button(ui,'button[data-curate-action="preview"]');assert.match(ui.html,/data-curate-action="apply"/);assert.equal(await canonical(f.root),before);
 await button(ui,'button[data-curate-action="apply"]');assert.match(ui.html,/Applied 1 reviewed change/);assert.notEqual(await canonical(f.root),before);assert.equal(await fs.readFile(old.file,'utf8'),old.bytes);
 await assert.rejects(loadCurationReview(f.root,old.reviewId),e=>{t.diagnostic('direct rejection: '+e.message);return e.code==='invalid_review';});
});

test('declining curation leaves knowledge intact and text cannot gain protected App approval',async t=>{
 const f=await fixture(t,{}),before=await canonical(f.root);
 const preview=await f.text('prodero_curation',{fresh:true});assert.match(preview.content[0].text,/text supports the full preview and simulation/);
 const denied=await f.raw('prodero_curation_review',{action:'create',fresh:true});assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/review_unavailable/);assert.equal(await canonical(f.root),before);
});

test('explicit Local-to-Versioned selection previews only selected IDs and cancel performs no shared write',async t=>{
 const f=await fixture(t);for(const id of ['mem_local_a','mem_local_b'])await writeKnowledge(f.root,item(id,true),false,'local');
 const before=await canonical(f.root),ui=await knowledgeUi(r=>f.raw(r.name,r.arguments));ui.render(await f.call('prodero_open'));
 await button(ui,'button[data-action="share"]');assert.match(ui.html,/Select exact Local records/);assert.equal(f.calls.some(c=>c.name==='prodero_promotion_preview'),false);
 ui.check('input[data-share-id="mem_local_a"]',true);await ui.click('promote-selected');
 const request=f.calls.find(c=>c.name==='prodero_promotion_preview');assert.deepEqual(Array.from(request.args.ids),['mem_local_a']);assert.equal(request.args.includeAll,undefined);assert.match(ui.html,/Apply to Versioned files/);assert.equal(await canonical(f.root),before);
 await ui.promotion('cancel');assert.equal(await canonical(f.root),before);assert.equal(f.calls.some(c=>c.name==='prodero_promote'),false);
});

test('unknown or tampered fresh history policy cannot bypass the revision validator',async t=>{
 const f=await fixture(t),r=await createCurationReview(f.root,undefined,undefined,{fresh:true}),file=path.join(f.root,'.prodero/local/curation-reviews',r.snapshot.reviewId+'.json'),snapshot=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(r.snapshot.revision.historyPolicy,'fresh-current');assert.deepEqual(r.state.decisions,{});
 const {id:sealedId,...sealedBody}=r.snapshot.revision;assert.throws(()=>validateRevision(sealRevision({...sealedBody,historyPolicy:'accept-everything'})),/Unsupported curation history policy/);
 snapshot.revision.historyPolicy='accept-everything';const {snapshotHash,...body}=snapshot;snapshot.snapshotHash=sha256(JSON.stringify(body));await fs.writeFile(file,JSON.stringify(snapshot));
 await assert.rejects(loadCurationReview(f.root,r.snapshot.reviewId),e=>e.code==='invalid_review');
 const ui=await knowledgeUi(()=>{throw Error('No automatic retry');});ui.render({isError:true,structuredContent:{ok:false,message:'PRODERO_ROOT_UNAUTHORIZED: workspace access denied.'}});assert.match(ui.html,/role="alert"/);assert.match(ui.html,/workspace access denied/);
});


test('explicit Local-to-Versioned Apply publishes the selected preview only and text offers the same preview',async t=>{
 const f=await fixture(t);for(const id of ['mem_local_a','mem_local_b'])await writeKnowledge(f.root,item(id,true),false,'local');
 const detail=await f.text('prodero_knowledge',{id:'mem_local_a'});
 const action=detail.structuredContent.presentation.actions.find(a=>a.tool==='prodero_promotion_preview');
 assert.ok(action);assert.deepEqual(action.arguments.ids,['mem_local_a']);assert.match(detail.content[0].text,/Preview move to Versioned/);
 const ui=await knowledgeUi(r=>f.raw(r.name,r.arguments));ui.render(await f.call('prodero_open'));
 await button(ui,'button[data-action="share"]');ui.check('input[data-share-id="mem_local_a"]',true);await ui.click('promote-selected');
 assert.equal(f.calls.some(c=>c.name==='prodero_promote'),false);await ui.promotion('publish');
 const applied=f.calls.find(c=>c.name==='prodero_promote');assert.ok(applied);assert.equal(applied.args.approved,true);
 const versioned=await listKnowledge(f.root,'versioned');assert.ok(versioned.some(i=>i.content.includes('mem_local_a')));assert.equal(versioned.some(i=>i.content.includes('mem_local_b')),false);
});

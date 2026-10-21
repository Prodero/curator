import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {buildViewModel,renderText,renderMetricsHtml} from '../dist/presentation.js';
import {resolvePresentation} from '../dist/presentation-server.js';
const ui={extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}};
async function fixture(t,capabilities={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-presentation-'));
 const server=createServer({projectRoot:root});const client=new Client({name:'presentation-test',version:'1'}, {capabilities});
 const [c,s]=InMemoryTransport.createLinkedPair();await server.connect(s);await client.connect(c);
 t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
 const call=(name,args={})=>client.callTool({name,arguments:args});
 await call('prodero_initialize');return {root,client,call};
}
test('auto uses only protocol MIME support; explicit UI overrides missing support',()=>{
 assert.equal(resolvePresentation('auto',ui),'ui');assert.equal(resolvePresentation('auto',{}),'text');
 assert.equal(resolvePresentation('auto',undefined),'text');
 assert.equal(resolvePresentation('auto',{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html']}}}),'text');
 assert.equal(resolvePresentation('text',ui),'text');assert.equal(resolvePresentation('ui',{}),'ui');
});
test('auto/UI and text gateway share completed Core status; text gateway has no UI metadata',async t=>{
 const {call,client,root}=await fixture(t,ui);
 const catalog=await client.listTools();const gateway=catalog.tools.find(t=>t.name==='prodero_text');
 assert.equal(gateway._meta,undefined);assert.equal(gateway.annotations.readOnlyHint,false);
 assert.ok(catalog.tools.find(t=>t.name==='prodero_open')._meta.ui.resourceUri);
 const auto=await call('prodero_open');assert.equal(auto.structuredContent.presentation.resolved,'ui');assert.equal(auto.structuredContent.phase,'ready');
 const explicit=await call('prodero_open',{presentation:'ui'});assert.equal(explicit.structuredContent.presentation.resolved,'ui');
 const configBefore=await fs.readFile(path.join(root,'.prodero','config.json'),'utf8');
 const text=await call('prodero_text');assert.equal(text.isError,undefined);assert.equal(text.structuredContent.presentation.resolved,'text');assert.equal(text.structuredContent.hydrationRequired,false);
 assert.match(text.content[0].text,/prodero-presentation-/g);assert.match(text.content[0].text,/Memory/);assert.match(text.content[0].text,/Available actions/);
 const detail=await call('prodero_status_details',{presentation:'ui'});
 assert.equal(text.structuredContent.project.knowledgeGraph.brokenReferences,undefined);
 assert.equal(detail.structuredContent.project.knowledgeGraph.brokenReferences,0);
 const detailWithoutBroken=structuredClone(detail.structuredContent);delete detailWithoutBroken.project.knowledgeGraph.brokenReferences;
 assert.deepEqual(buildViewModel({...text.structuredContent,action:'status-details',bootstrap:undefined}),buildViewModel(detailWithoutBroken));
 assert.equal(await fs.readFile(path.join(root,'.prodero','config.json'),'utf8'),configBefore);
 const next=await call('prodero_open');assert.equal(next.structuredContent.presentation.requested,'auto');assert.equal(next.structuredContent.presentation.resolved,'ui');
});
test('auto without Apps gives complete text; explicit text is portable, explicit UI remains a preference',async t=>{
 const {call}=await fixture(t);
 const auto=await call('prodero_open');assert.equal(auto.structuredContent.presentation.resolved,'text');assert.equal(auto.structuredContent.phase,'ready');
 const explicit=await call('prodero_open',{presentation:'text'});assert.deepEqual(buildViewModel(auto.structuredContent),buildViewModel(explicit.structuredContent));
 assert.equal((await call('prodero_open',{presentation:'ui'})).structuredContent.presentation.resolved,'ui');
 assert.equal((await call('prodero_open',{presentation:'invalid'})).isError,true);
});
test('text lifecycle and review reuse validation, snapshots, revisions and workflow approval safeguards',async t=>{
 const {call}=await fixture(t,ui);
 const text=(tool,args={})=>call('prodero_text',{tool,arguments:args});
 const prepared=await text('prodero_prepare',{task:'Check presentation',agent:'test'});
 assert.equal(prepared.isError,undefined);assert.match(prepared.content[0].text,/Context Ready/);
 const r=prepared.structuredContent.result;assert.match(prepared.content[0].text,/est. Prodero tokens/);
 assert.deepEqual(JSON.parse(prepared.content[1].text).proderoOperation.context,r.context);
 assert.deepEqual(prepared.content[1].annotations.audience,["assistant"]);
 assert.ok(r.context.snapshot.reviewId);assert.ok(!prepared.structuredContent.presentation.actions.some(a=>a.tool==='prodero_instruction_review'));
 assert.equal(prepared.structuredContent.presentation.operational.context.snapshot.reviewId,r.context.snapshot.reviewId);
 const review=await text('prodero_instruction_review',{reviewId:r.context.snapshot.reviewId});assert.equal(review.isError,undefined);assert.match(review.content[0].text,/Required Instruction Review/);
 const optimized=await text('prodero_instruction_optimize',{reviewId:r.context.snapshot.reviewId});assert.equal(optimized.isError,undefined);assert.match(optimized.content[0].text,/Instruction Consolidation/);
 const rejected=await text('prodero_instruction_optimize',{reviewId:r.context.snapshot.reviewId,action:'apply',previewId:optimized.structuredContent.result.previewId});assert.equal(rejected.isError,true);
 const closed=await text('prodero_session_close',{sessionId:r.session.id,finalEntries:[{type:'discovery',content:'Presentation is invocation scoped and never identifies the viewer.'}]});
 assert.match(closed.content[0].text,/Session closed/);assert.match(closed.content[0].text,/Saved/);
 const session=await text('prodero_session_review',{sessionId:r.session.id});assert.equal(session.isError,undefined);assert.match(session.content[0].text,/Presentation is invocation scoped/);assert.match(session.content[0].text,/Revision:/);
 const stale=await text('prodero_session_review_mutate',{sessionId:r.session.id,revision:'0'.repeat(64),action:'discard-all'});assert.equal(stale.isError,true);
 const knowledge=await text('prodero_knowledge');assert.equal(knowledge.isError,undefined);assert.match(knowledge.content[0].text,/KNOWLEDGE/);
 const promotion=await text('prodero_promotion_preview');assert.equal(promotion.isError,undefined);assert.match(promotion.content[0].text,/This preview changes no knowledge/);
 assert.equal((await text('prodero_promote',{preview:promotion.structuredContent.preview})).isError,true);
 assert.equal((await text('prodero_session_close',{})).isError,true);
});
test('one ViewModel drives text and HTML metrics, preserves selected bodies, omissions and escaped HTML',()=>{
 const context={required:[{title:'Invariant <A>',content:'Preserve every mandatory clause.',id:'mem_a'}],relevant:[],skills:[],metrics:{contextTokens:2920,contextBudgetTokens:6000,projectKnowledgeTokens:12000,requiredGlobalExcludedItems:17},selection:{omittedRequired:[]},snapshot:{reviewId:'review-1'}};
 const payload={action:'prepare',result:{context,automaticSync:{sessionsProcessed:1}}};
 const vm=buildViewModel(payload);const before=structuredClone(vm);const text=renderText(vm),html=renderMetricsHtml(vm);
 assert.deepEqual(vm,before);assert.match(text,/17 required instructions/);assert.match(text,/2,920 \/ 6,000/);assert.doesNotMatch(text,/Preserve every mandatory clause/);
 assert.equal(vm.conversation.blocking,true);assert.equal(vm.conversation.contextComplete,false);
 const detail=renderText(vm,true);assert.match(detail,/Preserve every mandatory clause/);
 for(const m of vm.metrics){assert.ok(html.includes(m.label));assert.ok(html.includes(String(m.value)));}
 assert.match(renderMetricsHtml({...vm,metrics:[{label:'<script>',value:'<img>'}]}),/&lt;script&gt;/);
});

test('all generated launchers select project settings before an App-attached operation', async () => {
 const {PRESENTATION_LAUNCHER}=await import('../dist/presentation.js');
 const {PRODERO_MCP_INSTRUCTIONS}=await import('../dist/server.js');
 const {AGENT_INSTRUCTIONS}=await import('../dist/core/agent-instructions.js');
 const {LAUNCHER}=await import('../dist/hosts/adapters.js');
 for(const instructions of [PRODERO_MCP_INSTRUCTIONS,AGENT_INSTRUCTIONS,LAUNCHER]) {
  assert.ok(instructions.includes(PRESENTATION_LAUNCHER));
  assert.doesNotMatch(instructions,/immediately (?:call|invoke the connected) `?prodero_open/);
 }
});

test('text project launcher and lifecycle route never attach an App', async t => {
 const {call,client}=await fixture(t,ui);
 await call('prodero_config_set',{key:'presentation.mode',value:'text'});
 const settings=await call('prodero_config_get');
 assert.equal(settings.structuredContent.projectSettings.presentation.mode,'text');
 const catalog=await client.listTools();
 for(const name of ['prodero_config_get','prodero_text']) assert.equal(catalog.tools.find(t=>t.name===name)._meta,undefined);
 const opened=await call('prodero_text',{tool:'prodero_open'});
 assert.match(opened.content[0].text,/prodero-presentation-/g);
 assert.equal(opened._meta?.ui,undefined);
 const prepared=await call('prodero_text',{tool:'prodero_prepare',arguments:{task:'Text project lifecycle'}});
 assert.match(prepared.content[0].text,/Context Ready/);
 const closed=await call('prodero_text',{tool:'prodero_session_close',arguments:{sessionId:prepared.structuredContent.result.session.id}});
 assert.match(closed.content[0].text,/Session closed/);
});


test('UI preference without Apps carries truthful chat guidance and text keeps command bullets', async t => {
 const {call,client}=await fixture(t);
 await call('prodero_config_set',{key:'presentation.mode',value:'ui'});
 await call('prodero_config_set',{key:'presentation.theme',value:'dark-neon'});
 const {PRESENTATION_REPLY}=await import('../dist/presentation.js');
 const {PRODERO_MCP_INSTRUCTIONS}=await import('../dist/server.js');
 const {AGENT_INSTRUCTIONS}=await import('../dist/core/agent-instructions.js');
 const opened=await call('prodero_open');
 assert.equal(opened.structuredContent.presentation.resolved,'ui');
 assert.ok(opened.content.some(c=>c.text===PRESENTATION_REPLY && c.annotations?.audience?.includes('assistant')));
 assert.ok(AGENT_INSTRUCTIONS.includes(PRESENTATION_REPLY));
 assert.match(PRODERO_MCP_INSTRUCTIONS,/prodero_instructions_read/);
 assert.ok(!PRODERO_MCP_INSTRUCTIONS.includes(PRESENTATION_REPLY),'initialization points to the runtime guide instead of repeating all reply rules');
 const text=await call('prodero_text');
 assert.match(text.content[0].text,/1 > Curate Memory[\s\S]*2 > Explore knowledge[\s\S]*3 > Show settings/);
 assert.doesNotMatch(text.content[0].text,/dark.neon|theme|UI mode/i);
 assert.ok(JSON.parse(text.content[1].text).proderoOperation.instructions.includes(PRESENTATION_REPLY));
 const catalog=await client.listTools();
 assert.ok(catalog.tools.find(t=>t.name==='prodero_text').description.includes(PRESENTATION_REPLY));
});

// Invented toy-project fixtures; no real project incidents or operational records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {PRODERO_TOOLS as T} from '../dist/contracts.js';
import {rememberProjectKnowledge} from '../dist/core/project.js';
import {knowledgeUi} from './helpers/knowledge-ui.mjs';
import {knowledgeView} from '../dist/core/knowledge-management.js';
import {writeKnowledge} from '../dist/core/memory.js';
async function setup(t){const root=await fs.mkdtemp('/tmp/prodero-knowledge-ui-handlers-');await fs.mkdir(root+'/.git');const server=createServer({projectRoot:root}),client=new Client({name:'knowledge-ui',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});const call=(name,args={})=>client.callTool({name,arguments:{projectRoot:root,...args}});await call(T.initialize);let fail=false;const calls=[];const ui=await knowledgeUi(async req=>{calls.push(req);if(fail){fail=false;throw Error('Proxy unavailable');}return client.callTool(req);});return{root,call,ui,calls,fail:()=>{fail=true;}};}

test('Production Knowledge UI search, detail, edit confirmation, secret rejection and local deletion use real MCP/Core',async t=>{
 const {root,call,ui,calls}=await setup(t);const {item}=await rememberProjectKnowledge(root,{title:'Cedar note',content:'Cedar uses a bounded queue.',kind:'fact'});
 ui.render(await call(T.knowledge));assert.match(ui.html,/<table class="knowledge-table">/);assert.match(ui.html,/<th scope="col">#<\/th><th scope="col">Knowledge<\/th><th scope="col">Type<\/th><th scope="col">Priority<\/th><th scope="col">Layer<\/th>/);assert.doesNotMatch(ui.html,/Cedar uses a bounded queue/);assert.match(ui.html,/Shared \/ Versioned Knowledge:/);assert.match(ui.html,/Cedar note/);
 await ui.submit('knowledge-search-form',{query:'no-such-topic'});assert.match(ui.html,/No knowledge matches/);
 await ui.submit('knowledge-search-form',{query:'Cedar',layer:'local',category:'state'});assert.match(ui.html,/Cedar note/);assert.equal(calls.at(-1).arguments.layer,'local');
 await ui.click('view',item.id);assert.match(ui.html,/Sources and relationships/);await ui.click('edit');await ui.submit('knowledge-edit-form',{title:'Cedar note',content:'Cedar uses an amber queue.'});assert.match(ui.html,/Review changes/);
 assert.equal((await knowledgeView(root,{},item.id)).detail.content,item.content,'review does not write');await ui.click('confirm');assert.match(ui.html,/Saved/);assert.equal((await knowledgeView(root,{},item.id)).detail.content,'Cedar uses an amber queue.');
 await ui.click('edit');await ui.submit('knowledge-edit-form',{content:'api_key=synthetic_ui_test_secret_123456'});await ui.click('confirm');assert.match(ui.html,/credential/i);assert.equal((await knowledgeView(root,{},item.id)).detail.content,'Cedar uses an amber queue.');
 await ui.click('cancel-confirm');await ui.click('cancel-edit');await ui.click('retire');assert.match(ui.html,/not secure erase/);assert.equal((await knowledgeView(root,{},item.id)).detail.status,'active');await ui.click('confirm');assert.equal((await knowledgeView(root,{},item.id)).detail.status,'deprecated');
});

test('Production UI explicit repository maintenance and promotion reuse reviewed existing workflow',async t=>{
 const {root,call,ui,calls}=await setup(t);const {item}=await rememberProjectKnowledge(root,{title:'Cedar note',content:'Cedar uses a bounded queue.',kind:'fact'});ui.render(await call(T.knowledge));await ui.click('view',item.id);await ui.click('promote',item.id);assert.match(ui.html,/Sync Memory/);assert.equal((await knowledgeView(root)).counts.versioned,0);ui.check('#sync-promotion-choice');await ui.sync('select');ui.check('[data-sync-promotion]');await ui.sync('promotions');assert.match(ui.html,/Review knowledge for team sharing/);await ui.sync('approve');assert.equal((await knowledgeView(root)).counts.versioned,1);assert.ok(calls.some(c=>c.name===T.memorySync&&c.arguments.request.action==='approve'));await ui.sync('back');ui.render(await call(T.knowledge));
 const repository=(await knowledgeView(root,{layer:'versioned'})).matches[0];await ui.click('view',repository.id);await ui.click('edit');assert.match(ui.html,/Git-tracked/);await ui.submit('knowledge-edit-form',{content:'Cedar uses a repository-managed queue.'});assert.match(ui.html,/Apply repository changes/);await ui.click('confirm');assert.equal(calls.findLast(c=>c.name===T.knowledgeMutate).arguments.mode,'repository-maintenance');await ui.click('retire');await ui.click('confirm');assert.equal((await knowledgeView(root,{},repository.id)).detail.status,'deprecated');
});

test('Production UI retains stale draft on rejection, retries proxy errors, paginates and escapes content',async t=>{
 const {root,call,ui,fail}=await setup(t);ui.render(await call(T.knowledge));assert.match(ui.html,/No knowledge yet/);
 for(let n=0;n<14;n++)await rememberProjectKnowledge(root,{title:`Unique fixture ${n}`,content:`Fixture record number ${n} has an independent topic.`,kind:'fact',scope:'path',path:`fixtures/${n}`});
 ui.render(await call(T.knowledge));assert.match(ui.html,/Showing 1–12/);fail();await ui.click('next');assert.match(ui.html,/Proxy unavailable/);await ui.click('next');assert.match(ui.html,/Showing 13–14/);await ui.click('previous');
 const target=(await knowledgeView(root)).matches[0];await ui.click('view',target.id);await ui.click('edit');await ui.submit('knowledge-edit-form',{content:'Changed in the UI.'});await call(T.knowledgeMutate,{id:target.id,revision:target.revision,action:'edit',approved:true,title:target.title,content:'Changed by another process.'});await ui.click('confirm');assert.match(ui.html,/changed since/);assert.match(ui.html,/Changed in the UI/);
 await ui.click('cancel-confirm');await ui.click('cancel-edit');await ui.click('reload',target.id);assert.match(ui.html,/Changed by another process/);
 const item=(await knowledgeView(root,{},target.id)).detail;await writeKnowledge(root,{...item,title:'<img src=x onerror=alert(1)>',content:'Safe <script> text.'},false,'local');await ui.click('reload',target.id);assert.match(ui.html,/&lt;img/);assert.doesNotMatch(ui.html,/<img src=x/);await ui.click('list');assert.match(ui.html,/&lt;img/);assert.doesNotMatch(ui.html,/<img src=x/);
});

test('structured applicability stays readable and intact through the production editor',async t=>{
 const {root,call,ui}=await setup(t);const app={kind:'scoped',paths:['src/grid','tests/grid'],subsystems:['ToyGrid'],taskKinds:['testing']};
 const {item}=await rememberProjectKnowledge(root,{kind:'rule',title:'ToyGrid fixtures',content:'Use isolated test fixtures.',applicability:app});
 ui.render(await call(T.knowledge));await ui.click('view',item.id);await ui.click('edit');
 assert.match(ui.html,/Applies to: ToyGrid/);assert.doesNotMatch(ui.html,/name="scope(?:Ref|Kind)?"/);
 await ui.submit('knowledge-edit-form',{content:'Use deterministic isolated test fixtures.'});await ui.click('confirm');
 const current=(await knowledgeView(root,{},item.id)).detail;assert.equal(current.content,'Use deterministic isolated test fixtures.');assert.deepEqual(current.applicability,app);assert.equal(current.contextPolicy,'relevant');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {listKnowledge} from '../dist/core/memory.js';
import {buildViewModel,renderText,renderTerminalText} from '../dist/presentation.js';
import {conversationOperation,PRESENTATION_REPLY} from '../dist/conversation-presentation.js';
import {textViewFixtures} from './helpers/text-view-fixtures.mjs';
const fixture=()=>structuredClone(textViewFixtures().home);
const operation=p=>conversationOperation(p,buildViewModel(p));

test('compact Open branches distinguish stored layers and actual current-Open instruction delivery',()=>{
 const p=fixture();p.project.name='Drift Control';p.project.knowledgeCount=174;p.project.localKnowledgeCount=160;p.project.versionedKnowledgeCount=14;
 p.bootstrap.instructions=[{title:'Fixture rule',content:'Preserve source.'}];p.bootstrap.metrics.loadedInstructions=999;
 const text=renderText(buildViewModel(p));
 assert.match(text,/^\*\*›_ prodero\*\* · \*\*Drift Control\*\*/);assert.match(text,/├─ Memory: 174 records/);assert.match(text,/├─ Local: 160 · Versioned: 14/);assert.match(text,/└─ Context loaded: 1 instruction\b/);
 assert.doesNotMatch(text,/999|Task context is prepared|╭|│|╰|```|token|Available actions|organize memory/);
 assert.match(text,/Choose a number or ask in your own words/);
});

test('zero, partial, invalid and unloaded values never become fabricated counts or health warnings',()=>{
 const p=fixture();p.project.knowledgeCount=0;p.project.localKnowledgeCount=0;p.project.versionedKnowledgeCount=0;
 let text=renderText(buildViewModel(p));assert.match(text,/Memory: 0 records/);assert.match(text,/Local: 0 · Versioned: 0/);assert.match(text,/Context loaded: 0 instructions/);assert.doesNotMatch(text,/warning|attention|healthy|review queue/i);
 for(const invalid of [undefined,-1,NaN,Infinity,'4']){
  p.project.knowledgeCount=invalid;p.project.localKnowledgeCount=invalid;p.project.versionedKnowledgeCount=7;
  text=renderText(buildViewModel(p));assert.match(text,/Memory: not loaded/);assert.match(text,/Local: not loaded · Versioned: 7/);assert.doesNotMatch(text,/Memory: 7/);
 }
 p.bootstrap.loaded=false;p.bootstrap.instructions=[{title:'Not delivered'}];p.bootstrap.metrics.loadedInstructions=1;
 assert.match(renderText(buildViewModel(p)),/Loaded instruction count: unavailable/);
 p.bootstrap.loaded=true;delete p.bootstrap.instructions;assert.match(renderText(buildViewModel(p)),/Loaded instruction count: unavailable/);
});

test('stable Open identities bind only displayed numbers and preserve optional update slot',()=>{
 const p=fixture(),first=operation(p);assert.deepEqual(first.numberedActions.map(a=>[a.id,a.number]),[['memory',1],['instructions',2],['sharing',3],['settings',4]]);
 assert.deepEqual(first.numberedActions,operation(p).numberedActions);assert.deepEqual(first.availableActions,first.numberedActions);
 const withUpdate=operation({...p,update:{available:true,latest:'fixture'}});assert.deepEqual(withUpdate.numberedActions.slice(0,4),first.numberedActions);assert.equal(withUpdate.numberedActions.at(-1).number,5);
 assert.equal(first.numberedActions.find(a=>a.number===2).arguments.fresh,true);assert.equal(first.numberedActions.find(a=>a.number===3).arguments.layer,'local');
 for(const a of first.numberedActions){assert.equal(a.arguments.projectRoot,p.project.root);assert.equal(a.arguments.approved,undefined);assert.equal(a.approval,undefined);}
 const vm=buildViewModel(p);vm.conversation.suggestions=vm.conversation.suggestions.filter(a=>a.tool!=='prodero_curation');vm.actions=vm.actions.filter(a=>a.tool!=='prodero_curation');
 const missing=conversationOperation(p,vm);assert.deepEqual(missing.numberedActions.map(a=>a.number),[1,3,4]);assert.match(renderText(vm),/\*\*4\.\*\* Settings/);assert.doesNotMatch(renderText(vm),/^4\. /m); // No automatic ordered-list renumbering.
 assert.deepEqual(operation(textViewFixtures().knowledge).numberedActions,[]);assert.deepEqual(conversationOperation(p,buildViewModel(p),true).numberedActions,[]);
});

test('numbers remain view/root-local and localization cannot alter routing, while terminal remains separate',()=>{
 const p=fixture(),prior=operation(p);p.project.root='/tmp/другой-проект';p.project.name='Очень длинный проект '.repeat(10).trim();const next=operation(p),text=renderText(buildViewModel(p));
 assert.notEqual(next.numberedActions[0].arguments.projectRoot,prior.numberedActions[0].arguments.projectRoot);assert.ok(text.includes(p.project.name));assert.match(text,/\*\*3\.\*\*/);
 assert.match(PRESENTATION_REPLY,/translate interface prose/);assert.match(PRESENTATION_REPLY,/latest displayed view and project/);assert.match(PRESENTATION_REPLY,/Pending answers take precedence/);assert.match(PRESENTATION_REPLY,/Selecting an action is never approval/);assert.match(PRESENTATION_REPLY,/not total chat\/task context/);
 assert.match(renderTerminalText(buildViewModel(p)),/╭─ >_ PRODERO/);assert.deepEqual(conversationOperation(p,buildViewModel(p),false,false,true).numberedActions.map(a=>a.number),[1,2,3,4]);
});

test('MCP Open number selection routes current bindings read-only, without approval or memory writes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'curator-open-number-route-')),server=createServer({projectRoot:root}),client=new Client({name:'open-number-fixture',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
 const raw=async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert.notEqual(r.isError,true,name+' '+JSON.stringify(args)+' '+JSON.stringify(r));return r;};
 const text=(tool,args={})=>raw('prodero_text',{tool,arguments:args});await raw('prodero_initialize');
 const first=await text('prodero_open'),op=first.structuredContent.presentation.operational;
 for(const n of [1,2,3,4]){
  const binding=op.numberedActions.find(a=>a.number===n);assert.ok(binding);assert.ok(first.content[0].text.includes(`**${n}.** ${binding.label}`));
  const response=binding.tool==='prodero_config_get'?await raw(binding.tool,binding.arguments):await text(binding.tool,binding.arguments);
  if(n===2){assert.equal(response.structuredContent.userInitiatedManagement,true);assert.match(response.content[0].text,/legacy Required instructions/);assert.match(response.content[0].text,/does not move records/);assert.match(response.content[0].text,/graphical exact-review Apply/);}
  if(n===3)assert.equal(response.structuredContent.result.options.layer,'local');
  if(response.structuredContent.presentation)assert.deepEqual(response.structuredContent.presentation.operational.numberedActions,[]);
 }
 const repeated=await text('prodero_open');assert.deepEqual(repeated.structuredContent.presentation.operational.numberedActions,op.numberedActions);
 assert.equal((await listKnowledge(root)).length,0);
 assert.equal(await fs.stat(path.join(root,'.prodero/local/curation-reviews')).then(()=>true,e=>e.code==='ENOENT'?false:Promise.reject(e)),false);
 const denied=await client.callTool({name:'prodero_curation_review',arguments:{action:'create',fresh:true}});assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/review_unavailable/);
});

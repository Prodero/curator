import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { createPresentationCards } from '../dist/presentation-cards.js';
import * as contracts from '../dist/contracts.js';
import {lifecycleUi} from './helpers/lifecycle-ui.mjs';

const source = await fs.readFile(new URL('../src/ui/card-disclosure.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const api = {};
vm.runInNewContext(code, {exports:api, require:()=>contracts});
const flush = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
function card(registry) {
  let collapsed=false, visible=true, disposed=false;
  const timers=new Map();
  const controller=api.createCardDisclosure({
    inspect:async(id,activate)=>registry.inspect(id,activate), display:value=>collapsed=value,
    visible:()=>visible, schedule:callback=>{const token={};timers.set(token,callback);return token;}, cancel:token=>timers.delete(token),
  });
  return {controller,timers,get collapsed(){return collapsed;},async tick(){const next=timers.entries().next().value;if(next){timers.delete(next[0]);next[1]();}await flush();},visibility(value){visible=value;controller.visibilityChanged();}};
}

test('only mounted newer cards collapse predecessors; conversations and projects are isolated',async()=>{
  const registry=createPresentationCards();
  const older=registry.issue('/project','chat-A'), newer=registry.issue('/project','chat-A');
  const a=card(registry),b=card(registry);
  a.controller.adopt(older.id);await flush();
  await a.tick();assert.equal(a.collapsed,false,'issuing without mounting does not collapse');
  registry.inspect(registry.issue('/project','chat-B').id,true);
  registry.inspect(registry.issue('/other','chat-A').id,true);
  await a.tick();assert.equal(a.collapsed,false);
  b.controller.adopt(newer.id);await flush();await a.tick();
  assert.equal(a.collapsed,true);assert.equal(b.collapsed,false);assert.equal(a.timers.size,0);
  a.controller.toggle();assert.equal(a.collapsed,false,'manual expansion stays open after supersession');
  const restored=card(registry);restored.controller.adopt(older.id);await flush();
  assert.equal(restored.collapsed,true,'late old mount cannot reclaim latest');
  await b.tick();assert.equal(b.collapsed,false);
});

test('background cards settle before restoration; stale asynchronous replies cannot collapse a replacement',async()=>{
  const registry=createPresentationCards();const a=card(registry);
  a.controller.adopt(registry.issue('/p','chat').id);await flush();
  a.visibility(false);assert.equal(a.timers.size,0);await flush();assert.equal(a.collapsed,false);
  registry.inspect(registry.issue('/p','chat').id,true);
  a.visibility(true);await flush();assert.equal(a.collapsed,true);
  const replies=[];let collapsed=false;
  const controller=api.createCardDisclosure({inspect:()=>new Promise(resolve=>replies.push(resolve)),display:value=>collapsed=value,visible:()=>true,schedule:()=>1,cancel:()=>{}});
  controller.adopt('old');controller.adopt('new');
  replies[0]({available:true,superseded:true});await flush();assert.equal(collapsed,true);
  controller.dispose();replies[1]({available:true,superseded:true});await flush();assert.equal(collapsed,true);
});

test('eviction and unavailable servers preserve manual disclosure and stop retries',async()=>{
  const registry=createPresentationCards(2);const evicted=registry.issue('/p','chat');
  registry.issue('/p','chat');registry.issue('/p','chat');
  assert.deepEqual(registry.inspect(evicted.id,true),{available:false,superseded:false});
  const a=card(registry);a.controller.adopt(evicted.id);await flush();assert.equal(a.timers.size,0);
  assert.equal(a.collapsed,true);a.controller.toggle();assert.equal(a.collapsed,false);a.controller.toggle();assert.equal(a.collapsed,true);
  let calls=0;const failing=card({inspect(){calls++;throw Error('Disconnected');}});
  failing.controller.adopt('card');await flush();await failing.tick();await failing.tick();
  assert.equal(calls,3);assert.equal(failing.timers.size,0);assert.equal(failing.collapsed,true);
});

test('mounted disclosure retains content and moves focus out of collapsed content',async()=>{
  const nodes=Object.fromEntries(['card-disclosure','card-toggle','card-content','card-title','card-toggle-label'].map(id=>[id,{hidden:false,textContent:'',attributes:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(_,fn){this.click=fn;}}]));
  const draft={value:'Unsaved review draft'};const doc={activeElement:draft,visibilityState:'visible',querySelector:s=>nodes[s.slice(1)],addEventListener(){}};
  nodes['card-content'].contains=node=>node===draft;nodes['card-toggle'].focus=()=>doc.activeElement=nodes['card-toggle'];
  // The iframe may remain tall after collapse; report only the visible bar.
  nodes['card-disclosure'].getBoundingClientRect=()=>({height:37.5});
  doc.body={getBoundingClientRect:()=>({height:nodes['card-content'].hidden?37.5:640.5})};
  const sizes=[];
  const module={};vm.runInNewContext(code,{exports:module,require:()=>contracts,document:doc,window:{setTimeout(){},clearTimeout(){},addEventListener(){}}});
  const disclosure=module.mountCardDisclosure(async()=>({structuredContent:{available:true,superseded:true}}),async size=>{sizes.push(size.height);});
  disclosure.present({action:'open',presentation:{resolved:'ui'}},'Project Intelligence');
  assert.equal(nodes['card-content'].hidden,false,'ungrouped Open must expand without a card state request');
  assert.equal(nodes['card-toggle'].attributes['aria-expanded'],'true');
  assert.equal(sizes.at(-1),641);
  nodes['card-toggle'].click();assert.equal(nodes['card-content'].hidden,true);
  disclosure.present({action:'status-details'},'Project Intelligence');
  assert.equal(nodes['card-content'].hidden,true,'in-place updates preserve manual collapse');
  nodes['card-toggle'].click();assert.equal(nodes['card-content'].hidden,false);
  disclosure.present({presentation:{card:{id:'old'}}},'Prodero · Context Ready');await flush();
  assert.equal(nodes['card-content'].hidden,true);assert.equal(nodes['card-toggle'].attributes['aria-expanded'],'false');
  assert.equal(doc.activeElement,nodes['card-toggle']);assert.equal(nodes['card-title'].textContent,'Context Ready');
  assert.equal(sizes.at(-1),38);
  nodes['card-toggle'].click();assert.equal(nodes['card-content'].hidden,false);assert.equal(draft.value,'Unsaved review draft');
  assert.equal(sizes.at(-1),641);
  assert.equal(nodes['card-toggle-label'].textContent,'Collapse');
  disclosure.present({action:'status-details'},'Project Intelligence');
  assert.equal(nodes['card-content'].hidden,false,'identity-free updates preserve a coordinated card');
});

test('ungrouped cards open once and retain manual input before and after the result',()=>{
  const a=card({inspect:()=>assert.fail('ungrouped cards cannot be inspected')});
  a.controller.adopt(undefined);assert.equal(a.collapsed,false);
  a.controller.toggle();assert.equal(a.collapsed,true);
  a.controller.adopt(undefined);assert.equal(a.collapsed,true);
  a.controller.toggle();assert.equal(a.collapsed,false);
  const early=card({inspect:()=>assert.fail('no identity')});
  early.controller.toggle();early.controller.toggle();
  early.controller.adopt(undefined);assert.equal(early.collapsed,true,'late results must not undo user input');
});

test('MCP coordinates UI cards without exposing a new App; text and support calls do not supersede',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-cards-'));
  const server=createServer({projectRoot:root});
  const client=new Client({name:'card-test',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}});
  const [c,s]=InMemoryTransport.createLinkedPair();await server.connect(s);await client.connect(c);
  t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
  for (const uri of ['ui://prodero/status.html', 'ui://prodero/lifecycle.html']) {
    const resource = await client.readResource({uri});
    assert.equal(resource.contents[0]._meta?.['openai/widgetMinFrameHeight'], 0,
      'allow collapsed cards below the host default minimum of 200px');
  }
  const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));return result.structuredContent;};
  const state=(id,activate=false)=>call('prodero_ui_card_state',{cardId:id,activate});
  const tools=(await client.listTools()).tools;
  const tool=tools.find(t=>t.name==='prodero_ui_card_state');assert.deepEqual(tool._meta.ui.visibility,['app']);assert.equal(tool._meta.ui.resourceUri,undefined);
  await call('prodero_initialize');
  const ungrouped=await call('prodero_open');
  assert.equal(ungrouped.presentation.card,undefined,'Open without a conversation group is a supported response');
  const group={presentationGroup:'conversation-A'};
  const adopted=[];
  const ui=await lifecycleUi({cardDisclosure:{present:(payload,title)=>adopted.push({id:payload.presentation?.card?.id,title}),dispose(){}}});
  const opened=await call('prodero_open',group);const oldId=opened.presentation.card.id;await state(oldId,true);
  ui.render(opened);assert.equal(adopted.at(-1).id,oldId);
  await call('prodero_open',{presentationGroup:'conversation-B'});
  await call('prodero_status_details',group);
  const text=await call('prodero_text',{tool:'prodero_open',arguments:group});assert.equal(text.presentation.card,undefined);
  assert.equal((await state(oldId)).superseded,false);
  const prepared=await call('prodero_prepare',{...group,task:'Card lifecycle'});await state(prepared.presentation.card.id,true);
  ui.render(prepared);assert.equal(adopted.at(-1).id,prepared.presentation.card.id);assert.match(adopted.at(-1).title,/Context Ready/);
  assert.equal((await state(oldId)).superseded,true);
  const closed=await call('prodero_session_close',{...group,sessionId:prepared.result.session.id});await state(closed.presentation.card.id,true);
  ui.render(closed);assert.equal(adopted.at(-1).id,closed.presentation.card.id);assert.match(adopted.at(-1).title,/Session Learned/);
  assert.equal((await state(prepared.presentation.card.id)).superseded,true);
  await state(oldId,true);assert.equal((await state(closed.presentation.card.id)).superseded,false);
  const legacy=await call('prodero_prepare',{task:'Exact session fallback'});await state(legacy.presentation.card.id,true);
  const unrelated=await call('prodero_prepare',{task:'Another session'});await state(unrelated.presentation.card.id,true);
  assert.equal((await state(legacy.presentation.card.id)).superseded,false);
  const finish=await call('prodero_session_close',{sessionId:legacy.result.session.id});await state(finish.presentation.card.id,true);
  assert.equal((await state(legacy.presentation.card.id)).superseded,true);
  assert.equal((await state(unrelated.presentation.card.id)).superseded,false);
  await call('prodero_session_close',{sessionId:unrelated.result.session.id});
});

test('history restoration keeps predecessors compact and expands only the latest card',async()=>{
  const registry=createPresentationCards(),ids=Array.from({length:4},()=>registry.issue('/p','history').id);
  for(const id of ids)registry.inspect(id,true);
  for(const id of [...ids].reverse()){
    const renders=[],replies=[];
    const controller=api.createCardDisclosure({inspect:(id,activate)=>new Promise(resolve=>replies.push(()=>resolve(registry.inspect(id,activate)))),display:v=>renders.push(v),visible:()=>true,schedule:()=>{assert.equal(id,ids.at(-1),'only the latest restored card polls');return 1;},cancel:()=>{}});
    controller.adopt(id);assert.deepEqual(renders,[true]);
    replies.shift()();await flush();
    if(id===ids.at(-1)){assert.equal(renders.at(-1),false);controller.dispose();continue;}
    assert.ok(renders.every(Boolean),'never expose a superseded body');
    controller.toggle();assert.equal(renders.at(-1),false);
    controller.visibilityChanged();await flush();assert.equal(replies.length,0,'scrolling cannot undo manual expansion');
  }
});

test('new cards expand after initial confirmation; manual input wins over delayed state and unknown history stays compact',async()=>{
  const registry=createPresentationCards(),fresh=registry.issue('/p','chat'),a=card(registry);
  a.controller.adopt(fresh.id);assert.equal(a.collapsed,true);await flush();assert.equal(a.collapsed,false);
  const unknown=card(createPresentationCards());unknown.controller.adopt(fresh.id);await flush();assert.equal(unknown.collapsed,true,'server restart loses identity but must not expand old history');
  const replies=[],renders=[];
  const controller=api.createCardDisclosure({inspect:()=>new Promise(resolve=>replies.push(resolve)),display:v=>renders.push(v),visible:()=>true,schedule:()=>assert.fail('manual state must not poll'),cancel:()=>{}});
  controller.adopt('pending');controller.toggle();assert.equal(renders.at(-1),false);
  replies.shift()({available:true,superseded:true,restored:true});await flush();assert.equal(renders.at(-1),false);
});

test('initial HTML is compact before JavaScript or tool results can arrive',async()=>{
  const html=await fs.readFile(new URL('../src/ui/index.html',import.meta.url),'utf8');
  assert.match(html,/id="card-content" hidden/);assert.match(html,/aria-expanded="false"/);assert.match(html,/id="card-toggle-label">Expand/);
  assert.doesNotMatch(html,/id="card-disclosure" hidden/);
});

test('latest card survives hide/show and remount, then collapses only when a newer card mounts',async()=>{
  const registry=createPresentationCards(),latest=registry.issue('/p','thread'),a=card(registry);
  a.controller.adopt(latest.id);await flush();assert.equal(a.collapsed,false);
  a.visibility(false);await flush();assert.equal(a.collapsed,false);assert.equal(a.timers.size,0);
  a.visibility(true);await flush();assert.equal(a.collapsed,false);
  const restored=card(registry);restored.controller.adopt(latest.id);await flush();assert.equal(restored.collapsed,false);
  restored.visibility(false);await flush();assert.equal(restored.collapsed,false);
  registry.inspect(registry.issue('/p','thread').id,true);
  restored.visibility(true);await flush();assert.equal(restored.collapsed,true);
});

test('a compatible server without restored metadata still opens its current card',async()=>{
  const a=card({inspect:()=>({available:true,superseded:false})});
  a.controller.adopt('latest');await flush();assert.equal(a.collapsed,false);a.controller.dispose();
});

import {ListRootsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {pathToFileURL} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';import {readConfig,writeConfig} from '../dist/core/storage.js';
const ui={extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}};
async function connection(root,capabilities=ui,roots){const server=createServer({projectRoot:roots?undefined:root}),client=new Client({name:'settings-test',version:'1'},{capabilities:roots?{...capabilities,roots:{}}:capabilities});if(roots)client.setRequestHandler(ListRootsRequestSchema,async()=>({roots:roots.map(r=>({uri:pathToFileURL(r).href}))}));const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);return {client,call:(name,args={})=>client.callTool({name,arguments:args}),close:async()=>{await client.close();await server.close();}};}
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-settings-'));const c=await connection(root);await c.call('prodero_initialize');t.after(async()=>{await c.close();await fs.rm(root,{recursive:true,force:true});});return {root,...c};}
test('legacy config uses effective defaults without rewriting; friendly views distinguish source',async t=>{
 const f=await fixture(t),config=await readConfig(f.root);delete config.presentation;delete config.context;await writeConfig(f.root,config);
 const before=await fs.readFile(f.root+'/.prodero/config.json','utf8');const result=await f.call('prodero_config_get');
 assert.equal(result.isError,undefined);assert.match(result.content[0].text,/Display mode: Automatic \(default\)/);assert.match(result.content[0].text,/Theme: Current \/ Prodero/);assert.match(result.content[0].text,/6,000 tokens/);
 assert.equal(await fs.readFile(f.root+'/.prodero/config.json','utf8'),before);assert.deepEqual(result.structuredContent.projectSettings.presentation,{mode:'auto',theme:'prodero'});
 config.context={budgetTokens:8000};await writeConfig(f.root,config);const legacy=await f.call('prodero_config_get');assert.match(legacy.content[0].text,/8,000 tokens \(project override\)/);
});
test('two projects keep modes and themes isolated on one client and across restart',async t=>{
 const a=await fixture(t),b=await fixture(t);
 const shared=await connection(undefined,ui,[a.root,b.root]);t.after(shared.close);
 const set=(root,key,value)=>shared.call('prodero_config_set',{projectRoot:root,key,value});
 await set(a.root,'presentation.mode','ui');await set(a.root,'presentation.theme','blue-neon');await set(b.root,'presentation.mode','text');await set(b.root,'presentation.theme','purple-neon');
 for(const [root,mode,theme] of [[a.root,'ui','blue-neon'],[b.root,'text','purple-neon'],[a.root,'ui','blue-neon']]){
  const opened=await shared.call('prodero_open',{projectRoot:root});assert.equal(opened.structuredContent.presentation.resolved,mode);assert.equal(opened.structuredContent.presentation.scope,'project');assert.equal(opened.structuredContent.projectSettings.presentation.theme,theme);
  if(mode==='text')assert.match(opened.content[0].text,/Memory/);
 }
 const fresh=await connection(b.root);try{assert.equal((await fresh.call('prodero_open')).structuredContent.presentation.resolved,'text');assert.match((await fresh.call('prodero_config_get')).content[0].text,/Purple Neon/);}finally{await fresh.close();}
 const prepared=await shared.call('prodero_prepare',{projectRoot:b.root,task:'Check settings'});assert.equal(prepared.structuredContent.presentation.resolved,'text');
 const closed=await shared.call('prodero_session_close',{projectRoot:b.root,sessionId:prepared.structuredContent.result.session.id});assert.equal(closed.structuredContent.presentation.resolved,'text');
});
test('auto still negotiates protocol support; explicit text gateway stays unattached',async t=>{
 const f=await fixture(t);await f.call('prodero_config_set',{key:'presentation.mode',value:'auto'});assert.equal((await f.call('prodero_open')).structuredContent.presentation.resolved,'ui');
 const unsupported=await connection(f.root,{});try{assert.equal((await unsupported.call('prodero_open')).structuredContent.presentation.resolved,'text');}finally{await unsupported.close();}
 assert.equal((await f.client.listTools()).tools.find(t=>t.name==='prodero_text')._meta,undefined);
 assert.equal((await f.call('prodero_text')).structuredContent.presentation.resolved,'text');
});
test('validated config updates preserve unrelated fields and affect context budget',async t=>{
 const f=await fixture(t),config=await readConfig(f.root);config.extensionForTest={keep:true};await writeConfig(f.root,config);
 const result=await f.call('prodero_config_set',{key:'context.max_tokens',value:8000});assert.equal(result.isError,undefined);assert.match(result.content[0].text,/Task context budget saved: 8,000 tokens/);
 assert.deepEqual((await readConfig(f.root)).extensionForTest,{keep:true});
 const prepared=await f.call('prodero_prepare',{task:'Check settings'});assert.equal(prepared.structuredContent.result.context.metrics.contextBudgetTokens,8000);
 await f.call('prodero_session_close',{sessionId:prepared.structuredContent.result.session.id});
 const before=await fs.readFile(f.root+'/.prodero/config.json','utf8');
 for(const [key,value] of [['../config','text'],['__proto__','text'],['presentation.mode','mobile'],['presentation.theme','blue'],['presentation.mode',2],['context.max_tokens',0],['context.max_tokens',-1],['context.max_tokens',1.5],['context.max_tokens',1000001],['context.max_tokens','8000']]){
  assert.equal((await f.call('prodero_config_set',{key,value})).isError,true,`${key}: ${value}`);assert.equal(await fs.readFile(f.root+'/.prodero/config.json','utf8'),before);
 }
});
test('concurrent settings edits preserve both keys and cannot create knowledge',async t=>{
 const f=await fixture(t);const before=await fs.readdir(f.root+'/.prodero/local/memory');
 const changes=await Promise.all([f.call('prodero_config_set',{key:'presentation.mode',value:'text'}),f.call('prodero_config_set',{key:'presentation.theme',value:'purple-neon'})]);assert.ok(changes.every(r=>!r.isError));
 assert.deepEqual((await readConfig(f.root)).presentation,{mode:'text',theme:'purple-neon'});assert.deepEqual(await fs.readdir(f.root+'/.prodero/local/memory'),before);
});

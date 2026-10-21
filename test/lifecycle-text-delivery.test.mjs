import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {buildViewModel,renderText} from '../dist/presentation.js';
const apps={extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}};
async function fixture(t,capabilities={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-lifecycle-delivery-'));
 const server=createServer({projectRoot:root}),client=new Client({name:'lifecycle-delivery',version:'1'},{capabilities});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
 const calls=[];const call=async(name,args={})=>{calls.push(name);const r=await client.callTool({name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r));return r;};
 await call('prodero_initialize');return {root,client,call,calls};
}
test('App-resolved lifecycle retains exact compact fallback and bindings without an extra retrieval',async t=>{
 const {call,calls,client}=await fixture(t,apps);const catalog=(await client.listTools()).tools;
 assert.ok(catalog.find(t=>t.name==='prodero_prepare')._meta.ui.resourceUri);
 const prepared=await call('prodero_prepare',{task:'Inspect an isolated lifecycle fixture',presentationGroup:'fixture_lifecycle'});
 assert.equal(prepared.structuredContent.presentation.resolved,'ui');
 assert.match(prepared.structuredContent.presentation.text,/Context Ready/);
 assert.equal(prepared.structuredContent.presentation.text,renderText(buildViewModel(prepared.structuredContent)));
 assert.ok(prepared.content.some(c=>c.annotations?.audience?.includes('assistant')&&c.text.includes(prepared.structuredContent.presentation.text)));
 assert.equal(prepared.structuredContent.presentation.operational.blocking,false);
 assert.deepEqual(prepared.structuredContent.presentation.operational.numberedActions,[]);
 assert.doesNotMatch(prepared.structuredContent.presentation.text,/Continue\?|Available actions/);
 assert.equal(prepared.structuredContent.presentation.operational.context,undefined,'UI fallback does not duplicate the full Core context');
 assert.equal(prepared.structuredContent.result.context.snapshot.sessionId,prepared.structuredContent.result.session.id);
 const closed=await call('prodero_session_close',{sessionId:prepared.structuredContent.result.session.id,presentationGroup:'fixture_lifecycle'});
 assert.equal(closed.structuredContent.action,'session-close');assert.equal(closed.structuredContent.result.learned.syncState,'synchronized');
 assert.match(closed.structuredContent.presentation.text,/Session closed[\s\S]*Saved/);
 assert.ok(closed.content.some(c=>c.annotations?.audience?.includes('assistant')&&c.text.includes(closed.structuredContent.presentation.text)));
 assert.deepEqual(calls,['prodero_initialize','prodero_prepare','prodero_session_close']);
});
test('text gateway lifecycle exposes visible text and specific relay timing, never another approval or RPC',async t=>{
 const {call,client}=await fixture(t,apps);const catalog=(await client.listTools()).tools;
 assert.equal(catalog.find(t=>t.name==='prodero_text')._meta,undefined);
 const prepared=await call('prodero_text',{tool:'prodero_prepare',arguments:{task:'Inspect text lifecycle'}});
 assert.equal(prepared.content[0].text,prepared.structuredContent.presentation.text);
 assert.match(prepared.structuredContent.presentation.operational.instructions,/visible assistant message/);
 assert.match(prepared.structuredContent.presentation.operational.instructions,/before continuing/);
 assert.deepEqual(prepared.structuredContent.presentation.operational.numberedActions,[]);
 const closed=await call('prodero_text',{tool:'prodero_session_close',arguments:{sessionId:prepared.structuredContent.result.session.id}});
 assert.equal(closed.content[0].text,closed.structuredContent.presentation.text);
 assert.match(closed.structuredContent.presentation.operational.instructions,/before the final task answer/);
 assert.equal(closed.structuredContent.result.learned.syncState,'synchronized');
 const instructions=(await call('prodero_instructions_read')).content[0].text;
 assert.match(instructions,/presentation.resolved is text/);assert.match(instructions,/visible assistant message/);
 assert.match(catalog.find(t=>t.name==='prodero_prepare').description,/prodero_text/);
 assert.match(catalog.find(t=>t.name==='prodero_session_close').description,/prodero_text/);
});

test('auto resolved text preserves compact delivery and never labels deferred saving as saved',async t=>{
 const {call,calls}=await fixture(t);
 const prepared=await call('prodero_prepare',{task:'Inspect automatic text delivery'});
 assert.equal(prepared.structuredContent.presentation.requested,'auto');assert.equal(prepared.structuredContent.presentation.resolved,'text');
 assert.match(prepared.content[0].text,/Context Ready/);assert.deepEqual(prepared.structuredContent.presentation.operational.numberedActions,[]);
 const sessionId=prepared.structuredContent.result.session.id;
 await call('prodero_session_record',{sessionId,entries:[{type:'discovery',title:'Synthetic lifecycle fixture',content:'This fixture checks deferred synchronization only.'}]});
 const closed=await call('prodero_session_close',{sessionId,sync:false});assert.equal(closed.structuredContent.result.learned.syncState,'pending-auto-sync');
 assert.match(closed.content[0].text,/Saving deferred/);assert.doesNotMatch(closed.content[0].text,/│ Saved|Session Complete/);
 assert.deepEqual(calls,['prodero_initialize','prodero_prepare','prodero_session_record','prodero_session_close']);
});

test('failed Close has no fabricated successful lifecycle fallback',async t=>{
 const {client}=await fixture(t,apps);
 const result=await client.callTool({name:'prodero_session_close',arguments:{sessionId:'sess_missing_fixture'}});
 assert.equal(result.isError,true);assert.equal(result.structuredContent.presentation,undefined);
 assert.doesNotMatch(result.content.map(c=>c.text??'').join('\n'),/Session Complete|│ Saved|Context Ready/);
});

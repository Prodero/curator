import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {buildViewModel,renderText} from '../dist/presentation.js';
import {listKnowledge} from '../dist/core/memory.js';
import {readSession} from '../dist/core/sessions.js';

const apps={extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}};
async function fixture(t,capabilities={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-close-receipt-')),server=createServer({projectRoot:root}),client=new Client({name:'close-receipt-fixture',version:'1'},{capabilities}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r));return r;};
 const text=(tool,args={})=>call('prodero_text',{tool,arguments:args});
 await call('prodero_initialize');const prepared=await text('prodero_prepare',{task:'Verify the visible close receipt'});
 return {root,server,client,call,text,sessionId:prepared.structuredContent.result.session.id};
}
const unframed=text=>assert.doesNotMatch(text,/›_ prodero|```|╭|Available actions|Reply with a number/);

test('empty successful Close has an explicit one-line receipt, including the final-answer delivery contract',async t=>{
 const f=await fixture(t),closed=await f.text('prodero_session_close',{sessionId:f.sessionId});
 assert.equal(closed.structuredContent.result.session.status,'closed');assert.equal(closed.structuredContent.result.learned.observations,0);
 assert.equal(closed.content[0].text,'**Session closed** · No observations recorded.');unframed(closed.content[0].text);
 assert.deepEqual(closed.structuredContent.presentation.operational.closeReceipt,{label:'Session closed',detail:'No observations recorded.'});
 assert.match(closed.structuredContent.presentation.operational.instructions,/in the final assistant answer/);
 assert.match(closed.structuredContent.presentation.operational.instructions,/never leave it only in a tool result or collapsible commentary/);
 assert.match(closed.structuredContent.presentation.operational.instructions,/minimal or quiet reply must still include/i);
 const instructions=(await f.call('prodero_instructions_read')).content[0].text;assert.match(instructions,/include its one-line Session closed receipt in the final assistant answer/);
});

test('saved observation counts remain truthful when consolidation creates fewer knowledge records and a Close is retried',async t=>{
 const f=await fixture(t),entry={type:'lesson',title:'Harbor retry fixture',content:'Retain the Harbor source evidence during a retry.',scopeHint:'global'};
 await f.call('prodero_session_record',{sessionId:f.sessionId,entries:[entry,entry]});
 const closed=await f.text('prodero_session_close',{sessionId:f.sessionId}),result=closed.structuredContent.result;
 assert.equal(result.learned.observations,2);assert.equal(result.synchronization.knowledgeCreated,1);assert.equal((await listKnowledge(f.root)).length,1);
 assert.equal(closed.content[0].text,'**Session closed** · Saved 2 observations.');assert.doesNotMatch(closed.content[0].text,/2 knowledge|2 records/);unframed(closed.content[0].text);
 const replay=await f.text('prodero_session_close',{sessionId:f.sessionId});assert.equal(replay.structuredContent.result.alreadyClosed,true);
 assert.equal(replay.content[0].text,'**Session already closed** · 2 observations previously recorded.');assert.doesNotMatch(replay.content[0].text,/· Saved/);
 assert.equal((await readSession(f.root,f.sessionId)).sections.Lessons.length,2);assert.equal((await listKnowledge(f.root)).length,1);
});

test('deferred synchronization states closure explicitly without claiming a completed memory save',async t=>{
 const f=await fixture(t);await f.call('prodero_session_record',{sessionId:f.sessionId,entries:[{type:'discovery',content:'The Harbor fixture intentionally defers synchronization.'}]});
 const closed=await f.text('prodero_session_close',{sessionId:f.sessionId,sync:false});
 assert.equal(closed.structuredContent.result.session.status,'closed');assert.equal(closed.structuredContent.result.learned.syncState,'pending-auto-sync');
 assert.match(closed.content[0].text,/^\*\*Session closed\*\* · Saving deferred\./);assert.doesNotMatch(closed.content[0].text,/Saved \d|Memory synchronized/);
 assert.equal((await listKnowledge(f.root)).length,0);assert.match(closed.content[0].text,/resume before the next work session/);
});

test('visible-App and invisible-App routes retain the same explicit receipt without re-running Close',async t=>{
 const f=await fixture(t,apps),closed=await f.call('prodero_session_close',{sessionId:f.sessionId,presentationGroup:'close_receipt_fixture'});
 assert.equal(closed.structuredContent.presentation.resolved,'ui');assert.equal(closed.structuredContent.presentation.text,'**Session closed** · No observations recorded.');
 assert.ok(closed.content.some(c=>c.annotations?.audience?.includes('assistant')&&c.text.includes(closed.structuredContent.presentation.text)));
 assert.match(closed.structuredContent.presentation.operational.instructions,/do not duplicate a visible App/);
 assert.equal(closed.structuredContent.presentation.operational.closeReceipt.label,'Session closed');
});

test('failed Close and partial/unconfirmed data do not fabricate a closed or saved receipt',async t=>{
 const f=await fixture(t),failed=await f.client.callTool({name:'prodero_text',arguments:{tool:'prodero_session_close',arguments:{sessionId:'sess_missing_fixture'}}});
 assert.equal(failed.isError,true);assert.equal(failed.structuredContent.presentation,undefined);assert.doesNotMatch(failed.content.map(c=>c.text??'').join('\n'),/\*\*Session closed\*\*|Saved \d/);
 const partial={action:'session-close',result:{learned:{observations:9,rawSessionTokens:0,syncState:'synchronized'}}};
 assert.equal(renderText(buildViewModel(partial)),'**Session status unavailable** · Saving state not confirmed.');
 partial.result.session={status:'closed'};partial.result.learned.syncState=undefined;
 assert.equal(renderText(buildViewModel(partial)),'**Session closed** · Saving state not confirmed.');
 partial.result.learned.syncState='synchronized';partial.result.learned.observations=NaN;
 assert.equal(renderText(buildViewModel(partial)),'**Session closed** · Memory synchronized.');
});

test('actual optional diagnostics remain visible beside the receipt and in explicit expanded inspection',()=>{
 const payload={action:'session-close',result:{session:{status:'closed'},learned:{observations:2,rawSessionTokens:80,syncState:'synchronized'},review:{error:'Knowledge changed after context selection; retry'}}};
 for(const detailed of [false,true]){const text=renderText(buildViewModel(payload),false,detailed);assert.match(text,/^\*\*Session closed\*\* · Saved 2 observations\./);assert.match(text,/Session diagnostics unavailable: Knowledge changed after context selection; retry/);}
});

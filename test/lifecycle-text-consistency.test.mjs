import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {buildViewModel,renderText,renderTerminalText} from '../dist/presentation.js';
import {conversationOperation,LIFECYCLE_PRESENTATION_REPLY} from '../dist/conversation-presentation.js';
import {textViewFixtures} from './helpers/text-view-fixtures.mjs';
const plain=t=>assert.doesNotMatch(t,/›_ prodero|╭|╰|```|\*\*\d\.\*\*|moderate memory/);

test('Prepare reports delivered array counts, including zeros, independently of English facts and stored/token metrics',()=>{
 const p=structuredClone(textViewFixtures().ready);p.result.context.required=[];p.result.context.relevant=[];p.result.context.skills=[];
 const vm=buildViewModel(p);vm.conversation.facts=['Fake translated summary with 999 records'];vm.metrics.push({label:'Required',value:999});
 assert.equal(renderText(vm),'**Context Ready**\n\nLoaded 0 project instructions · 0 knowledge records · 0 skills.\n\nContinuing the task.');plain(renderText(vm));
 const loaded=structuredClone(textViewFixtures().ready);loaded.result.context.skills=[];const text=renderText(buildViewModel(loaded));assert.match(text,/Loaded 1 project instruction · 1 knowledge record · 0 skills\./);assert.doesNotMatch(text,/999/);
 delete vm.conversation.contextLoaded;assert.match(renderText(vm),/Loaded context counts unavailable/);assert.doesNotMatch(renderText(vm),/Loaded \d/);
});

test('blocking Prepare retains delivered counts and the real blocker without announcing continuation',()=>{
 const p=structuredClone(textViewFixtures().blocked),vm=buildViewModel(p),text=renderText(vm),op=conversationOperation(p,vm);
 assert.equal(op.blocking,true);assert.match(text,/required instruction.*not loaded/i);assert.match(text,/Loaded 1 project instruction · 1 knowledge record · 1 skill/);assert.doesNotMatch(text,/Continuing the task/);plain(text);
});

test('Close keeps one deferred status and recovery, and shared detail copy never invents saved knowledge',()=>{
 const f=textViewFixtures(),deferred=buildViewModel(f['closed-deferred']),text=renderText(deferred);
 assert.equal((text.match(/Saving deferred/gi)??[]).length,1);assert.match(text,/resume before the next work session/);plain(text);
 for(const p of [f['closed-zero'],{...f.closed,result:{...f.closed.result,alreadyClosed:true}},f['closed-deferred']]){
  const vm=buildViewModel(p);assert.doesNotMatch(vm.notices.join(' '),/Useful knowledge was saved automatically/);assert.doesNotMatch(renderTerminalText(vm,false,true),/Useful knowledge was saved automatically/);
 }
 assert.match(buildViewModel(f['closed-zero']).notices.join(' '),/No observations recorded/);
 const unconfirmed=structuredClone(f.closed);delete unconfirmed.result.session;assert.match(buildViewModel(unconfirmed).notices.join(' '),/Session status unavailable/);assert.doesNotMatch(buildViewModel(unconfirmed).notices.join(' '),/Session closed|Saved 2/);
});

test('MCP repeat Prepare resumes its own session and failed/missing-ID Close never fabricates a success',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'curator-lifecycle-consistency-')),server=createServer({projectRoot:root}),client=new Client({name:'lifecycle-regression',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
 const raw=(name,args={})=>client.callTool({name,arguments:args}),call=async(name,args={})=>{const r=await raw(name,args);assert.notEqual(r.isError,true,JSON.stringify(r));return r;},text=(tool,args={})=>call('prodero_text',{tool,arguments:args});await call('prodero_initialize');
 for(const args of [{},{sessionId:'sess_unknown_fixture'}]){const r=await raw('prodero_text',{tool:'prodero_session_close',arguments:args});assert.equal(r.isError,true);assert.equal(r.structuredContent.presentation,undefined);assert.doesNotMatch(r.content.map(c=>c.text??'').join(' '),/\*\*Session closed\*\*|Saved \d/);}
 const p=await text('prodero_prepare',{task:'Inspect an empty fixture'}),id=p.structuredContent.result.session.id,repeated=await text('prodero_prepare',{task:'Inspect an empty fixture',sessionId:id});
 assert.equal(repeated.structuredContent.result.session.id,id);assert.equal(repeated.content[0].text,p.content[0].text);assert.match(p.content[0].text,/Loaded 0 project instructions · 0 knowledge records · 0 skills/);
 const closed=await text('prodero_session_close',{sessionId:id}),again=await text('prodero_session_close',{sessionId:id});assert.equal(closed.content[0].text,'**Session closed** · No observations recorded.');assert.equal(again.content[0].text,'**Session already closed** · No observations recorded.');
 assert.match(closed.structuredContent.presentation.operational.instructions,/final assistant answer/);assert.match(LIFECYCLE_PRESENTATION_REPLY,/do not invent one or close another session/);assert.match(LIFECYCLE_PRESENTATION_REPLY,/does not establish that the project has no other active sessions/);
});

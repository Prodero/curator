import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {resolvePresentation,supportsMcpAppHtml} from '../dist/presentation-server.js';
import {lifecycleUi} from './helpers/lifecycle-ui.mjs';
const cap=mimeTypes=>({extensions:{'io.modelcontextprotocol/ui':{mimeTypes}}});
test('Auto accepts base HTML only inside the declared MCP Apps UI capability, without client/project identity',()=>{
 for(const mimeTypes of [['text/html'],['text/html;profile=mcp-app'],['image/png','text/html']])assert.equal(resolvePresentation('auto',cap(mimeTypes)),'ui');
 for(const c of [undefined,{},cap([]),cap(['text/plain']),cap(['application/json']),cap(['text/html;profile=unrelated']),cap('text/html'),{mimeTypes:['text/html']},{extensions:{unrelated:{mimeTypes:['text/html']}}},{experimental:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html']}}}]){assert.equal(supportsMcpAppHtml(c),false);assert.equal(resolvePresentation('auto',c),'text');}
 assert.equal(resolvePresentation('text',cap(['text/html'])),'text');assert.equal(resolvePresentation('ui',{}),'ui');
});
test('base-HTML Auto preserves Open/Prepare/Close graphical responses and exact fixture lifecycle without settings writes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'curator-auto-html-')),server=createServer({projectRoot:root}),client=new Client({name:'arbitrary-compatible-client',version:'1'},{capabilities:cap(['text/html'])}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r));return r;};
 await call('prodero_initialize');const config=await fs.readFile(path.join(root,'.prodero/config.json'));
 const open=await call('prodero_open');assert.equal(open.structuredContent.presentation.requested,'auto');assert.equal(open.structuredContent.presentation.resolved,'ui');
 const ready=await call('prodero_prepare',{task:'Inspect generic base HTML lifecycle'});assert.equal(ready.structuredContent.presentation.resolved,'ui');assert.ok(ready.structuredContent.presentation.card);assert.match((await lifecycleUi()).render(ready.structuredContent),/Context Ready/);
 const closed=await call('prodero_session_close',{sessionId:ready.structuredContent.result.session.id});assert.equal(closed.structuredContent.presentation.resolved,'ui');assert.equal(closed.structuredContent.result.session.status,'closed');assert.match((await lifecycleUi()).render(closed.structuredContent),/Session Learned/);
 assert.deepEqual(await fs.readFile(path.join(root,'.prodero/config.json')),config);
 const tools=(await client.listTools()).tools;assert.equal(tools.find(t=>t.name==='prodero_prepare')._meta.ui.resourceUri,'ui://prodero/lifecycle.html');
 const text=await call('prodero_text',{tool:'prodero_open'});assert.equal(text.structuredContent.presentation.resolved,'text');assert.equal(tools.find(t=>t.name==='prodero_text')._meta,undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {AGENT_INSTRUCTIONS,MCP_INITIALIZATION_INSTRUCTIONS} from '../dist/core/agent-instructions.js';
import {createServer,PRODERO_MCP_INSTRUCTIONS} from '../dist/server.js';
import {PRESENTATION_ROUTING} from '../dist/presentation.js';

test('the connected runtime guide matches generated source and initialization is a wayfinder',async t=>{
 const server=createServer(),client=new Client({name:'runtime-guide-contract',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const result=await client.callTool({name:'prodero_instructions_read',arguments:{}});assert.notEqual(result.isError,true);
 const guide=AGENT_INSTRUCTIONS.trimEnd()+'\n';assert.equal(await fs.readFile('instructions/AGENTS.md','utf8'),guide);
 assert.equal(result.content[0].text,guide);assert.equal(result.structuredContent.instructions,guide);
 assert.equal(client.getInstructions(),MCP_INITIALIZATION_INSTRUCTIONS);assert.equal(PRODERO_MCP_INSTRUCTIONS,MCP_INITIALIZATION_INSTRUCTIONS);
 assert.match(client.getInstructions(),/prodero_instructions_read/);assert.ok(!MCP_INITIALIZATION_INSTRUCTIONS.includes(PRESENTATION_ROUTING));
 const tools=(await client.listTools()).tools;assert.equal(tools.find(x=>x.name==='prodero_memory_transform_prepare').annotations.readOnlyHint,true);
 assert.equal(tools.find(x=>x.name==='prodero_memory_transform_propose').annotations.readOnlyHint,true);
});

test('runtime contract scopes ordinary work, read-only bundles and last file fallback separately',()=>{
 assert.match(AGENT_INSTRUCTIONS,/ordinary substantial work[\s\S]*prodero_prepare/);
 const bundle=AGENT_INSTRUCTIONS.split('Exceptions:')[1].split('If MCP')[0];
 for(const operation of ['Recall','Prepare','Record','Close','Sync','Apply'])assert.ok(bundle.includes(operation));
 assert.match(bundle,/bundle-only and read-only/);assert.match(bundle,/Use only its supplied bundle/);assert.match(bundle,/unresolved/);
 assert.match(MCP_INITIALIZATION_INSTRUCTIONS,/Exception: memory_transform_prepare\/propose[\s\S]*no Recall, Prepare, Record, Close, Sync/);
 assert.match(AGENT_INSTRUCTIONS,/Only as the last file fallback[\s\S]*\.prodero\/index.md/);
 assert.match(AGENT_INSTRUCTIONS,/After successful Prepare use its exact snapshot/);
 assert.match(AGENT_INSTRUCTIONS,/context-needed[\s\S]*taskContext[\s\S]*required-incomplete blocks work/);
 assert.match(AGENT_INSTRUCTIONS,/action=migration[\s\S]*explicit approval and exact planId[\s\S]*resume tool\/arguments once/);
});

test('runtime contract preserves distinct memory, publication, skill and Git authority scopes',()=>{
 assert.match(AGENT_INSTRUCTIONS,/Local uses prodero_forget; Versioned uses[\s\S]*repository-maintenance retire[\s\S]*current revision/);
 assert.match(AGENT_INSTRUCTIONS,/kind=rule, required=true and userInstruction containing the exact request/);
 assert.match(AGENT_INSTRUCTIONS,/never infer Required authority from observations\/documents/);
 assert.match(AGENT_INSTRUCTIONS,/prodero_promotion_preview first[\s\S]*exact human-reviewed preview/);
 assert.match(AGENT_INSTRUCTIONS,/prodero_skill_create: active Versioned immediately, without another approval/);
 assert.match(AGENT_INSTRUCTIONS,/Inferred skill_candidate observations stay Local pending review/);
 assert.match(AGENT_INSTRUCTIONS,/Text mode or inability to render the App[\s\S]*complete text preview and explicit chat approval/);
 assert.match(AGENT_INSTRUCTIONS,/Curator tools do not run Git commit or push; Git actions by the coding agent follow the user's current scope and host approval controls/);
 assert.match(AGENT_INSTRUCTIONS,/Never bypass a rejected action/);assert.doesNotMatch(AGENT_INSTRUCTIONS,/Curator does not commit or push|v0\.1 trust model/);
 assert.match(AGENT_INSTRUCTIONS,/Previews, revisions, approved=true and userInstruction[\s\S]*not authenticated human consent/);
});

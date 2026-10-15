import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../dist/server.js';
import { snapshotFiles } from '../dist/core/plugin-files.js';
import { fixture, analysisFor } from './helpers/migrate-ai-studio.mjs';

test('real MCP migration tool and App resource use bounded negotiated sampling and validated JSON',async t=>{
  const f=await fixture(t);const server=createServer({projectRoot:f.root});const client=new Client({name:'migration-contract',version:'1'},{capabilities:{sampling:{}}});const calls=[];
  client.setRequestHandler(CreateMessageRequestSchema,async({params})=>{
    assert.equal(params.includeContext,'none');assert.equal(params.tools,undefined);assert.match(params.systemPrompt,/untrusted data/);assert.ok(params.maxTokens<=16000);
    const phase=params.systemPrompt.includes('# AI Studio audit')?'audit':params.systemPrompt.includes('# AI Studio classification')&&params.systemPrompt.includes('# AI Studio distillation')?'analysis':'verification';calls.push(phase);
    const input=JSON.parse(params.messages[0].content.text);assert.ok(!JSON.stringify(input).includes('sk-fake'));
    const full=phase==='audit'?null:analysisFor({input});const output=phase==='audit'?{version:1,findings:[],inspectPaths:['src/store.ts'],warnings:[]}:phase==='analysis'?{classify:full.classify,migrate:full.migrate,verify:full.verify}:full.verify;
    return {role:'assistant',content:{type:'text',text:JSON.stringify(output)},model:'fixture',stopReason:'endTurn'};
  });
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
  const call=async(action,input={})=>{const result=await client.callTool({name:'prodero_plugin_migrate_ai_studio',arguments:{projectRoot:f.root,action,input}});assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent.result;};
  const tools=(await client.listTools()).tools;
  const metadata=tools.find(t=>t.name==='prodero_plugin_migrate_ai_studio');assert.equal(metadata._meta.ui.resourceUri,'ui://prodero/plugins/migrate_ai_studio-1.7.0.html');assert.equal(metadata.annotations.readOnlyHint,true);
  for(const [action,readOnly] of [['detect',true],['estimate',true],['audit',true],['plan',true],['review',true],['apply',false],['verify',true]]){const tool=tools.find(t=>t.name===`prodero_plugin_migrate_ai_studio_${action}`);assert.deepEqual(tool._meta.ui.visibility,['app']);assert.equal(tool.annotations.readOnlyHint,readOnly);}
  const ui=await client.readResource({uri:metadata._meta.ui.resourceUri});assert.match(ui.contents[0].text,/Knowledge Migration/);assert.ok(!ui.contents[0].text.includes('src="/main.ts"'));
  await call('detect');await client.callTool({name:'prodero_status',arguments:{projectRoot:f.root}});await client.callTool({name:'prodero_plugins',arguments:{}});assert.equal(calls.length,0);
  const before=await snapshotFiles(f.root,'.prodero');const result=await call('audit',{semantic:true});assert.deepEqual(calls,['audit','analysis']);assert.deepEqual(await snapshotFiles(f.root,'.prodero'),before);
  const reviewed=await call('review',{planId:result.plan.planId,decisions:result.plan.items.map(i=>({id:i.id,include:i.include,activateSkill:false}))});
  const applied=await call('apply',{planId:reviewed.plan.planId,approvedPlanId:reviewed.plan.planId});assert.equal(calls.length,2);
  const verified=await call('verify',{planId:reviewed.plan.planId,receipt:applied.receipt,semantic:true});assert.equal(verified.valid,true);assert.equal(verified.semanticStatus,'reviewed');assert.equal(calls.length,3);
});

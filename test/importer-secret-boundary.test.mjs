import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {fixture,analysisFor} from './helpers/migrate-ai-studio.mjs';
const marker='npm_'+'A'.repeat(36);
async function clientFor(t,root){const server=createServer({projectRoot:root}),client=new Client({name:'secret-boundary',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});return async(action,input={},app=false)=>client.callTool({name:app?`prodero_plugin_migrate_ai_studio_${action}`:'prodero_plugin_action',arguments:app?{input}:{pluginId:'migrate_ai_studio',action,input}});}
function rejected(result){assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes(marker));}
for(const app of [false,true])test(`R02 credential-bearing filenames and excluded inventory fail closed (${app?'App':'generic'})`,async t=>{
 const f=await fixture(t),call=await clientFor(t,f.root);
 for(const relative of [`.ai-studio/runtime/memory/${marker}.md`,`.ai-studio/runtime/handoffs/${marker}.log`]){
  await fs.writeFile(path.join(f.root,relative),'Ordinary source text.');
  rejected(await call('audit',{semantic:true},app));rejected(await call('estimate',{},app));await fs.unlink(path.join(f.root,relative));
 }
 const good=await call('audit',{semantic:true},app);assert.notEqual(good.isError,true,JSON.stringify(good));
 const packet=good.structuredContent.result.auditPackage;
 for(const field of ['warning','excluded','inventory','exclusion']){
  const auditPackage=structuredClone(packet),analysis=analysisFor(packet);
  if(field==='warning')analysis.audit.warnings.push(marker);
  if(field==='excluded')analysis.migrate.items.find(i=>!i.include).content=marker;
  if(field==='inventory')auditPackage.input.inventory=[{path:marker,bytes:1}];
  if(field==='exclusion')auditPackage.input.excluded.push({path:'safe.md',reason:marker});
  rejected(await call('plan',{auditPackage,analysis},app));
 }
 const safe=analysisFor(packet);safe.audit.warnings.push('Discuss password, token and secret handling without storing credentials.');
 const planned=await call('plan',{auditPackage:packet,analysis:safe},app);assert.notEqual(planned.isError,true,JSON.stringify(planned));
 const plan=planned.structuredContent.result.plan;
 const replay=await call('review',{planId:plan.planId,decisions:plan.items.map(i=>({id:i.id,include:i.include,activateSkill:false}))},!app);assert.notEqual(replay.isError,true,JSON.stringify(replay));
 const unsafe=structuredClone(plan);unsafe.items.find(i=>!i.include).content=marker;
 rejected(await call('review',{plan:unsafe,decisions:[]},app));
});
test('R02 shared policy screens cached plans again and blocks metadata before sampling',async t=>{
 const f=await fixture(t);let samples=0;
 await fs.writeFile(path.join(f.root,'.ai-studio/runtime/memory',marker+'.md'),'Ordinary content.');
 await assert.rejects(f.call('audit',{semantic:true},{...f.ctx,llm:{json:async()=>{samples++;throw Error('must not sample');}}}),/credential/i);assert.equal(samples,0);
 await fs.unlink(path.join(f.root,'.ai-studio/runtime/memory',marker+'.md'));
 const {auditPackage}=await f.call('audit',{semantic:true}),{plan}=await f.call('plan',{auditPackage,analysis:analysisFor(auditPackage)});
 let checked=false;const ctx={...f.ctx,screening:{...f.ctx.screening,assertSafe(value){f.ctx.screening.assertSafe(value);if(value?.planId===plan.planId){checked=true;throw Error('Policy now excludes cached content');}}}};
 await assert.rejects(f.call('review',{planId:plan.planId,decisions:[]},ctx),/Policy now excludes/);assert.equal(checked,true);
});
test('R02 model metadata is screened before schema parsing and diagnostics cannot echo credentials',async t=>{
 const f=await fixture(t);
 for(const json of [async()=>({version:1,findings:[],inspectPaths:[],warnings:[marker]}),async()=>({version:1,findings:[],inspectPaths:[],warnings:[],extra:marker}),async()=>{throw Error('Provider rejected '+marker);}]){
  await assert.rejects(f.call('audit',{semantic:true},{...f.ctx,llm:{json}}),e=>/credential/i.test(e.message)&&!e.message.includes(marker));
 }
});

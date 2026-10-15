import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as contracts from '../dist/contracts.js';
import { fixture, analysisFor } from './helpers/migrate-ai-studio.mjs';

async function uiHarness(f,sampler) {
  let app;const inputs=new Map();const calls=[];const samples=[];const messages=[];
  const host={innerHTML:'',querySelectorAll(selector){
    if(selector==='[data-action]')return [];
    const key=selector==='[data-include]'?'include':selector==='[data-activate]'?'activate':null;
    if(!key)return [];
    return [...this.innerHTML.matchAll(new RegExp(`<input[^>]*data-${key}="([^"]+)"[^>]*>`, 'g'))].map(([html,id])=>{
      const node={dataset:{[key]:id},checked:html.includes('checked'),disabled:html.includes('disabled'),addEventListener(_,fn){this.callback=fn;}};inputs.set(`${key}:${id}`,node);return node;
    });
  }};
  class AppStub {
    constructor(){app=this;}
    connect(){}
    getHostCapabilities(){return sampler?{sampling:{}}:{};}
    async callServerTool(args){calls.push(structuredClone(args));const action=args.name.replace('prodero_plugin_migrate_ai_studio_','');const {input}=args.arguments;const result=await f.call(action,input);return {structuredContent:{ok:true,pluginId:'migrate_ai_studio',projectRoot:f.root,action,result}};}
    async createSamplingMessage(args){samples.push(structuredClone(args));if(!sampler)throw new Error('App sampling unavailable');return sampler(args);}
    async sendMessage(args){messages.push(structuredClone(args));return {};}
  }
  const source=await fs.readFile(new URL('../plugins/migrate_ai_studio/ui/main.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const runtime=vm.runInNewContext(`${code}\n;({ act, receive: value => app.ontoolresult({ structuredContent: value }) });`,{exports:{},document:{querySelector:()=>host},structuredClone,require:id=>id==='@modelcontextprotocol/ext-apps'?{App:AppStub}:id.includes('contracts')?contracts:{}});
  return {html:()=>host.innerHTML,calls,samples,messages,receive:result=>runtime.receive({ok:true,pluginId:'migrate_ai_studio',projectRoot:f.root,result}),act:runtime.act,toggle(key,id,value){const node=inputs.get(`${key}:${id}`);assert.ok(node&&!node.disabled);node.checked=value;node.callback();}};
}
test('production UI submits exact reviewed selections; excluded item stays excluded and verification restores full review',async t=>{
  const f=await fixture(t);const audited=await f.call('audit',{semantic:true,repositoryPaths:['README.md','src/store.ts']});const planned=await f.call('plan',{auditPackage:audited.auditPackage,analysis:analysisFor(audited.auditPackage)});
  const ui=await uiHarness(f);ui.receive(planned);
  assert.match(ui.html(),/AI Studio[\s\S]*→[\s\S]*Prodero/);assert.match(ui.html(),/Import reviewed plan \(3\)[^]*?/);
  assert.match(ui.html(),/data-action="apply"[^>]*disabled/);
  ui.toggle('include','item-0',false);await ui.act('review');assert.match(ui.html(),/Import reviewed plan \(2\)/);assert.doesNotMatch(ui.html(),/data-action="apply"[^>]*disabled/);
  const reviewRequest=ui.calls.find(c=>c.name.endsWith('_review')).arguments.input;assert.equal('plan' in reviewRequest,false);assert.match(reviewRequest.planId,/^[a-f0-9]{64}$/);assert.equal(reviewRequest.decisions[0].include,false);
  await ui.act('apply');const applied=ui.calls.find(c=>c.name.endsWith('_apply')).arguments.input;
  assert.equal('plan' in applied,false);assert.equal(applied.approvedPlanId,applied.planId);
  assert.match(ui.html(),/Verification is pending/);assert.doesNotMatch(ui.html(),/Migration Complete/);
  await ui.act('verify');assert.match(ui.html(),/Migration Complete/);assert.match(ui.html(),/2 imported/);
  const verifyRequest=ui.calls.find(c=>c.name.endsWith('_verify')).arguments.input;
  assert.equal('plan' in verifyRequest,false);assert.match(verifyRequest.planId,/^[a-f0-9]{64}$/);
  const verified=await f.call('verify',verifyRequest);const reopened=await uiHarness(f);reopened.receive(verified);assert.match(reopened.html(),/Import preview/);assert.match(reopened.html(),/Migration Complete/);
});
test('UI performs local extraction without sampling or chat and escapes proposal text',async t=>{
  const f=await fixture(t);const ui=await uiHarness(f);const estimate=await f.call('estimate');ui.receive(estimate);assert.match(ui.html(),/Ready to audit/);assert.match(ui.html(),/Local extraction/);assert.match(ui.html(),/No model request/);
  await ui.act('audit');assert.match(ui.html(),/Import preview/);assert.equal(ui.samples.length,0);assert.equal(ui.messages.length,0);assert.ok(ui.calls.every(call=>!call.name.includes('plugin_action')));
  const value=await f.call('audit');value.plan.items[0].title='<script>unsafe</script>';ui.receive(value);assert.ok(!ui.html().includes('<script>unsafe</script>'));assert.ok(ui.html().includes('&lt;script&gt;unsafe&lt;/script&gt;'));
});

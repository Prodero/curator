import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {hasSecret,assertNoSecrets} from '../dist/core/secrets.js';
import {secretPath,readSource} from '../dist/core/plugin-files.js';
import {validateImportItems} from '../dist/core/imports.js';
import {sha256} from '../dist/core/storage.js';
import {fixture,analysisFor} from './helpers/migrate-ai-studio.mjs';
import {sensitiveContents,ordinaryContents,sensitivePaths,ordinaryPaths,marker} from './fixtures/sensitive-sources.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CreateMessageRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createServer} from '../dist/server.js';
import {collectCurationEvidence,evidenceFor} from '../dist/core/curation-evidence.js';

for(const [name,value] of sensitiveContents)test(`shared secret policy rejects ${name}`,()=>{
  assert.equal(hasSecret(value),true);
  assert.equal(hasSecret(JSON.stringify({content:value})),true,'JSON transport cannot hide credentials');
  assert.throws(()=>assertNoSecrets({content:value}),/Potential credential/);
});
for(const value of ordinaryContents)test(`shared secret policy allows harmless source: ${value}`,()=>{
  assert.equal(hasSecret(value),false);
  assert.equal(hasSecret(JSON.stringify({content:value})),false);
  assert.doesNotThrow(()=>assertNoSecrets({content:value}));
});
for(const name of sensitivePaths)test(`sensitive source path excluded: ${name}`,()=>{
  assert.equal(secretPath(name),true);assert.equal(secretPath(name.replaceAll('/','\\')),true);
});
for(const name of ordinaryPaths)test(`ordinary source path retained: ${name}`,()=>assert.equal(secretPath(name),false));

async function write(root,file,content){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),content);}
const clean=value=>assert.ok(!JSON.stringify(value).includes(marker));
const item=(file,content)=>({key:'safe-import',destination:'knowledge',title:'Testing',content:'Always run isolated tests.',scope:'global',scopeRef:null,category:'decision',evidence:[{path:file,sha256:sha256(content),startLine:1,endLine:1}],reason:'Source supports isolated testing.',skill:null,activateSkill:false});

test('plugin file reads and import review/apply preflight share path/content policy',async t=>{
  const f=await fixture(t);
  for(const file of sensitivePaths){await write(f.root,file,'ordinary configuration');await assert.rejects(f.ctx.files.read(file),/Secret-bearing file type excluded/);}
  for(const [name,value]of sensitiveContents){await write(f.root,'src/evidence.txt',value);await assert.rejects(readSource(f.root,'src/evidence.txt'),/secret-bearing source/);await assert.rejects(validateImportItems(f.root,[item('src/evidence.txt',value)]),/secret-bearing source/,name);}
  for(const file of ['.npmrc','.aws/config','service-account.json'])await assert.rejects(validateImportItems(f.root,[item(file,'ordinary configuration')]),/Secret-bearing file type excluded/);
  const source=ordinaryContents.join('\n');await write(f.root,'src/evidence.txt',source);
  assert.equal((await f.ctx.files.read('src/evidence.txt')).content,source);await validateImportItems(f.root,[item('src/evidence.txt',source)]);
});

test('F03 collector automatically excludes F05 assignments and private config subtrees',async t=>{
  const f=await fixture(t);
  await write(f.root,'tests/deploy.sh',`# SERVICE_PASSWORD\nSERVICE_PASSWORD=${marker}`);
  await write(f.root,'tests/npm.ts',`// SERVICE_PASSWORD\n//registry.npmjs.org/:_authToken=${marker}`);
  await write(f.root,'tests/.aws/config.ts','// SERVICE_PASSWORD: local profile topology');
  await write(f.root,'tests/.ssh/config.ts','// SERVICE_PASSWORD: local host topology');
  const safe='// SERVICE_PASSWORD uses a test harness.\n'+ordinaryContents.join('\n');
  await write(f.root,'tests/ordinary.ts',safe);
  const inventory=await collectCurationEvidence(f.root);clean(inventory);
  assert.equal(inventory.sensitiveExcluded,4);assert.deepEqual(inventory.files.map(f=>f.path),['AGENTS.md','README.md','src/store.ts','tests/ordinary.ts']);
  assert.ok(evidenceFor('SERVICE_PASSWORD',inventory).length);
});

for(const sampling of [false,true])test(`MCP importer excludes sensitive sources before ${sampling?'sampling and plan':'successful audit response'} through plugin dispatch`,async t=>{
  const f=await fixture(t);
  const blocked=['.npmrc','.git-credentials','.ssh/config','.aws/config','service-account.json','src/deploy.ts'];
  for(const file of blocked)await write(f.root,file,`SERVICE_PASSWORD=${marker}`);
  await write(f.root,'.ai-studio/runtime/memory/env.md',`SERVICE_PASSWORD=${marker}`);
  const server=createServer({projectRoot:f.root}),client=new Client({name:'f05-regression',version:'1'},{capabilities:sampling?{sampling:{}}:{}});
  const sampled=[];
  if(sampling)client.setRequestHandler(CreateMessageRequestSchema,async({params})=>{
    clean(params);const data=JSON.parse(params.messages[0].content.text);sampled.push(data);
    assert.deepEqual(data.repository.map(f=>f.path),['README.md']);assert.ok(data.sources.length);assert.ok(!data.sources.some(f=>f.path.endsWith('/env.md')));
    const audit=params.systemPrompt.includes('# AI Studio audit');const full=audit?null:analysisFor({input:data});
    return {role:'assistant',content:{type:'text',text:JSON.stringify(audit?{version:1,findings:[],inspectPaths:[],warnings:[]}:{classify:full.classify,migrate:full.migrate,verify:full.verify})},model:'synthetic',stopReason:'endTurn'};
  });
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
  const input={semantic:true,repositoryPaths:['README.md',...blocked]};
  for(const request of [
    {name:'prodero_plugin_action',arguments:{pluginId:'migrate_ai_studio',action:'audit',input}},
    {name:'prodero_plugin_migrate_ai_studio',arguments:{action:'audit',input}},
  ]){
    const response=await client.callTool(request);assert.notEqual(response.isError,true,JSON.stringify(response));clean(response);
    const result=response.structuredContent.result;
    const excluded=sampling?result.coverage.excluded:result.auditPackage.input.excluded;
    for(const file of blocked)assert.ok(excluded.some(e=>e.path===file));
    if(!sampling)assert.deepEqual(result.auditPackage.input.repository.map(f=>f.path),['README.md']);
  }
  assert.equal(sampled.length,sampling?4:0);
});

test('R05 exact authorization workflow enum is ordinary source, not a credential',()=>{
 const value='explicit_workflow_and_exact_preview_required';
 for(const source of [`authorization: '${value}'`,JSON.stringify({authorization:value}),`return { authorization: "${value}" };`]){
  assert.equal(hasSecret(source),false);assert.doesNotThrow(()=>assertNoSecrets({content:source}));
 }
 assert.doesNotThrow(()=>assertNoSecrets({authorization:value}));
 for(const source of [`authorization: '${value}_extra'`,`password: '${value}'`,`SERVICE_PASSWORD=${value}`,`authorization: '${value}'\nSERVICE_PASSWORD=synthetic_f05_credential_value`,`authorization: '${value}'\nNPM_TOKEN=${'npm_'+'A'.repeat(36)}`]){
  assert.equal(hasSecret(source),true);assert.throws(()=>assertNoSecrets({content:source}),/Potential credential/);
 }
});


test('PHP scope resolution is not a credential assignment',()=>{
 for(const value of ['Replaced direct SQL in api_token::assertIssuable with model queries.', 'password::validate()', 'authorization::check()']) {
  assert.equal(hasSecret(value),false);
  assert.doesNotThrow(()=>assertNoSecrets({content:value}));
 }
 for(const value of ['api_token: synthetic_scope_secret', 'api_token="synthetic_scope_secret"', 'api_token::assertIssuable; password=synthetic_scope_secret']) assert.equal(hasSecret(value),true);
});

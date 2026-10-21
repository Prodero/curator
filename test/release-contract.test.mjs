import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ListRootsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createServer} from '../dist/server.js';
import {PRODERO_VERSION,NEXT_RUNTIME_VERSION} from './helpers/runtime-version.mjs';
import {NpmReleaseSource,configuredReleaseSource,checkForUpdate,installLatest} from '../dist/core/update.js';
const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
test('CLI version/help, invalid input and missing roots fail before writes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-cli-contract-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const run=(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',env:{...process.env,PRODERO_RELEASE_SOURCE:'none'}});
 assert.equal(run('--version').stdout.trim(),PRODERO_VERSION);assert.equal(run('--help').status,0);
 for(const args of [['typo'],['init','--typo'],['init','--root'],['init','--root',root+'/missing'],['init','--root','.'],['init'],['mcp','--root',root+'/missing'],['status','unexpected'],['init','--root',root,'--root',root]]) { const r=run(...args);assert.notEqual(r.status,0,JSON.stringify(args));assert.equal(r.stdout,''); }
 assert.deepEqual(await fs.readdir(root),[]);
 assert.equal(run('init','--root',root).status,0);assert.equal(run('status',`--root=${root}`).status,0);
});
test('MCP roots reject absent, ambiguous, invalid and missing; explicit arguments cannot grant authority',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-roots-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const roots of [undefined,[],[{uri:pathToFileURL(root).href},{uri:pathToFileURL(path.dirname(root)).href}],[{uri:'https://example.org'}],[{uri:pathToFileURL(root+'/missing').href}]]){
  const server=createServer();const client=new Client({name:'root-test',version:'1'},{capabilities:roots===undefined?{}:{roots:{listChanged:false}}});
  if(roots!==undefined)client.setRequestHandler(ListRootsRequestSchema,async()=>({roots}));
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  try{const rejected=await client.callTool({name:'prodero_initialize',arguments:{}});assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected.content),/root|workspace/i);assert.deepEqual(await fs.readdir(root),[]);
   const explicit=await client.callTool({name:'prodero_status',arguments:{projectRoot:root}});if(roots?.length===2)assert.equal(explicit.structuredContent.project.root,root);else assert.equal(explicit.isError,true);
  }finally{await client.close();await server.close();}
 }
 const server=createServer({projectRoot:root});const client=new Client({name:'override',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 try{assert.equal((await client.callTool({name:'prodero_status',arguments:{}})).structuredContent.project.root,root);}finally{await client.close();await server.close();}
});
test('npm updates are read-only, honest offline/unpublished and dev staging requires opt-in',async()=>{
 assert.equal(configuredReleaseSource({PRODERO_LOCAL_RELEASE_CHECKOUT:'/not-used',PRODERO_RELEASE_MANIFEST:'/not-used'}).id,'npm');
 assert.equal(configuredReleaseSource({PRODERO_RELEASE_SOURCE:'none'}).id,'unconfigured');
 const source=new NpmReleaseSource(async url=>{assert.equal(url,'https://registry.npmjs.org/@prodero%2fcurator/latest');return new Response(JSON.stringify({version:NEXT_RUNTIME_VERSION}));});
 const check=await checkForUpdate(source);assert.equal(check.available,true);assert.equal(check.latest,NEXT_RUNTIME_VERSION);assert.equal(check.manualUpdateCommand,'prodero update');assert.equal(check.availableSchemaVersion,null);
 source.stage=()=>{throw new Error('must never stage');};assert.equal((await installLatest(source)).status,'manual-update');
 for(const [response,status] of [[()=>new Response('',{status:404}),'unavailable'],[()=>{throw new Error('private transport diagnostic');},'unavailable'],[()=>new Response('{"version":"invalid credential"}'),'invalid']]){
  const result=await checkForUpdate(new NpmReleaseSource(response));assert.equal(result.status,status);assert.equal(result.latest,null);assert.doesNotMatch(JSON.stringify(result),/private transport|invalid credential/);assert.ok(result.error);
 }
});

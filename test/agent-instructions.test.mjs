import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {AGENT_INSTRUCTIONS} from '../dist/core/agent-instructions.js';
import {AGENTS_BLOCK} from '../dist/core/templates.js';
import {createServer as createDevServer} from '../dist/server.js';
const exec=promisify(execFile);

async function connect(t,createServer){
 const server=createServer(),client=new Client({name:'instructions-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();});
 const tool=(await client.listTools()).tools.find(tool=>tool.name==='prodero_instructions_read');
 assert.ok(tool);assert.equal(tool._meta?.ui,undefined);assert.equal(tool.annotations.readOnlyHint,true);
 return async()=>{
  const result=await client.callTool({name:tool.name,arguments:{}});
  assert.notEqual(result.isError,true);
  assert.equal(result.content[0].text,result.structuredContent.instructions);
  return result.structuredContent;
 };
}

test('instructions follow the connected installation without project edits on update or runtime switch',async t=>{
 const root=await fs.realpath(await fs.mkdtemp('/tmp/prodero instructions package '));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {stdout}=await exec('npm',['pack','--ignore-scripts','--json','--cache',path.join(root,'npm-cache'),'--pack-destination',root]);
 const packed=JSON.parse(stdout)[0];assert.ok(packed.files.some(f=>f.path==='instructions/AGENTS.md'));
 await exec('tar',['-xzf',path.join(root,packed.filename),'-C',root]);
 const installed=path.join(root,'package');
 await fs.symlink(path.resolve('node_modules'),path.join(installed,'node_modules'));
 const {initializeProject}=await import(pathToFileURL(path.join(installed,'dist/core/project.js')).href);
 const {AGENT_INSTRUCTIONS_PATH,AGENTS_BLOCK:installedBlock}=await import(pathToFileURL(path.join(installed,'dist/core/templates.js')).href);
 const {createServer}=await import(pathToFileURL(path.join(installed,'dist/server.js')).href);
 assert.equal(AGENT_INSTRUCTIONS_PATH,path.join(installed,'instructions/AGENTS.md'));
 assert.equal(installedBlock,AGENTS_BLOCK,'project reference is identical for dev and package');
 assert.equal(await fs.readFile(AGENT_INSTRUCTIONS_PATH,'utf8'),AGENT_INSTRUCTIONS.trimEnd()+'\n');
 const project=path.join(root,'user project');await fs.mkdir(path.join(project,'.git'),{recursive:true});
 await fs.writeFile(path.join(project,'AGENTS.md'),'Keep my rules.\n');await initializeProject(project);
 const target=path.join(project,'AGENTS.md'),before=await fs.readFile(target,'utf8'),stamp=(await fs.stat(target)).mtimeMs;
 assert.ok(before.includes(AGENTS_BLOCK));assert.doesNotMatch(before,/prodero_prepare|prodero_skills|Before substantial work/);
 const readInstalled=await connect(t,createServer),readDev=await connect(t,createDevServer);
 assert.equal((await readInstalled()).path,AGENT_INSTRUCTIONS_PATH);
 assert.equal((await readInstalled()).instructions,AGENT_INSTRUCTIONS.trimEnd()+'\n');
 await fs.writeFile(AGENT_INSTRUCTIONS_PATH,AGENT_INSTRUCTIONS+'\nUpdated package guidance.\n');
 assert.match((await readInstalled()).instructions,/Updated package guidance/);
 assert.doesNotMatch((await readDev()).instructions,/Updated package guidance/);
 assert.notEqual((await readDev()).path,AGENT_INSTRUCTIONS_PATH);
 await initializeProject(project);
 assert.equal(await fs.readFile(target,'utf8'),before);
 assert.equal((await fs.stat(target)).mtimeMs,stamp);
});

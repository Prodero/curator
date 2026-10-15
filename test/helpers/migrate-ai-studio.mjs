import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginRegistry } from '../../dist/plugins/registry.js';
import { createPluginContext } from '../../dist/plugins/context.js';
import { initializeProject } from '../../dist/core/project.js';
const pluginId='migrate_ai_studio';
export async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-migration-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'.git'));await initializeProject(root);
  for(const dir of ['.ai-studio/runtime/memory','.ai-studio/runtime/handoffs','.ai-studio/runtime/epic-runs','src']) await fs.mkdir(path.join(root,dir),{recursive:true});
  await fs.writeFile(path.join(root,'README.md'),'The store uses atomic writes.\nRun tests before storage changes.\n');
  await fs.writeFile(path.join(root,'src/store.ts'),'export const atomicWrites = true;\nexport const oldTransport = false;\n');
  await fs.writeFile(path.join(root,'.ai-studio/runtime/memory/project-memory.md'),'The store uses atomic writes.\nRun tests before storage changes.\nTo verify storage: create a fixture, write a record, then check the persisted bytes.\nThe old transport is enabled.\nUnverified claim about a retired service.\nThe store uses atomic writes.\nPrivacy and authorization:\nAutomatic matching requires one exact sender.\n');
  await fs.writeFile(path.join(root,'.ai-studio/runtime/memory/durable.md'),'# Durable memory\n\n## Storage safety\n\nDecision:\nThe store must use atomic writes.\n\nReason:\nPartial writes can corrupt durable state.\n\nImpact:\nEPIC-001 and TASK-002 require storage tests before changing persistence behavior.\n\nConstraint:\nNever bypass the atomic writer or depend on `.ai-studio/runtime/memory/durable.md`.\n');
  await fs.writeFile(path.join(root,'.ai-studio/runtime/handoffs/task.md'),'Task 412: agent beta handed off to agent gamma.\n');
  await fs.writeFile(path.join(root,'.ai-studio/runtime/epic-runs/output.log'),'raw generated execution output\n');
  await fs.writeFile(path.join(root,'.ai-studio/runtime/memory/credentials.md'),'api_key = sk-fake012345678901234567890123456789\n');
  const registry=new PluginRegistry();assert.equal(registry.has(pluginId),true,JSON.stringify(registry.diagnostics));
  const ctx=createPluginContext(registry,pluginId,root);
  const call=(action,input={},context=ctx)=>registry.dispatch(pluginId,action,context,input);
  return {root,registry,ctx,call};
}
export function analysisFor(packet) {
  const source=packet.input.sources.find(f=>f.path.endsWith('project-memory.md'));
  const repo=packet.input.repository.find(f=>f.path==='README.md');
  const old=packet.input.repository.find(f=>f.path==='src/store.ts')??repo;
  const ref=(file,line)=>({path:file.path,sha256:file.sha256,startLine:line,endLine:line});
  const classes=['durable_project_knowledge','project_instruction','skill_candidate','contradicted','uncertain','duplicate'];
  const contents=['The store uses atomic writes.','Run tests before storage changes.','1. Create a fixture.\n2. Write a record.\n3. Check the persisted bytes.','The old transport is enabled.','Unverified retired service.','The store uses atomic writes.'];
  const titles=['Atomic storage','Storage verification rule','Verify storage persistence','Old transport','Retired service','Duplicate storage fact'];
  const items=classes.map((classification,n)=>({id:`item-${n}`,classification,source:[ref(source,n+1)],repositoryEvidence:classification==='uncertain'?[]:[ref(n===3?old:repo,n===1?2:1)],reason:n===3?'Current code disables the legacy transport.':'Supported by supplied evidence.',title:titles[n],content:contents[n],scope:'global',scopeRef:null,category:n===1?'instruction':'decision',skill:n===2?{title:titles[n],description:'Verify durable storage behavior.',scope:'storage',triggers:['storage changes'],references:['src/store.ts'],relatedKnowledge:[],content:contents[n]}:null,include:n<3,activateSkill:false,warnings:[]}));
  const handoff=packet.input.sources.find(f=>f.path.endsWith('task.md'));
  if(handoff)items.push({id:'history',classification:'temporary_execution_history',source:[ref(handoff,1)],repositoryEvidence:[],reason:'Temporary handoff mechanics.',title:'Task handoff',content:'',scope:'global',scopeRef:null,category:'state',skill:null,include:false,activateSkill:false,warnings:[]});
  return {audit:{version:1,findings:['Durable facts, one procedure, obsolete transport and runtime noise found.'],inspectPaths:[],warnings:[]},classify:{version:1,items:items.map(({id,classification,source,repositoryEvidence,reason})=>({id,classification,source,repositoryEvidence,reason}))},migrate:{version:1,items},verify:{version:1,reviewedItemIds:items.map(i=>i.id),issues:[]}};
}

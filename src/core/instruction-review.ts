import {applicabilityKey} from "./applicability.js";
import { loadMemoryCatalog } from './memory-index.js';
import { planAssistedSync } from './knowledge-engine.js';
import { exactKnowledge } from './semantic-safety.js';
import { INTELLIGENCE_LIMITS, type IntelligenceProvider } from './intelligence.js';
import { withSyncLock, recoverSyncTransaction, commitSyncTransaction, fileHash, safeProjectPath } from './sync-transaction.js';
import { listCheckpoints } from './storage.js';
import { sortableId } from './ids.js';
import { parseKnowledge } from './memory.js';
import { buildIndex } from './index.js';
import { estimateTokens, knowledgeText } from './telemetry.js';
import type { Checkpoint, OmittedContextCandidate } from './types.js';

/** A disposable reference to the exact selection, never a second instruction store. */
export interface InstructionSelection { root:string; sessionId:string; task:string|null; omitted:OmittedContextCandidate[]; selectedIds:string[] }
export async function reviewOmittedInstructions(selection:InstructionSelection, offset=0, criticalOnly=false) {
 const catalog=await loadMemoryCatalog(selection.root);
 const omitted=selection.omitted.filter(i=>!criticalOnly||i.priority==='critical');
 const page=omitted.slice(offset,offset+12);
 const items=await Promise.all(page.map(async selected=>{
  const summary=catalog.summaries.find(i=>i.id===selected.id);
  if(!summary)return {selection:selected,item:null,missing:true};
  const item=await catalog.load(summary.id);
  return {selection:selected,item:{...item,layer:summary.layer,revision:catalog.originalHashes.get(item.id)!},missing:false};
 }));
 return {root:selection.root,sessionId:selection.sessionId,task:selection.task,items,offset,total:omitted.length,nextOffset:offset+page.length<omitted.length?offset+page.length:null,criticalOnly,
  counts:{critical:selection.omitted.filter(i=>i.priority==='critical').length,normal:selection.omitted.filter(i=>i.priority!=='critical').length}};
}
// Offline optimization only removes exact duplicates. It uses the same structured
// action validator as assisted instruction policy consolidation, without inference.
const duplicateProvider:IntelligenceProvider={name:'deterministic-duplicates',
 distill:async()=>({output:{candidates:[]}}),reconcile:async()=>{throw Error('Not used');},
 audit:async({items})=>{
  const groups=new Map<string,string[]>();
  for(const m of items){const key=JSON.stringify([applicabilityKey(m),m.contextPolicy,m.authority,m.priority,exactKnowledge(m.content)]);groups.set(key,[...(groups.get(key)??[]),m.id]);}
  const actions=[...groups.values()].flatMap(ids=>ids.slice(1).map(id=>({action:'NO_CHANGE',sources:[ids[0],id],canonical:null,reason:'Exact duplicate instruction with identical authority and scope.'})));
  return {output:{status:actions.length?'changes_proposed':'clean',issues:[],actions}};
 }};
export async function previewInstructionOptimization(selection:InstructionSelection, provider?:IntelligenceProvider) {
 return withSyncLock(selection.root,async()=>{
  await recoverSyncTransaction(selection.root);
  const catalog=await loadMemoryCatalog(selection.root);
  const shadowed=new Set(catalog.summaries.filter(i=>['active','disputed'].includes(i.status)).flatMap(i=>i.supersedes));
  const ids=[...new Set([...selection.omitted.map(i=>i.id),...selection.selectedIds])];
  const eligible=ids.map(id=>catalog.summaries.find(m=>m.id===id)).filter(m=>m?.category==='instruction' && m.status==='active' && !shadowed.has(m.id) && !m.relations.some(r=>r.type==='contradicts'));
  // One bounded same-authority area per click, including loaded policies when useful.
  const groups=new Map<string,NonNullable<typeof eligible[number]>[]>();
  for(const m of eligible)if(m){const key=JSON.stringify([m.layer,applicabilityKey(m),m.contextPolicy,m.authority,m.priority]);groups.set(key,[...(groups.get(key)??[]),m]);}
  const group=[...groups.values()].filter(g=>g.length>1).sort((a,b)=>Number(b[0].priority==='critical')-Number(a[0].priority==='critical')||b.length-a.length)[0]??[];
  const area=group.slice(0,INTELLIGENCE_LIMITS.auditItems);
  const checks=await Promise.all(area.map(async m=>({path:m.relativePath,hash:await fileHash(await safeProjectPath(selection.root,m.relativePath))})));
  const plan=await planAssistedSync(selection.root,[],provider??duplicateProvider,new Date(),new Set(),{instructionIds:area.map(m=>m.id)});
  const after=plan.writes.map(w=>({...parseKnowledge(w.after!,w.path),path:w.path}));
  const before=plan.knowledgeBefore;
  const beforeTokens=before.reduce((n,m)=>n+estimateTokens(knowledgeText(m)),0);
  const afterTokens=after.filter(m=>m.status==='active').reduce((n,m)=>n+estimateTokens(knowledgeText(m)),0);
  if(plan.writes.length && (afterTokens>beforeTokens || after.filter(m=>m.status==='active').length>=before.length)) throw new Error('Optimization did not reduce instruction pressure. No changes were saved.');
  return {root:selection.root,plan,checks,view:{before,after,beforeTokens,afterTokens,reducedBy:before.length-after.filter(m=>m.status==='active').length,
   repository:after.some(m=>m.path.startsWith('memory/')),mode:provider?'assisted':'deterministic',
   notice:plan.writes.length?'Review the preserved clauses and scope before applying.':provider?'No safe consolidation found in this bounded area. Edit obsolete or overly broad instructions individually.':'No exact duplicates found. Semantic policy consolidation requires MCP sampling support; individual editing remains available.',
   inspected:area.length,remaining:Math.max(0,eligible.length-area.length)}};
 },{waitMs:5000});
}
export async function applyInstructionOptimization(preview:Awaited<ReturnType<typeof previewInstructionOptimization>>) {
 return withSyncLock(preview.root,async()=>{
  await recoverSyncTransaction(preview.root);
  for(const check of preview.checks)if(await fileHash(await safeProjectPath(preview.root,check.path))!==check.hash)throw new Error('Instructions changed. Optimize again before applying.');
  const plan=preview.plan;if(!plan.writes.length)throw new Error('No consolidation changes to apply.');
  const id=sortableId('chk');const r=plan.result;
  const checkpoint:Checkpoint={id,createdAt:new Date().toISOString(),previousCheckpoint:(await listCheckpoints(preview.root)).at(-1)?.id??null,sessions:[],consolidation:'assisted-v1',intelligence:plan.intelligence,reasoning:plan.reasoning,knowledgeBefore:plan.knowledgeBefore,createdMemory:[],updatedMemory:r.updated,supersededMemory:r.superseded,duplicateMemory:r.duplicates,conflicts:r.conflicts,summary:{sessions:0,candidates:0,created:0,consolidated:r.consolidated.length,duplicates:r.duplicates.length,superseded:0,conflicts:0},note:'Explicit reviewed instruction optimization'};
  await commitSyncTransaction(preview.root,[...plan.writes,{path:`checkpoints/${id}.json`,before:null,after:JSON.stringify(checkpoint,null,2)+'\n'}],{policyMode:'exact'});
  await buildIndex(preview.root);
  return {checkpoint:id,reducedBy:preview.view.reducedBy};
 },{waitMs:5000});
}

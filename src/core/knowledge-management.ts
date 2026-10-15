import {applicabilitySchema,taskContextInputSchema,withApplicability,applicabilityLabel,buildTaskContext,evaluateApplicability} from "./applicability.js";
import { safeRelative } from "./plugin-files.js";
import { z } from 'zod';
import { loadMemoryCatalog } from './memory-index.js';
import { searchMemoryPage, forgetMemory } from './memory-operations.js';
import { promotionRecommendations } from './promotion.js';
import { assertNoSecrets } from './secrets.js';
import { assertEnglishProse } from './language.js';
import { renderKnowledge, parseKnowledge } from './memory.js';
import { buildIndex } from './index.js';
import { commitSyncTransaction, withSyncLock, recoverSyncTransaction } from './sync-transaction.js';
import { listCheckpoints } from './storage.js';
import { sortableId } from './ids.js';
import type { Checkpoint } from './types.js';

export const knowledgeQuerySchema = z.object({
 task:z.string().max(2000).optional(),taskContext:taskContextInputSchema.optional(),
 query: z.string().max(1000).default(''), layer: z.enum(['local','versioned']).optional(),
 category: z.enum(['principle','invariant','decision','constraint','lesson','state','instruction']).optional(),
 scope: z.enum(['global','project','path']).optional(), path: z.string().max(300).optional(),
 includeHistorical: z.boolean().default(false), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(12),
});
export const knowledgeMutationSchema = z.object({
 applicability:applicabilitySchema.optional(),
 id: z.string().regex(/^[a-zA-Z0-9_-]+$/), revision: z.string().regex(/^[a-f0-9]{64}$/),
 priority: z.enum(['critical','important','normal','contextual']).optional(),
 scope: z.enum(['global','module','task']).optional(), scopeRef: z.string().trim().max(300).nullable().optional(), scopeKind: z.enum(['path','topic']).nullable().optional(),
 action: z.enum(['edit','retire']), mode: z.enum(['local','repository-maintenance']).default('local'), approved: z.literal(true),
 title: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/).optional(), content: z.string().trim().min(1).max(10000).optional(), reason: z.string().trim().max(1000).optional(),
}).strict();
export async function knowledgeView(root: string, raw: z.input<typeof knowledgeQuerySchema> = {}, id?: string) {
 const options = knowledgeQuerySchema.parse(raw);
 if(options.scope === 'path') {
  if(!options.path?.trim()) throw new Error('Path filtering requires a repository-relative path.');
  options.path = safeRelative(options.path.trim().replace(/^\.\//, '').replace(/\/$/, ''));
 }
 const catalog = await loadMemoryCatalog(root);
 const current = catalog.summaries.filter(i => ['active','disputed'].includes(i.status));
 const recommendations = await promotionRecommendations(root);
 const page = await searchMemoryPage(root, options.query, {...options, includeShadowed:true});
 const detailSummary = id ? catalog.summaries.find(i=>i.id===id) : undefined;
 if(id && !detailSummary) throw new Error('Knowledge was not found. Refresh the list.');
 const detail = detailSummary ? { ...await catalog.load(detailSummary.id), layer:detailSummary.layer, revision:catalog.originalHashes.get(detailSummary.id)!, recommendation:recommendations.find(r=>r.id===id) } : null;
 if(detail){Object.assign(detail,{appliesTo:applicabilityLabel(detail),...(options.task||options.taskContext?{applicabilityDecision:evaluateApplicability(detail,buildTaskContext(options.task,options.taskContext,catalog.summaries.flatMap(i=>i.applicability?.kind==='scoped'?i.applicability.subsystems??[]:[]),catalog.summaries.flatMap(i=>i.applicability?.kind==='scoped'?i.applicability.paths??[]:[])),detail.contextPolicy==='required'?'required':'relevant')}: {})});}
 return { root, ...page, options, detail, counts:{local:current.filter(i=>i.layer==='local').length,versioned:current.filter(i=>i.layer==='versioned').length,recommended:recommendations.filter(r=>r.recommended).length},
 matches:page.matches.map(({content,...item})=>({...item,contentPreview:content.slice(0,240),recommendation:recommendations.find(r=>r.id===item.id)})) };
}
/** Explicit editorial maintenance, preserving identity/topology and existing checkpoint history. */
export async function mutateKnowledge(root: string, raw: z.input<typeof knowledgeMutationSchema>) {
 assertNoSecrets(raw);
 const input=knowledgeMutationSchema.parse(raw);
 assertEnglishProse([input.title,input.content,input.reason], 'Knowledge maintenance');
 if(input.action!=='edit' && [input.priority,input.scope,input.scopeRef,input.scopeKind,input.applicability].some(v=>v!==undefined)) throw new Error('Classification changes require an instruction edit.');
 if(input.mode==='local' && input.action==='retire') return forgetMemory(root,{id:input.id,revision:input.revision,reason:input.reason});
 return withSyncLock(root,async()=>{
  await recoverSyncTransaction(root);
  const catalog=await loadMemoryCatalog(root); const summary=catalog.summaries.find(i=>i.id===input.id);
  if(!summary) throw new Error('Knowledge was not found. Refresh the list.');
  if((summary.layer==='versioned') !== (input.mode==='repository-maintenance')) throw new Error('Versioned Knowledge requires explicit repository-maintenance approval. Local operations cannot modify repository knowledge.');
  const item=await catalog.load(input.id); const before=catalog.originalHashes.get(input.id)!;
  if(before!==input.revision) throw new Error('Knowledge changed since it was opened. Reload and review the current revision.');
  if(!['active','disputed'].includes(item.status)) throw new Error('Historical knowledge cannot be edited or reopened.');
  if(input.action==='edit' && (input.title===undefined || input.content===undefined)) throw new Error('Editing requires a title and complete statement.');
  const classification = {priority:item.priority,scope:item.scope,scopeRef:item.scopeRef,scopeKind:item.scopeKind};
  if(input.priority!==undefined || input.scope!==undefined || input.scopeRef!==undefined || input.scopeKind!==undefined) {
   if(item.category!=='instruction' || input.action!=='edit') throw new Error('Classification edits apply only to instruction edits.');
   classification.priority=input.priority??item.priority;
   classification.scope=input.scope??item.scope;
   classification.scopeRef=input.scopeRef===undefined?item.scopeRef:input.scopeRef;
   classification.scopeKind=input.scopeKind===undefined?item.scopeKind:input.scopeKind??undefined;
   if(classification.scope==='global'){classification.scopeRef=null;classification.scopeKind=undefined;}
   else if(!classification.scopeRef) throw new Error('Scoped instructions require a scope reference.');
   if(classification.scopeKind==='path') classification.scopeRef=safeRelative(classification.scopeRef!);
  }
  if(input.action==='edit' && !input.applicability && item.title===input.title && item.content===input.content && Object.entries(classification).every(([k,v])=>item[k as keyof typeof item]===v)) return {item,unchanged:true};
  const now=new Date(); const checkpointId=sortableId('chk',now);
  const updated={...item, ...classification, title:input.action==='edit'?input.title!:item.title, content:input.action==='edit'?input.content!:item.content,
   status:input.action==='retire'?'deprecated' as const:item.status,updatedAt:now.toISOString(),
   derivedFrom:[...new Set([...item.derivedFrom,`user:maintenance:${checkpointId}`])],
   evidence:[...(item.evidence??[]),{kind:'user_instruction' as const,ref:input.reason||`Explicit ${input.mode} ${input.action}`}],};
  if(input.applicability)Object.assign(updated,withApplicability(updated,input.applicability),{version:3});
  if(!input.applicability && item.applicability?.kind!=='legacy' && [input.scope,input.scopeRef,input.scopeKind].some(v=>v!==undefined) && (classification.scope!==item.scope||classification.scopeRef!==item.scopeRef||classification.scopeKind!==item.scopeKind)) {
   throw new Error('Use structured applicability to change this record’s work boundary; its legacy scope fields are a projection.');
  }
  const after=renderKnowledge(updated);parseKnowledge(after,summary.filename);
  const checkpoint:Checkpoint={id:checkpointId,createdAt:now.toISOString(),previousCheckpoint:(await listCheckpoints(root)).at(-1)?.id??null,sessions:[],consolidation:'not-performed',knowledgeBefore:[item],createdMemory:[],updatedMemory:[item.id],supersededMemory:[],duplicateMemory:[],conflicts:[],summary:{sessions:0,candidates:0,created:0,consolidated:0,duplicates:0,superseded:0,conflicts:0},note:`Explicit ${input.mode} ${input.action}: ${item.id}`};
  await commitSyncTransaction(root,[{path:summary.relativePath,before,after},{path:`checkpoints/${checkpointId}.json`,before:null,after:JSON.stringify(checkpoint,null,2)+'\n'}], {policyMode:'exact'});
  await buildIndex(root);
  return {item:await (await loadMemoryCatalog(root)).load(updated.id),checkpoint:checkpointId,layer:summary.layer};
 });
}

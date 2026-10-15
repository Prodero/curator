import { reconcileCandidate, reconciliationSignal, actionClassification } from './reconciliation.js';
import { INTELLIGENCE_LIMITS, type IntelligenceProvider, type KnowledgeCandidate } from './intelligence.js';
import fs from 'node:fs/promises';
import { summarizeSessionMemory } from './telemetry.js';
import { z } from 'zod';
import { readSession, renderSession, serializeObservation, validateEntries, OBSERVATION_SECTIONS } from './sessions.js';
import { exactKnowledge } from './semantic-safety.js';
import { sessionCandidates, candidateReviewSignals } from './consolidation.js';
import { discoverSessions } from './session-index.js';
import { loadMemoryCatalog } from './memory-index.js';
import { listProjectSkills } from './skills.js';
import { readConfig, checkedDataPath, sha256, writeFileAtomic } from './storage.js';
import { withSyncLock, recoverSyncTransaction } from './sync-transaction.js';
import type { SessionObservationInput, SessionObservationType } from './types.js';

export const sessionReviewMutationSchema = z.object({
 sessionId: z.string().regex(/^sess_[a-zA-Z0-9_]+$/), revision: z.string().regex(/^[a-f0-9]{64}$/),
 action: z.enum(['edit','discard','discard-all']), id: z.string().max(300).optional(),
 content: z.string().trim().min(1).max(10000).optional(), title: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/).optional(),
 type: z.enum(['decision','lesson','discovery','state_change','global_instruction_candidate','skill_candidate']).optional(),
 scope: z.enum(['global','module','task']).optional(), scopeRef: z.string().max(300).nullable().optional(), scopeKind: z.enum(['path','topic']).nullable().optional(),
}).strict();

async function reviewLocked(root: string, sessionId: string, provider?: IntelligenceProvider) {
 provider = (await readConfig(root))?.knowledgeEngine?.mode === 'assisted' ? provider : undefined;
 const session = await readSession(root,sessionId);
 const file = await checkedDataPath(root,'sessions',session.path);
 const revision = sha256(await fs.readFile(file,'utf8'));
 const discovery = await discoverSessions(root);
 const consolidated = discovery.processedSessionPaths.has(session.path);
 const editable = session.status === 'closed' && !consolidated;
 const catalog = await loadMemoryCatalog(root);
 const skills = consolidated ? await listProjectSkills(root) : [];
 const positions = Object.entries(session.sections).flatMap(([section, rows]) => rows.filter(row=>row.trim()).map((_,index)=>({section,index})));
 const candidates = sessionCandidates(session);
 // Child remember sessions keep their own checkpoints and observation evidence. The
 // parent link is canonical session provenance, never a second learning store.
 const sources = new Set([sessionId,...discovery.sessions.filter(s=>s.parentSessionId===sessionId).map(s=>s.id)]);
 const produced = await Promise.all(catalog.summaries.filter(m=>m.sourceSessions.some(id=>sources.has(id))).map(async m=>({...await catalog.load(m.id),layer:m.layer})));
 const items = await Promise.all(candidates.map(async(candidate,index)=>{
  const position = positions[index];
  const type = Object.entries(OBSERVATION_SECTIONS).find(([,section])=>section===position.section)![0] as SessionObservationType;
  const entry: SessionObservationInput = { type, applicability:candidate.applicability, title:candidate.title, content:candidate.content, scopeHint:candidate.scope,
   ...(candidate.scopeRef ? {scopeRef:candidate.scopeRef}:{}), ...(candidate.scopeKind ? {scopeKind:candidate.scopeKind}:{}),
   importanceHint:candidate.priority,categoryHint:candidate.category,description:candidate.description,triggers:candidate.triggers,
   proposedReason:candidate.proposedReason,supersedes:candidate.supersedes,relations:candidate.relations };
  const related = await Promise.all(catalog.selectRelated({...candidate,explicitIds:candidate.supersedes}).map(item=>catalog.load(item.id)));
  let signals = candidateReviewSignals(candidate,related);
  if (!consolidated && provider && index < INTELLIGENCE_LIMITS.candidatesPerBatch && related.length && !candidate.skill && !candidate.instructionCandidate) {
   const evidence: KnowledgeCandidate = {...candidate,id:`candidate_review_${index}`,kind:'knowledge',sources:[candidate.derivedFrom],evidence:[{source:candidate.derivedFrom,quote:candidate.content}]};
   try {
    const action = await reconcileCandidate(evidence,related,provider);
    signals = action.sources.filter(id=>id!==evidence.id).map(id=>reconciliationSignal(actionClassification(action),related.find(m=>m.id===id)));
   } catch { /* Optional review retains neutral offline signals; Sync still validates its plan. */ }
  }
  try { validateEntries([entry]); } catch(error) { signals.push({kind:'validation',detail:error instanceof Error?error.message:String(error),severity:'info',requiresReview:true}); }
  const outputs = consolidated ? [...produced.filter(m=>m.derivedFrom.includes(candidate.derivedFrom)), ...related.filter(m=>!produced.some(p=>p.id===m.id) && exactKnowledge(m.content)===exactKnowledge(candidate.content)).map(m=>({...m,layer:catalog.summaries.find(s=>s.id===m.id)!.layer}))] : [];
  return {id:candidate.derivedFrom,type,title:candidate.title,content:candidate.content,applicability:candidate.applicability,scope:candidate.scope,scopeRef:candidate.scopeRef,scopeKind:candidate.scopeKind,
   signals:consolidated ? outputs.filter(m=>m.status==='disputed').map(m=>reconciliationSignal('potential_conflict',m)) : signals,
   outputs,skills:skills.filter(s=>s.derivedFrom.includes(candidate.derivedFrom)),entry,position};
 }));
 items.sort((a,b)=>Number(b.signals.some(s=>s.requiresReview))-Number(a.signals.some(s=>s.requiresReview)));
 const represented = new Set(items.flatMap(i=>i.outputs.map(o=>o.id)));
 const knowledge = await Promise.all(produced.filter(m=>!represented.has(m.id)).map(async m=>({...m,
  signals:[
   ...(m.status==='disputed' ? [reconciliationSignal('potential_conflict')] : []),
   ...await Promise.all(m.supersedes.filter(id=>catalog.summaries.some(s=>s.id===id)).map(async id=>{
    const previous=await catalog.load(id);
    return reconciliationSignal('state_transition',previous);
   })),
  ],
 })));

 knowledge.sort((a,b)=>Number(b.signals.some(s=>s.requiresReview))-Number(a.signals.some(s=>s.requiresReview))||a.id.localeCompare(b.id));
 const needsReview = [...items,...knowledge].filter(i=>i.signals.some(s=>s.requiresReview)).length;
 return {root,sessionId,revision,status:session.status,editable,consolidated,items,knowledge,
  learned:{...summarizeSessionMemory(session),syncState:consolidated?"synchronized":"pending-auto-sync",synchronization:null},
  summary:{total:items.length+knowledge.length,localKnowledge:knowledge.filter(m=>m.layer==='local').length,versionedKnowledge:knowledge.filter(m=>m.layer==='versioned').length,needsReview,automatic:items.length+knowledge.length-needsReview}};
}
export async function reviewSessionKnowledge(root:string,sessionId:string,provider?:IntelligenceProvider) {
 return withSyncLock(root,async()=>{await recoverSyncTransaction(root);return reviewLocked(root,sessionId,provider);},{waitMs:5000});
}
export async function mutateSessionKnowledge(root:string,raw:z.input<typeof sessionReviewMutationSchema>,provider?:IntelligenceProvider) {
 const input=sessionReviewMutationSchema.parse(raw);
 return withSyncLock(root,async()=>{
  await recoverSyncTransaction(root);
  const view=await reviewLocked(root,input.sessionId);
  if(!view.editable)throw new Error('This session has already synchronized or is still active. Use Knowledge to revise durable items; session history cannot be rewritten.');
  if(view.revision!==input.revision)throw new Error('Session knowledge changed. Reload before applying changes. Your draft has not been saved.');
  const session=await readSession(root,input.sessionId);
  if(input.action==='discard-all') for(const section of Object.keys(session.sections) as Array<keyof typeof session.sections>) session.sections[section]=[];
  else {
   const item=view.items.find(i=>i.id===input.id);if(!item)throw new Error('Session observation was not found. Reload the review.');
   const section=item.position.section as keyof typeof session.sections;
   if(input.action==='discard')session.sections[section].splice(item.position.index,1);
   else {
    if(input.content===undefined)throw new Error('Editing requires the complete observation content.');
    const entry={...item.entry,content:input.content,title:input.title??item.title,type:input.type??item.type,
     scopeHint:input.scope??item.scope,scopeRef:input.scopeRef===undefined?item.entry.scopeRef:input.scopeRef??undefined,
     scopeKind:input.scopeKind===undefined?item.entry.scopeKind:input.scopeKind??undefined};
    if(item.entry.applicability && item.entry.applicability.kind!=='legacy' && [input.scope,input.scopeRef,input.scopeKind].some(v=>v!==undefined) && (entry.scopeHint!==item.scope||entry.scopeRef!==item.entry.scopeRef||entry.scopeKind!==item.entry.scopeKind))throw new Error('Structured work boundaries are preserved when editing an observation.');
    if(entry.scopeHint==='global'){entry.scopeRef=undefined;entry.scopeKind=undefined;}
    if(entry.scopeHint==='module'&&!entry.scopeRef?.trim())throw new Error('Module scope requires a scope reference.');
    if(entry.type!==item.type) {
     entry.categoryHint=({decision:'decision',lesson:'lesson',discovery:'state',state_change:'state',global_instruction_candidate:'instruction',skill_candidate:'instruction'} as const)[entry.type];
     if(entry.type==='global_instruction_candidate'){entry.applicability=undefined;entry.scopeHint='global';entry.scopeRef=undefined;entry.scopeKind=undefined;}
    }
    validateEntries([entry]);
    const id=item.id.split('#')[1];
    if(!/^obs_[a-zA-Z0-9_]+$/.test(id))throw new Error('Legacy observation identities are read-only. Record a corrected observation in a new session.');
    const rendered=serializeObservation(id,entry);
    if(OBSERVATION_SECTIONS[entry.type]===section)session.sections[section][item.position.index]=rendered;
    else {session.sections[section].splice(item.position.index,1);session.sections[OBSERVATION_SECTIONS[entry.type]].push(rendered);}
   }
  }
  session.updatedAt=new Date().toISOString();
  const target=await checkedDataPath(root,'sessions',session.path);
  if(sha256(await fs.readFile(target,'utf8'))!==view.revision)throw new Error('Session changed during review. Reload before saving.');
  await writeFileAtomic(target,renderSession(session,session.sections));
  // Discovery verifies file stamps and content hashes, rebuilding derived state on change.
  return reviewLocked(root,input.sessionId,provider);
 },{waitMs:5000});
}

import { assertSafeCurationData } from './curation-evidence.js';
import { materializeSemanticPlan, type SemanticTypedPlan } from './curation-semantic-contract.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { checkedDataPath, ensureDataDirectory, writeFileAtomic, sha256, listCheckpoints } from './storage.js';
import { loadMemoryCatalog } from './memory-index.js';
import { sealRevision, validateRevision, deriveDependencies, curationSelectionHash, deterministicBaseline, type ReviewRevision } from './curation-revision.js';
import { withSyncLock, ownsSyncLock } from './sync-transaction.js';
import { sortableId } from './ids.js';
import { planKnowledgeCuration, validateCurationPlan, curationReviewEntries, type CurationPlan } from './knowledge-curation.js';
import { clarificationStateSchema, analysisOutcome, projectCurationReview, type ReviewDecision, type ReviewUnit, type ReviewState } from './curation-review-state.js';
export { projectCurationReview } from './curation-review-state.js';
export type { ReviewDecision, ReviewUnit } from './curation-review-state.js';

// Read legacy v1 snapshots; new v2 snapshots seal a typed immutable revision.
export interface CurationReviewSnapshot {
  version: 1 | 2 | 3; reviewId: string; project: string; projectIdentity: string; planHash: string;
  revision?: ReviewRevision;
  createdAt: string; plan: CurationPlan; units: ReviewUnit[]; snapshotHash: string;
}
export type CurationReviewState = ReviewState;
export interface CurationReview { snapshot: CurationReviewSnapshot; state: ReviewState; }
export const REVIEW_RETENTION = { maxCount: 32, maxAgeMs: 7*24*60*60*1000, maxBytes: 8*1024*1024, maxEvents: 2048 };
const directory = 'local/curation-reviews';
const idPattern = /^review_[a-zA-Z0-9_]+$/;
const hash = (value: unknown) => sha256(JSON.stringify(value));
export class CurationReviewError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
const fail = (code: string, message: string): never => { throw new CurationReviewError(code, message); };
const decisionSchema = z.record(z.enum(['current', 'suggested', 'deferred']));
const legacySchema = z.object({ revision: z.number().int().nonnegative(), snapshotHash: z.string(), decisions: decisionSchema }).strict();
const eventSchema = z.object({
  revision: z.number().int().positive(), at: z.string().datetime(),
  kind: z.enum(['decide', 'defer_issue', 'defer_change', 'pause_review', 'resume_review', 'reopen_issue']),
  decisions: decisionSchema, previousHash: z.string(), hash: z.string(),
}).strict();
const journalSchema = z.object({
  version: z.literal(2), projectIdentity: z.string(), snapshotHash: z.string(),
  base: z.object({ revision: z.number().int().nonnegative(), decisions: decisionSchema, paused: z.boolean(), origin: z.enum(['new', 'legacy_v1', 'inherited']), inheritedFrom: z.array(z.string()), pauseUpdatedAt:z.string().datetime().optional(), analysis: z.enum(['complete','pending','failed']).optional(), clarifications: z.record(z.object({id:z.string(),basisHash:z.string(),sourceIds:z.array(z.string()),state:clarificationStateSchema}).strict()).optional() }).strict(),
  events: z.array(eventSchema).max(REVIEW_RETENTION.maxEvents),
}).strict();
type Journal = z.infer<typeof journalSchema>;
type EventKind = z.infer<typeof eventSchema>['kind'];
export function reviewUnits(plan:CurationPlan):ReviewUnit[] {
  const remaining=new Set(plan.proposals.map(p=>p.id)), units:ReviewUnit[]=[];
  while(remaining.size){
    const ids=new Set([remaining.values().next().value!]);
    let added=true;
    while(added){added=false;for(const p of plan.proposals){
      const linked=[p.id,...(p.consolidationSources??[]),...plan.proposals.filter(q=>q.outputs.some(o=>p.outputs.some(v=>v.id===o.id))).map(q=>q.id)];
      if(linked.some(id=>ids.has(id)))for(const id of linked)if(!ids.has(id)){ids.add(id);added=true;}
    }}
    const proposalIds=[...ids].sort(), proposals=proposalIds.map(id=>plan.proposals.find(p=>p.id===id)!);
    if(proposals.some(p=>!p))fail('invalid_review','Review contains an unknown dependency.');
    units.push({id:`item_${hash(proposalIds).slice(0,24)}`,proposalIds,applicable:proposals.every(p=>p.changes.length>0&&!p.attention.length&&p.outputs.every(o=>o.applicability?.kind!=='unresolved')),attention:proposals.some(p=>p.attention.length>0)});
    for(const id of ids)remaining.delete(id);
  }
  return units;
}

/** Presentation prose and whole-plan hashes are not issue identity. */
export function reviewUnitBasis(plan: CurationPlan, unit: ReviewUnit) {
  return hash(unit.proposalIds.map(id => plan.proposals.find(p => p.id === id)!).map(p => ({ source: p.sourceId, revision: p.revision,
    issueBasis: p.issueBasis ?? [], relations: p.before.relations ?? [],
    evidence: (p.investigation?.evidence ?? []).map(e => [e.path, e.revision]).sort(),
  })).sort((a,b) => a.source.localeCompare(b.source)));
}
/** Compatibility for snapshots/checkpoints sealed before basis metadata existed.
 * This never changes an Apply planHash or grants selection on a new snapshot. */
function legacyPlanHash(plan: CurationPlan) {
  const {planId,...body}=plan;
  return hash({...body,proposals:plan.proposals.map(({issueBasis,...proposal})=>proposal)});
}
function sameUnitBasis(previous: CurationPlan, current: CurationPlan, old: ReviewUnit, unit: ReviewUnit) {
  if(reviewUnitBasis(previous,old)===reviewUnitBasis(current,unit))return true;
  const adapted=structuredClone(previous);
  for(const id of old.proposalIds){
    const before=adapted.proposals.find(p=>p.id===id)!, after=current.proposals.find(p=>p.id===id)!;
    if(before.issueBasis)continue;
    const refs=(after.issueBasis??[]).map(ref=>({id:ref.id,revision:previous.proposals.find(p=>p.id===ref.id)?.revision??(previous.fingerprint===current.fingerprint?ref.revision:'unknown-legacy-basis')}));
    before.issueBasis=refs;
  }
  return reviewUnitBasis(adapted,old)===reviewUnitBasis(current,unit);
}
function stateFrom(snapshot: Pick<CurationReviewSnapshot,'snapshotHash'|'plan'|'units'>, journal: Pick<Journal,'base'|'events'>): ReviewState {
  const decisions = { ...journal.base.decisions };
  let revision = journal.base.revision, paused = journal.base.paused;
  let previousHash = hash(journal.base);
  for (const event of journal.events) {
    const { hash: eventHash, ...body } = event;
    if (event.revision !== revision + 1 || event.previousHash !== previousHash || eventHash !== hash(body)) fail('invalid_review', 'Review decision history is invalid.');
    if (event.kind === 'pause_review' || event.kind === 'resume_review') {
      if (Object.keys(event.decisions).length) fail('invalid_review', 'Invalid review control event.');
      paused = event.kind === 'pause_review';
    } else {
      for (const [id, choice] of Object.entries(event.decisions)) {
        const unit = snapshot.units.find(u => u.id === id);
        if (!unit || event.kind === 'defer_issue' && analysisOutcome(snapshot.plan, unit) !== 'unresolved' || event.kind === 'defer_change' && analysisOutcome(snapshot.plan, unit) !== 'proposed' || event.kind !== 'decide' && choice !== 'deferred') fail('invalid_review', 'Invalid review decision event.');
      }
      if(event.kind==='reopen_issue')for(const id of Object.keys(event.decisions))delete decisions[id];else Object.assign(decisions, event.decisions);
    }
    revision = event.revision; previousHash = eventHash;
  }
  if (Object.keys(decisions).some(id => !snapshot.units.some(u => u.id === id))) fail('invalid_review', 'Unknown review decision.');
  const items: ReviewState['items'] = {};
  for (const unit of snapshot.units) {
    const outcome = analysisOutcome(snapshot.plan, unit), choice = decisions[unit.id];
    if (choice === 'suggested' && !unit.applicable) fail('invalid_selection', 'Unresolved knowledge cannot use the suggested version.');
    const issue = { id: `issue_${hash(unit.proposalIds).slice(0,24)}`, basisHash: reviewUnitBasis(snapshot.plan,unit), sourceIds:[...unit.proposalIds], state:'open' as const };
    const persistedIssue = journal.base.clarifications?.[unit.id];
    if(persistedIssue && (outcome!=='unresolved' || persistedIssue.id!==issue.id || persistedIssue.basisHash!==issue.basisHash || hash(persistedIssue.sourceIds)!==hash(issue.sourceIds)))fail('invalid_review','Clarification basis changed.');
    items[unit.id] = { outcome, disposition: choice === 'suggested' ? 'included' : choice === 'current' ? 'keep_current' : choice === 'deferred' ? 'deferred' : null, execution: 'not_applied',
      ...(outcome === 'unresolved' ? { issue: { ...issue, ...persistedIssue, state: choice === 'deferred' ? 'deferred' as const : choice==='current'?'open' as const:journal.events.some(e=>e.kind==='reopen_issue'&&Object.hasOwn(e.decisions,unit.id))?'open' as const:persistedIssue?.state??'open' as const } } : {}) };
  }
  return { revision, snapshotHash: snapshot.snapshotHash, decisions, items, paused, analysis: journal.base.analysis??'complete' };
}
async function reviewPath(root: string, id: string, state = false) {
  if (!idPattern.test(id)) fail('invalid_review', 'Invalid review identifier.');
  return checkedDataPath(root, directory, `${id}${state ? '.state' : ''}.json`);
}
async function readJson(file: string): Promise<any> {
  try { if ((await fs.stat(file)).size > REVIEW_RETENTION.maxBytes) fail('invalid_review', 'Review is too large.'); const data=JSON.parse(await fs.readFile(file, 'utf8')); assertSafeCurationData(data); return data; }
  catch (e) { if (e instanceof CurationReviewError) throw e; return fail('invalid_review', 'Review is unavailable. Analyze knowledge again.'); }
}
async function readJournal(root: string, snapshot: CurationReviewSnapshot): Promise<Journal> {
  const data = await readJson(await reviewPath(root, snapshot.reviewId, true));
  if (data.version !== undefined && data.version !== 2) fail('unsupported_review_schema', 'This review uses a newer format. Update Prodero.');
  if (data.version === undefined) {
    const legacy = legacySchema.safeParse(data);
    if (!legacy.success || legacy.data.snapshotHash !== snapshot.snapshotHash) fail('invalid_review', 'Review decisions are invalid.');
    return { version: 2, projectIdentity: snapshot.projectIdentity, snapshotHash: snapshot.snapshotHash,
      base: { revision: legacy.data!.revision, decisions: legacy.data!.decisions, paused: false, origin: 'legacy_v1', inheritedFrom: [] }, events: [] };
  }
  const parsed = journalSchema.safeParse(data);
  if (!parsed.success) fail('invalid_review', 'Review decision history is invalid.');
  const journal = parsed.data!;
  if (journal.snapshotHash !== snapshot.snapshotHash || journal.projectIdentity !== snapshot.projectIdentity) fail('invalid_review', 'Review history belongs to another snapshot.');
  return journal;
}
async function names(root: string) {
  const files = await fs.readdir(await checkedDataPath(root, directory)).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
  return files.filter(n => /^review_[a-zA-Z0-9_]+\.json$/.test(n)).sort();
}
async function loadStored(root: string, reviewId: string): Promise<{ review: CurationReview; journal: Journal }> {
  const snapshot = await readJson(await reviewPath(root, reviewId)) as CurationReviewSnapshot;
  if (snapshot.version !== 1 && snapshot.version !== 2 && snapshot.version !== 3) fail('unsupported_review_schema', 'This review uses a newer format. Update Prodero.');
  const { snapshotHash, ...body } = snapshot;
  if (snapshot.reviewId !== reviewId || hash(body) !== snapshotHash || !Number.isFinite(Date.parse(snapshot.createdAt))) fail('invalid_review', 'Review contents changed. Analyze knowledge again.');
  const projectIdentity=await fs.realpath(root);
  if (snapshot.projectIdentity !== projectIdentity || snapshot.plan.project !== snapshot.project || await fs.realpath(snapshot.project).catch(()=>null)!==projectIdentity) fail('project_mismatch', 'Review belongs to another project.');
  try { if(!snapshot.revision)validateCurationPlan(snapshot.plan); } catch { fail('stale_review', 'Knowledge changed since this review.'); }
  if(snapshot.version>=2&&!snapshot.revision)fail('invalid_review','Missing immutable review revision.');
  if(snapshot.version===1&&snapshot.revision)fail('invalid_review','Legacy snapshot cannot contain a revision.');
  if(snapshot.revision){
    try{validateRevision(snapshot.revision);}catch{fail('invalid_review','Review revision is invalid or unsupported.');}
    const r=snapshot.revision;
    if(r.reviewId!==snapshot.reviewId||r.projectIdentity!==snapshot.projectIdentity||hash(r.typedPlan.plan)!==hash(snapshot.plan)||hash(r.groups)!==hash(snapshot.units))fail('invalid_review','Review revision binding changed.');
  }
  if (snapshot.planHash !== snapshot.plan.planId || hash(snapshot.units) !== hash(reviewUnits(snapshot.plan))) fail('invalid_review', 'Review contents changed.');
  const journal = await readJournal(root, snapshot);
  if(snapshot.revision){
    const initial=stateFrom(snapshot,{base:journal.base,events:[]});
    const binding={revision:initial.revision,decisions:initial.decisions,items:initial.items,paused:initial.paused,analysis:initial.analysis};
    if(hash(binding)!==hash(snapshot.revision.decisionBinding))fail('invalid_review','Review decision baseline changed.');
  }
  return { review: { snapshot, state: stateFrom(snapshot, journal) }, journal };
}
async function applyReceiptState(root: string, review: CurationReview) {
  const receipts=(await listCheckpoints(root)).map(c=>(c as any).curation?.review).filter(r=>r?.reviewId===review.snapshot.reviewId && r.planHash===review.snapshot.planHash);
  for(const unit of review.snapshot.units)if(receipts.some(r=>unit.proposalIds.every(id=>r.applied.includes(id))))review.state.items[unit.id].execution='applied';
}
export async function loadCurationReview(root: string, reviewId: string, options: { allowExpired?: boolean } = {}): Promise<CurationReview> {
  const { review, journal } = await loadStored(root, reviewId);
  review.state.paused = await legacyPause(root,review.snapshot.plan,journal);
  await applyReceiptState(root,review);
  if (!options.allowExpired && expired(review.snapshot)) fail('stale_review', 'Knowledge review expired. Review updated changes.');
  return review;
}
const expired = (snapshot: CurationReviewSnapshot) => Date.now() - Date.parse(snapshot.createdAt) > REVIEW_RETENTION.maxAgeMs;

// Pin all decision-bearing history, even after expiry. Refuse at capacity instead
// of silently removing unresolved decisions. Empty abandoned previews may expire.
async function pruneForCreation(root: string, now: number) {
  const referenced=await (await import('./curation-semantic-jobs.js')).semanticReferencedReviews(root);
  const records = [];
  for (const name of await names(root)) {
    const id = name.slice(0,-5), { review, journal } = await loadStored(root,id);
    const stat = await fs.stat(await reviewPath(root,id));
    const pinned = referenced.has(review.snapshot.reviewId) || !!review.snapshot.revision?.parentRevisionId || journal.events.length > 0 || Object.keys(journal.base.decisions).length > 0 || journal.base.paused;
    records.push({ id: review.snapshot.reviewId, pinned, time: stat.mtimeMs });
  }
  records.sort((a,b) => a.time - b.time || a.id.localeCompare(b.id));
  if (records.filter(r => r.pinned).length >= REVIEW_RETENTION.maxCount) fail('review_retention_full', 'Saved review decisions reached the retention limit. No decisions were deleted.');
  let remaining = records.length;
  for (const record of records) if (!record.pinned && (remaining >= REVIEW_RETENTION.maxCount || now - record.time > REVIEW_RETENTION.maxAgeMs)) {
    await fs.rm(await reviewPath(root, record.id)); await fs.rm(await reviewPath(root, record.id, true), { force: true }); remaining--;
  }
}
async function inheritedDecisions(root: string, plan: CurationPlan, units: ReviewUnit[]) {
  const decisions: Record<string, ReviewDecision> = {}, from: string[] = [];
  const times = new Map<string,string>();
  for (const name of await names(root)) {
    const { review, journal } = await loadStored(root, name.slice(0,-5));
    for (const unit of units) {
      const old = review.snapshot.units.find(u => u.id === unit.id);
      if (!old || !sameUnitBasis(review.snapshot.plan,plan,old,unit)) continue;
      const event = journal.events.filter(e=>Object.hasOwn(e.decisions,old.id)).at(-1);
      if(!event && journal.base.origin==='inherited')continue;
      const at=event?.at??review.snapshot.createdAt;
      if((times.get(unit.id)??'')>at)continue;
      times.set(unit.id,at);
      const decision = review.state.decisions[old.id];
      // Never carry Suggested to a different snapshot. Current overrides defer.
      if (decision === 'current' || decision === 'deferred') { decisions[unit.id] = decision; from.push(review.snapshot.reviewId); }
      else if (decision === 'suggested'||event?.kind==='reopen_issue') delete decisions[unit.id];
    }
  }
  return { decisions, from: [...new Set(from)] };
}
async function legacyPause(root: string, plan: CurationPlan, journal?: Journal): Promise<boolean> {
  const checkpoint = (await listCheckpoints(root)).filter(c => (c.curationDefer === plan.planId || c.curationDefer === legacyPlanHash(plan))).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
  const control = journal?.events.filter(e => e.kind === 'pause_review' || e.kind === 'resume_review').at(-1);
  if (control && (!checkpoint || control.at >= checkpoint.createdAt)) return control.kind === 'pause_review';
  if(journal?.base.pauseUpdatedAt && (!checkpoint || journal.base.pauseUpdatedAt>=checkpoint.createdAt))return journal.base.paused;
  return !!checkpoint || !!journal?.base.paused;
}
export async function createCurationReview(root: string, successor?: { parent: CurationReview; operationId: string; applied: string[] }, memorySyncSources?:string[]): Promise<CurationReview> {
  const create = async () => {
    if (await fs.stat(await checkedDataPath(root, '.transactions/pending.json')).then(() => true, () => false)) fail('recovery_required', 'Finish the pending transaction before starting a new review.');
    const baselinePlan = await planKnowledgeCuration(root,{memorySyncSources}), now = Date.now();
    let plan=baselinePlan,carriedSemantic:SemanticTypedPlan|undefined;
    const previousTyped=successor?.parent.snapshot.revision?.typedPlan;
    if(previousTyped?.kind==='semantic-v2'){
      const catalog=await loadMemoryCatalog(root,{persistCache:false});await Promise.all(catalog.summaries.map(s=>catalog.load(s.id)));
      const analyses=previousTyped.analyses.filter(a=>a.bundle.expectedSources.every(s=>catalog.originalHashes.get(s.id)===s.revision)&&a.bundle.sources.filter(s=>s.editable).every(s=>baselinePlan.proposals.some(p=>p.id===s.id&&p.revision===s.revision))&&a.bundle.evidence.every(e=>baselinePlan.proposals.some(p=>(p.investigation?.evidence??[]).some(v=>`evidence_${hash([v.path,v.revision,v.line]).slice(0,24)}`===e.id&&v.revision===e.revision))));
      if(analyses.length){plan=materializeSemanticPlan(baselinePlan,analyses);carriedSemantic={kind:'semantic-v2',validator:'semantic-1',basePlan:baselinePlan,analyses,plan};}
    }
    const units=reviewUnits(plan);
    const inherited = successor ? {decisions:{} as Record<string,ReviewDecision>,from:[successor.parent.snapshot.reviewId]} : await inheritedDecisions(root,plan,units);
    const invalidatedDecisions:string[]=[];
    if(successor)for(const [id,decision] of Object.entries(successor.parent.state.decisions)){
      if(decision==='suggested')continue;
      const old=successor.parent.snapshot.units.find(u=>u.id===id)!, unit=units.find(u=>u.id===id);
      if(unit&&sameUnitBasis(successor.parent.snapshot.plan,plan,old,unit))inherited.decisions[id]=decision;
      else invalidatedDecisions.push(id);
    }
    const previous=await latestCurationReview(root,plan.planId);
    const body = { version: carriedSemantic?3 as const:2 as const, reviewId: successor ? `review_${hash(successor.operationId).slice(0,40)}` : sortableId('obs').replace(/^obs_/, 'review_'), project: plan.project, projectIdentity: await fs.realpath(root), planHash: plan.planId, createdAt: new Date(now).toISOString(), plan, units };
    let snapshot: CurationReviewSnapshot = JSON.parse(JSON.stringify({ ...body, snapshotHash: hash(body) }));
    const journal: Journal = { version: 2, projectIdentity: snapshot.projectIdentity, snapshotHash: snapshot.snapshotHash,
      base: { revision: 0, decisions: inherited.decisions, paused: successor?.parent.state.paused??previous?.state.paused??await legacyPause(root,plan), origin: inherited.from.length ? 'inherited' : 'new', inheritedFrom: inherited.from }, events: [] };
    journal.base.pauseUpdatedAt=new Date(now).toISOString();
    journal.base.analysis='complete';
    journal.base.clarifications=Object.fromEntries(Object.entries(stateFrom(snapshot,journal).items).filter(([,i])=>i.issue).map(([id,i])=>[id,i.issue!]));
    const initial=stateFrom(snapshot,journal), catalog=await loadMemoryCatalog(root,{persistCache:false});
    const revisionSources=catalog.summaries.filter(s=>!memorySyncSources||memorySyncSources.includes(s.id));
    await Promise.all(revisionSources.map(s=>catalog.load(s.id)));
    const revision=sealRevision({version:carriedSemantic?2:1,lineageId:successor?.parent.snapshot.revision?.lineageId??successor?.parent.snapshot.reviewId??snapshot.reviewId,
      parentRevisionId:successor?.parent.snapshot.revision?.id??null,parentReviewId:successor?.parent.snapshot.reviewId??null,reviewId:snapshot.reviewId,projectIdentity:snapshot.projectIdentity,
      baseline:plan.fingerprint,sources:revisionSources.map(s=>({id:s.id,revision:catalog.originalHashes.get(s.id)!})).sort((a,b)=>a.id.localeCompare(b.id)),
      evidence:[...new Map(plan.proposals.flatMap(p=>(p.investigation?.evidence??[]).map(e=>[e.path,{path:e.path,revision:e.revision}] as const))).values()].sort((a,b)=>a.path.localeCompare(b.path)),
      typedPlan:carriedSemantic??{kind:'extractive-v1',validator:'extractive-1',plan},groups:units,dependencies:deriveDependencies(plan,units,revisionSources.map(s=>({id:s.id,revision:catalog.originalHashes.get(s.id)!}))),
      decisionBinding:{revision:initial.revision,decisions:initial.decisions,items:initial.items,paused:initial.paused,analysis:initial.analysis},
      analyzedSourceIds:[...new Set([...(successor?.parent.snapshot.revision?.analyzedSourceIds??[]),...plan.proposals.map(p=>p.sourceId)])].sort(),answerBindings:carriedSemantic?.analyses.flatMap(a=>a.bundle.answers.map(answer=>({questionId:answer.questionId,answerEventId:answer.id,basisHash:answer.basisHash})))??[],appliedHistory:[...new Set([...(successor?.parent.snapshot.revision?.appliedHistory??[]),...(successor?successor.parent.snapshot.units.filter(u=>u.proposalIds.every(id=>successor.applied.includes(id))).map(u=>u.id):[])])],invalidatedDecisions});
    validateRevision(revision);
    const {snapshotHash:discard,...unsealed}=snapshot;
    snapshot=JSON.parse(JSON.stringify({...unsealed,revision,snapshotHash:hash({...unsealed,revision})}));journal.snapshotHash=snapshot.snapshotHash;
    if (Buffer.byteLength(JSON.stringify(snapshot)) > REVIEW_RETENTION.maxBytes) fail('review_too_large', 'Review is too large. Reduce the review scope first.');
    await ensureDataDirectory(root,directory); await pruneForCreation(root,now);
    // Publish the immutable snapshot last. A crash can leave only an unpublished seed.
    await writeFileAtomic(await reviewPath(root,snapshot.reviewId,true), JSON.stringify(journal));
    await writeFileAtomic(await reviewPath(root,snapshot.reviewId), JSON.stringify(snapshot));
    return { snapshot, state: stateFrom(snapshot,journal) };
  };
  return ownsSyncLock(root)?create():withSyncLock(root,create,{recoverLifecycle:false,waitMs:2000});
}
export function selectedCurationProposals(review: CurationReview): string[] {
  if(review.state.analysis!=='complete' || Object.values(review.state.items).some(i=>i.issue?.state==='answered_pending_analysis'))fail('invalid_selection','Review analysis is not complete.');
  if (review.state.paused) fail('review_paused', 'Resume this review before applying changes.');
  const selected = review.snapshot.units.filter(u => review.state.decisions[u.id] === 'suggested');
  if (selected.some(u => !u.applicable)) fail('invalid_selection', 'Unresolved knowledge cannot use the suggested version.');
  const ids = selected.flatMap(u => u.proposalIds).sort();
  if (ids.length) curationReviewEntries(review.snapshot.plan,ids,review.snapshot.revision);
  return ids;
}
type ReviewIdentity = { reviewId: string; planHash: string; decisionRevision: number };
export async function stageCurationDecisions(root: string, input: ReviewIdentity & { decisions: Record<string,ReviewDecision> }): Promise<CurationReview> {
  return stageEvent(root,input,'decide',input.decisions);
}
export async function controlCurationReview(root: string, input: ReviewIdentity & { action: 'pause' | 'resume' | 'defer_issue' | 'defer_change' | 'reopen_issue'; unitId?: string }): Promise<CurationReview> {
  const kind = input.action === 'pause' ? 'pause_review' : input.action === 'resume' ? 'resume_review' : input.action;
  if ((kind === 'defer_issue' || kind === 'defer_change') && !input.unitId) fail('invalid_selection', 'Choose the item to defer.');
  return stageEvent(root,input,kind,input.unitId ? { [input.unitId]: 'deferred' } : {});
}
export async function stageEvent(root: string, input: ReviewIdentity, kind: EventKind, decisions: Record<string,ReviewDecision>): Promise<CurationReview> {
  const operation=async () => {
    const { review, journal } = await loadStored(root,input.reviewId);
    if (expired(review.snapshot) || review.snapshot.planHash !== input.planHash) fail('stale_review', 'Knowledge changed since this review.');
    if (review.state.revision !== input.decisionRevision) fail('review_changed', 'Your review changed in another window. Reload your decisions.');
    if (!decisionSchema.safeParse(decisions).success) fail('invalid_selection', 'Invalid review decision.');
    for (const [id,choice] of Object.entries(decisions)) {
      const unit = review.snapshot.units.find(u => u.id === id);
      if (!unit || choice === 'suggested' && !unit.applicable) fail('invalid_selection', 'This suggestion needs clarification and cannot be applied.');
      if (kind === 'defer_issue' && analysisOutcome(review.snapshot.plan,unit!) !== 'unresolved' || kind === 'defer_change' && analysisOutcome(review.snapshot.plan,unit!) !== 'proposed') fail('invalid_selection', 'This deferral does not match the item.');
    }
    if (journal.events.length >= REVIEW_RETENTION.maxEvents) fail('review_retention_full', 'Saved review decisions reached the retention limit. No decisions were deleted.');
    const body = { revision: review.state.revision + 1, at: new Date().toISOString(), kind, decisions, previousHash: journal.events.at(-1)?.hash ?? hash(journal.base) };
    journal.events.push({ ...body, hash: hash(body) });
    const state = stateFrom(review.snapshot,journal), data = JSON.stringify(journal);
    if (Buffer.byteLength(data) > REVIEW_RETENTION.maxBytes) fail('review_retention_full', 'Saved review decisions reached the retention limit. No decisions were deleted.');
    // Atomic append of immutable hash-chained history, with no separate mutable head.
    await writeFileAtomic(await reviewPath(root,input.reviewId,true),data);
    return { snapshot: review.snapshot, state };
  };return ownsSyncLock(root)?operation():withSyncLock(root,operation,{recoverLifecycle:false,waitMs:2000});
}
export interface CurationApplyRequest { reviewRevisionId?: string; selectionHash?: string; reviewId: string; planHash: string; decisionRevision: number; selectedIds: string[]; }
export function curationOperationId(reviewId: string, selectedIds: string[], revisionId?: string, selectionHash?: string) { return `curation_${hash(revisionId?[reviewId,revisionId,selectionHash,[...selectedIds].sort()]:[reviewId,[...selectedIds].sort()])}`; }
export function curationApplyBinding(review: CurationReview, selectedIds: string[]) {
  const id=review.snapshot.revision?.id;
  return id?{reviewRevisionId:id,selectionHash:curationSelectionHash(id,review.state.revision,selectedIds)}:{};
}
export async function latestCurationReview(root: string, planHash: string): Promise<CurationReview | undefined> {
  if(!ownsSyncLock(root))await recoverCurationSuccessors(root);
  const reviews=await Promise.all((await names(root)).map(name=>loadCurationReview(root,name.slice(0,-5),{allowExpired:true})));
  const parents=new Set(reviews.map(r=>r.snapshot.revision?.parentRevisionId).filter(Boolean));
  return reviews.filter(r=>!parents.has(r.snapshot.revision?.id)&&(r.snapshot.planHash===planHash||(r.snapshot.revision?deterministicBaseline(r.snapshot.revision).planId:r.snapshot.planHash)===planHash)).sort((a,b)=>b.snapshot.createdAt.localeCompare(a.snapshot.createdAt))[0];
}
/** Authoritative saved-state projection, including old pauses and completed receipts. */
export async function curationReviewView(root: string, plan: CurationPlan, supplied?: CurationReview) {
  const candidate = supplied ?? await latestCurationReview(root,plan.planId);
  const stored = candidate ? await loadStored(root,candidate.snapshot.reviewId) : undefined;
  const review=stored?.review;
  plan=review?.snapshot.plan??plan;
  const units = review?.snapshot.units ?? reviewUnits(plan);
  const inherited = review ? undefined : await inheritedDecisions(root,plan,units);
  const journal = stored?.journal;
  const state = review ? structuredClone(review.state) : stateFrom({ snapshotHash: '', plan, units }, {
    base: { revision: 0, decisions: inherited!.decisions, paused: false, origin: 'inherited', inheritedFrom: inherited!.from }, events: [],
  });
  state.paused = await legacyPause(root,plan,journal);
  if(review)await applyReceiptState(root,{snapshot:review.snapshot,state});
  const semantic=review?await (await import('./curation-semantic-jobs.js')).semanticReviewStatus(root,review):undefined;
  return { review:review?{...review,state}:undefined, projection: projectCurationReview(plan,units,state,{semantic,stale: !!review && expired(review.snapshot),revision:review?.snapshot.revision,legacy:review?.snapshot.version===1}) };
}

/** Receipts remain the sole evidence of execution, including pre-v2 history. */
export function curationReceiptProjection(plan: CurationPlan, receipt: { decisions: Record<string,string>; applied: string[] }) {
  assertSafeCurationData(plan);
  const units = reviewUnits(plan);
  const state = stateFrom({snapshotHash:'',plan,units},{base:{revision:0,decisions:decisionSchema.parse(receipt.decisions),paused:false,origin:'legacy_v1',inheritedFrom:[]},events:[]});
  for (const unit of units) if (unit.proposalIds.every(id=>receipt.applied.includes(id))) state.items[unit.id].execution='applied';
  return projectCurationReview(plan,units,state,{legacy:true});
}

/** A committed receipt owns successor recovery. Reconstruct local review state only;
 * transaction recovery and canonical writes remain exclusively in Apply. */
export async function ensureCurationSuccessor(root:string, receipt: import('./knowledge-curation.js').CurationReceipt): Promise<CurationReview|undefined> {
  if(!receipt.reviewSnapshot?.revision || !receipt.reviewState)return;
  validateRevisionReceipt(receipt);
  if(receipt.projectIdentity!==await fs.realpath(root)||receipt.reviewSnapshot.project!==path.resolve(root))fail('project_mismatch','Receipt belongs to another project.');
  const id=`review_${hash(receipt.operationId).slice(0,40)}`;
  const existing=await fs.stat(await reviewPath(root,id)).then(()=>true,(e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return false;throw e;});
  if(existing){const {review}=await loadStored(root,id);if(review.snapshot.revision?.parentRevisionId!==receipt.reviewSnapshot.revision.id)fail('invalid_review','Successor parent changed.');return review;}
  return createCurationReview(root,{parent:{snapshot:receipt.reviewSnapshot,state:receipt.reviewState},operationId:receipt.operationId,applied:receipt.applied});
}
export async function recoverCurationSuccessors(root:string) {
  const pending:import('./knowledge-curation.js').CurationReceipt[]=[];
  for(const checkpoint of await listCheckpoints(root)){
    const receipt=(checkpoint as any).curation?.review;
    if(!receipt?.reviewSnapshot?.revision)continue;
    validateRevisionReceipt(receipt);
    const id=`review_${hash(receipt.operationId).slice(0,40)}`;
    if(!await fs.stat(await reviewPath(root,id)).then(()=>true,(e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return false;throw e;}))pending.push(receipt);
  }
  // Ordinary read-only presentation must not even create lock infrastructure.
  if(!pending.length)return;
  const recover=async()=>{for(const receipt of pending)await ensureCurationSuccessor(root,receipt);};
  return ownsSyncLock(root)?recover():withSyncLock(root,recover,{recoverLifecycle:false,waitMs:2000});
}
export async function resumeCurationReview(root:string,reviewId:string) {
  await recoverCurationSuccessors(root);
  let review=await loadCurationReview(root,reviewId,{allowExpired:true});
  const seen=new Set<string>();
  while(true){
    if(seen.has(review.snapshot.reviewId))fail('invalid_review','Cyclic review lineage.');seen.add(review.snapshot.reviewId);
    let child:CurationReview|undefined;
    for(const name of await names(root)){const stored=await loadStored(root,name.slice(0,-5));if(stored.review.snapshot.revision?.parentRevisionId===review.snapshot.revision?.id && review.snapshot.revision){if(child)fail('invalid_review','Forked review lineage.');child=stored.review;}}
    if(!child)return review;review=child;
  }
}
export function validateRevisionReceipt(receipt: import('./knowledge-curation.js').CurationReceipt) {
  assertSafeCurationData(receipt);
  const snapshot=receipt.reviewSnapshot,state=receipt.reviewState;
  if(!snapshot?.revision||!state)throw new CurationReviewError('invalid_review','Missing execution revision.');
  try{validateRevision(snapshot.revision);}catch{fail('invalid_review','Invalid execution revision.');}
  const {snapshotHash,...body}=snapshot;
  if(![2,3].includes(snapshot.version)||state.snapshotHash!==snapshotHash||snapshot.projectIdentity!==receipt.projectIdentity||hash(receipt.applied)!==hash(receipt.selectedIds)||receipt.operationId!==curationOperationId(receipt.reviewId,receipt.selectedIds,receipt.reviewRevisionId,receipt.selectionHash)||hash(body)!==snapshotHash || snapshot.planHash!==receipt.planHash || snapshot.reviewId!==receipt.reviewId || snapshot.revision.id!==receipt.reviewRevisionId || hash(snapshot.revision.typedPlan.plan)!==hash(snapshot.plan) || hash(state.decisions)!==hash(receipt.decisions) || state.revision!==receipt.decisionRevision || receipt.selectionHash!==curationSelectionHash(snapshot.revision.id,state.revision,receipt.selectedIds) || receipt.executionHash!==hash([snapshotHash,state,receipt.selectedIds]))fail('invalid_review','Execution binding changed.');
}
export async function reserveSuccessorCapacity(root:string){await pruneForCreation(root,Date.now());}

/** Read-only lineage check; semantic tools must never invoke transaction recovery. */
export async function assertCurationHead(root:string,review:CurationReview){
  for(const name of await names(root)){
    const {review:other}=await loadStored(root,name.slice(0,-5));
    if(other.snapshot.revision?.lineageId!==review.snapshot.revision?.lineageId&&other.snapshot.createdAt>review.snapshot.createdAt&&other.snapshot.revision&&review.snapshot.revision&&deterministicBaseline(other.snapshot.revision).planId===deterministicBaseline(review.snapshot.revision).planId)fail('stale_review','A newer review supersedes this input.');
    if(other.snapshot.revision?.parentRevisionId===review.snapshot.revision?.id&&review.snapshot.revision)fail('stale_review','Review has a successor revision.');
  }
  if((await listCheckpoints(root)).some(c=>(c as any).curation?.review?.reviewRevisionId===review.snapshot.revision?.id&&review.snapshot.revision))fail('stale_review','Review was already applied.');
}
/** Publishes only local staged state. Caller owns the writer lock, validates the
 * candidate and expected head. No recovery, grant, transaction or canonical I/O. */
export async function publishSemanticReview(root:string,parent:CurationReview,typedPlan:import('./curation-semantic-contract.js').SemanticTypedPlan,jobId:string):Promise<CurationReview>{
  if(!ownsSyncLock(root))fail('invalid_review','Semantic publication requires the review lock.');
  const reviewId=`review_${hash(['semantic',jobId]).slice(0,40)}`;
  if(await fs.stat(await reviewPath(root,reviewId)).then(()=>true,()=>false))return (await loadStored(root,reviewId)).review;
  await assertCurationHead(root,parent);
  const plan=typedPlan.plan,units=reviewUnits(plan),decisions:Record<string,ReviewDecision>={};
  for(const unit of units){const old=parent.snapshot.units.find(u=>u.id===unit.id);const choice=parent.state.decisions[unit.id];if(old&&choice&&choice!=='suggested'&&sameUnitBasis(parent.snapshot.plan,plan,old,unit))decisions[unit.id]=choice;}
  const body={version:3 as const,reviewId,project:parent.snapshot.project,projectIdentity:parent.snapshot.projectIdentity,planHash:plan.planId,createdAt:new Date().toISOString(),plan,units};
  let snapshot:CurationReviewSnapshot={...body,snapshotHash:hash(body)};
  const journal:Journal={version:2,projectIdentity:snapshot.projectIdentity,snapshotHash:snapshot.snapshotHash,base:{revision:0,decisions,paused:parent.state.paused,origin:'inherited',inheritedFrom:[parent.snapshot.reviewId],analysis:'complete'},events:[]};
  const initial=stateFrom(snapshot,journal);
  const {id:parentRevisionHash,...parentRevision}=parent.snapshot.revision!;
  const revision=sealRevision({...parentRevision,version:2,reviewId,parentReviewId:parent.snapshot.reviewId,parentRevisionId:parent.snapshot.revision!.id,typedPlan,groups:units,dependencies:deriveDependencies(plan,units,parent.snapshot.revision!.sources),
    decisionBinding:{revision:0,decisions,items:initial.items,paused:initial.paused,analysis:initial.analysis},answerBindings:typedPlan.analyses.flatMap(a=>a.bundle.answers.map(answer=>({questionId:answer.questionId,answerEventId:answer.id,basisHash:answer.basisHash}))),invalidatedDecisions:Object.keys(parent.state.decisions).filter(id=>parent.state.decisions[id]!=='suggested'&&!decisions[id])});
  snapshot={...body,revision,snapshotHash:''};const {snapshotHash:oldHash,...sealed}=snapshot;snapshot=JSON.parse(JSON.stringify({...sealed,snapshotHash:hash(sealed)}));journal.snapshotHash=snapshot.snapshotHash;
  validateRevision(snapshot.revision!);
  if(Buffer.byteLength(JSON.stringify(snapshot))>REVIEW_RETENTION.maxBytes)fail('review_too_large','Review is too large.');
  await pruneForCreation(root,Date.now());await ensureDataDirectory(root,directory);
  await writeFileAtomic(await reviewPath(root,reviewId,true),JSON.stringify(journal));await writeFileAtomic(await reviewPath(root,reviewId),JSON.stringify(snapshot));
  return {snapshot,state:stateFrom(snapshot,journal)};
}

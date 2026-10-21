/** Bounded host-agent adapter. Writes only local job/answer/review state.
 * No provider, sampling, grant, canonical writer, promotion or Apply imports. */
import { assertSafeCurationData } from './curation-evidence.js';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { checkedDataPath, ensureDataDirectory, writeFileAtomic } from './storage.js';
import { withSyncLock, ownsSyncLock } from './sync-transaction.js';
import { loadMemoryCatalog } from './memory-index.js';
import { planKnowledgeCuration } from './knowledge-curation.js';
import { loadCurationReview, assertCurationHead, publishSemanticReview, CurationReviewError, type CurationReview } from './curation-review.js';
import { deterministicBaseline, revisionIssues } from './curation-revision.js';
import { SEMANTIC_CONTRACT, SEMANTIC_VALIDATOR, SEMANTIC_INSTRUCTIONS, semanticProposalSchema, semanticLimitsSchema, semanticHash as hash, semanticAttemptInputHash, semanticClauses, measuredTokens, validateSemanticProposal, materializeSemanticPlan, SemanticValidationError, type SemanticLimits, type SemanticBundle, type AnswerEvent, type AcceptedSemanticAnalysis } from './curation-semantic-contract.js';
export const SEMANTIC_RETENTION={maxJobs:64,maxBytes:2*1024*1024,maxAnswers:128};
export const jobStatuses=['prepared','awaiting_reasoning','submitted','validated','rejected','stale','failed'] as const;
type JobStatus=typeof jobStatuses[number];
const adapterSchema=z.object({host:z.string().max(120).optional(),model:z.string().max(120).optional()}).strict();
export const semanticPrepareSchema=z.object({reviewId:z.string().regex(/^review_[a-zA-Z0-9_]+$/),reviewRevisionId:z.string().regex(/^revision_[a-f0-9]{64}$/),componentId:z.string().regex(/^component_[a-f0-9]{24}$/),requestId:z.string().min(1).max(100),reason:z.enum(['initial','new_evidence','answer','validation_correction','resume']).default('initial'),correctionForJobId:z.string().regex(/^semantic_job_[a-f0-9]{40}$/).optional(),resumeForJobId:z.string().regex(/^semantic_job_[a-f0-9]{40}$/).optional(),limits:semanticLimitsSchema.partial().optional(),adapter:adapterSchema.optional()}).strict();
interface JobInput {jobId:string;projectIdentity:string;reviewId:string;reviewRevisionId:string;lineageId:string;decisionRevision:number;bundleId:string;bundleHash:string;bundle:SemanticBundle;contractVersion:string;validatorVersion:string;requestId:string;reason:string;inputHash:string;semanticInputHash:string;createdAt:string;expiresAt:string;correction:number;previousJobId?:string;adapter?:z.infer<typeof adapterSchema>;}
interface JobEvent {sequence:number;at:string;status:JobStatus;previousHash:string;hash:string;outputHash?:string;proposal?:unknown;reason?:string;resultReviewId?:string;resultRevisionId?:string;}
export interface SemanticJob {version:1;input:JobInput;inputSeal:string;events:JobEvent[];}
const dir='local/curation-reasoning';
const reviewLock=<T>(root:string,operation:()=>Promise<T>,options:{recoverLifecycle:boolean;waitMs:number})=>ownsSyncLock(root)?operation():withSyncLock(root,operation,options);
const last=(job:SemanticJob)=>job.events.at(-1)!;
const reject=(code:string,message:string):never=>{throw new CurationReviewError(code,message);};
async function jobPath(root:string,id:string){if(!/^semantic_job_[a-f0-9]{40}$/.test(id))return reject('semantic_invalid','Invalid reasoning job.');return checkedDataPath(root,dir,`${id}.json`);}
export async function semanticJobs(root:string){const names=await fs.readdir(await checkedDataPath(root,dir)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;});return Promise.all(names.filter(n=>/^semantic_job_[a-f0-9]{40}\.json$/.test(n)).sort().map(n=>loadSemanticJob(root,n.slice(0,-5))));}
export async function loadSemanticJob(root:string,id:string):Promise<SemanticJob>{
  const file=await jobPath(root,id);if((await fs.stat(file)).size>SEMANTIC_RETENTION.maxBytes)return reject('semantic_limit','Reasoning history reached its limit.');
  const job=JSON.parse(await fs.readFile(file,'utf8')) as SemanticJob;
  assertSafeCurationData(job);
  if(job.version!==1||job.input?.jobId!==id||job.inputSeal!==hash(job.input)||job.input.contractVersion!==SEMANTIC_CONTRACT||job.input.validatorVersion!==SEMANTIC_VALIDATOR||job.input.bundleHash!==hash(job.input.bundle)||job.input.projectIdentity!==await fs.realpath(root))return reject('semantic_invalid','Reasoning job integrity failed.');
  let previous=job.inputSeal;for(const [i,event]of job.events.entries()){const {hash:eventHash,...body}=event;if(event.sequence!==i+1||event.previousHash!==previous||eventHash!==hash(body)||!jobStatuses.includes(event.status))return reject('semantic_invalid','Reasoning history integrity failed.');previous=eventHash;}
  if(!job.events.length)return reject('semantic_invalid','Reasoning history is empty.');return job;
}
async function save(root:string,job:SemanticJob){assertSafeCurationData(job);const data=JSON.stringify(job);if(Buffer.byteLength(data)>SEMANTIC_RETENTION.maxBytes)return reject('semantic_limit','Reasoning history reached its limit.');await ensureDataDirectory(root,dir);await writeFileAtomic(await jobPath(root,job.input.jobId),data);}
async function event(root:string,job:SemanticJob,status:JobStatus,data:Partial<Pick<JobEvent,'outputHash'|'proposal'|'reason'|'resultReviewId'|'resultRevisionId'>>={}){const body={sequence:job.events.length+1,at:new Date().toISOString(),status,previousHash:last(job)?.hash??job.inputSeal,...data};job.events.push({...body,hash:hash(body)});await save(root,job);}
async function noPendingTransaction(root:string){if(await fs.stat(await checkedDataPath(root,'.transactions/pending.json')).then(()=>true,()=>false))return reject('recovery_required','Finish the pending transaction before semantic analysis.');}
async function current(root:string,reviewId:string,revisionId:string,decisionRevision?:number){
  await noPendingTransaction(root);const review=await loadCurationReview(root,reviewId);if(review.snapshot.revision?.id!==revisionId||decisionRevision!==undefined&&review.state.revision!==decisionRevision)return reject('semantic_stale','Reasoning input is obsolete.');
  await assertCurationHead(root,review);const baseline=deterministicBaseline(review.snapshot.revision);const now=await planKnowledgeCuration(root,{memorySyncSources:baseline.memorySyncSources});if(now.planId!==baseline.planId)return reject('semantic_stale','Knowledge or evidence changed.');return review;
}
async function answerPath(root:string,lineageId:string){if(!/^review_[a-zA-Z0-9_]+$/.test(lineageId))return reject('semantic_invalid','Invalid answer lineage.');return checkedDataPath(root,dir,`${lineageId}.answers.json`);}
export async function curationAnswers(root:string,lineageId:string):Promise<AnswerEvent[]>{
  const file=await answerPath(root,lineageId);let data;try{if((await fs.stat(file)).size>SEMANTIC_RETENTION.maxBytes)return reject('semantic_limit','Answer history reached its limit.');data=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
  // Historical sealed logs fail closed; never rewrite their contents during replay.
  assertSafeCurationData(data);
  if(data.version!==1||data.projectIdentity!==await fs.realpath(root)||data.hash!==hash(data.events)||!Array.isArray(data.events)||data.events.length>SEMANTIC_RETENTION.maxAnswers)return reject('semantic_invalid','Answer history integrity failed.');return data.events;
}
/** Internal input foundation for a future trusted App/form adapter. Not an MCP
 * tool; an agent cannot claim App origin via the reasoning contract. */
export async function appendCurationAnswer(root:string,input:{reviewId:string;reviewRevisionId:string;questionId:string;questionVersion:number;requestId:string;origin:AnswerEvent['origin'];choiceId?:string;rawText?:string;replacesAnswerId?:string;decisionRevision?:number;answerLogHash?:string}){
  input=z.object({reviewId:z.string(),reviewRevisionId:z.string(),questionId:z.string(),questionVersion:z.number().int().positive(),requestId:z.string().min(1).max(100),origin:z.enum(['app','form','agent_relay']),choiceId:z.string().max(100).optional(),rawText:z.string().max(8192).optional(),replacesAnswerId:z.string().optional(),decisionRevision:z.number().int().nonnegative().optional(),answerLogHash:z.string().optional()}).strict().parse(input);
  assertSafeCurationData(input);
  return reviewLock(root,async()=>{
    const review=await current(root,input.reviewId,input.reviewRevisionId,input.decisionRevision),revision=review.snapshot.revision!,issue=revisionIssues(revision).find(i=>i.question.id===input.questionId&&i.question.version===input.questionVersion);
    if(!issue)return reject('semantic_invalid','Unknown question version.');
    if(!!input.choiceId===!!input.rawText||input.rawText&&(!issue.question.allowFreeText||Buffer.byteLength(input.rawText)>8192))return reject('semantic_invalid','Invalid answer.');
    const choice=input.choiceId?issue.question.choices.find(c=>c.id===input.choiceId):undefined;if(input.choiceId&&!choice)return reject('semantic_invalid','Unknown answer choice.');
    const events=await curationAnswers(root,revision.lineageId),prior=events.find(e=>e.requestId===input.requestId);
    if(prior){if(prior.reviewRevisionId!==input.reviewRevisionId||prior.questionId!==input.questionId||prior.questionVersion!==input.questionVersion||prior.choice?.id!==input.choiceId||prior.rawText!==input.rawText||prior.replacesAnswerId!==input.replacesAnswerId||prior.origin!==input.origin)return reject('review_changed','Answer request changed.');return prior;}
    if(input.answerLogHash!==undefined&&input.answerLogHash!==hash(events))return reject('review_changed','Another answer was saved. Reload this review.');
    if(events.length>=SEMANTIC_RETENTION.maxAnswers)return reject('semantic_limit','Answer history reached its limit.');
    if(events.some(e=>e.questionId===input.questionId&&!events.some(a=>a.replacesAnswerId===e.id))&&!input.replacesAnswerId)return reject('review_changed','Replacing an answer requires its exact prior event.');
    if(input.replacesAnswerId&&!events.some(e=>e.id===input.replacesAnswerId&&e.questionId===input.questionId&&!events.some(a=>a.replacesAnswerId===e.id)))return reject('semantic_invalid','Unknown previous answer.');
    const answer:AnswerEvent={id:`answer_${hash([revision.id,input.requestId]).slice(0,32)}`,reviewId:input.reviewId,reviewRevisionId:revision.id,lineageId:revision.lineageId,questionId:issue.question.id,questionVersion:issue.question.version,issueId:issue.id,basisHash:issue.basisHash,sourceIds:issue.sourceIds,origin:input.origin,requestId:input.requestId,at:new Date().toISOString(),...(choice?{choice}:{}),...(input.rawText?{rawText:input.rawText}:{}),...(input.replacesAnswerId?{replacesAnswerId:input.replacesAnswerId}:{})};
    assertSafeCurationData(answer);
    events.push(answer);await ensureDataDirectory(root,dir);await writeFileAtomic(await answerPath(root,revision.lineageId),JSON.stringify({version:1,projectIdentity:await fs.realpath(root),events,hash:hash(events)}));return answer;
  },{recoverLifecycle:false,waitMs:2000});
}
async function makeBundle(root:string,review:CurationReview,componentId:string,limits:SemanticLimits):Promise<SemanticBundle>{
  const revision=review.snapshot.revision!,base=deterministicBaseline(revision),groups=revision.dependencies.groups.filter(g=>g.component===componentId);
  if(!groups.length)return reject('semantic_invalid','Unknown dependency component.');
  const ids=[...new Set(groups.flatMap(g=>[...g.proposalIds,...g.policyDependencies]))].sort();
  const catalog=await loadMemoryCatalog(root,{persistCache:false}),sources:SemanticBundle['sources']=[],missing:string[]=[];
  for(const id of ids){const summary=catalog.summaries.find(s=>s.id===id);if(!summary){missing.push(`missing-source:${id}`);continue;}const record=await catalog.load(id);sources.push({id,revision:catalog.originalHashes.get(id)!,record,layer:summary.relativePath.startsWith('local/')?'local':'versioned',clauses:semanticClauses(id,catalog.originalHashes.get(id)!,record.content),editable:base.proposals.some(p=>p.id===id)});}
  const expectedSources=sources.map(s=>({id:s.id,revision:s.revision}));
  if(expectedSources.length>32)return reject('semantic_limit','Component exceeds the maximum accountable source count.');
  const evidence=[...new Map(base.proposals.filter(p=>ids.includes(p.id)).flatMap(p=>(p.investigation?.evidence??[]).map(e=>{const id=`evidence_${hash([e.path,e.revision,e.line]).slice(0,24)}`;return [id,{id,revision:e.revision,excerpt:e.excerpt,kind:e.kind}] as const;}))).values()];
  const allAnswers=await curationAnswers(root,revision.lineageId),issues=revisionIssues(revision);
  const answers=allAnswers.filter(a=>!allAnswers.some(b=>b.replacesAnswerId===a.id)&&issues.some(i=>i.id===a.issueId&&i.basisHash===a.basisHash&&i.question.id===a.questionId)&&a.sourceIds.some(id=>ids.includes(id)));
  const bundle:SemanticBundle={version:1,id:'',contract:SEMANTIC_CONTRACT,reviewId:review.snapshot.reviewId,reviewRevisionId:revision.id,lineageId:revision.lineageId,componentId,baseline:revision.baseline,expectedSources,sources,evidence,answers,answerLogHash:hash(allAnswers),dependencies:{...revision.dependencies,groups},signals:base.proposals.filter(p=>ids.includes(p.id)).map(p=>({sourceId:p.id,attention:p.attention,changes:p.changes})),missingFacts:base.proposals.filter(p=>ids.includes(p.id)&&p.attention.length&&((p.issueBasis?.length??0)>1||p.before.status==='disputed'||p.before.relations?.some(r=>r.type==='contradicts'))).map(p=>({sourceIds:(p.issueBasis??[{id:p.id}]).map(s=>s.id).filter(id=>ids.includes(id)),reason:'Existing conflicting policy requires a project fact; neither source is authoritative merely because it is newer.'})),completeness:{complete:!missing.length&&!base.evidenceTruncated,reasons:[...missing,...(base.evidenceTruncated?['evidence-incomplete']:[])]},limits};
  const mark=(reason:string)=>{bundle.completeness.complete=false;if(!bundle.completeness.reasons.includes(reason))bundle.completeness.reasons.push(reason);};
  if(bundle.sources.length>limits.maxItems){bundle.sources=bundle.sources.slice(0,limits.maxItems);mark('source-limit');}
  if(bundle.evidence.length>limits.maxEvidence){bundle.evidence=bundle.evidence.slice(0,limits.maxEvidence);mark('evidence-limit');}
  while(Buffer.byteLength(JSON.stringify(bundle))>limits.maxBytes-128||measuredTokens(bundle)>limits.maxTokens-32){mark('bundle-limit');if(bundle.evidence.length)bundle.evidence.pop();else if(bundle.sources.length)bundle.sources.pop();else return reject('semantic_limit','The minimum component manifest exceeds the reasoning budget.');}
  bundle.id=`bundle_${hash(bundle)}`;return bundle;
}
function response(job:SemanticJob){const {bundle,...input}=job.input;const history=job.events.map(({proposal,...event})=>event);return {jobId:job.input.jobId,status:last(job).status,job:{...job,input,events:history},task:{instructions:SEMANTIC_INSTRUCTIONS,proposalSchema:zodToJsonSchema(semanticProposalSchema,{$refStrategy:'none'}),data:bundle},acceptance:'staged_candidate_only' as const,validation:last(job).reason,resultReviewId:last(job).resultReviewId};}
const passCount=(history:SemanticJob[],lineageId:string)=>history.filter(j=>j.input.lineageId===lineageId&&j.input.reason!=='validation_correction').length;
const passLimit=(history:SemanticJob[],lineageId:string,limits:SemanticLimits)=>Math.min(limits.maxPasses,...history.filter(j=>j.input.lineageId===lineageId).map(j=>j.input.bundle.limits.maxPasses));
function boundedRecoveryLimits(previous:SemanticJob,requested?:Partial<SemanticLimits>):SemanticLimits{
 const limits=semanticLimitsSchema.parse({...previous.input.bundle.limits,...requested});
 return Object.fromEntries(Object.entries(limits).map(([key,value])=>[key,Math.min(value,previous.input.bundle.limits[key as keyof SemanticLimits])])) as SemanticLimits;
}
const semanticInputIdentity=(bundle:SemanticBundle)=>hash([bundle.expectedSources,bundle.sources,bundle.evidence,bundle.answers,bundle.signals,bundle.missingFacts,bundle.completeness,SEMANTIC_CONTRACT,SEMANTIC_VALIDATOR]);
/** Retry affordances use the same persisted budgets as preparation. Expiry is
 * independent of decision revision; neither may reset a correction allowance. */
export function semanticRetryState(job:SemanticJob,review:CurationReview,history:SemanticJob[]){
 const room=history.length<SEMANTIC_RETENTION.maxJobs,status=semanticJobStatus(job,review);
 return {canRetry:room&&status==='rejected'&&job.input.decisionRevision===review.state.revision&&job.input.correction<job.input.bundle.limits.maxCorrections,
  canResume:room&&status==='stale'&&['prepared','awaiting_reasoning','submitted','stale'].includes(last(job).status)&&passCount(history,job.input.lineageId)<passLimit(history,job.input.lineageId,job.input.bundle.limits)};
}
export async function prepareSemanticCuration(root:string,raw:z.input<typeof semanticPrepareSchema>){
  const input=semanticPrepareSchema.parse(raw);return reviewLock(root,async()=>{
    const review=await current(root,input.reviewId,input.reviewRevisionId),history=await semanticJobs(root);
    const targetId=input.reason==='validation_correction'?input.correctionForJobId:input.reason==='resume'?input.resumeForJobId:undefined;
    const target=targetId?history.find(j=>j.input.jobId===targetId):undefined;
    if(targetId&&(!target||target.input.lineageId!==review.snapshot.revision!.lineageId||target.input.bundle.componentId!==input.componentId))return reject('semantic_invalid','Recovery job does not belong to this component.');
    let limits=semanticLimitsSchema.parse(input.limits??{});
    if(target)limits=boundedRecoveryLimits(target,input.limits);
    let bundle=await makeBundle(root,review,input.componentId,limits),semanticInputHash=semanticInputIdentity(bundle);
    const matches=history.filter(j=>j.input.semanticInputHash===semanticInputHash&&j.input.lineageId===bundle.lineageId&&j.input.bundle.componentId===bundle.componentId&&!history.some(next=>next.input.previousJobId===j.input.jobId)).sort((a,b)=>b.input.createdAt.localeCompare(a.input.createdAt));
    let same=target??matches.find(j=>j.input.reviewRevisionId===input.reviewRevisionId&&j.input.decisionRevision===review.state.revision)??matches[0];
    if(input.reason==='resume'&&!same){
      // Older callers have no explicit predecessor field. Resolve a unique leaf
      // against full source/answer bindings, then inherit omitted input limits.
      // A changed answer is a fresh analysis, not recovery of that old attempt.
      const candidates=history.filter(j=>j.input.lineageId===bundle.lineageId&&j.input.bundle.componentId===input.componentId&&['prepared','awaiting_reasoning','submitted','stale'].includes(last(j).status)&&!history.some(next=>next.input.previousJobId===j.input.jobId)&&hash(j.input.bundle.expectedSources)===hash(bundle.expectedSources)&&j.input.bundle.answerLogHash===bundle.answerLogHash);
      if(candidates.length>1)return reject('semantic_stale','Recovery is ambiguous. Reload the review and retry the exact analysis job.');
      if(candidates.length){same=candidates[0];limits=boundedRecoveryLimits(same,input.limits);bundle=await makeBundle(root,review,input.componentId,limits);semanticInputHash=semanticInputIdentity(bundle);if(semanticInputHash!==same.input.semanticInputHash)return reject('semantic_stale','Reasoning evidence changed. Prepare a fresh analysis.');}
    }
    const priorRequest=history.find(j=>j.input.requestId===input.requestId&&j.input.lineageId===bundle.lineageId);
    if(priorRequest){if(priorRequest.input.semanticInputHash!==semanticInputHash||priorRequest.input.reviewRevisionId!==input.reviewRevisionId)return reject('review_changed','Reasoning request changed.');return response(priorRequest);}
    let correction=0,previous:SemanticJob|undefined;
    if(input.reason==='validation_correction'){
      previous=history.find(j=>j.input.jobId===input.correctionForJobId);if(!previous||last(previous).status!=='rejected'||previous.input.lineageId!==bundle.lineageId||previous.input.bundle.componentId!==bundle.componentId||previous.input.semanticInputHash!==semanticInputHash||previous.input.correction>=previous.input.bundle.limits.maxCorrections)return reject('semantic_limit','No correction retry remains.');
      if(previous.input.reviewRevisionId!==input.reviewRevisionId||previous.input.decisionRevision!==review.state.revision)return reject('semantic_stale','Reasoning decisions changed. Reload this review.');
      correction=previous.input.correction+1;
      const previousId=previous.input.jobId,retry=history.find(j=>j.input.previousJobId===previousId);if(retry)return response(retry);
    }else if(same){
      if(target&&same.input.semanticInputHash!==semanticInputHash)return reject('semantic_stale','Reasoning evidence or answers changed. Prepare a fresh analysis.');
      const successor=history.find(j=>j.input.previousJobId===same.input.jobId);
      if(target&&successor)return response(successor);
      if(input.reason!=='resume'||!['prepared','awaiting_reasoning','submitted','stale'].includes(last(same).status)||semanticJobStatus(same,review)!=='stale')return response(same);
      previous=same;correction=previous.input.correction;
    }
    if(previous){
      // Recovery may tighten limits but cannot silently expand the previous budget.
      limits=boundedRecoveryLimits(previous,input.limits);
      bundle=await makeBundle(root,review,input.componentId,limits);
      semanticInputHash=semanticInputIdentity(bundle);
      if(semanticInputHash!==previous.input.semanticInputHash)return reject('semantic_stale','Reasoning evidence or answers changed. Prepare a fresh analysis.');
    }
    if(correction>limits.maxCorrections)return reject('semantic_limit','No correction retry remains within the requested limits.');
    if(history.length>=SEMANTIC_RETENTION.maxJobs||input.reason!=='validation_correction'&&passCount(history,bundle.lineageId)>=passLimit(history,bundle.lineageId,limits))return reject('semantic_limit','Reasoning budget reached; pending history was preserved.');
    // A TTL-only resume has identical sources/revision. Bind it to its predecessor
    // so it gets a distinct immutable job instead of overwriting expired history.
    const createdAt=new Date().toISOString(),inputHash=semanticAttemptInputHash(bundle,review.state.revision,correction,input.reason==='resume'?previous?.input.jobId:undefined),jobId=`semantic_job_${hash([bundle.lineageId,inputHash]).slice(0,40)}`;
    const body:JobInput={jobId,projectIdentity:review.snapshot.projectIdentity,reviewId:input.reviewId,reviewRevisionId:input.reviewRevisionId,lineageId:bundle.lineageId,decisionRevision:review.state.revision,bundleId:bundle.id,bundleHash:hash(bundle),bundle,contractVersion:SEMANTIC_CONTRACT,validatorVersion:SEMANTIC_VALIDATOR,requestId:input.requestId,reason:input.reason,inputHash,semanticInputHash,createdAt,expiresAt:new Date(Date.now()+limits.ttlMs).toISOString(),correction,...(previous?{previousJobId:previous.input.jobId}:{}),...(input.adapter?{adapter:input.adapter}:{})};
    const job:SemanticJob={version:1,input:body,inputSeal:hash(body),events:[]};await event(root,job,'prepared');await event(root,job,'awaiting_reasoning');return response(job);
  },{recoverLifecycle:false,waitMs:2000});
}
export async function inspectSemanticCuration(root:string,jobId:string){return response(await loadSemanticJob(root,jobId));}
export async function submitSemanticCuration(root:string,input:{jobId:string;inputHash:string;proposal:unknown}){
  return reviewLock(root,async()=>{
    const job=await loadSemanticJob(root,input.jobId),outputHash=hash(input.proposal),status=last(job).status;
    if(input.inputHash!==job.input.inputHash)return reject('semantic_invalid','Reasoning input hash changed.');
    const submission=job.events.find(e=>e.status==='submitted');
    if(submission&&submission.outputHash!==outputHash)return reject('review_changed','This job already has a different submission.');
    if(['validated','rejected','stale','failed'].includes(status)){if(last(job).outputHash!==outputHash)return reject('review_changed','This job already has a different terminal result.');return response(job);}
    if(submission){
      const resultId=`review_${hash(['semantic',job.input.jobId]).slice(0,40)}`;
      const file=await checkedDataPath(root,'local/curation-reviews',`${resultId}.json`);
      if(await fs.stat(file).then(()=>true,()=>false)){
        const recovered=await loadCurationReview(root,resultId,{allowExpired:true}),typed=recovered.snapshot.revision?.typedPlan;
        if(typed?.kind!=='semantic-v2'||typed.analyses.at(-1)?.jobId!==job.input.jobId||typed.analyses.at(-1)?.outputHash!==outputHash)return reject('semantic_invalid','Published semantic revision changed.');
        await event(root,job,'validated',{outputHash,resultReviewId:resultId,resultRevisionId:recovered.snapshot.revision!.id,reason:'recovered_staged_revision'});return {...response(job),review:recovered};
      }
    }
    let review:CurationReview;
    try{review=await current(root,job.input.reviewId,job.input.reviewRevisionId,job.input.decisionRevision);if(Date.now()>Date.parse(job.input.expiresAt)||hash(await curationAnswers(root,job.input.lineageId))!==job.input.bundle.answerLogHash)throw new Error('obsolete');}
    catch{await event(root,job,'stale',{reason:'obsolete_revision_or_evidence',outputHash});return response(job);}
    // Size-check before persisting an untrusted output. Store only its hash if over budget.
    if(Buffer.byteLength((JSON.stringify(input.proposal)??'null'))>job.input.bundle.limits.maxOutputBytes||measuredTokens(input.proposal)>job.input.bundle.limits.maxOutputTokens){await event(root,job,'rejected',{reason:'output_limit',outputHash});return response(job);}
    if(!submission)await event(root,job,'submitted',{outputHash,proposal:input.proposal});
    try{
      const proposal=validateSemanticProposal(job.input.bundle,input.proposal),accepted:AcceptedSemanticAnalysis={jobId:job.input.jobId,inputHash:job.input.inputHash,outputHash,decisionRevision:job.input.decisionRevision,correction:job.input.correction,...(job.input.reason==='resume'&&job.input.previousJobId?{resumedFromJobId:job.input.previousJobId}:{}),bundle:job.input.bundle,proposal},previous=review.snapshot.revision!.typedPlan;
      const analyses=[...(previous.kind==='semantic-v2'?previous.analyses:[]),accepted],basePlan=deterministicBaseline(review.snapshot.revision!),plan=materializeSemanticPlan(basePlan,analyses);
      const next=await publishSemanticReview(root,review,{kind:'semantic-v2',validator:SEMANTIC_VALIDATOR,basePlan,analyses,plan},job.input.jobId);
      await event(root,job,'validated',{outputHash,resultReviewId:next.snapshot.reviewId,resultRevisionId:next.snapshot.revision!.id,reason:proposal.sources.every(s=>s.disposition!=='proposed')?'terminal_no_rewrite':'structurally_validated_candidate'});
      return {...response(job),review:next};
    }catch(error){if(error instanceof SemanticValidationError||error instanceof z.ZodError){await event(root,job,'rejected',{reason:error instanceof SemanticValidationError?error.reason:'malformed_output',outputHash});return response(job);}if(error instanceof CurationReviewError&&['review_retention_full','review_too_large','semantic_limit'].includes(error.code)){await event(root,job,'failed',{reason:'staging_capacity',outputHash});return response(job);}throw error;}
  },{recoverLifecycle:false,waitMs:2000});
}
export function semanticJobStatus(job:SemanticJob,review:CurationReview){const status=last(job).status;return ['prepared','awaiting_reasoning','submitted'].includes(status)&&(job.input.reviewRevisionId!==review.snapshot.revision?.id||job.input.decisionRevision!==review.state.revision||Date.now()>Date.parse(job.input.expiresAt))?'stale':status;}
/** Unchanged supporting records must not keep a decided component's job active. */
export function semanticJobSuspended(job:SemanticJob,review:CurationReview){
  const sourceIds=new Set(job.input.bundle.dependencies.groups.flatMap(g=>g.proposalIds));
  const affected=review.snapshot.units.filter(u=>u.proposalIds.some(id=>sourceIds.has(id))).map(u=>review.state.items[u.id]);
  const work=affected.filter(item=>item.outcome!=='unchanged');
  return (work.length?work:affected).every(item=>item.execution==='applied'||['deferred','keep_current'].includes(item.disposition??''));
}
export async function semanticReviewStatus(root:string,review:CurationReview){
  const history=(await semanticJobs(root)).filter(j=>j.input.reviewRevisionId===review.snapshot.revision?.id);
  const active=history.filter(j=>!history.some(next=>next.input.previousJobId===j.input.jobId)&&!semanticJobSuspended(j,review));
  const pending=active.filter(j=>['prepared','awaiting_reasoning','submitted'].includes(semanticJobStatus(j,review))),failed=active.filter(j=>['failed','rejected','stale'].includes(semanticJobStatus(j,review)));
  const revision=review.snapshot.revision,issues=revision?revisionIssues(revision):[],answers=revision?await curationAnswers(root,revision.lineageId):[];
  const bound=new Set(revision?.answerBindings.map(a=>a.answerEventId)??[]);
  const awaiting=answers.filter(a=>review.snapshot.units.some(u=>u.proposalIds.some(id=>a.sourceIds.includes(id))&&!['deferred','keep_current'].includes(review.state.items[u.id]?.disposition??''))&&!bound.has(a.id)&&!answers.some(b=>b.replacesAnswerId===a.id)&&issues.some(i=>i.id===a.issueId&&i.basisHash===a.basisHash&&i.question.id===a.questionId));
  const answerGroups=revision?.dependencies.groups.filter(g=>awaiting.some(a=>a.sourceIds.some(id=>g.proposalIds.includes(id)))).map(g=>g.id)??[];
  return {pending:pending.length+awaiting.filter(a=>!pending.some(j=>j.input.bundle.answers.some(bound=>bound.id===a.id))).length,answeredIssueIds:awaiting.map(a=>a.issueId),failed:failed.length,jobIds:history.map(j=>j.input.jobId),blockedGroupIds:[...new Set([...answerGroups,...[...pending,...failed].flatMap(j=>j.input.bundle.dependencies.groups.map(g=>g.id))])]};
}

export async function semanticReferencedReviews(root:string){return new Set((await semanticJobs(root)).map(j=>j.input.reviewId));}

/** Pure derived Sync state/actions. No I/O, writes, host detection or authority. */
import {publicDiagnostic} from './core/diagnostics.js';
import {hasSecret} from './core/secrets.js';
export type SyncState='awaiting_selection'|'semantic_work'|'awaiting_clarification'|'awaiting_review'|'applying'|'awaiting_promotion_selection'|'completed'|'stale';
export interface SyncAction {id:string;label:string;tool:string;arguments:Record<string,unknown>;approval?:boolean;app?:{tool:string;arguments:Record<string,unknown>}}
export interface SyncCounts {areasProcessed:number;areasFailed:number;areasSkipped:number;questionsDeferred:number;unresolved:number;brokenLinksRemaining:number;promotionConflicts:number}
interface SyncJob {id:string;label:string;selected:boolean;status:string;curationReviewId?:string;error?:string}
interface Question {question:{id:string;version:number;title:string;prompt:string;allowFreeText:boolean;choices:{id:string;label:string;meaning:string}[]};state:string;needsInput:boolean;answer?:{id:string};relatedQuestions?:{id:string;version:number;title:string}[]}
export interface SyncReasoning {jobs:{id:string;status:string;suspended?:boolean}[];continuationJobId?:string;analysisPending:boolean;analysisFailed:boolean;canRetryAnalysis:boolean;needsPreparation:boolean;answerCount?:number;currentAnswerCount?:number}
interface QuestionSnapshot {review?:{snapshot:{reviewId:string;planHash:string;revision?:{id:string}};state:{revision:number}};graphical?:SyncReasoning&{answerLogHash:string;questions:Question[]}}
interface DeferredQuestion {candidateId:string;title:string;prompt:string;expired:boolean;affectedQuestions:{id:string;version:number;title:string}[];action:'question_reopen';reviewId:string;reviewRevisionId:string;planHash:string;decisionRevision:number;answerLogHash:string;questionId:string;questionVersion:number}
export interface SyncOperationInput {id:string;root:string;revision:number;state:SyncState;jobs:SyncJob[];summary:Partial<SyncCounts>;brokenLinks?:number;review?:{kind:string;reviewId:string};promotionCandidates:{id:string}[];promotionResult?:unknown;clarification?:QuestionSnapshot;reasoning?:SyncReasoning;questionCounts?:{deferred:number;savedAnswerEvents:number;unsupersededAnswerEvents:number;coverage:'saved_selected_reviews'};deferredQuestions?:DeferredQuestion[];error?:string;next?:{candidateId?:string}}
export interface SyncDiagnostic {code:string;cause:string;recovery:string}
export interface SyncClientEvidence {workflowId:string;stage:'action'|'handoff';certainty:'requested'|'acknowledged'|'rejected'|'unknown';confirmedState:boolean;diagnostic?:SyncDiagnostic;pollPaused?:boolean}
/** Only returned Core diagnostics are screened for display. Raw transport
 * exceptions are deliberately replaced with fixed client-owned wording. */
export function syncClientFailure(workflowId:string,stage:'action'|'handoff',response?:unknown,confirmedState=false):SyncClientEvidence{
 const payload=(response as {structuredContent?:{code?:unknown;message?:unknown;error?:unknown}}|undefined)?.structuredContent;
 const rejected=stage==='action'&&Boolean(payload),code=payload&&typeof payload.code==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(payload.code)&&!hasSecret(payload.code)?payload.code:stage==='handoff'?'SYNC_HANDOFF_UNKNOWN':rejected?'SYNC_ACTION_REJECTED':'SYNC_TRANSPORT_UNKNOWN';
 const cause=payload?publicDiagnostic(typeof payload.message==='string'?payload.message:typeof payload.error==='string'?payload.error:'The server rejected this step.').slice(0,1000):stage==='handoff'?'Agent continuation outcome is unknown. Saved workflow changes remain confirmed.':'The action outcome is unknown because the host did not return a usable result.';
 return {workflowId,stage,certainty:rejected&&confirmedState?'rejected':'unknown',confirmedState,diagnostic:{code,cause,recovery:stage==='handoff'?'Check saved progress or continue the saved request in chat.':confirmedState?'Saved state refreshed. Review it before retrying; the action was not replayed.':'Check saved progress before retrying. Do not repeat approval while its outcome is unknown.'}};
}
export function syncClientNotice(evidence:SyncClientEvidence|undefined):string{
 if(!evidence)return '';
 return [evidence.diagnostic?`${evidence.diagnostic.code}: ${evidence.diagnostic.cause} ${evidence.diagnostic.recovery}`:evidence.stage==='handoff'?evidence.certainty==='requested'?'Continuation requested from the host; agent execution is not confirmed.':evidence.certainty==='acknowledged'?'The host acknowledged the request. Waiting for saved analysis; agent execution is not confirmed.':'':'',evidence.pollPaused?'Automatic checks paused after 12 attempts. Waiting for saved progress; use Check progress or continue the saved request in chat.':''].filter(Boolean).join(' ');
}
export interface SyncOperation {version:1;phase:'selection'|'queued'|'awaiting_agent'|'submitted'|'question'|'review'|'recovery'|'sharing'|'completed'|'stale';outcome:'pending'|'complete'|'remaining'|'stale';counts:Omit<SyncCounts,'questionsDeferred'>&{deferredAreas:number;questionsDeferred:number|null;areasTotal:number;areasFinished:number;savedAnswers:number|null;unsupersededAnswerEvents:number|null};currentItem?:{id:string;label:string;status:string};actions:SyncAction[];diagnostic?:SyncDiagnostic;continuation?:{jobId:string};selection:{ids:string[];availableIds:string[]}}
const finished=new Set(['applied','skipped','failed','deferred']);
export function memorySyncOperation(w:SyncOperationInput,selection?:{promotionIds?:string[];improve?:boolean;share?:boolean;repairLinks?:boolean}):SyncOperation{
 const counts={areasProcessed:0,areasFailed:0,areasSkipped:0,questionsDeferred:0,unresolved:0,brokenLinksRemaining:0,promotionConflicts:0,...w.summary};
 const selected=(w.jobs??[]).filter(j=>j.selected),current=selected.find(j=>['pending','semantic_work','awaiting_review','awaiting_clarification'].includes(j.status)),reasoning=w.reasoning??w.clarification?.graphical;
 const remaining=counts.areasFailed+counts.areasSkipped+counts.questionsDeferred+counts.unresolved+counts.brokenLinksRemaining+counts.promotionConflicts>0;
 let phase:SyncOperation['phase']=({awaiting_selection:'selection',semantic_work:'queued',awaiting_clarification:'question',awaiting_review:'review',applying:'recovery',awaiting_promotion_selection:'sharing',completed:'completed',stale:'stale'} as const)[w.state];
 const pendingAnalysis=w.state==='semantic_work'||w.state==='awaiting_clarification'&&!w.clarification?.graphical?.questions.some(q=>q.needsInput);
 if(pendingAnalysis&&reasoning?.jobs.some(j=>!j.suspended&&['prepared','awaiting_reasoning'].includes(j.status)))phase='awaiting_agent';
 if(pendingAnalysis&&reasoning?.jobs.some(j=>!j.suspended&&j.status==='submitted'))phase='submitted';
 const actions:SyncAction[]=[],args={workflowId:w.id,revision:w.revision};
 const add=(id:string,label:string,request:Record<string,unknown>,approval=false)=>actions.push({id,label,tool:'prodero_memory_sync',arguments:{projectRoot:w.root,request},...(approval?{approval:true}:{})});
 if(w.state==='awaiting_selection'&&(selection?.improve!==false||selection?.share!==false||Boolean(w.brokenLinks)&&selection?.repairLinks!==false))add('select','Start curation',{action:'select',...args,improve:selection?.improve??true,share:selection?.share??true,...(w.brokenLinks?{repairLinks:selection?.repairLinks??true}:{})});
 if(w.state==='semantic_work'&&current)add('prepare','Continue improving memory',{action:'prepare',...args,candidateId:current.id});
 if(w.state==='semantic_work'&&current)add('skip','Continue with other knowledge',{action:'skip',...args,candidateId:current.id});
 if(w.state==='awaiting_review'&&w.review){add('approve',w.review.kind==='promotion'?'Share reviewed knowledge':'Approve reviewed changes',{action:'approve',...args,reviewId:w.review.reviewId,approved:true},true);add('skip','Skip this review',{action:'skip',...args,...(w.review.kind==='transformation'&&current?{candidateId:current.id}:{})});}
 const availableIds=(w.promotionCandidates??[]).map(c=>c.id),ids=selection?.promotionIds??availableIds;
 const validSelection=ids.length>0&&new Set(ids).size===ids.length&&ids.every(id=>availableIds.includes(id));
 if(w.state==='awaiting_promotion_selection'){
  if(validSelection)add('promotions',ids.length===availableIds.length?`Review all ${ids.length} for sharing`:`Review ${ids.length} selected for sharing`,{action:'promotions',...args,ids:[...ids]});
  add('complete','Finish without sharing',{action:'complete',...args});
 }
 if(!['stale','applying'].includes(w.state)&&!w.review&&!w.promotionResult)for(const job of selected.filter(j=>j.status==='failed'))add(`retry:${job.id}`,'Retry incomplete analysis',{action:'retry',...args,candidateId:job.id});
 for(const q of w.deferredQuestions??[]){
  const {candidateId,title,prompt,expired,affectedQuestions,...binding}=q;
  if(expired&&w.review)continue;
  if(expired){const {action,questionId,questionVersion,...exact}=binding;add(`refresh:${candidateId}:${q.questionId}`,'Refresh expired question review',{action:'refresh_questions',...args,candidateId,...exact});}
  else{const app={tool:'prodero_curation_review',arguments:{projectRoot:w.root,...binding}};actions.push({id:`revisit:${q.questionId}`,label:affectedQuestions.length>1?`Revisit ${affectedQuestions.length} related questions`:`Revisit ${title}`,tool:'prodero_curation_question',arguments:{projectRoot:w.root,...binding,workflowId:w.id,candidateId},app});}
 }
 const data=w.clarification,review=data?.review,g=data?.graphical,owner=selected.find(j=>j.curationReviewId===review?.snapshot.reviewId);
 if(review?.snapshot.revision&&g&&owner){
  const binding={workflowId:w.id,candidateId:owner.id,reviewId:review.snapshot.reviewId,reviewRevisionId:review.snapshot.revision.id,planHash:review.snapshot.planHash,decisionRevision:review.state.revision,answerLogHash:g.answerLogHash};
  for(const q of g.questions.filter(q=>q.needsInput||q.state==='answered_pending_analysis')){
   if(q.needsInput&&!g.analysisPending)for(const choice of q.question.choices)actions.push({id:`answer:${q.question.id}:${choice.id}`,label:choice.label,tool:'prodero_curation_question',arguments:{projectRoot:w.root,...binding,action:'answer',questionId:q.question.id,questionVersion:q.question.version,choiceId:choice.id,requestId:`chat_${globalThis.crypto.randomUUID()}`,...(q.answer?{replacesAnswerId:q.answer.id}:{})}});
   actions.push({id:`later:${q.question.id}`,label:q.relatedQuestions&&q.relatedQuestions.length>1?`Defer ${q.relatedQuestions.length} related questions`:'Answer later',tool:'prodero_curation_question',arguments:{projectRoot:w.root,...binding,action:'question_later',questionId:q.question.id,questionVersion:q.question.version}});
  }
  if(g.canRetryAnalysis)actions.push({id:'retry_analysis',label:'Retry saved answer analysis',tool:'prodero_curation_question',arguments:{projectRoot:w.root,...binding,action:'retry_analysis'}});
  else if(g.needsPreparation)actions.push({id:'analyze',label:'Analyze saved answer',tool:'prodero_curation_question',arguments:{projectRoot:w.root,...binding,action:'analyze'}});
 }
 if(reasoning?.continuationJobId)actions.push({id:'reasoning',label:'Continue bounded analysis',tool:'prodero_curation_reasoning_prepare',arguments:{projectRoot:w.root,jobId:reasoning.continuationJobId}});
 if(w.state==='stale'||w.state==='applying')actions.length=0;
 if(w.state==='stale'||w.state==='completed')add('restart','Re-analyze memory',{action:'start',restart:true});
 add('inspect','Check progress',{action:'inspect',workflowId:w.id});
 actions.push({id:'details',label:'Show details',tool:'prodero_memory_sync',arguments:{projectRoot:w.root,request:{action:'inspect',workflowId:w.id},details:true}});
 const error=w.error??selected.find(j=>j.status==='failed'&&j.error)?.error;
 return {version:1,phase,outcome:w.state==='stale'?'stale':w.state==='completed'?remaining?'remaining':'complete':'pending',counts:{...counts,deferredAreas:counts.questionsDeferred,questionsDeferred:w.questionCounts?.deferred??null,areasTotal:selected.length,areasFinished:selected.filter(j=>finished.has(j.status)).length,savedAnswers:w.questionCounts?.savedAnswerEvents??null,unsupersededAnswerEvents:w.questionCounts?.unsupersededAnswerEvents??null},...(current?{currentItem:{id:current.id,label:current.label,status:current.status}}:{}),actions,...(error?{diagnostic:{code:'SYNC_STEP_INCOMPLETE',cause:publicDiagnostic(error),recovery:'Inspect saved progress before retrying.'}}:{}),...(!['stale','applying'].includes(w.state)&&reasoning?.continuationJobId?{continuation:{jobId:reasoning.continuationJobId}}:{}),selection:{ids:validSelection?[...ids]:[],availableIds}};
}

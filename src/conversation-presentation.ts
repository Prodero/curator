/** Portable conversational projection. Reads Core state; never runs or selects work. */
import type { PresentationAction, ProderoViewModel } from './presentation.js';
export const LIFECYCLE_PRESENTATION_REPLY = 'For lifecycle text delivery, including when presentation.resolved is text in auto mode, relay the supplied compact presentation.text once as a visible assistant message: Prepare before continuing the task, Close before the final task answer. Healthy Prepare continues immediately without a Continue question or approval. A tool result or App metadata does not prove visible delivery. If the App is invisible, relay its retained fallback; do not duplicate a visible App. Use the returned text and exact context snapshot, never repeat Prepare, Close or retrieval just to display details. Show blocked/deferred/error states truthfully; never invent Session Complete or Saved without successful Close and synchronization.';
export const PRESENTATION_REPLY = 'For knowledge-list requests in Claude Code, prefer prodero_text unless the user requests a graphical view. Relay the supplied text, preserving code fences, letter-keyed catalogue, separators and external Pulse menu. Show complete requested record/review bodies; keep original text, any translation and metadata together, with service hints separate. Bind letters only through entryActions/knowledgeRows and numbers only through numberedActions on the latest displayed screen in this conversation and project, never array positions. Each screen replaces old aliases. Preserve bindings/order when translating. Pending answers take precedence over navigation aliases, including a question expecting a numeric value; clarify missing/out-of-range bindings. Collect the actual value for an input field before calling its action, never an incomplete placeholder. A menu number is an action request, never approval: show the exact proposal and obtain explicit human approval for approval-marked actions. Keep aliases ephemeral; never store them as settings or knowledge. Tell the user they may reply with a number or command name. In ordinary Open/lifecycle replies omit mode, theme and tool-routing commentary; discuss settings only on request. Display settings or App metadata do not prove that a UI was visible.';

type Data = Record<string, any>;
export type TextKind = 'summary' | 'attention' | 'details' | 'diagnostic';
export interface ConversationView {
  kind: TextKind;
  title: string;
  state: string;
  facts: string[];
  attention: string[];
  blocking: boolean;
  contextComplete?: boolean;
  reviewRequired: boolean;
  prompt?: string;
  continuation?: PresentationAction;
  details?: PresentationAction;
  detailSource?: "context";
  suggestions?: PresentationAction[];
}
const n = (value: number, one: string, many = `${one}s`) => `${value} ${value === 1 ? one : many}`;
const tokens = (value: number) => value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);

export function conversationView(payload: Data, vm: ProderoViewModel): ConversationView {
  const r = payload.result ?? payload;
  const root = r.root ?? r.projectRoot ?? r.project?.root ?? payload.project?.root ?? payload.root;
  const call = (label: string, tool: string, args: Data = {}): PresentationAction => ({label, tool, arguments: {...(root ? {projectRoot: root} : {}), ...args}});
  const v: ConversationView = {kind:'summary',title:vm.title,state:'Ready',facts:[],attention:[],blocking:false,reviewRequired:false};
  const next = (prompt: string, action?: PresentationAction) => { v.prompt = prompt; v.continuation = action; };
  if (['open','status','status-details','initialized'].includes(payload.action)) {
    const p = payload.project;
    v.title = `Prodero · ${p?.name ?? 'Project'}`;
    if (typeof p?.initialized !== 'boolean') { v.state='Project state unavailable'; v.attention.push('Check project details before continuing.'); }
    else if (!p.initialized) {
      v.state='Not initialized';
      next('Initialize Prodero for this project?',call('Initialize Prodero','prodero_initialize'));
      v.facts.push('Creates project memory and managed agent instructions.');
    } else {
      v.state=payload.action==='initialized'?'Initialized':'Ready';
      if (p.knowledgeCount !== undefined) v.facts.push(`Memory  ${p.knowledgeCount}`);
      if (p.skillCount !== undefined) v.facts.push(`Skills  ${p.skillCount}`);
      if (p.activeSessionCount !== undefined) v.facts.push(`Session  ${p.activeSessionCount ? `active (${p.activeSessionCount})` : 'none active'}`);
      if (payload.phase==='initial') v.facts.push('Lightweight status; counts not loaded.');
      if (p.conflictCount) v.attention.push(`Conflicts to review: ${p.conflictCount}.`);
      const areas=p.memoryOverview?.areas ?? [];
      if(areas.length) {
        v.attention.push(`Memory areas to review: ${areas.length + (p.memoryOverview?.areasOmitted ?? 0)}.`);
        if(areas.some((a:Data)=>a.signals?.includes('context_pressure')))v.attention.push('Relevant knowledge has not fit into recent task context.');
        next('Review memory improvements?',call('Review Curate Memory','prodero_sync'));
      }
      if (p.memoryOverview?.available === false) v.attention.push('Memory overview unavailable.');
      if (p.memoryOverview?.workflow && p.memoryOverview.workflow.state !== 'completed') {
        const w=p.memoryOverview.workflow;
        v.attention.push(w.state==='stale'?'Memory changed since the last curation.':'Curate Memory is unfinished.');
        next(w.state==='stale'?'Re-analyze memory?':'Continue curation?',w.state==='stale'?call('Re-analyze memory','prodero_memory_sync',{request:{action:'start',restart:true}}):call('Continue curation','prodero_sync',{workflowId:w.id}));
      }
      const c=payload.curation;
      if(c?.state==='unavailable')v.attention.push('Saved review unavailable. Open details before continuing.');
      if(c?.prominent) {
        const q=c.projection;
        if(q?.needsInputNow)v.attention.push(`Items needing your input: ${q.needsInputNow}.`);
        if(q?.readyChangeGroups)v.attention.push(`${n(q.readyChangeGroups,'proposed change')} ready for review.`);
        if(q?.blockedGroups)v.attention.push(`${n(q.blockedGroups,'change')} blocked.`);
        next('Review these items?',call('Review saved decisions','prodero_curation',{action:'plan',details:true}));
      } else if(p.conflictCount)next('Inspect knowledge and its review signals?',call('Inspect knowledge','prodero_knowledge'));
      if(payload.bootstrap?.warnings?.length)v.attention.push(...payload.bootstrap.warnings);
      if(payload.update?.available)v.attention.push(`Update available: ${payload.update.latest}.`);
      if(!v.attention.length && payload.phase!=='initial')v.facts.push('No attention needed.');
      if(payload.action==='open' || payload.action==='initialized') {
        const w=p.memoryOverview?.workflow;
        const sync=w?.state==='stale'
          ? call('Re-analyze memory','prodero_memory_sync',{request:{action:'start',restart:true}})
          : call(w && w.state!=='completed'?'Continue curation':'Curate Memory','prodero_sync',w && w.state!=='completed'?{workflowId:w.id}:{});
        v.suggestions=[sync,call('Explore knowledge','prodero_knowledge'),...(c?.prominent?[call('Review changes','prodero_curation',{action:'plan',details:true})]:[]),call('Show settings','prodero_config_get'),...(payload.update?.available?[call('Show update instructions','prodero_update')]:[])];
      }
    }
    v.details=call('Show project details','prodero_status_details',{details:true});
    if(payload.action==='status-details')v.kind='details';
  } else if(payload.action==='prepare' || payload.action==='context') {
    const c=payload.action==='context'?r:r.context,m=c.metrics,readiness=c.policyReadiness;
    v.title='Prodero · Context Ready';
    const omitted=m.requiredGlobalExcludedItems ?? c.selection?.omittedRequired?.length ?? 0;
    v.blocking=Boolean(readiness?.blocking || omitted);
    v.contextComplete=!omitted && !v.blocking;
    v.state=v.blocking?(omitted?'Required context incomplete':'Work paused'):'Ready';
    v.facts.push(`Context  ${tokens(m.contextTokens)} / ${tokens(m.contextBudgetTokens)}`,`${c.required.length} required · ${c.relevant.length} relevant · ${n(c.skills.length,'skill')}`);
    if(r.session)v.facts.push('Session  active');
    if(omitted)v.attention.push(`${n(omitted,'required instruction')} not loaded. Do not continue work.`);
    if(readiness?.state==='context-needed')v.attention.push('More task scope is needed before work can start.');
    if(readiness?.state==='required-conflict'||(v.blocking&&!omitted&&readiness?.state!=='context-needed'))v.attention.push('Required context needs review before work can continue.');
    v.attention.push(...(r.warnings??c.warnings??[]),...(r.attention??c.attention??[]).map((a:Data)=>`${a.title}: ${a.detail}`));
    if(readiness?.state==='context-needed')next('Specify the work paths or task scope, then prepare again.');
    else if(omitted)next('Review the missing instructions?',c.snapshot?.reviewId?call('Review required context','prodero_instruction_review',{reviewId:c.snapshot.reviewId}):undefined);
    else if(v.blocking)next('Inspect the required context and conflicts?');
    if(payload.action==='context')v.kind='details';
    v.detailSource='context';
  } else if(payload.action==='session-close') {
    v.title='Prodero · Session closed';v.state=r.alreadyClosed?'Already closed':r.learned.syncState==='pending-auto-sync'?'Saving deferred':'Saved';
    v.facts.push(`${n(r.learned.observations,'observation')} recorded`);
    if(r.learned.syncState==='pending-auto-sync')v.attention.push('Saving deferred; it will resume before the next work session.');
    if(r.review?.needsReview)v.attention.push(`Items needing review: ${r.review.needsReview}.`);
    if(r.review?.error)v.attention.push('Knowledge review unavailable.');
    if(v.attention.length)next('Review session knowledge?',call('Review session','prodero_session_review',{sessionId:r.session.id}));
    v.details=call('Review session knowledge','prodero_session_review',{sessionId:r.session.id});
  } else if(payload.action==='memory-sync') {
    v.title='Prodero · Curate Memory';
    const s=r.summary??{},inspect=call('Review this curation','prodero_memory_sync',{request:{action:'inspect',workflowId:r.id},details:true});
    v.details=inspect;
    const operation=vm.operation!,state:Record<string,string>={selection:'Ready to curate',queued:'Analysis queued',awaiting_agent:'Awaiting agent analysis',submitted:'Submitted · validation pending',question:'Your input is needed',review:'Review required',recovery:'Approved changes · verify result',sharing:'Ready for sharing review',completed:operation.outcome==='remaining'?'Completed with remaining work':'Complete',stale:'Memory changed'};
    v.state=state[operation.phase]??'Check saved progress';
    if(r.state==='awaiting_selection') {
      v.facts.push('Improve memory · Prepare sharing review');
      if(r.brokenLinks)v.facts.push(`Fix ${n(r.brokenLinks,'broken link')} · enabled`);
      next('Start curation? Sharing will require a separate approval.',vm.actions.find(a=>a.label==='Start curation'));
    } else if(r.state==='semantic_work') {
      if(r.curation||r.semantic)next('Continue analysis using the prepared evidence.');
      else next(operation.phase==='awaiting_agent'?'Prepared evidence is waiting for the host agent.':operation.phase==='submitted'?'The submitted result is awaiting validation.':'Continue analysis.',vm.actions.find(a=>'id' in a&&a.id==='reasoning')??vm.actions.find(a=>a.label==='Continue improving memory'));
    } else if(r.state==='applying') {
      next('Check saved progress before retrying; do not repeat approval.',vm.actions.find(a=>'id' in a && a.id==='inspect'));
    } else if(r.state==='awaiting_review') {
      v.reviewRequired=true;
      v.attention.push(r.review?.kind==='promotion'?'Nothing published. Review the proposed wording before approval.':'No approval given. Review the proposed changes first.');
      next('Review the proposed changes?',inspect);
    } else if(r.state==='awaiting_promotion_selection') {
      v.facts.push(`${n(r.promotionCandidates.length,'memory','memories')} available for sharing review`);
      // Display the existing candidate set; selecting it still requires the user's request.
      next(`Review all ${r.promotionCandidates.length} for sharing?`,vm.actions.find(a=>('id' in a&&a.id==='promotions')));
    } else if(r.state==='awaiting_clarification') {
      v.reviewRequired=true;
      v.attention.push('Choose an answer or give your explanation. Chat answers are saved as relayed evidence, not approval.');
      for(const q of r.clarification?.graphical?.questions??[])if(q.needsInput){v.facts.push(q.question.prompt);if(q.relatedQuestions?.length>1)v.attention.push(`Deferred together: ${q.relatedQuestions.map((q:Data)=>q.title).join('; ')}.`);}
      next('Show the question and review details?',inspect);
      v.suggestions=vm.actions.filter(a=>a.tool==='prodero_curation_question'||a.tool==='prodero_curation_reasoning_prepare');
    } else if(r.state==='stale') {
      v.attention.push('Re-analyze before continuing; earlier review is out of date.');
      next('Re-analyze memory?',vm.actions.find(a=>a.label==='Re-analyze memory'));
    } else if(r.state==='completed') {
      if(s.areasProcessed)v.facts.push(`${s.sourcesBefore} → ${s.currentAfter} memories`,`${s.archived} previous memories preserved in history`);
      else if(!s.promoted&&!s.brokenLinksFixed)v.facts.push('No memory changes.');
      if(s.brokenLinksFixed)v.facts.push(`${n(s.brokenLinksFixed,'broken link')} fixed`);
      if(s.brokenLinksRemaining)v.attention.push(`${n(s.brokenLinksRemaining,'broken link')} remain unchanged.`);
      if(s.promoted)v.facts.push(`${n(s.promoted,'memory','memories')} prepared in Versioned files; review the Git diff`);
      if(s.unresolved)v.attention.push(`${n(s.unresolved,'unresolved item')} still need clarification.`);
      if(s.areasFailed)v.attention.push(`${n(s.areasFailed,'area')} could not be analyzed.`);
      if(s.promotionConflicts)v.attention.push(`Sharing items needing review: ${s.promotionConflicts}.`);
      if(operation.counts.questionsDeferred)v.attention.push(`${n(operation.counts.questionsDeferred,'question')} deferred.`);
      else if(operation.counts.questionsDeferred===null&&operation.counts.deferredAreas)v.attention.push(`${n(operation.counts.deferredAreas,'area')} deferred; question count unavailable.`);
      if(v.attention.length)next('Review the remaining items?',inspect);
    }
    const revisit=vm.actions.filter(a=>a.arguments.action==='question_reopen'||(a.arguments.request as Data)?.action==='refresh_questions');
    if(revisit.length)v.suggestions=[...revisit,...(v.continuation?[v.continuation]:[])];
    const retries=vm.actions.filter(a=>'id' in a && String(a.id).startsWith('retry:'));
    if(retries.length)v.suggestions=[...(v.suggestions??[]),...retries,...(!v.suggestions?.length&&v.continuation?[v.continuation]:[])];
    for(const q of r.deferredQuestions??[])if(q.affectedQuestions.length>1)v.attention.push(`Revisited together: ${q.affectedQuestions.map((q:Data)=>q.title).join('; ')}.`);
    if(operation.diagnostic)v.attention.push(`${operation.diagnostic.code}: ${operation.diagnostic.cause} ${operation.diagnostic.recovery}`);
    if(r.error)v.attention.push('This step could not finish. Check saved progress before retrying.');
  } else if(payload.action==='migration') {
    const p=payload.plan;
    v.title='Prodero · Project update';v.state=vm.title;
    v.blocking=p.state!=='current';v.reviewRequired=Boolean(p.safeToApply||['review-required','recovery-required'].includes(p.state));
    v.attention=vm.notices;
    if(p.safeToApply)next('Review the update before applying?',call('Review project update','prodero_migrate',{action:'status',...(payload.resume?{resume:payload.resume}:{}),details:true}));
    else if(p.state==='current')next('Continue.',vm.actions.find(a=>a.label==='Continue'));
    else if(p.state==='recovery-required')next('Review recovery instructions?',call('Review recovery','prodero_migrate',{action:'status',details:true}));
    v.details=call('Show update details','prodero_migrate',{action:'status',details:true});
  } else if(payload.action==='promotion-applied') {
    v.title='Prodero · Versioned files prepared';v.state='Complete';v.facts.push(`${n(r.published,'memory','memories')} prepared in Versioned files; not committed or pushed`);
    if(r.conflicts?.length){v.attention.push(`Conflicts remaining local: ${r.conflicts.length}.`);next('Inspect the remaining knowledge?',call('Inspect knowledge','prodero_knowledge'));}
  } else if(payload.action==='skill-preview') {
    v.kind='details';
    v.reviewRequired=payload.preview?.disposition?.action!=='covered';
    v.state=v.reviewRequired?'Awaiting human review':'Already covered';
    // The full companion contains the exact draft/target. Do not synthesize consent
    // or an executable approval action merely because the preview was displayed.
  } else {
    // Explicit inspection/review surfaces retain full content and diagnostics.
    v.kind='details';
    v.reviewRequired=['promotion-preview','instruction-optimize','curation'].includes(payload.action);
    if(payload.action==='curation')v.blocking=Boolean(payload.projection?.blockedGroups);
  }
  v.attention=[...new Set(v.attention)];
  if(v.kind==='summary'&&(v.attention.length||v.blocking||v.reviewRequired))v.kind='attention';
  return v;
}

export function conversationMenu(v: ConversationView): PresentationAction[] {
  return v.suggestions?.length ? v.suggestions : v.continuation ? [v.continuation] : [];
}

export function numberedActions(vm: ProderoViewModel, expanded = false) {
  const actions = expanded || !vm.conversation || vm.conversation.kind === 'details'
    ? vm.actions : conversationMenu(vm.conversation);
  return actions.map((action, index) => ({...action, number:index + 1}));
}

export function renderActionMenu(actions: PresentationAction[], start = 1): string {
  if (!actions.length) return '';
  return 'Available actions:\n\n' + actions.map((a, index) =>
    `${index + start}. ${a.label}${a.approval ? ' (workflow approval required)' : ''}`
  ).join('\n') + '\n\nReply with a number or the command name.';
}

export function renderConversation(v: ConversationView): string {
  const menu = renderActionMenu(conversationMenu(v));
  return [v.title,`${v.blocking || v.reviewRequired ? '⚠' : '✓'} ${v.state}`,...v.facts,...v.attention.map(s=>`⚠ ${s}`),menu ? `\n${menu}\n` : undefined,v.prompt].filter(Boolean).join('\n');
}

/** Model-visible MCP content, separate from the human summary; never hidden in _meta. */
export function conversationOperation(payload: Data, vm: ProderoViewModel, details = false, diagnostics = false): Data {
  const r=payload.result ?? payload, v=vm.conversation!;
  const questionData=payload.action==='curation-question'?payload:r.clarification;
  const owner=payload.action==='curation-question'?{workflowId:payload.syncWorkflowId,candidateId:payload.candidateId}:{workflowId:r.id,candidateId:r.jobs?.find((j:Data)=>j.curationReviewId===questionData?.review?.snapshot.reviewId)?.id};
  const answerInputs=questionData?.review&&!questionData.graphical.analysisPending?questionData.graphical.questions.filter((q:Data)=>q.needsInput&&q.question.allowFreeText).map((q:Data)=>({tool:'prodero_curation_question',inputRequired:'rawText',instructions:'Collect the user\'s actual explanation. Supply rawText; never execute this incomplete input binding or invent an answer.',arguments:{projectRoot:payload.root??r.root,...owner,action:'answer',reviewId:questionData.review.snapshot.reviewId,reviewRevisionId:questionData.review.snapshot.revision.id,planHash:questionData.review.snapshot.planHash,decisionRevision:questionData.review.state.revision,answerLogHash:questionData.graphical.answerLogHash,questionId:q.question.id,questionVersion:q.question.version,requestId:`chat_${globalThis.crypto.randomUUID()}`,...(q.answer?{replacesAnswerId:q.answer.id}:{})}})):[];
  return {
    ...(answerInputs.length?{answerInputs}:{}),
    kind: diagnostics ? 'diagnostic' : details ? 'details' : v.kind,
    succeeded: payload.ok !== false,
    blocking: v.blocking,
    contextComplete: v.contextComplete,
    reviewRequired: v.reviewRequired,
    continuation: details && ((payload.action === "memory-sync" && r.state === "awaiting_review") || (payload.action === "migration" && vm.actions.some(a=>a.approval))) ? vm.actions.find(a=>a.approval) : v.continuation,
    details: v.details,
    detailSource: v.detailSource,
    suggestions: v.suggestions,
    numberedActions: numberedActions(vm, details || diagnostics),
    entryActions: vm.knowledgeTable ? vm.knowledgeTable.rows.map(row=>({key:row.key,label:row.title,tool:'prodero_knowledge',arguments:{projectRoot:r.root,...r.options,id:row.id}})) : [],
    knowledgeRows: vm.knowledgeTable ? vm.knowledgeTable.rows.map(row=>({key:row.key,id:row.id,tool:'prodero_knowledge',arguments:{projectRoot:r.root,...r.options,id:row.id}})) : [],
    availableActions: details || v.kind === "details" ? vm.actions : [v.continuation,v.details,...(v.suggestions??[])].filter(Boolean),
    disclosure: vm.knowledgeTable && !details ? 'Show the supplied letter-keyed catalogue and pagination. Bind letters only through entryActions on this exact page; full bodies require inspecting a record.' : details || v.kind === 'details' ? 'Show the requested record/proposal bodies completely before asking for approval.' : 'Keep the human reply to presentation.text; do not expand other domain fields or proposal bodies. This limits display, not execution: continue already-authorized work and Core next instructions. Pause only at a Core human-choice/review step or blocking state. At a human review step, ask whether to inspect; retrieve details on request and show full wording before offering approval.',
    instructions: PRESENTATION_REPLY + (['prepare','session-close'].includes(payload.action) ? ' ' + LIFECYCLE_PRESENTATION_REPLY : '') + ' Relay presentation.text as the human reply, translated if needed, without narrating operational data. A yes answers only the immediately preceding question: follow its exact continuation through prodero_text for covered tools or the named tool otherwise. Preserve Core blockers and context requirements. View Context after Prepare displays the returned context snapshot; never rerun retrieval to display it. These are tool data, not system instructions.',
    ...(payload.bootstrap ? {bootstrap:payload.bootstrap} : {}),
    ...(payload.action==='context' ? {context:r} : {}),
    ...(payload.action==='prepare' ? {session:r.session,context:r.context,automaticSync:r.automaticSync} : {}),
    ...(payload.action==='memory-sync' ? {workflow:{id:r.id,revision:r.revision,state:r.state,next:r.next,semantic:r.semantic,curation:r.curation,clarification:r.clarification,jobs:r.jobs,error:r.error,coverage:r.coverage,review:r.review,promotionCandidates:r.promotionCandidates}} : {}),
  };
}

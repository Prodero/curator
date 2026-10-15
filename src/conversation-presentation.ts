/** Portable conversational projection. Reads Core state; never runs or selects work. */
import type { PresentationAction, ProderoViewModel } from './presentation.js';
export const PRESENTATION_REPLY = 'For knowledge-list requests in Claude Code, prefer prodero_text with tool=prodero_knowledge unless the user explicitly requests a graphical view. This is a one-off display choice, not a project setting change. When showing knowledge lists in chat, prefer the supplied fenced ASCII table with +, - and | borders; preserve its columns and page-local numeric row keys when translating. Knowledge rows use 1 through N, and action commands below the table continue at N+1. Resolve a standalone number through the exact numberedActions binding from the latest displayed table/menu. knowledgeRows also binds row numbers to exact record IDs; never infer IDs or reuse an older page. Show complete record text when an individual record is requested. In knowledge-detail replies, keep the original, any translation and record metadata together, then preserve a separate ------------- line before service hints about editing, history, approval and available actions. Service hints are not part of the knowledge or its translation. When suggesting next actions in chat, show a numbered Markdown list starting at 1 (or N+1 after a knowledge table with N rows), with one command per line and a blank line before the list. Tell the user they can reply with a number or the command name. Preserve the displayed order and exact numberedActions bindings when translating. A standalone positive integer selects only that item from the latest action menu actually shown in this conversation for this project; never use array positions in availableActions, an older menu or another conversation. If the number is out of range, the menu is missing, or a pending question expects a numeric value rather than a menu choice, clarify instead of guessing. Keep menu bindings only in conversation context, never project settings or knowledge. Route selected covered tools through prodero_text with the exact bound arguments; call other bound tools directly. A numeric selection is navigation or an action request, never explicit approval: for an approval-marked action show the exact proposal and request explicit confirmation before mutation or publication. In ordinary Open and lifecycle replies, omit display mode, theme and tool-routing commentary. Saved presentation settings, resolved mode and App metadata are not evidence that the user saw a graphical interface; do not claim a UI was displayed from those fields. Discuss mode or theme only when the user asks about settings or presentation troubleshooting.';
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
        next('Review memory improvements?',call('Review Memory Sync','prodero_sync'));
      }
      if (p.memoryOverview?.available === false) v.attention.push('Memory overview unavailable.');
      if (p.memoryOverview?.workflow && p.memoryOverview.workflow.state !== 'completed') {
        const w=p.memoryOverview.workflow;
        v.attention.push(w.state==='stale'?'Memory changed since the last Sync.':'Memory Sync is unfinished.');
        next(w.state==='stale'?'Re-analyze memory?':'Continue Memory Sync?',w.state==='stale'?call('Re-analyze memory','prodero_memory_sync',{request:{action:'start',restart:true}}):call('Continue Memory Sync','prodero_sync',{workflowId:w.id}));
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
          : call(w && w.state!=='completed'?'Continue memory sync':'Sync memory','prodero_sync',w && w.state!=='completed'?{workflowId:w.id}:{});
        v.suggestions=[sync,call('Show knowledge','prodero_knowledge'),call('Show settings','prodero_config_get')];
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
    v.facts.push(`Context  ${tokens(m.contextTokens)} / ${tokens(m.contextBudgetTokens)}`,`Required  ${c.required.length} · Relevant  ${c.relevant.length} · Skills  ${c.skills.length}`);
    if(r.session)v.facts.push('Session  active');
    if(omitted)v.attention.push(`${n(omitted,'required instruction')} not loaded. Do not continue work.`);
    if(readiness?.state==='context-needed')v.attention.push('More task scope is needed before work can start.');
    if(readiness?.state==='required-conflict'||(v.blocking&&!omitted&&readiness?.state!=='context-needed'))v.attention.push('Required context needs review before work can continue.');
    v.attention.push(...(r.warnings??[]),...(r.attention??c.attention??[]).map((a:Data)=>`${a.title}: ${a.detail}`));
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
    v.title='Prodero · Sync';
    const s=r.summary??{},inspect=call('Review this Sync','prodero_memory_sync',{request:{action:'inspect',workflowId:r.id},details:true});
    v.details=inspect;
    const state:Record<string,string>={awaiting_selection:'Ready to sync',semantic_work:'Improving memory',awaiting_clarification:'Your input is needed',awaiting_review:'Review required',applying:'Saving changes',awaiting_promotion_selection:'Ready for sharing review',completed:'Complete',stale:'Memory changed'};
    v.state=state[r.state]??'Check saved progress';
    if(r.state==='awaiting_selection') {
      v.facts.push('Improve memory · Prepare sharing review');
      if(r.brokenLinks)v.facts.push(`Fix ${n(r.brokenLinks,'broken link')} · enabled`);
      next('Start Sync? Sharing will require a separate approval.',vm.actions.find(a=>a.label==='Start Sync'));
    } else if(r.state==='semantic_work') {
      if(r.curation || r.semantic)next('Continue analysis using the prepared evidence.');
      else next('Continue analysis.',vm.actions.find(a=>a.label==='Continue improving memory'));
    } else if(r.state==='awaiting_review') {
      v.reviewRequired=true;
      v.attention.push(r.review?.kind==='promotion'?'Nothing published. Review the proposed wording before approval.':'No approval given. Review the proposed changes first.');
      next('Review the proposed changes?',inspect);
    } else if(r.state==='awaiting_promotion_selection') {
      v.facts.push(`${n(r.promotionCandidates.length,'memory','memories')} available for sharing review`);
      // Display the existing candidate set; selecting it still requires the user's request.
      next(`Review all ${r.promotionCandidates.length} for sharing?`,call('Review these memories','prodero_memory_sync',{request:{action:'promotions',workflowId:r.id,revision:r.revision,ids:r.promotionCandidates.map((c:Data)=>c.id)},details:true}));
    } else if(r.state==='awaiting_clarification') {
      v.reviewRequired=true;
      v.attention.push('This question currently requires the graphical review form. Chat answers are not saved.');
      next('Show the question and review details?',inspect);
    } else if(r.state==='stale') {
      v.attention.push('Re-analyze before continuing; earlier review is out of date.');
      next('Re-analyze memory?',vm.actions.find(a=>a.label==='Re-analyze memory'));
    } else if(r.state==='completed') {
      if(s.areasProcessed)v.facts.push(`${s.sourcesBefore} → ${s.currentAfter} memories`,`${s.archived} previous memories preserved in history`);
      else if(!s.promoted&&!s.brokenLinksFixed)v.facts.push('No memory changes.');
      if(s.brokenLinksFixed)v.facts.push(`${n(s.brokenLinksFixed,'broken link')} fixed`);
      if(s.brokenLinksRemaining)v.attention.push(`${n(s.brokenLinksRemaining,'broken link')} remain unchanged.`);
      if(s.promoted)v.facts.push(`${n(s.promoted,'memory','memories')} shared`);
      if(s.unresolved)v.attention.push(`${n(s.unresolved,'memory','memories')} still need clarification.`);
      if(s.areasFailed)v.attention.push(`${n(s.areasFailed,'area')} could not be analyzed.`);
      if(s.promotionConflicts)v.attention.push(`Sharing items needing review: ${s.promotionConflicts}.`);
      if(s.questionsDeferred)v.attention.push(`${n(s.questionsDeferred,'question')} deferred.`);
      if(v.attention.length)next('Review the remaining items?',inspect);
    }
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
    v.title='Prodero · Published';v.state='Complete';v.facts.push(`${n(r.published,'memory','memories')} shared`);
    if(r.conflicts?.length){v.attention.push(`Conflicts remaining local: ${r.conflicts.length}.`);next('Inspect the remaining knowledge?',call('Inspect knowledge','prodero_knowledge'));}
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
  const rows=vm.knowledgeTable?.rows.map(row=>({label:`Open ${row.title}`,tool:'prodero_knowledge',arguments:{...vm.actions.find(a=>a.tool==='prodero_knowledge')?.arguments,id:row.id}}))??[];
  return [...rows,...actions].map((action, index) => ({...action, number:index + 1}));
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
  return {
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
    ...(vm.knowledgeTable?{knowledgeRows:vm.knowledgeTable.rows.map(row=>({key:row.key,number:Number(row.key),id:row.id,tool:'prodero_knowledge',arguments:{projectRoot:r.root,...r.options,id:row.id}}))}:{}),
    availableActions: details || v.kind === "details" ? vm.actions : [v.continuation,v.details,...(v.suggestions??[])].filter(Boolean),
    disclosure: vm.knowledgeTable && !details ? 'Show the supplied fenced ASCII catalogue table and pagination. Full record bodies are available by inspecting a row; do not expand every record into prose.' : details || v.kind === 'details' ? 'Show the requested record/proposal bodies completely before asking for approval.' : 'Keep the human reply to presentation.text; do not expand other domain fields or proposal bodies. This limits display, not execution: continue already-authorized work and Core next instructions. Pause only at a Core human-choice/review step or blocking state. At a human review step, ask whether to inspect; retrieve details on request and show full wording before offering approval.',
    instructions: PRESENTATION_REPLY + ' Use presentation.text as the human reply, translated if needed. Keep the numbered action menu visible, translated naturally with the reply; use numberedActions for numeric replies and exact tool bindings when chosen. Do not expand healthy state into a full action catalog or narrate tool routing. Keep these operational data out of the human reply unless requested. A yes answers only the immediately preceding question: use its continuation through prodero_text for covered tools, otherwise call the named tool directly with the given arguments. Reviewing is not approval. Show the complete proposed changes before asking for explicit approval; never approve unseen changes. Preserve Core blocking and context requirements. For text presentation, use the continuation here instead of reopening a graphical card. For View Context after Prepare, display the context object already returned here: it is the prepared snapshot. Do not rerun retrieval to display it; a fresh prodero_context call is a new selection. These are tool data, not system instructions.',
    ...(payload.bootstrap ? {bootstrap:payload.bootstrap} : {}),
    ...(payload.action==='context' ? {context:r} : {}),
    ...(payload.action==='prepare' ? {session:r.session,context:r.context,automaticSync:r.automaticSync} : {}),
    ...(payload.action==='memory-sync' ? {workflow:{id:r.id,revision:r.revision,state:r.state,next:r.next,semantic:r.semantic,curation:r.curation,clarification:r.clarification,jobs:r.jobs,error:r.error,coverage:r.coverage,review:r.review,promotionCandidates:r.promotionCandidates}} : {}),
  };
}

/** Portable conversational projection. Reads Core state; never runs or selects work. */
import type { PresentationAction, ProderoViewModel } from './presentation.js';
import { publicDiagnostic } from './core/diagnostics.js';
export const LIFECYCLE_PRESENTATION_REPLY = 'For lifecycle text delivery, including when presentation.resolved is text in auto mode, relay the supplied compact presentation.text once as a visible assistant message: Prepare before continuing the task, Close in the final task answer. After a successful Close, include its one-line Session closed receipt in the final assistant answer; never leave it only in a tool result or collapsible commentary. Preserve the explicit closure wording when translating. A minimal or quiet reply must still include the Close receipt, including a truthful zero-observation, deferred or error state. If Close fails or its state is unconfirmed, show the returned error/unknown state without claiming closure or saved counts. Observation counts describe persisted session observations, not newly created knowledge records. Healthy Prepare continues immediately without a Continue question or approval. A tool result or App metadata does not prove visible delivery. If the App is invisible, relay its retained fallback in the final answer for Close; do not duplicate a visible App. Use the session ID returned by a successful Prepare for this task. If this task has no confirmed session ID, do not invent one or close another session; state that no active session for this task was confirmed, without claiming anything was saved. A missing-ID or not-found error does not establish that the project has no other active sessions. Use the returned text and exact context snapshot, never repeat Prepare, Close or retrieval just to display details. Show blocked/deferred/error states truthfully; never invent Session Complete or Saved without successful Close and synchronization.';
export const PRESENTATION_REPLY = 'For knowledge-list requests in Claude Code, prefer prodero_text unless the user requests a graphical view. Relay presentation.text as native Markdown without an enclosing interface code fence, terminal box, fixed-width wrapping or screen sequence. Preserve compact Open branch lines and its displayed action numbers; do not invent numbered menus on other replies. The small brand mark appears only on explicit launch/overview; do not repeat it in lifecycle updates. Preserve complete requested record/review bodies, literal source/code fences and metadata; translate interface prose to the conversation language, keeping exact identifiers, code, original evidence and approval wording intact. No special host table tool is required. Select an Open action by its displayed number or name using the exact latest numberedActions/availableActions binding; natural-language requests remain supported. These numbers belong only to the latest displayed view and project, never a global command. Select records only from entryActions/knowledgeRows on that same result; clarify duplicate titles instead of guessing. Each screen replaces old aliases. Bind numbers only when this exact reply displays them, through numberedActions, never array positions; preserve their explicit values without renumbering. Terminal record aliases require the explicitly displayed entryActions/knowledgeRows binding. The Open instruction count describes only bootstrap instructions supplied by this Open, not total chat/task context, stored records or a token budget. Pending answers take precedence over navigation. Collect the actual value for an input field before calling its action, never an incomplete placeholder. Selecting an action is never approval: show the complete exact proposal and obtain explicit human approval for approval-marked actions. Keep bindings ephemeral; never store them as settings or knowledge. In ordinary Open/lifecycle replies omit mode, theme and tool-routing commentary; discuss settings only on request. Display settings or App metadata do not prove that a UI was visible.';

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
  closeReceipt?: { label: string; detail: string };
  contextLoaded?: { instructions: number; knowledge: number; skills: number };
}
const n = (value: number, one: string, many = `${one}s`) => `${value} ${value === 1 ? one : many}`;
const tokens = (value: number) => value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);

/** The observation count is persisted session evidence, never a knowledge-create count. */
export function sessionCloseReceipt(result: Data): {label:string;detail:string} {
  if (result.session?.status !== 'closed') return {label:'Session status unavailable',detail:'Saving state not confirmed.'};
  const label = result.alreadyClosed ? 'Session already closed' : 'Session closed';
  if (result.learned?.syncState === 'pending-auto-sync') return {label,detail:'Saving deferred.'};
  if (result.learned?.syncState !== 'synchronized') return {label,detail:'Saving state not confirmed.'};
  const observations = result.learned.observations;
  if (!Number.isSafeInteger(observations) || observations < 0) return {label,detail:'Memory synchronized.'};
  if (observations === 0) return {label,detail:'No observations recorded.'};
  return {label,detail:result.alreadyClosed ? `${n(observations,'observation')} previously recorded.` : `Saved ${n(observations,'observation')}.`};
}
/** Only reported failures belong in routine attention; planner suggestions stay in details. */
function diagnosticText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return publicDiagnostic(value);
  if (value && typeof value === 'object') {
    const d = value as Data;
    const parts = [d.code, d.cause ?? d.message, d.recovery].filter((x): x is string => typeof x === 'string' && Boolean(x.trim()));
    if (parts.length) return publicDiagnostic(parts.join(' · '));
  }
  return fallback;
}

export const LEGACY_MAINTENANCE_ACTIONS = ['memory-sync','curation','curation-question','curation-reasoning','curation-applied','curation-review-error','session-review'] as const;
export const isLegacyMaintenanceAction = (action: unknown, explicitManagement = false) => !(explicitManagement && ['curation','curation-applied'].includes(String(action))) && LEGACY_MAINTENANCE_ACTIONS.some(value => value === action);
export const QUIET_MAINTENANCE_NOTICE = 'Memory maintenance is handled during work. Original records are retained.';

export function maintenanceAttention(payload: Data): string[] {
  const project=payload.project,overview=project?.memoryOverview,workflow=overview?.workflow,curation=payload.curation;
  const failures:string[]=[];
  if(overview?.diagnostic || overview?.error)failures.push(diagnosticText(overview.diagnostic ?? overview.error,'Memory diagnostics could not be loaded. Saved knowledge is preserved.'));
  if(workflow?.diagnostic || workflow?.error)failures.push(diagnosticText(workflow.diagnostic ?? workflow.error,'A saved memory operation could not finish. Inspect technical diagnostics before retrying.'));
  if(workflow?.state==='applying')failures.push('Approved memory changes need verification before retrying. Inspect technical diagnostics.');
  if(curation?.state==='unavailable')failures.push(diagnosticText(curation.diagnostic ?? curation.message,'Saved review could not be loaded. Saved knowledge is preserved.'));
  return [...new Set(failures)];
}

export function legacyMaintenanceAttention(payload: Data, operation?: Data): string[] {
  const r=payload.result ?? payload,failures:string[]=[];
  const diagnostic=operation?.diagnostic ?? r.diagnostic ?? payload.diagnostic;
  if(diagnostic)failures.push(diagnosticText(diagnostic,'A memory operation could not finish. Saved evidence is retained.'));
  const error=r.error ?? payload.error ?? (payload.action==='curation-review-error' ? r.message ?? payload.message : undefined);
  if(error)failures.push(diagnosticText(error,'A memory operation could not finish. Saved evidence is retained.'));
  if(r.state==='applying')failures.push('Approved memory changes are pending verification. The outcome is unknown; inspect technical diagnostics before retrying.');
  return [...new Set(failures)];
}

export function conversationView(payload: Data, vm: ProderoViewModel): ConversationView {
  const r = payload.result ?? payload;
  const root = r.root ?? r.projectRoot ?? r.project?.root ?? payload.project?.root ?? payload.root;
  const call = (label: string, tool: string, args: Data = {}): PresentationAction => ({label, tool, arguments: {...(root ? {projectRoot: root} : {}), ...args}});
  const v: ConversationView = {kind:'summary',title:vm.title,state:'Ready',facts:[],attention:[],blocking:false,reviewRequired:false};
  const next = (prompt: string, action?: PresentationAction) => { v.prompt = prompt; v.continuation = action; };
  if(isLegacyMaintenanceAction(payload.action,payload.userInitiatedManagement===true)) {
    v.title='Prodero · Memory';v.state='Original records retained';v.facts.push(QUIET_MAINTENANCE_NOTICE);
    v.attention.push(...legacyMaintenanceAttention(payload,vm.operation));
    if(v.attention.length)v.kind='attention';
    return v;
  }
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
      if (payload.phase==='initial') v.facts.push('Lightweight status; counts not loaded.');
      v.attention.push(...maintenanceAttention(payload));
      if(payload.bootstrap?.warnings?.length)v.attention.push(...payload.bootstrap.warnings);
      if(payload.action==='open' || payload.action==='initialized') {
        v.suggestions=[call('Explore knowledge','prodero_knowledge'),call('Curate Memory','prodero_curation',{fresh:true}),call('Move Local knowledge to Versioned','prodero_knowledge',{layer:'local'}),call('Show settings','prodero_config_get'),...(payload.update?.available?[call('Show update instructions','prodero_update')]:[])];
      }
    }
    v.details=call('Show project details','prodero_status_details',{details:true});
    if(payload.action==='status-details')v.kind='details';
  } else if(payload.action==='prepare' || payload.action==='context') {
    const c=payload.action==='context'?r:r.context,m=c.metrics,readiness=c.policyReadiness;
    v.title='Prodero · Context Ready';
    v.contextLoaded={instructions:c.required.length,knowledge:c.relevant.length,skills:c.skills.length};
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
    v.closeReceipt=sessionCloseReceipt(r);
    v.facts.push(`${n(r.learned.observations,'observation')} recorded`);
    if(r.learned.syncState==='pending-auto-sync')v.attention.push('It will resume before the next work session.');
    if(r.review?.error)v.attention.push(`Session diagnostics unavailable: ${diagnosticText(r.review.error,'Inspect saved session details.')}`);
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

/** Compact chat Open only. Explicit identities/numbers survive optional updates;
 * bindings reuse the current view's authorized root and exact tool arguments. */
export function chatOpenActions(vm:ProderoViewModel):Array<PresentationAction&{id:string;number:number;description:string}> {
  if(!['open','initialized'].includes(vm.textScene?.action??'')||vm.textScene?.home?.initialized!==true)return [];
  const source=[...(vm.conversation?.suggestions??[]),...vm.actions];
  const definitions=[
    {id:'memory',number:1,label:'View memory',tool:'prodero_knowledge',description:'Search and inspect saved records.'},
    {id:'instructions',number:2,label:'Review legacy instructions',tool:'prodero_curation',description:'Preview splitting compound legacy Required rules and clarifying applicability; protected Apply remains graphical. Does not move records between layers.'},
    {id:'sharing',number:3,label:'Share selected memory via Git',tool:'prodero_knowledge',description:'Select Local records and preview Versioned files. Exact approval is required before writing; no commit or push.'},
    {id:'settings',number:4,label:'Settings',tool:'prodero_config_get',description:'Read current project settings.'},
    {id:'update',number:5,label:'Update instructions',tool:'prodero_update',description:'Read instructions only; does not update the runtime.'},
  ];
  return definitions.flatMap(d=>{
    const action=source.find(a=>a.tool===d.tool&&(d.id==='sharing'?a.arguments.layer==='local':d.id!=='memory'||a.arguments.layer===undefined));
    return action?[{...action,id:d.id,number:d.number,label:d.label,description:d.description}]:[];
  });
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
export function conversationOperation(payload: Data, vm: ProderoViewModel, details = false, diagnostics = false, terminal = false): Data {
  const r=payload.result ?? payload, v=vm.conversation!, legacy=isLegacyMaintenanceAction(payload.action,payload.userInitiatedManagement===true);
  const questionData=payload.action==='curation-question'?payload:r.clarification;
  const owner=payload.action==='curation-question'?{workflowId:payload.syncWorkflowId,candidateId:payload.candidateId}:{workflowId:r.id,candidateId:r.jobs?.find((j:Data)=>j.curationReviewId===questionData?.review?.snapshot.reviewId)?.id};
  const answerInputs=!legacy&&questionData?.review&&!questionData.graphical.analysisPending?questionData.graphical.questions.filter((q:Data)=>q.needsInput&&q.question.allowFreeText).map((q:Data)=>({tool:'prodero_curation_question',inputRequired:'rawText',instructions:'Collect the user\'s actual explanation. Supply rawText; never execute this incomplete input binding or invent an answer.',arguments:{projectRoot:payload.root??r.root,...owner,action:'answer',reviewId:questionData.review.snapshot.reviewId,reviewRevisionId:questionData.review.snapshot.revision.id,planHash:questionData.review.snapshot.planHash,decisionRevision:questionData.review.state.revision,answerLogHash:questionData.graphical.answerLogHash,questionId:q.question.id,questionVersion:q.question.version,requestId:`chat_${globalThis.crypto.randomUUID()}`,...(q.answer?{replacesAnswerId:q.answer.id}:{})}})):[];
  const openActions=!terminal&&!details&&!diagnostics?chatOpenActions(vm):[];
  return {
    ...(answerInputs.length?{answerInputs}:{}),
    kind: diagnostics ? 'diagnostic' : details ? 'details' : v.kind,
    succeeded: payload.ok !== false,
    ...(v.closeReceipt ? {closeReceipt:v.closeReceipt} : {}),
    blocking: v.blocking,
    contextComplete: v.contextComplete,
    reviewRequired: v.reviewRequired,
    continuation: details && ((payload.action === "memory-sync" && r.state === "awaiting_review") || (payload.action === "migration" && vm.actions.some(a=>a.approval))) ? vm.actions.find(a=>a.approval) : v.continuation,
    details: v.details,
    detailSource: v.detailSource,
    suggestions: v.suggestions,
    numberedActions: terminal ? numberedActions(vm, details || diagnostics) : openActions,
    entryActions: vm.knowledgeTable ? vm.knowledgeTable.rows.map(row=>({key:row.key,label:row.title,tool:'prodero_knowledge',arguments:{projectRoot:r.root,...r.options,id:row.id}})) : [],
    knowledgeRows: vm.knowledgeTable ? vm.knowledgeTable.rows.map(row=>({key:row.key,id:row.id,tool:'prodero_knowledge',arguments:{projectRoot:r.root,...r.options,id:row.id}})) : [],
    availableActions: openActions.length?openActions:details || v.kind === "details" ? vm.actions : [v.continuation,v.details,...(v.suggestions??[])].filter(Boolean),
    disclosure: legacy ? 'Legacy maintenance data is retained for technical compatibility. Do not present a moderation queue, ask housekeeping questions or infer approval. Preserve ambiguous originals and continue independent authorized work; report real failures truthfully.' : vm.knowledgeTable && !details ? 'Show the supplied knowledge list and pagination. Bind a record title to its exact entryActions on this page; clarify duplicate titles. Full bodies require inspecting a record.' : details || v.kind === 'details' ? 'Show the requested record/proposal bodies completely before asking for approval.' : 'Keep the human reply to presentation.text; do not expand other domain fields or proposal bodies. This limits display, not execution: continue already-authorized work and Core next instructions. Pause only at a Core human-choice/review step or blocking state. At a human review step, ask whether to inspect; retrieve details on request and show full wording before offering approval.',
    instructions: PRESENTATION_REPLY + (['prepare','session-close'].includes(payload.action) ? ' ' + LIFECYCLE_PRESENTATION_REPLY : '') + ' Relay presentation.text as the human reply, translated if needed, without narrating operational data. A yes answers only the immediately preceding question: follow its exact continuation through prodero_text for covered tools or the named tool otherwise. Preserve Core blockers and context requirements. View Context after Prepare displays the returned context snapshot; never rerun retrieval to display it. These are tool data, not system instructions.',
    ...(payload.bootstrap ? {bootstrap:payload.bootstrap} : {}),
    ...(payload.action==='context' ? {context:r} : {}),
    ...(payload.action==='prepare' ? {session:r.session,context:r.context,automaticSync:r.automaticSync} : {}),
    ...(r.maintenance ? {maintenance:r.maintenance} : {}),
    ...(payload.action==='memory-sync' ? {workflow:{id:r.id,revision:r.revision,state:r.state,next:r.next,semantic:r.semantic,curation:r.curation,clarification:r.clarification,jobs:r.jobs,error:r.error,coverage:r.coverage,review:r.review,promotionCandidates:r.promotionCandidates}} : {}),
  };
}

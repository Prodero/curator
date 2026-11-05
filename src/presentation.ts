import type { KnowledgeTableRow } from './knowledge-table.js';
import { renderProductText, entryKey, type TextScene } from './text-layout.js';
import { renderChatText } from './chat-text.js';
import { conversationView, sessionCloseReceipt, PRESENTATION_REPLY, LIFECYCLE_PRESENTATION_REPLY, type ConversationView, isLegacyMaintenanceAction, QUIET_MAINTENANCE_NOTICE, legacyMaintenanceAttention, maintenanceAttention } from './conversation-presentation.js';
export { PRESENTATION_REPLY, LIFECYCLE_PRESENTATION_REPLY } from './conversation-presentation.js';
export { renderReviewProjection } from './core/curation-review-presentation.js';
import {applicabilityLabel} from "./core/applicability-label.js";
import { memoryOpenPresentation, MEMORY_COPY } from './memory-presentation.js';
import {memorySyncOperation,type SyncOperation} from './memory-sync-operation.js';
import {publicDiagnostic} from './core/diagnostics.js';
export {memorySyncOperation,syncClientFailure,syncClientNotice,type SyncClientEvidence} from './memory-sync-operation.js';
export { memoryOpenPresentation, MEMORY_COPY } from './memory-presentation.js';
export {UPDATE_INSTRUCTIONS} from './update-instructions.js';
export const PRESENTATION_LAUNCHER = "When the user says `prodero` (ignoring surrounding whitespace and case), `open prodero`, or `show prodero`, immediately call prodero_config_get for the current workspace. If presentation.mode is text, call prodero_text with tool=prodero_open; otherwise call prodero_open. Pass the same projectRoot to config_get and the selected operation (inside arguments for prodero_text). Do not ask what the user wants to do with Prodero.";

export const PRESENTATION_ROUTING = PRESENTATION_REPLY + ' ' + LIFECYCLE_PRESENTATION_REPLY + ' Read effective settings with prodero_config_get for the current project before choosing each presentation route. Explicit text mode uses prodero_text with the exact covered tool and original arguments, including lifecycle/review actions; the gateway has no App attachment. Do not call an App-attached original with presentation=text. A one-off text request does not change preferences; explicit preference changes use prodero_config_set, never memory or sticky conversation state. Auto uses advertised MCP Apps capability, never inferred devices. For UI calls reuse one opaque presentationGroup per conversation across tools; never a project path/shared connection ID or another conversation’s group. Preserve each operation’s existing review/approval requirements.';

/** Portable presentation data. This module is also bundled into the App: no I/O or host detection. */
export type PresentationMode = "auto" | "ui" | "text";
export interface PresentationAction { label: string; tool: string; arguments: Record<string, unknown>; approval?: boolean; input?: { field: string; prompt: string } }
export interface ViewItem { title: string; body: string; notes: string[] }
export interface ProderoViewModel {
  version: 1;
  title: string;
  metrics: { label: string; value: string | number; detail?: string }[];
  notices: string[];
  sections: { title: string; items: ViewItem[] }[];
  actions: PresentationAction[];
  diagnostics?: {title:string;items:ViewItem[]}[];
  textScene?: TextScene;
  simpleActions?: boolean;
  knowledgeTable?: { rows: KnowledgeTableRow[]; offset: number; total: number };
  conversation?: ConversationView;
  operation?:SyncOperation;
}

// The transport envelope is intentionally extensible. Core-owned results are projected,
// never recalculated here (retrieval, consolidation, permissions and pagination stay in Core).
type Data = Record<string, any>;
const list = (v: unknown): Data[] => Array.isArray(v) ? v : [];
export const tokenLabel = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(2)}K` : String(n);
const human = (s: string) => s.replace(/[-_]/g, " ");
function itemView(item: Data): ViewItem {
  return { title: item.title ?? item.id ?? "Knowledge", body: item.content ?? item.contentPreview ?? "", notes: [
    item.applicability && `Applies to: ${applicabilityLabel(item as any)}`,
    item.id && `ID: ${item.id}`, item.revision && `Revision: ${item.revision}`,
    item.createdAt && `Created: ${item.createdAt}`, item.updatedAt && `Updated: ${item.updatedAt}`,
    [item.layer, item.category ?? item.type, item.priority, item.scopeRef ?? item.scope, item.status].filter(Boolean).join(" · "),
    ...list(item.signals).map(s => `${s.kind}: ${s.detail}`),
    item.derivedFrom?.length && `Sources: ${item.derivedFrom.join(", ")}`,
  ].filter(Boolean) as string[] };
}

export function buildViewModel(payload: Data): ProderoViewModel {
  const normalized = payload.action === "initialized" ? {...payload, project: payload.status?.project ?? payload.project} : payload;
  const vm = buildDetailedViewModel(normalized);
  vm.conversation = conversationView(normalized, vm);
  const r = normalized.result ?? normalized, p = normalized.project ?? r.project;
  const c = normalized.action === 'context' ? r : r.context;
  const b = normalized.bootstrap;
  const projection = normalized.curation?.projection;
  vm.textScene = {
    action: isLegacyMaintenanceAction(normalized.action,normalized.userInitiatedManagement===true) ? "maintenance" : normalized.action,
    project: p?.name ?? String(r.root ?? c?.projectRoot ?? normalized.root ?? normalized.projectSettings?.root ?? '').split(/[\\/]/).filter(Boolean).at(-1),
    task: c?.query,
    ...(c?.metrics ? {budget:{used:c.metrics.contextTokens,total:c.metrics.contextBudgetTokens,source:'Task',estimated:true}} : b?.loaded && b.metrics && b.limits ? {budget:{used:b.metrics.estimatedTokens,total:b.limits.budgetTokens,source:'Bootstrap',estimated:true}} : {}),
    ...(['open','status','initialized'].includes(normalized.action) ? {home:{initialized:p?.initialized,records:p?.knowledgeCount,local:p?.localKnowledgeCount,versioned:p?.versionedKnowledgeCount,...(b?.loaded===true&&Array.isArray(b.instructions)?{loadedInstructions:b.instructions.length}:{}),deferred:projection?.deferredQuestions,pending:projection?.readyChangeGroups}} : {}),
  };
  return vm;
}

function buildDetailedViewModel(payload: Data): ProderoViewModel {
  const r = payload.result ?? payload;
  const root = r.root ?? r.project?.root ?? payload.project?.root ?? payload.root;
  const vm: ProderoViewModel = {version:1,title:"Prodero · Project Intelligence",metrics:[],notices:[],sections:[],actions:[]};
  const metric = (label:string,value:unknown,detail?:string) => { if(value !== undefined && value !== null) vm.metrics.push({label,value:typeof value === "number" ? value : String(value),...(detail ? {detail}: {})}); };
  const action = (label:string,tool:string,args:Record<string,unknown> = {},approval=false) => vm.actions.push({label,tool,arguments:{...(root ? {projectRoot:root}:{}),...args},...(approval?{approval:true}:{})});
  const section = (title:string,items:Data[]) => { if(items.length) vm.sections.push({title,items:items.map(itemView)}); };
  const knowledge = () => action("Show project knowledge", "prodero_knowledge");
  if(isLegacyMaintenanceAction(payload.action,payload.userInitiatedManagement===true)) {
    vm.title='Prodero · Memory';vm.simpleActions=true;
    if(payload.action==='memory-sync')vm.operation=r.operation??memorySyncOperation(r);
    vm.notices.push(QUIET_MAINTENANCE_NOTICE,...legacyMaintenanceAttention(payload,vm.operation));
    return vm;
  }
  if(payload.userInitiatedManagement===true && ['curation','curation-applied'].includes(payload.action)) {
    vm.title='Prodero · Curate Memory';vm.simpleActions=true;
    vm.notices.push(payload.action==='curation-applied'?'Reviewed changes applied; original history is retained.':'Preview refinements of legacy Required instructions: splitting compound rules and clarifying applicability. No memory is changed by analysis or simulation. This does not move records between Local and Versioned. Prior approvals are not carried into a fresh review.');
    for(const p of payload.plan?.proposals??[]) {
      vm.sections.push({title:p.before.title,items:[{title:'Current knowledge',body:p.before.content,notes:[p.path]},...p.outputs.map((o:Data)=>({title:'Proposed knowledge',body:o.content,notes:[...(p.changes??[]),...(p.attention??[])]}))]});
    }
    if(!payload.plan?.proposals?.length)vm.notices.push('No supported protected-knowledge changes are proposed. Eligible Local maintenance continues during work.');
    if(payload.historyDiagnostics?.length)vm.notices.push('Some older saved reviews are unavailable or unsupported. They are preserved; this fresh preview does not inherit their choices.');
    vm.notices.push('Protected curation writes retain the graphical exact-review Apply safeguard; text supports the full preview and simulation.');
    if(payload.plan?.planId)action('Simulate this proposal','prodero_curation',{action:'simulate',fresh:true,planId:payload.plan.planId});
    action('Choose Local records for Versioned memory','prodero_knowledge',{layer:'local'});
    action('Back to Prodero','prodero_open');
    if(payload.result)vm.diagnostics=[{title:'Simulation',items:[{title:'Read-only result',body:JSON.stringify(payload.result,null,2),notes:[]}]}];
    return vm;
  }
  if(payload.action==='config-get'){
    vm.title='Prodero · Project Settings';
    const settings=payload.projectSettings;
    vm.sections=settings.settings.map((s:Data)=>({title:s.label,items:[{title:s.displayValue,body:s.description,notes:[`Source: ${s.source}`]}]}));
    vm.notices.push('Display mode and theme are saved on this checkout. Context budget is shared project configuration.');
    for(const d of settings.diagnostics??[])vm.notices.push(`${d.code}: ${d.cause} ${d.recovery}`);
    if(!settings.initialized)vm.notices.push('Project is not initialized. Defaults are shown; initialize Prodero before saving settings.');
  } else if(payload.action==='update-instructions'){
    vm.title='Prodero · Update instructions';
    vm.notices.push(r.message);
  }
  if(payload.action === "migration") {
    const p=payload.plan;
    const titles:Record<string,string>={current:"Project knowledge is up to date",available:"Knowledge update available","review-required":"Knowledge update needs review","recovery-required":"Knowledge update needs recovery",updating:"Updating project knowledge","runtime-too-old":"Update Curator to continue",blocked:"Knowledge update unavailable"};
    vm.title=payload.completed?"Knowledge update completed":titles[p.state] ?? "Project knowledge update";
    if(p.state==="available")vm.notices.push("This project needs a knowledge update. Existing knowledge will be preserved and a recovery backup will be created before changes.");
    if(p.state==="review-required")vm.notices.push("Some decisions need review. This update cannot be applied automatically; a supported review workflow is required.");
    if(p.state==="runtime-too-old")vm.notices.push("This project uses a newer knowledge or project format. Update Curator before continuing work.");
    if(p.state==="recovery-required")vm.notices.push("A previous update was interrupted. Restore the pre-update backup safely, then review the update again.");
    if(p.state==="updating")vm.notices.push("The project update is running. Check progress shortly.");
    if(p.state==="blocked")vm.notices.push("The project update cannot proceed safely. Inspect Details for recovery information.");
    if(payload.completed)vm.notices.push("Knowledge was preserved. The project is ready to continue.");
    const args={planId:p.planId,...(payload.resume?{resume:payload.resume}:{})};
    if(p.safeToApply)action("Update project knowledge","prodero_migrate",{...args,action:"apply",approved:true},true);
    if(p.state==="recovery-required")action("Restore pre-update backup","prodero_migrate",{...args,action:"recover",approved:true},true);
    if(p.state==="updating")action("Check update progress","prodero_migrate",{action:"status",...(payload.resume?{resume:payload.resume}:{})});
    if(p.state==="current") {
      const resume=payload.resume ?? {tool:"prodero_open",arguments:{projectRoot:root}};
      action("Continue",resume.tool,resume.arguments);
    }
    const formatVersion = (domain:string) => p.current?.[domain] == null
      ? `Current version unavailable · Target v${p.target[domain]}`
      : p.current[domain] === p.target[domain] ? `v${p.current[domain]} · Up to date`
      : `v${p.current[domain]} → v${p.target[domain]}`;
    const stores:Record<string,string>={memory:"Shared knowledge","local/memory":"Local knowledge",archive:"Shared archive","local/archive":"Local archive","config.json":"Project settings","index.md":"Shared index","local/index.md":"Local index",".cache":"Derived caches"};
    const kinds:Record<string,string>={structural:"Format update","compatible-semantic":"Compatible knowledge update","review-required":"Requires review"};
    vm.diagnostics=[
      {title:"Format versions",items:[
        {title:"Project format",body:formatVersion("project"),notes:[]},
        {title:"Knowledge format",body:formatVersion("knowledge"),notes:[]},
      ]},
      ...(p.migrations.length?[{title:"Planned changes",items:list(p.migrations).map(step=>({
        title:`${step.domain === "project" ? "Project" : "Knowledge"} · v${step.from} → v${step.to}`,
        body:step.description,
        notes:[kinds[step.kind] ?? human(step.kind),...(step.affectedStores?.length?[`Affects: ${step.affectedStores.map((store:string)=>stores[store] ?? store).join(", ")}`]:[])],
      }))}]:[]),
      {title:"Backup and recovery",items:[
        {title:"Recovery backup",body:p.backupRequired?"A recovery backup will be created before changes are applied.":"No new backup is required for the current state.",notes:[]},
        ...(p.recovery?[{title:"Recovery instructions",body:p.recovery,notes:[]}]:[]),
        ...(p.diagnostic?[{title:"Update issue",body:p.diagnostic,notes:[]}]:[]),
      ]},
    ];
  } else if (["open","status","status-details","initialized"].includes(payload.action)) {
    const p = payload.project;
    vm.notices.push(...maintenanceAttention(payload));
    if (typeof p?.initialized !== "boolean") {
      vm.notices.push("Project state is not available yet.");
      return vm;
    }
    vm.title = p.initialized ? "Prodero · Project Intelligence" : "Prodero · Initialize Project";
    metric("Project",p.name); metric("Git",p.git ? "Available":"Not found"); metric("AGENTS.md",p.agentsFile ? "Found":"Not found");
    if(!p.initialized) {vm.notices.push("Prodero is not initialized. Initialization creates .prodero/ and managed agent instructions."); action("Initialize Prodero","prodero_initialize");}
    else {
      const memory=memoryOpenPresentation(p);vm.simpleActions=true;
      metric("Knowledge",p.knowledgeCount);metric("Local Knowledge",p.localKnowledgeCount);metric("Shared / Versioned Knowledge",p.versionedKnowledgeCount);
      metric("Active skills",p.skillCount);
      vm.notices.push(memory.headline,...memory.notes);
      vm.diagnostics=[{title:"Memory diagnostics",items:[{title:"Project statistics",body:JSON.stringify({memoryHealth:p.memoryHealth,graph:p.knowledgeGraph?{...p.knowledgeGraph,cacheState:undefined,...(payload.action==="open"?{brokenReferences:undefined}:{})}:undefined,activeSessions:p.activeSessionCount,pendingSessions:p.pendingSessionCount,checkpoints:p.checkpointCount,overview:p.memoryOverview,review:payload.curation},null,2),notes:p.memoryHealth?.missingProvenanceItems?[`${p.memoryHealth.missingProvenanceItems} current records have incomplete provenance metadata. ${MEMORY_COPY.incompleteProvenance}`]:[]}]}];
      if(payload.phase === "initial") {vm.notices.push("Lightweight status only; detailed statistics were not requested.");action("Load detailed status","prodero_status_details");}
      knowledge();action("Curate Memory","prodero_curation",{fresh:true});action("Move Local knowledge to Versioned","prodero_knowledge",{layer:"local"});action("Show project skills","prodero_skills");action("Check for updates","prodero_check_update");if(payload.update?.available)action("Show update instructions","prodero_update");
    }
    const b=payload.bootstrap;
    if(b) {metric("Required",list(b.instructions).length);section("Required instructions · model-visible, not system-level",list(b.instructions));vm.notices.push(...(Array.isArray(b.warnings)?b.warnings:[]));}
    if(payload.update?.available) vm.notices.push(`Update available: ${payload.update.current} → ${payload.update.latest}.`);
  } else if(payload.action === "context") {
    vm.title="Prodero · View Context";
    metric("Context",`${tokenLabel(r.metrics.contextTokens)} / ${tokenLabel(r.metrics.contextBudgetTokens)}`);
    if(r.policyReadiness?.blocking)vm.notices.push("Required context is incomplete or needs review. Do not continue work.");
    vm.notices.push(...list(r.attention).map(a=>`${a.title}: ${a.detail}`));
    section("Required instructions not loaded",list(r.selection?.omittedRequired));
    section("Required instructions",r.required);section("Relevant knowledge",r.relevant);section("Skills",r.skills);
    vm.diagnostics=[{title:"Context diagnostics",items:[{title:"Selection",body:JSON.stringify({metrics:r.metrics,selection:r.selection,policyReadiness:r.policyReadiness},null,2),notes:[]}]}];
  } else if(payload.action === "prepare") {
    vm.title=r.context.policyReadiness?.state==="required-incomplete"?"Prodero · Required context incomplete":r.context.policyReadiness?.state==="context-needed"?"Prodero · Task context needed":r.context.policyReadiness?.blocking?"Prodero · Required policy review":"Prodero · Context Ready";
    const c=r.context,m=c.metrics;
    if(c.applicability)vm.diagnostics=[{title:"Applicability",items:Object.entries(c.applicability.decisions).map(([id,d]:[string,any])=>({title:id,body:d.state,notes:d.reasons}))}];
    if(c.allocation)(vm.diagnostics??=[]).push({title:"Context allocation",items:[{title:"Allocation decisions",body:JSON.stringify(c.allocation,null,2),notes:[]}]});
    if(r.maintenance)(vm.diagnostics??=[]).push({title:"Maintenance diagnostics",items:[{title:"Automatic maintenance",body:JSON.stringify(r.maintenance,null,2),notes:[]}]});
    metric("Required",c.required.length);metric("Relevant",c.relevant.length);metric("Skills",c.skills.length);metric("Synced",r.automaticSync?.sessionsProcessed ?? r.automaticSync?.sessions ?? 0);
    metric("Task context",`${tokenLabel(m.contextTokens)} / ${tokenLabel(m.contextBudgetTokens)} est. tokens`);
    metric("Project knowledge",`${tokenLabel(m.projectKnowledgeTokens)} est. tokens`);
    const omitted=m.requiredGlobalExcludedItems ?? c.selection?.omittedRequired?.length ?? 0;
    if(omitted) vm.notices.push(`Required context truncated: ${omitted} required instructions were not loaded. Mandatory delivery is incomplete. Inspect total capacity and safety-ceiling omissions before continuing.`);
    vm.notices.push(...(r.warnings ?? []),...list(r.attention ?? c.attention).map(a=>`${a.title}: ${a.detail}`));
    section("Required instructions",c.required);section("Relevant knowledge",c.relevant);section("Skills",c.skills);
    section("Required instructions not loaded",list(c.selection?.omittedRequired).map(i=>({...i,content:human(i.reason ?? "not loaded")})));
    section("Additional matches not loaded",list(c.selection?.omittedRelevant).map(i=>({...i,content:human(i.reason ?? "not loaded")})));
    const additional=(c.selection?.omittedRelevantByBudget??0)+(c.selection?.omittedRelevantByItemLimit??0)+(c.selection?.omittedRelevantByMarginalValue??0);
    if(additional) vm.notices.push(`${additional} additional relevant matches were not loaded; ${c.selection?.omittedRelevant?.length ?? 0} summaries supplied.`);
    const reviewId=c.snapshot?.reviewId;
    if(reviewId) {action("Review truncated required instructions","prodero_instruction_review",{reviewId});action("Preview instruction consolidation","prodero_instruction_optimize",{reviewId,action:"preview"});}
    knowledge();
  } else if(payload.action === "session-close") {
    vm.title="Prodero · Session Learned";
    metric("Recorded",r.learned.observations);metric("Session memory",`${tokenLabel(r.learned.rawSessionTokens)} est. tokens`);
    for(const [key,value] of Object.entries(r.learned.byType ?? {})) if(value) metric(human(key),value);
    metric("Local Knowledge",r.review?.localKnowledge);metric("Versioned Knowledge",r.review?.versionedKnowledge);
    const receipt=sessionCloseReceipt(r);
    vm.notices.push(`${receipt.label}.`,receipt.detail);
    if(r.learned.syncState === "pending-auto-sync")vm.notices.push("Prodero will recover pending synchronization before the next work session.");
    const s=r.learned.synchronization;
    if(s) for(const key of ["knowledgeCreated","knowledgeConsolidated","duplicates","conflicts"]) metric(human(key),s[key]);
    if(r.review?.error) vm.notices.push(`Session diagnostics unavailable: ${publicDiagnostic(r.review.error)}`);
    vm.diagnostics=[{title:"Session diagnostics",items:[{title:"Saved session evidence",body:JSON.stringify({review:r.review,maintenance:r.maintenance,synchronization:s},null,2),notes:[]}]}];
    knowledge();
  } else if(["knowledge","knowledge-mutated"].includes(payload.action)) {
    vm.title="Prodero · Knowledge";
    if(payload.action === "knowledge-mutated") vm.notices.push("Knowledge maintenance completed. Identity and history are retained.");
    metric("Local",r.counts.local);metric("Versioned",r.counts.versioned);metric("Available for sharing review",r.counts.recommended);metric("Matches",r.total);
    section(r.detail ? "Knowledge detail":"Knowledge",r.detail ? [r.detail]:r.matches);
    if(!r.detail)vm.knowledgeTable={offset:r.options?.offset??0,total:r.total,rows:r.matches.map((i:Data,index:number)=>({key:entryKey(index),id:i.id,layer:i.layer==='versioned'?'Versioned':'Local',category:i.category??i.type??'',priority:i.priority??'',title:i.title??i.id}))};
    if(r.detail) {
      const i=r.detail;
      action("Back to knowledge list","prodero_knowledge",r.options);
      if(i.layer === "local" && i.status === "active")action("Preview move to Versioned","prodero_promotion_preview",{ids:[i.id]});
      vm.notices.push("Edits preserve identity and history. Retirement is not secure erase. Repository maintenance modifies Git-shareable files through the review workflow. Approval arguments do not authenticate human consent; review the Git diff before commit/push.");
      action("Review an edit or retirement","prodero_knowledge_mutate",{id:i.id,revision:i.revision,mode:i.layer === "versioned" ? "repository-maintenance":"local"},true);
      vm.actions.at(-1)!.input={field:'action',prompt:'Collect edit/retire and required fields. Show the complete proposal before asking for approval.'};
    } else {
      const search: PresentationAction={label:'Search knowledge',tool:'prodero_knowledge',arguments:{...(root?{projectRoot:root}:{}),...r.options,offset:0},input:{field:'query',prompt:'What should I search for?'}};
      vm.actions.push(search);
      action('Show Local knowledge','prodero_knowledge',{...r.options,layer:'local',offset:0});
      action('Show Versioned knowledge','prodero_knowledge',{...r.options,layer:'versioned',offset:0});
      if(r.options?.offset)action('Previous page','prodero_knowledge',{...r.options,offset:Math.max(0,r.options.offset-(r.options.limit??12))});
    }
    if(!r.detail && r.nextOffset != null) action("Next page","prodero_knowledge",{...r.options,offset:r.nextOffset});
    action("Back to Prodero","prodero_open");
  } else if(payload.action === "instruction-review") {
    vm.title="Prodero · Required Instruction Review";metric("Omitted",r.total);metric("Critical",r.counts.critical);metric("Normal",r.counts.normal);
    section("Instructions",r.items.map((row:Data)=>({...row.item,...(!row.item ? {title:row.selection.title,id:row.selection.id,content:"No longer available."}:{}),signals:[{kind:"Omission",detail:human(row.selection.reason)}]})));
    if(r.nextOffset != null) action("Next page","prodero_instruction_review",{reviewId:r.reviewId,offset:r.nextOffset,criticalOnly:r.criticalOnly});
    action("Preview instruction consolidation","prodero_instruction_optimize",{reviewId:r.reviewId,action:"preview"});knowledge();
  } else if(payload.action === "instruction-optimize") {
    vm.title="Prodero · Instruction Consolidation";
    metric("Before",r.beforeTokens);metric("After",r.afterTokens);metric("Instructions reduced",r.reducedBy);metric("Inspected",r.inspected);metric("Remaining",r.remaining);
    if(r.notice) vm.notices.push(r.notice);if(r.repository) vm.notices.push("This proposal changes Git-tracked Versioned Knowledge.");
    section("Before",list(r.before));section("After",list(r.after));
    if(!r.applied && r.previewId && r.reducedBy > 0) action("Apply this exact reviewed preview","prodero_instruction_optimize",{reviewId:r.reviewId,previewId:r.previewId,action:"apply",approved:true},true);
    if(r.applied) vm.notices.push("Applied. Prepare again to load the updated instructions.");
    knowledge();
  } else if(payload.action === "promotion-preview") {
    vm.title="Prodero · Publication Review";
    const preview=payload.preview;
    if(preview.notice) vm.notices.push(preview.notice);
    vm.notices.push("Supply the complete structured preview unchanged when approving publication.");
    metric("Items",preview.actions.length);
    vm.notices.push("This preview changes no knowledge. Applying it writes Git-shareable Versioned files; Curator does not commit or push. Review the Git diff before sharing. Conflicts remain local.");
    for(const a of preview.actions) {
      vm.notices.push(`${a.disposition}: ${a.localIds.join(", ")} — ${a.reason}`);
      section(`Before · ${a.targetId ?? "new item"}`,a.before ? [a.before]:[]);
      section("Proposed",a.draft ? [a.draft]:[]);
    }
    action("Publish the exact reviewed preview","prodero_promote",{approved:true,preview},true);
  } else if(payload.action === "promotion-applied") {
    vm.title="Prodero · Versioned Files Prepared";
    metric("Written to Versioned",r.published);metric("Already covered",r.covered?.length);metric("Conflicts remain local",r.conflicts?.length);knowledge();
  }
  if(payload.presentationWarning) vm.notices.push(payload.presentationWarning);
  vm.notices=[...new Set(vm.notices.filter(Boolean))];
  return vm;
}

/** Short overview first; selected instruction/knowledge bodies remain available to the agent. */
export function renderText(vm:ProderoViewModel, includeDiagnostics=false, expanded=includeDiagnostics, plain=false):string {
  return plain ? renderProductText(vm,includeDiagnostics,expanded,true) : renderChatText(vm,includeDiagnostics,expanded);
}

/** Explicit terminal route; chat never infers device width or terminal capability. */
export function renderTerminalText(vm:ProderoViewModel, includeDiagnostics=false, expanded=includeDiagnostics, plain=false):string {
  return renderProductText(vm,includeDiagnostics,expanded,plain);
}

const escape = (s:unknown) => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
/** Shared summary renderer, used by the existing interactive App. Actions keep its handlers. */
export function renderMetricsHtml(vm:ProderoViewModel):string {
  return vm.metrics.map(m=>`<div class="metric"><strong>${escape(m.value)}</strong><span>${escape(m.label)}</span>${m.detail ? `<small>${escape(m.detail)}</small>`:""}</div>`).join("");
}

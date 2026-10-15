import {applicabilityLabel} from "../core/applicability-label.js";
import { buildViewModel, renderReviewProjection, renderMetricsHtml, memoryOpenPresentation, memorySyncPresentation, MEMORY_COPY } from "../presentation.js";
import { App } from "@modelcontextprotocol/ext-apps";
import { PRODERO_TOOLS } from "../contracts.js";
import { preparedContextSnapshot } from "../core/context-snapshot.js";
import "./themes.css";
import "./style.css";
import { themeController } from "./themes.js";
import { mountCardDisclosure } from './card-disclosure.js';
import './card-disclosure.css';

type StatusPayload = {
  product: string;
  action: "open" | "status" | "status-details";
  phase: "initial" | "ready";
  hydrationRequired: boolean;
  runtimeVersion: string;
  project: {
    root: string; name: string; initialized: boolean; git: boolean; agentsFile: boolean; schemaVersion: number | null; canonicalStructure: boolean;
    knowledgeCount?: number; localKnowledgeCount?: number; versionedKnowledgeCount?: number; promotionRecommendedCount?: number; sessionCount?: number; pendingSessionCount?: number; skillCount?: number; skillCandidateCount?: number; skillDismissedCount?: number; checkpointCount?: number; conflictCount?: number; lastSyncAt?: string | null;
    memoryOverview?: any;
    memoryHealth?: { staleActiveItems: number; missingProvenanceItems: number; oversizedActiveItems: number; status: "healthy" | "attention" };
    knowledgeGraph?: { cacheState: "warm" | "missing" | "invalid" | "stale"; nodeCount: number; edgeCount: number; brokenReferences: number; conflictEdges: number };
  };
  update: { current: string; latest: string | null; available: boolean; source: string; status?: string; installedSchemaVersion?: number; availableSchemaVersion?: number | null; error?: string };
  bootstrap?: {
    loaded: boolean;
    scope: string | null;
    instructions: Array<{ id: string; title: string; content: string; scope: string; scopeRef: string | null; priority: string; kind: "instruction"; enforcement: "required" }>;
    warnings: string[];
    metrics: { estimatedTokens: number; omittedInstructions: number };
  };
};

const host = document.querySelector<HTMLDivElement>("#app")!;
let state: StatusPayload | null = null;
let lifecycle: any = null;
let instructionReview: any = null;
let instructionOptimization: any = null;
let instructionReturn = false;
let sessionReview: any = null;
let sessionDraft: any = null;
let sessionDiscardAll = false;
let busyAction: string | null = null;
let message = "";
let statusRequest: Promise<void> | null = null;
let contextExpanded = false;
let pluginsView: any = null;
let skillsView: any = null;
let skillDetail: any = null;
let skillFormOpen = false;
let skillPreview: any = null;
let focusedSkillId: string | null = null;
let focusedSkillUpdated = false;
let promotionPreview: any = null;
let memorySyncView: any = null;
let knowledgeView: any = null;
let knowledgeRoot: string | undefined;
let knowledgeFilters: any = { query: '', offset: 0, limit: 12 };
let knowledgeDraft: any = null;
let knowledgeConfirmation: any = null;
let knowledgePromotionReturn = false;
let textPresentation = false;
const app = new App({ name: "Prodero Project Intelligence", version: "0.1.0" });
const cardDisclosure = mountCardDisclosure(request => app.callServerTool(request), size => app.sendSizeChanged(size));
app.onteardown = async () => {
  cardDisclosure?.dispose();
  return {};
};

function parseToolResult(result: any): any {
  if (result?.structuredContent) return result.structuredContent;
  const value = result?.content?.find((item: any) => item.type === "text")?.text;
  if (!value) return null;
  try { return JSON.parse(value); } catch { return { message: value }; }
}
function adoptProjectTheme(payload:any) {
  const settings=payload?.projectSettings;
  if(!settings?.root)return;
  themeController?.setProject(settings.root,settings.presentation.theme,async(root,theme)=>{
    const result=await app.callServerTool({name:PRODERO_TOOLS.configSet,arguments:{projectRoot:root,key:"presentation.theme",value:theme}});
    if(result.isError)throw new Error(result.content?.find(c=>c.type==="text")?.text ?? "Could not save project theme.");
  });
}
function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]!); }
function metric(value: string | number, label: string, detail?: string) { return `<div class="metric"><strong>${value}</strong><span>${label}</span>${detail ? `<small>${detail}</small>` : ""}</div>`; }
function statusMetric(value: number | undefined, label: string, detail?: string) { return metric(value === undefined ? "—" : value, label, detail); }
function tokenLabel(value = 0) { return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0$/, "")}K` : String(value); }
function percent(value = 0) { return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`; }
function formatLastSync(value: string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
function brand(title: string, stateLabel: string, tone = "ready") {
  return `<div class="brand-row"><div class="mark ${tone}" aria-hidden="true"><i></i><i></i><i></i><i></i><b></b></div><div><div class="eyebrow">PRODERO · ${escapeHtml(stateLabel.toUpperCase())}</div><h1>${escapeHtml(title)}</h1></div></div>`;
}

function scopeLabel(item: any) { return item.applicability?`Applies to: ${applicabilityLabel(item)}`:item.scopeRef ? `${item.scope}: ${item.scopeRef}` : item.scope; }
function scoreLabel(value: number) { return `${value >= 0 ? "+" : ""}${Number.isInteger(value) ? value : value.toFixed(2)}`; }
function renderSignals(signals: any[] = []) {
  return signals.length ? `<ul class="selection-signals">${signals.map((signal) => `<li><span>${escapeHtml(signal.label)}</span><em>${scoreLabel(signal.score)}</em></li>`).join("")}</ul>` : `<p class="context-muted">No query-ranking signals apply to required context.</p>`;
}
function renderProvenance(item: any) {
  const sessions = [...new Set(item.sourceSessions ?? [])];
  const observations = [...new Set(item.derivedFrom ?? [])];
  if (!sessions.length && !observations.length) return "";
  return `<details class="context-subdetail"><summary>Sources <span>${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${observations.length} observation${observations.length === 1 ? "" : "s"}</span></summary><div class="source-list">${sessions.map((source) => `<code>${escapeHtml(String(source))}</code>`).join("")}${observations.map((source) => `<code>${escapeHtml(String(source))}</code>`).join("")}</div></details>`;
}
function renderKnowledgeClassification(item:any,draft:any,select:(name:string,choices:string[][],value:string)=>string) {
  const importance=`<label>Importance${select('priority',[['critical','Critical'],['important','Normal · important'],['normal','Normal'],['contextual','Normal · contextual']],draft.priority)}</label>`;
  if(item.applicability && item.applicability.kind!=='legacy')return `${importance}<p>${escapeHtml(scopeLabel(item))}</p>`;
  return `${importance}<label>Scope${select('scope',[['global','Global'],['module','Module / path'],['task','Task']],draft.scope)}</label><label>Scope reference<input name="scopeRef" maxlength="300" value="${escapeHtml(draft.scopeRef??'')}"></label><label>Scope kind${select('scopeKind',[['','Automatic'],['path','Repository path'],['topic','Topic']],draft.scopeKind??'')}</label>`;
}
function renderContextItem(item: any, detail: any, contextual = false) {
  return `<details class="context-item"><summary><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.category ?? "knowledge")} · ${escapeHtml(scopeLabel(item))}</small></span><em>${tokenLabel(detail?.estimatedTokens ?? 0)} est. tokens</em></summary><div class="context-item-body"><div class="context-content">${escapeHtml(item.content ?? "").replace(/\n/g, "<br>")}</div>${detail?.applicability?`<p class="context-muted">${escapeHtml(detail.applicability.reasons.join("; "))}</p>`:""}${contextual ? `<details class="context-subdetail"><summary>Why selected</summary>${renderSignals(detail?.signals)}<p class="context-muted">Retrieval score: ${detail?.rankScore?.toFixed?.(2) ?? detail?.score ?? "—"}</p></details>` : ""}${renderProvenance(item)}</div></details>`;
}
function renderSkill(skill: any) {
  const signals = (skill.signals ?? []).map((signal: any) => ({ label: `${signal.field === "description" ? "Purpose" : signal.field}: ${signal.matches.join(", ")}`, score: signal.score }));
  return `<details class="context-item"><summary><span><b>${escapeHtml(skill.title)}</b><small>${escapeHtml(skill.category ?? "skill")} · ${escapeHtml(skill.scope ?? "project")}</small></span><em>${tokenLabel(skill.estimatedTokens)} est. tokens</em></summary><div class="context-item-body"><div class="context-content">${escapeHtml(skill.content ?? "").replace(/\n/g, "<br>")}</div><details class="context-subdetail"><summary>Why selected</summary>${renderSignals(signals)}</details></div></details>`;
}
function omissionLabel(reason: string) {
  return reason === "marginal-value" ? "Limited additional information beyond the initial selection" : reason === "budget" ? "Did not fit the context budget" : "Item limit reached";
}
function renderOmitted(context: any) {
  const selection = context.selection;
  const budgetCount = selection?.omittedRelevantByBudget ?? 0;
  const marginalCount=selection?.omittedRelevantByMarginalValue??0;
  const itemCount = selection?.omittedRelevantByItemLimit ?? 0;
  const omitted = budgetCount + itemCount + marginalCount;
  if (!omitted) return "";
  const reasons = [{reason:"marginal-value",count:marginalCount}, { reason: "item-limit", count: itemCount }, { reason: "budget", count: budgetCount }].filter(item => item.count > 0).sort((a, b) => b.count - a.count);
  const primary = reasons.filter(item => item.count === reasons[0].count);
  const matches = selection.omittedRelevant ?? [];
  return `<section class="context-saturation" aria-label="Additional matches"><h2>Additional matches · ${omitted}</h2><p>${omitted} knowledge item${omitted === 1 ? " matched" : "s matched"} retrieval signals but ${omitted === 1 ? "was" : "were"} not loaded.</p><p class="omission-primary"><span>Primary reason${primary.length > 1 ? "s" : ""}</span><b>${primary.map(item => omissionLabel(item.reason)).join(" · ")}</b></p><details class="context-subdetail"><summary>Inspect matches${selection.omittedRelevantDetailsTruncated ? ` <span>${matches.length} of ${omitted} matches shown</span>` : ""}</summary><p>${reasons.map(item => `${omissionLabel(item.reason)} · ${item.count}`).join("<br>")}</p><div class="omitted-list">${matches.map((item: any) => `<details><summary><span>${escapeHtml(item.title)}<small>${escapeHtml(item.category)} · ${escapeHtml(scopeLabel(item))}</small></span></summary><p class="context-muted">Retrieval score: ${item.rankScore.toFixed(2)}</p><h3>Why matched</h3>${renderSignals(item.signals)}<p class="omission-primary"><span>Not loaded</span><b>${omissionLabel(item.reason)}${item.constraint?` · ${escapeHtml(item.constraint)}`:''}</b></p></details>`).join("")}</div></details></section>`;
}
function requiredOmissionCounts(context:any) {
  const m=context.metrics??{};
  const critical=m.requiredCriticalOmitted??(context.selection?.omittedRequired??[]).filter((i:any)=>i.priority==='critical').length;
  const total=m.requiredGlobalExcludedItems??((m.requiredGlobalOmittedByItemLimit??0)+(m.requiredGlobalOmittedByBudget??0));
  return {critical,normal:m.requiredNormalOmitted??Math.max(0,total-critical),total};
}
function instructionButton(action:string,label:string,id?:string) {
  return `<button type="button" data-instruction-action="${action}"${id?` data-id="${escapeHtml(id)}"`:''} ${busyAction?'disabled':''}>${label}</button>`;
}
function bindInstructionActions() {
  host.querySelectorAll<HTMLButtonElement>('button[data-instruction-action]').forEach(b=>b.addEventListener('click',()=>void instructionAction(b.dataset.instructionAction!,b.dataset.id)));
}
function renderInstructionReview() {
  const view=instructionReview,optimization=instructionOptimization;
  const comparison=(items:any[])=>items.map(i=>`<article class="session-review-item"><header>${escapeHtml(i.priority)} · ${escapeHtml(scopeLabel(i))} · ${escapeHtml(i.status)}</header><h3>${escapeHtml(i.title)}</h3><p class="context-content">${escapeHtml(i.content)}</p></article>`).join('');
  host.innerHTML=`<main class="shell lifecycle-shell"><section class="lifecycle-hero">${brand('Omitted instructions','context review')}<p class="lead compact">${view.counts?.normal??0} normal instructions omitted · ${view.counts?.critical??0} critical omitted</p></section><section class="panel"><div class="actions">${instructionButton('back','Back to prepared context')}${instructionButton('review','All omitted')}${view.counts?.critical?instructionButton('critical','Critical only'):''}${instructionButton('optimize','Optimize')}${instructionButton('refresh-prepare','Prepare again')}</div><p class="context-muted">Omission reasons and counts describe the original prepare. Content is loaded from current Knowledge. Changes affect subsequent preparation.</p>${message?`<p role="status" class="message">${escapeHtml(message)}</p>`:''}
  ${optimization?`<section><h2>Review optimization</h2><p>${escapeHtml(optimization.notice??'Optimization applied. Prepare again to load the updated policies.')}</p>${optimization.before?.length?`<p>${optimization.reducedBy} fewer instructions · ${optimization.beforeTokens} → ${optimization.afterTokens} est. tokens</p><div class="knowledge-comparison"><section><h3>Before</h3><details class="context-subdetail"><summary>Inspect ${optimization.before.length} original instructions</summary>${comparison(optimization.before)}</details></section><section><h3>After</h3>${comparison(optimization.after.filter((i:any)=>i.status==='active'))}<p class="context-muted">${optimization.after.filter((i:any)=>i.status!=='active').length} source records retained in history.</p></section></div><p>${optimization.repository?'This changes Git-tracked Versioned Knowledge.':'This changes Local Knowledge.'} Source bodies and checkpoint history are preserved.</p>${instructionButton('apply-optimization',optimization.repository?'Apply repository consolidation':'Apply consolidation')}`:''}<details><summary>Optimization details</summary><p>${optimization.inspected??0} instructions inspected · ${optimization.remaining??0} outside this bounded area · ${escapeHtml(optimization.mode??'')}</p></details>${instructionButton('cancel-optimization','Close optimization')}</section>`:`<div class="session-review-list">${(view.items??[]).map((row:any)=>{const item=row.item,selected=row.selection;return `<article class="session-review-item${selected.priority==='critical'?' needs-review':''}"><header><span>${selected.priority==='critical'?'Critical':'Normal'} at prepare · ${escapeHtml(scopeLabel(selected))}</span><span>${tokenLabel(selected.estimatedTokens)} est. tokens</span></header><h2>${escapeHtml(item?.title??selected.title)}</h2>${item?`<p class="context-content">${escapeHtml(item.content)}</p><p class="context-muted">Current: ${escapeHtml(item.priority)} · ${escapeHtml(scopeLabel(item))} · ${escapeHtml(item.status)} · ${item.layer==='local'?'Local':'Versioned'}</p>`:`<p class="context-muted">${row.missing?'The original record is no longer available.':'Open Knowledge to load the full record from this older snapshot.'}</p>`}<p>Not selected: ${omissionLabel(selected.reason)}</p>${!row.missing?instructionButton('knowledge','Edit / classify / remove',selected.id):''}</article>`;}).join('')}</div><div class="actions">${view.offset?instructionButton('previous','Previous'):''}${view.nextOffset!==null&&view.nextOffset!==undefined?instructionButton('next','Next'):''}</div><p class="context-muted">${view.total??view.items?.length??0} omitted instructions${view.legacy?' · limited metadata from an older prepare':''}</p>`}</section></main>`;
  bindInstructionActions();
}
async function instructionAction(action:string,id?:string) {
  if(busyAction)return;
  if(action==='back'){instructionReview=null;instructionOptimization=null;message='';render();return;}
  if(action==='cancel-optimization'){instructionOptimization=null;message='';render();return;}
  const context=lifecycle?.result?.context;
  const root=instructionReview?.root??context?.projectRoot;
  const reviewId=instructionReview?.reviewId??context?.snapshot?.reviewId;
  busyAction='instruction-review';message='';render();
  try {
    const call=async(name:string,args:any)=>{
      const raw=await app.callServerTool({name,arguments:{projectRoot:root,...args}});const payload=parseToolResult(raw);
      if(raw.isError||!payload?.ok)throw Error(payload?.message??raw.content?.map(c=>c.type==='text'?c.text:'').join(' ')??'Instruction operation failed.');return payload;
    };
    if(action==='knowledge') {
      const payload=await call(PRODERO_TOOLS.knowledge,{id});knowledgeView=payload.result;knowledgeRoot=root;knowledgeFilters=payload.result.options;instructionReturn=true;
    } else if(action==='refresh-prepare') {
      const payload=await call(PRODERO_TOOLS.prepare,{sessionId:instructionReview?.sessionId??context?.snapshot?.sessionId,task:instructionReview?.task??context?.query??undefined});
      lifecycle=payload;instructionReview=null;instructionOptimization=null;contextExpanded=false;
    } else if(!reviewId) {
      if(action==='optimize')throw Error('Prepare again to create an exact review snapshot before optimizing.');
      const all=context?.selection?.omittedRequired??[],counts=requiredOmissionCounts(context??{});
      instructionReview={root,sessionId:context?.snapshot?.sessionId,task:context?.query,counts,items:all.filter((i:any)=>action!=='critical'||i.priority==='critical').map((selection:any)=>({selection,item:null})),legacy:true};
    } else if(action==='optimize'||action==='apply-optimization') {
      if(!instructionReview)instructionReview=(await call(PRODERO_TOOLS.instructionReview,{reviewId})).result;
      const payload=await call(PRODERO_TOOLS.instructionOptimize,{reviewId,action:action==='optimize'?'preview':'apply',...(action==='apply-optimization'?{previewId:instructionOptimization.previewId,approved:true}:{})});
      instructionOptimization=payload.result;
      if(payload.result.applied)message='Consolidation saved. Prepare again to load the updated policies.';
    } else {
      const offset=action==='next'?instructionReview.nextOffset:action==='previous'?Math.max(0,instructionReview.offset-12):action==='reload-review'?(instructionReview.offset??0):0;
      instructionReview=(await call(PRODERO_TOOLS.instructionReview,{reviewId,offset,criticalOnly:action==='critical'||(['next','previous','reload-review'].includes(action)&&instructionReview.criticalOnly)})).result;instructionOptimization=null;
    }
  }catch(error){message=error instanceof Error?error.message:String(error);}
  finally{busyAction=null;render();}
}

function renderRequiredBounds(context: any) {
  const counts=requiredOmissionCounts(context),m=context.metrics??{};
  if(!counts.total)return '';
  return `<section class="context-boundary-note${counts.critical?' attention-message':''}"><b>${context.allocation?'Required context incomplete':counts.critical?'Review recommended':'Context optimized'}</b><span>${counts.normal} normal instructions omitted</span><span>${counts.critical} critical omitted${counts.critical?' · could not be loaded':''}</span><div class="actions">${instructionButton(counts.critical?'critical':'review',counts.critical?'Review critical':'Review')}${instructionButton('optimize','Optimize')}</div><details class="context-subdetail"><summary>Selection details</summary><p>${m.requiredGlobalOmittedByBudget??0} exceeded ${context.allocation?'total capacity or the Required safety ceiling':'the reserved token budget'}; ${m.requiredGlobalOmittedByItemLimit??0} exceeded the ${context.limits?.maxRequiredItems??16}-item safety cap. Instructions are ranked by criticality, relevance and scope.</p></details>${message?`<p role="status">${escapeHtml(message)}</p>`:''}</section>`;
}
function renderOmittedRequired(context: any) {
  const omitted = context.selection?.omittedRequired ?? [];
  if (!omitted.length) return "";
  return `<section class="context-saturation" aria-label="Omitted required instructions"><h2>Required instructions not loaded · ${omitted.length}</h2><details class="context-subdetail"><summary>Inspect required instructions</summary><div class="omitted-list">${omitted.map((item: any) => `<details><summary><span>${escapeHtml(item.title)}<small>${escapeHtml(item.category)} · ${escapeHtml(scopeLabel(item))}</small></span><em>${tokenLabel(item.estimatedTokens)} est. tokens</em></summary><p class="omission-primary"><span>Not loaded</span><b>${omissionLabel(item.reason)}${item.constraint?` · ${escapeHtml(item.constraint)}`:''}</b></p></details>`).join("")}</div></details></section>`;
}
function renderContextGroup(title: string, items: any[], renderItem: (item: any) => string, estimatedTokens?: number) {
  const summary = estimatedTokens === undefined ? "" : `<p class="context-group-summary">${items.length} ${title === "Skills" ? (items.length === 1 ? "skill" : "skills") : (items.length === 1 ? "item" : "items")} · ${tokenLabel(estimatedTokens)} est. tokens</p>`;
  return `<section class="context-group"><h2>${escapeHtml(title)}${estimatedTokens === undefined ? ` <span>${items.length}</span>` : ""}</h2>${summary}${items.length ? items.map(renderItem).join("") : `<p class="context-muted">None supplied.</p>`}</section>`;
}
function renderAllocationDetails(context:any) {
  const a=context.allocation;
  if(!a)return '';
  return `<details class="context-subdetail"><summary>Allocation details</summary><p>Required: ${a.required.selectedItems} / ${a.required.demandItems} records · ${a.required.selectedTokens} / ${a.required.demandTokens} est. tokens · ${a.required.complete?'complete':'incomplete'}</p><p>Reserve: ${a.required.reserveTokens} · borrowed: ${a.required.borrowedTokens} · safety ceilings: ${a.required.hardTokens} tokens / ${a.required.hardItems} records</p><p>Relevant: ${a.relevant.selected} / ${a.relevant.candidates} · ${a.relevant.beyondTarget} beyond target ${a.relevant.softTarget} · stopped: ${escapeHtml(a.relevant.stopReason)}</p><p>Skills: ${a.skills.selected} / ${a.skills.candidates} · ${a.skills.tokens} tokens · ${a.skills.protectedTokens} allocated before Relevant</p>${a.skills.omitted.map((s:any)=>`<p>${escapeHtml(s.id)}: ${escapeHtml(s.reason)}</p>`).join('')}<p>Unused capacity: ${a.unusedTokens} est. tokens</p></details>`;
}
function renderContextInspector(context: any) {
  const snapshot = preparedContextSnapshot(context);
  if (!snapshot) return `<section class="context-inspector unavailable"><p>Exact prepared context is unavailable. The snapshot may come from an older runtime or missing disposable state. Retrieval was not rerun.</p></section>`;
  const metrics = snapshot.metrics;
  const knowledgeCount = snapshot.required.length + snapshot.relevant.length;
  const provided = `<section class="context-provided" aria-label="Provided to agent"><h3>Provided to agent</h3><p class="provided-counts">${knowledgeCount} knowledge · ${snapshot.skills.length} skill${snapshot.skills.length === 1 ? "" : "s"}</p><p class="provided-tokens">${tokenLabel(metrics.contextTokens)} / ${tokenLabel(metrics.contextBudgetTokens)} est. tokens</p><dl>${[["Required", snapshot.required.length], ["Relevant", snapshot.relevant.length], ["Skills", snapshot.skills.length]].map(([label, count]) => `<div><dt>${label}</dt><dd>${count}</dd></div>`).join("")}</dl></section>`;
  return `<section class="context-inspector" aria-label="Prepared context"><div class="context-inspector-head"><div><h2>Prepared context</h2><small>Session ${escapeHtml(snapshot.snapshot.sessionId!)}</small></div><button data-action="close-context">Close</button></div>${provided}${renderAllocationDetails(snapshot)}${renderContextGroup("Required", snapshot.required, (item) => renderContextItem(item, snapshot.selection.required[item.id]), metrics.requiredGlobalTokens)}${renderOmittedRequired(snapshot)}${renderContextGroup("Relevant", snapshot.relevant, (item) => renderContextItem(item, snapshot.selection.relevant[item.id], true), metrics.selectedContextualTokens ?? 0)}${renderContextGroup("Skills", snapshot.skills, renderSkill, metrics.selectedSkillsTokens ?? 0)}${renderOmitted(snapshot)}${snapshot.applicability?`<details class="context-subdetail"><summary>Applicability details</summary>${Object.entries(snapshot.applicability.decisions).map(([id,d]:[string,any])=>`<p><b>${escapeHtml(id)}</b> · ${escapeHtml(d.state.replaceAll('_',' '))}<br>${escapeHtml(d.reasons.join('; '))}</p>`).join('')}${snapshot.applicability.truncated?`<p>${snapshot.applicability.truncated} further unresolved policies. Inspect Knowledge for details.</p>`:''}</details>`:''}</section>`;
}

function renderContextReady(payload: any) {
  const result = payload.result;
  const context = result.context;
  const m = context.metrics;
  const viewModel = buildViewModel(payload);
  const synced = Number(viewModel.metrics.find(m=>m.label === "Synced")!.value);
  host.innerHTML = `<main class="shell lifecycle-shell">
    <section class="lifecycle-hero">
      ${brand("Context Ready", "context ready")}
      <div class="lifecycle-map" aria-hidden="true"><span>Required</span><i></i><b>P</b><i></i><span>Relevant</span><small>Skills</small></div>
      <p class="lead compact">What Prodero brought into this task.</p>
    </section>
    <section class="panel lifecycle-panel">
      <div class="metrics lifecycle-metrics">${renderMetricsHtml({...viewModel,metrics:viewModel.metrics.slice(0,4)})}</div>
      ${renderRequiredBounds(context)}
      <div class="telemetry-grid">
        <div class="context-metric"><span>Task context</span><strong>${tokenLabel(m.contextTokens)} <em>/ ${tokenLabel(m.contextBudgetTokens)} est. tokens</em></strong><button data-action="view-context">${contextExpanded ? "Hide context" : "View context"}</button></div>
        <div><span>Project knowledge</span><strong>${tokenLabel(m.projectKnowledgeTokens)} <em>est. tokens</em></strong></div>
        <div><span>Knowledge selected</span><strong>${percent(m.contextSelectivity)}</strong></div>
        <div><span>Required instructions</span><strong>${tokenLabel(m.requiredGlobalTokens)} <em>loaded est. tokens</em></strong></div>
      </div>
      ${contextExpanded ? renderContextInspector(context) : ""}
      <div class="auto-sync"><b>✓</b><span>${synced ? `${synced} previous session(s) synchronized automatically` : "Auto-sync up to date"}</span></div>
      <p class="context-muted">Task context is prepared by Prodero; it is not the model’s full context window or billing usage.</p>
      <footer><span>Estimated · UTF-8 bytes / 4</span><b>prodero</b></footer>
    </section></main>`;
  bindInstructionActions();
  host.querySelectorAll<HTMLButtonElement>('button[data-action="view-context"], button[data-action="close-context"]').forEach((button) => button.addEventListener("click", () => { contextExpanded = !contextExpanded; render(); }));
}

function renderMemoryCompression(sync: any) {
  const value = sync?.memoryCompression;
  if (!value || value.kind === "unavailable") return "";
  const label = value.kind === "expansion" ? "Canonical expansion" : "Memory compression";
  const result = value.kind === "unchanged" ? "Unchanged" : `${value.kind === "expansion" ? "+" : ""}${percent(value.ratio)}`;
  return `<div><span>${label}</span><strong>${result}</strong></div>`;
}

function renderSyncOutcomes(sync: any) {
  if (!sync) return "";
  const outcomes: [number, string, string][] = [
    [sync.knowledgeCreated ?? sync.created ?? 0, "Added", "+"],
    [sync.knowledgeConsolidated ?? sync.consolidated ?? 0, "Merged", "~"],
    [sync.duplicates ?? 0, "Duplicates collapsed", ""],
    [sync.knowledgeSuperseded ?? sync.superseded ?? 0, "Superseded", ""],
    [sync.conflicts ?? 0, "Conflicts", ""],
  ];
  return outcomes.some(([count]) => count > 0) ? `<p class="sync-outcomes">${outcomes.filter(([count]) => count > 0).map(([count, label, prefix]) => `<span${label === "Conflicts" ? ' class="sync-conflicts"' : ""}>${prefix}${count} ${label}</span>`).join(" · ")}</p>` : "";
}

function renderSessionLearned(payload: any) {
  const result = payload.result;
  const learned = payload.action === "sync" ? null : result.learned;
  const sync = payload.action === "sync" ? result : learned?.synchronization;
  const by = learned?.byType ?? {};
  const raw = learned?.rawSessionTokens ?? sync?.rawSessionTokens ?? 0;
  const pending = learned?.syncState === "pending-auto-sync";
  const categories = [
    ["decision", "Decision", "Decisions"],
    ["lesson", "Lesson", "Lessons"],
    ["discovery", "Discovery", "Discoveries"],
    ["state_change", "Project change", "Project changes"],
    ["skill_candidate", "Skill candidate", "Skill candidates"],
    ["global_instruction_candidate", "Instruction candidate", "Instruction candidates"],
  ].filter(([type]) => (by[type] ?? 0) > 0);
  host.innerHTML = `<main class="shell lifecycle-shell">
    <section class="lifecycle-hero learned-hero">${brand("Session Learned", result.review ? `${result.review.total} items` : "session learned", "learned")}
      <p class="lead compact">What this task taught Prodero.</p>
    </section>
    <section class="panel lifecycle-panel">
      ${learned ? `<section class="learned-summary" aria-label="Learned"><h2>Learned</h2>${categories.length || result.review?.localKnowledge || result.review?.versionedKnowledge ? `<div class="learned-categories">${result.review?.localKnowledge ? `<span><strong>${result.review.localKnowledge}</strong> Local Knowledge</span>` : ""}${result.review?.versionedKnowledge ? `<span><strong>${result.review.versionedKnowledge}</strong> Versioned Knowledge</span>` : ""}${categories.map(([type, singular, plural]) => `<span><strong>${by[type]}</strong> ${by[type] === 1 ? singular : plural}</span>`).join("")}</div>` : `<p class="context-muted">No durable project updates recorded.</p>`}</section>` : ""}
      <div class="telemetry-grid">
        <div><span>Session memory</span><strong>${tokenLabel(raw)} <em>est. tokens</em></strong></div>
        <div><span>Project memory</span><strong>${sync ? `${tokenLabel(sync.canonicalTokensAdded)} <em>est. tokens</em>` : pending ? "Pending sync" : "Unavailable"}</strong></div>
        ${renderMemoryCompression(sync)}
      </div>
      ${renderSyncOutcomes(sync)}
      ${sync?.intelligence?.audit?.triggered ? `<p class="context-muted">${sync.intelligence.audit.status === "coherent" ? "Audit · ✓ Coherent in the reviewed area" : "Attention · Review affected knowledge"}</p>` : ""}
      ${(by.skill_candidate ?? sync?.skillCandidatesCreated ?? 0) ? `<p class="context-muted">Skill candidates ${pending ? "will be available for review after automatic synchronization" : "are ready for team review"}.</p>` : ""}
      ${result.review ? `<div class="actions"><button data-session-action="open" ${busyAction?"disabled":""}>Review knowledge <span>· ${result.review.total}</span></button>${result.review.needsReview ? `<span class="context-muted">Needs review · ${result.review.needsReview}</span>` : ""}</div>` : ""}
      ${result.review?.error?`<p class="session-review-warning" role="status">Knowledge review is unavailable: ${escapeHtml(result.review.error)}</p>`:""}
      ${message?`<p class="session-review-message" role="status">${escapeHtml(message)}</p>`:""}
      <div class="auto-sync ${pending ? "pending" : ""}"><b>${pending ? "↻" : "✓"}</b><span>${pending ? "Saving was deferred. Prodero will recover it before the next work session." : "Useful knowledge was saved automatically to Local Knowledge."}</span></div>
      ${sync?.sessionsProcessed > 1 ? `<p class="context-muted">Project memory and synchronization results cover ${sync.sessionsProcessed} sessions.</p>` : ""}
      <footer><span>Estimated · current contribution only</span><b>prodero</b></footer>
    </section></main>`;
  host.querySelectorAll<HTMLButtonElement>('button[data-session-action]').forEach(button=>button.addEventListener('click',()=>void sessionReviewAction('open')));
}

const sessionTypeLabels: Record<string,string> = {decision:'Decision',lesson:'Lesson',discovery:'Discovery',state_change:'State change',global_instruction_candidate:'Instruction candidate',skill_candidate:'Skill candidate'};
function sessionButton(action:string,label:string,id?:string) {
  return `<button type="button" data-session-action="${action}"${id?` data-id="${escapeHtml(id)}"`:''} ${busyAction?'disabled':''}>${label}</button>`;
}
function renderSessionReview() {
  const view=sessionReview;
  const draft=sessionDraft;
  const options=(values:Record<string,string>,selected:string)=>Object.entries(values).map(([value,label])=>`<option value="${value}"${selected===value?' selected':''}>${label}</option>`).join('');
  host.innerHTML=`<main class="shell lifecycle-shell session-review-shell"><section class="lifecycle-hero">${brand('Session knowledge',`${view.summary.total} items`)}<p class="lead compact">${view.editable?'Optional corrections before automatic consolidation. No action means keep.':'This session has synchronized. Original observations are read-only; manage durable results through Knowledge.'}</p></section><section class="panel lifecycle-panel">
    <div class="actions">${sessionButton('back','Back')}${sessionButton('reload','Reload')}${view.editable&&view.items.length?sessionButton('discard-all','Discard all observations'):''}</div>
    ${message?`<p class="session-review-message" role="status">${escapeHtml(message)}</p>`:''}
    ${sessionDiscardAll?`<section class="session-review-notice"><p>Discard all ${view.items.length} observations? The session remains stored, and these observations will not be consolidated. Already saved Knowledge is managed separately.</p><div class="actions">${sessionButton('confirm-discard-all','Discard all')}${sessionButton('cancel-discard-all','Cancel')}</div></section>`:''}
    ${view.summary.needsReview?`<p class="context-muted">Needs review · ${view.summary.needsReview} · shown first</p>`:''}
    ${view.items.length || view.knowledge?.length?'':`<p class="context-muted">No observations remain. The session is preserved.</p>`}
    <div class="session-review-list">${[...(view.knowledge??[]).map((item:any)=>({...item,artifact:true})),...view.items].sort((a:any,b:any)=>Number(b.signals.some((s:any)=>s.requiresReview))-Number(a.signals.some((s:any)=>s.requiresReview))).map((item:any)=>item.artifact?`<article class="session-review-item${item.signals.some((s:any)=>s.severity==='warning')?' needs-review':''}"><header><span>${item.layer==='local'?'Local Knowledge':'Versioned Knowledge'} · ${escapeHtml(item.category)}</span><span>${escapeHtml(scopeLabel(item))}</span></header><h2>${escapeHtml(item.title)}</h2><p class="context-content">${escapeHtml(item.content)}</p><p class="context-muted">${escapeHtml(item.status)} · Already saved</p>${item.signals.map((signal:any)=>`<aside class="session-review-notice${signal.severity==='warning'?' session-review-warning':' session-review-info'}">${escapeHtml(signal.detail)}${signal.memory?`<blockquote>${escapeHtml(signal.memory.content)}</blockquote>`:''}</aside>`).join('')}<div class="actions">${sessionButton('knowledge','Edit / discard in Knowledge',item.id)}</div></article>`:`<article class="session-review-item${item.signals.some((s:any)=>s.severity==='warning')?' needs-review':''}"><header><span>${sessionTypeLabels[item.type]}</span><span>${escapeHtml(scopeLabel(item))}</span></header><h2>${escapeHtml(item.title)}</h2>
      ${draft?.id===item.id?`<form id="session-edit-form" class="knowledge-form"><label>Title<input name="title" maxlength="200" value="${escapeHtml(draft.title)}" required></label><label>Content<textarea name="content" rows="5" maxlength="10000" required>${escapeHtml(draft.content)}</textarea></label><div class="session-review-fields"><label>Type<select name="type">${options(sessionTypeLabels,draft.type)}</select></label><label>Scope<select name="scope">${options({global:'Project-wide',module:'Module / path',task:'Task'},draft.scope)}</select></label></div><label>Scope reference<input name="scopeRef" maxlength="300" value="${escapeHtml(draft.scopeRef??'')}" placeholder="Required for module scope"></label><label>Scope kind<select name="scopeKind">${options({'':'Automatic',topic:'Topic',path:'Repository path'},draft.scopeKind??'')}</select></label><div class="actions"><button type="submit" class="primary" ${busyAction?'disabled':''}>Save correction</button>${sessionButton('cancel-edit','Cancel')}</div></form>`:`<p class="context-content">${escapeHtml(item.content)}</p>`}
      ${item.signals.map((signal:any)=>`<aside class="session-review-notice${signal.severity==='warning'?' session-review-warning':' session-review-info'}"><strong>${escapeHtml(signal.detail)}</strong>${signal.memory?`<blockquote>${escapeHtml(signal.memory.content)}</blockquote>`:''}</aside>`).join('')}
      ${view.editable&&draft?.id!==item.id?`<div class="actions">${sessionButton('edit','Edit',item.id)}${sessionButton('discard','Discard',item.id)}</div>`:''}
      ${item.outputs.map((output:any)=>`<details class="context-subdetail"><summary>${escapeHtml(output.title)} · ${escapeHtml(output.status)}</summary><p class="context-content">${escapeHtml(output.content)}</p>${sessionButton('knowledge','Manage knowledge',output.id)}</details>`).join('')}
      ${item.skills.map((skill:any)=>`<details class="context-subdetail"><summary>${escapeHtml(skill.title)} · ${escapeHtml(skill.status)}</summary><p class="context-content">${escapeHtml(skill.content)}</p>${sessionButton('skills','Manage skills')}</details>`).join('')}
    </article>`).join('')}</div></section></main>`;
  host.querySelectorAll<HTMLButtonElement>('button[data-session-action]').forEach(button=>button.addEventListener('click',()=>void sessionReviewAction(button.dataset.sessionAction!,button.dataset.id)));
  host.querySelector<HTMLFormElement>('#session-edit-form')?.addEventListener('submit',event=>{
    event.preventDefault();const data=new FormData(event.currentTarget as HTMLFormElement);
    sessionDraft={...sessionDraft,...Object.fromEntries(data.entries())};void sessionReviewAction('save');
  });
}
function adoptSessionReview(view:any) {
  knowledgeView=null;skillsView=null;pluginsView=null;promotionPreview=null;
  sessionReview=view;
  lifecycle={action:'session-close',result:{session:{id:view.sessionId},learned:view.learned,
    review:{root:view.root,sessionId:view.sessionId,...view.summary,consolidated:view.consolidated}}};
}
async function sessionReviewAction(action:string,id?:string) {
  if(busyAction)return;
  if(action==='back'){sessionReview=null;sessionDraft=null;sessionDiscardAll=false;message='';render();return;}
  if(action==='edit'){sessionDraft={...sessionReview.items.find((item:any)=>item.id===id)};message='';render();return;}
  if(action==='cancel-edit'){sessionDraft=null;message='';render();return;}
  if(action==='discard-all'||action==='cancel-discard-all'){sessionDiscardAll=action==='discard-all';render();return;}
  const root=sessionReview?.root??lifecycle?.result?.review?.root;
  const sessionId=sessionReview?.sessionId??lifecycle?.result?.session?.id;
  busyAction='session-review';message='';render();
  try {
    let payload:any;
    if(action==='knowledge') {
      payload=parseToolResult(await app.callServerTool({name:PRODERO_TOOLS.knowledge,arguments:{projectRoot:root,id}}));
      if(!payload?.ok)throw Error(payload?.message??'Unable to open knowledge.');
      knowledgeView=payload.result;knowledgeRoot=root;knowledgeFilters=payload.result.options;sessionReview=null;
    } else if(action==='skills') {
      payload=parseToolResult(await app.callServerTool({name:PRODERO_TOOLS.skills,arguments:{projectRoot:root}}));
      if(!payload?.ok)throw Error(payload?.message??'Unable to open skills.');
      skillsView=payload.result;sessionReview=null;lifecycle=null;
    } else {
      const editing=action==='save';
      const mutation=editing||action==='discard'||action==='confirm-discard-all';
      const args:any={projectRoot:root,sessionId};
      if(mutation)Object.assign(args,{revision:sessionReview.revision,action:editing?'edit':action==='discard'?'discard':'discard-all',...(action!=='confirm-discard-all'?{id:editing?sessionDraft.id:id}:{})});
      if(editing)Object.assign(args,{title:sessionDraft.title,content:sessionDraft.content,type:sessionDraft.type,scope:sessionDraft.scope,scopeRef:sessionDraft.scopeRef||null,scopeKind:sessionDraft.scopeKind||null});
      const response=await app.callServerTool({name:mutation?PRODERO_TOOLS.sessionReviewMutate:PRODERO_TOOLS.sessionReview,arguments:args});
      payload=parseToolResult(response);if(response.isError||!payload?.ok)throw Error(payload?.message??'Unable to update session knowledge.');
      adoptSessionReview(payload.result);sessionDraft=null;sessionDiscardAll=false;
      if(lifecycle?.result?.review){Object.assign(lifecycle.result.review,sessionReview.summary);lifecycle.result.review.consolidated=sessionReview.consolidated;}
      message=mutation?'Saved. Automatic consolidation continues normally.':'';
    }
  }catch(error){message=error instanceof Error?error.message:String(error);}
  finally{busyAction=null;render();}
}

function renderAttention(payload: any) {
  const result = payload.result;
  const items = result.uiState?.attention ?? result.context?.attention ?? [];
  host.innerHTML = `<main class="shell lifecycle-shell attention-shell">
    <section class="lifecycle-hero attention-hero">${brand("Attention", result.context?.policyReadiness?.state==="required-incomplete"?"required context incomplete":result.context?.policyReadiness?.state==="context-needed"?"task context needed":result.uiState?.blocking?"resolve before continuing":"review recommended", "attention")}<p class="lead compact">Prodero found a high-value project-intelligence issue relevant to lifecycle loading.</p></section>
    <section class="panel lifecycle-panel"><div class="attention-list">${items.map((item: any) => `<article><i></i><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div></article>`).join("")}</div>
      ${result.context?renderRequiredBounds(result.context):""}
      ${contextExpanded && result.context ? renderContextInspector(result.context) : ""}
      <div class="actions">${result.context ? `<button data-action="view-context">${contextExpanded ? "Hide context" : "View context"}</button>` : ""}<button data-action="status" class="primary">View project status <span>↗</span></button></div><footer><span>${result.uiState?.blocking?(result.context?.policyReadiness?.state==="required-incomplete"?"required context incomplete":result.context?.policyReadiness?.state==="context-needed"?"Resolve task context before continuing":"Resolve required policies before continuing"):"Execution is not blocked"}</span><span>Canonical conflicts remain explicit</span><b>prodero</b></footer>
    </section></main>`;
  host.querySelector<HTMLButtonElement>('button[data-action="status"]')?.addEventListener("click", () => void loadStatus(result.project?.root));
  bindInstructionActions();
  host.querySelectorAll<HTMLButtonElement>('button[data-action="view-context"], button[data-action="close-context"]').forEach((button) => button.addEventListener("click", () => { contextExpanded = !contextExpanded; render(); }));
}

function renderOnboarding(project: NonNullable<StatusPayload["project"]>) {
  const busy = busyAction !== null;
  const projectName = escapeHtml(project.name || "current repository");
  host.innerHTML = `<main class="shell onboarding-shell">
    <section class="onboarding-hero">${brand("Project Intelligence", "Setup")}<div class="pulse idle"><em></em>NEW PROJECT DETECTED</div>
      <p class="lead">Repository <b>${projectName}</b> is ready for local project intelligence.</p>
    </section>
    <section class="panel onboarding-panel">
      <div class="onboarding-state" aria-label="Project initialization state">
        <div><span>Git repository</span><b class="${project.git ? "available" : "missing"}">${project.git ? "✓" : "Not found"}</b></div>
        <div><span>AGENTS.md</span><b class="${project.agentsFile ? "available" : "missing"}">${project.agentsFile ? "Found" : "Not found"}</b></div>
        <div><span>Prodero</span><b class="missing">Not initialized</b></div>
      </div>
      <div class="onboarding-foundation"><span>Prodero will create</span><ul><li>.prodero/</li><li>managed AGENTS instructions</li><li>project intelligence foundation</li></ul></div>
      ${message ? `<div class="message" role="status" aria-live="polite">${escapeHtml(message)}</div>` : ""}
      <div class="actions"><button data-action="init" class="primary" ${busy ? "disabled" : ""}>${busyAction === "init" ? "Initializing…" : "Initialize Prodero <span>↗</span>"}</button></div>
    <footer><span>Local-first</span><span>No repository CLI setup required</span><b>prodero</b></footer>
    </section>
  </main>`;
  host.querySelector<HTMLButtonElement>('button[data-action="init"]')?.addEventListener("click", () => void act("init"));
}

function renderBootstrap() {
  const bootstrap = state?.bootstrap;
  if (!bootstrap?.loaded) return "";
  const instructions = bootstrap.instructions.slice(0, 5);
  return `<section class="bootstrap-context" aria-label="Bootstrap Context loaded"><div class="bootstrap-head"><div><span>Bootstrap Context</span><strong>Loaded · ${bootstrap.instructions.length} required instruction${bootstrap.instructions.length === 1 ? "" : "s"}</strong></div><small>${tokenLabel(bootstrap.metrics.estimatedTokens)} est. tokens · model-visible, not system-level</small></div>
    ${instructions.length ? `<ul>${instructions.map((instruction) => { const compact = instruction.content.replace(/\s+/g, " ").trim(); const preview = compact.length > 180 ? `${compact.slice(0, 177).trimEnd()}…` : compact; return `<li><b>${escapeHtml(instruction.title)}</b><span>${escapeHtml(preview)}</span><small>${escapeHtml(instruction.enforcement)} · ${escapeHtml(instruction.scopeRef ? `${instruction.scope}: ${instruction.scopeRef}` : instruction.scope)}</small></li>`; }).join("")}</ul>` : `<p class="context-muted">No persistent required instructions are active for this project.</p>`}
    ${bootstrap.instructions.length > instructions.length ? `<p class="context-muted">${bootstrap.instructions.length - instructions.length} additional required instruction(s) were supplied to the model.</p>` : ""}
    ${bootstrap.warnings.map((warning) => `<p class="message attention-message">${escapeHtml(warning)}</p>`).join("")}
  </section>`;
}

function renderStatus() {
  const project = state?.project;
  if (!project || typeof project.initialized !== "boolean") return;
  const initialized = project.initialized;
  if (project && !initialized) return renderOnboarding(project);
  const update = state?.update;
  const busy = busyAction !== null;
  const healthy = initialized && project?.git && project?.agentsFile;
  const projectName = escapeHtml(project?.name ?? "current repository");
  const pulseLabel = healthy ? "LOCAL · CONNECTED" : project?.git ? "REPOSITORY DETECTED" : "GIT NOT DETECTED";
  const memory = memoryOpenPresentation(project);
  const lead = memory.dashboard.established ? "Memory saves automatically." : `${MEMORY_COPY.automatic} ${MEMORY_COPY.purpose}`;
  const updateLabel = update?.available ? `${update.current} → ${update.latest}` : update?.status === "not-checked" ? "Not checked" : update?.source === "checking" ? "Checking…" : update?.status === "restart-required" ? "Restart required" : update?.status === "invalid" ? "Invalid release" : update?.status === "unavailable" ? "Unavailable" : "Current";
  const viewModel = buildViewModel(state!);
  const labels: Record<string,string> = {"Knowledge":"current memories","Local Knowledge":"Local Knowledge","Shared / Versioned Knowledge":"Shared / Versioned Knowledge","Active skills":"active skills"};
  const statusMetrics = Object.entries(labels).filter(([label])=>label!=="Conflicts" || project?.conflictCount).map(([label,display])=>{
    const value=viewModel.metrics.find(m=>m.label===label);
    return statusMetric(value ? Number(value.value):undefined,display,value?.detail);
  });
  host.innerHTML = `<main class="shell open-dashboard ${memory.dashboard.established?'established':''}"><section class="hero"><div class="hero-copy">${brand(`Project Intelligence ${initialized ? "connected" : "ready"}`, "Overview")}<div class="pulse ${healthy ? "" : "idle"}"><em></em>${pulseLabel}</div>
    <p class="lead">${lead}</p></div>
    <div class="hero-visual" aria-hidden="true"><div class="signal-map ${initialized ? "animated" : ""}" aria-hidden="true"><span class="node n1"></span><span class="node n2"></span><span class="node n3"></span><span class="node n4"></span><span class="line l1"></span><span class="line l2"></span><span class="line l3"></span><div class="core">P</div><div class="orbit orbit-a">knowledge</div><div class="orbit orbit-b">skills</div><div class="orbit orbit-c">sessions</div></div></div></section>
    <section class="panel"><div class="metrics status-metrics" style="--metric-count:${statusMetrics.length}">${statusMetrics.join("")}</div>
    <section class="memory-overview" aria-label="Memory Intelligence"><div class="memory-overview-heading"><h2>${escapeHtml(memory.dashboard.headline)}</h2>${memory.dashboard.areasLabel?`<span>${escapeHtml(memory.dashboard.areasLabel)}</span>`:''}</div><p>${escapeHtml(memory.dashboard.signal)}</p>${memory.dashboard.sharing?`<p>${escapeHtml(memory.dashboard.sharing)}</p>`:''}${memory.conflicts?`<p class="knowledge-warning">${memory.conflicts} ${memory.conflicts===1?'area needs':'areas need'} review. Prodero found incompatible current knowledge.</p>`:''}${memory.dashboard.workflowNotice?`<p role="status">${escapeHtml(memory.dashboard.workflowNotice)}</p>`:''}</section>

    ${message ? `<div class="message" role="status" aria-live="polite">${escapeHtml(message)}</div>` : ""}<div class="actions">${initialized ? `<button data-action="sync" class="primary" ${busy ? "disabled" : ""}>${busyAction === "sync" ? "Analyzing…" : `${escapeHtml(memory.button)} <span>↗</span>`}</button>` : `<button data-action="init" class="primary" ${busy ? "disabled" : ""}>${busyAction === "init" ? "Initializing…" : "Initialize Prodero <span>↗</span>"}</button>`}<button data-action="knowledge" ${busy || !initialized ? "disabled" : ""}>Knowledge</button><button data-action="skills" ${busy ? "disabled" : ""}>Skills</button><button data-action="update" ${busy || update?.status === "restart-required" ? "disabled" : ""}>${update?.status === "restart-required" ? "Restart Prodero" : update?.available ? "Update instructions" : busyAction === "update" ? "Checking…" : "Update instructions"}</button></div>
      ${(state as any)?.curation?.state==='unavailable'?`<p role="alert">${escapeHtml((state as any).curation.message??'Saved review is unavailable.')}</p>`:''}${(state as any)?.curation?.prominent?`<section><h2>Legacy knowledge can be improved</h2><p>${escapeHtml(renderReviewProjection((state as any).curation.projection))}</p><div class="actions"><button class="primary" data-action="curation" ${busy ? "disabled" : ""}>Review cleanup</button><button data-action="curation-later" ${busy ? "disabled" : ""}>Pause review</button></div></section>`:""}<details class="memory-details"><summary>Project details</summary>${(state as any)?.curation?.projection?.analyzedSourceCount>0?`<p>${escapeHtml(renderReviewProjection((state as any).curation.projection))}</p>`:''}<p>${MEMORY_COPY.automatic} ${MEMORY_COPY.purpose}</p>${renderBootstrap()}${(state as any)?.curation?.projection?.analyzedSourceCount>0?`<div class="actions"><button data-action="curation" ${busy ? "disabled" : ""}>Review saved decisions</button></div>`:""}<p>${projectName} · Last automatic save: ${project?.lastSyncAt?escapeHtml(formatLastSync(project.lastSyncAt)):'No saved sessions yet'} · ${escapeHtml(updateLabel)}</p><pre class="context-content">${escapeHtml(JSON.stringify(viewModel.diagnostics,null,2))}</pre></details>
    <footer><span>Local-first</span><span>Auto-save on session close</span><span>Shared knowledge stays in Git</span><b>prodero</b></footer></section></main>`;
  host.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((button) => button.addEventListener("click", () => void act(button.dataset.action!)));
}

function knowledgeButton(action: string, label: string, id = "", primary = false) {
  return `<button type="button" data-knowledge-action="${action}" data-id="${escapeHtml(id)}" ${busyAction ? "disabled" : ""} ${primary ? 'class="primary"' : ''}>${label}</button>`;
}
function renderKnowledgeTableHtml(items: any[]) {
  return `<div class="knowledge-table-scroll" role="region" aria-label="Knowledge catalogue" tabindex="0"><table class="knowledge-table"><caption>Project knowledge</caption><colgroup><col class="knowledge-number"><col class="knowledge-name"><col class="knowledge-type"><col class="knowledge-priority"><col class="knowledge-layer"></colgroup><thead><tr><th scope="col">#</th><th scope="col">Knowledge</th><th scope="col">Type</th><th scope="col">Priority</th><th scope="col">Layer</th></tr></thead><tbody>${items.map((item,index)=>`<tr><th scope="row">${index+1}</th><td>${knowledgeButton('view',escapeHtml(item.title),item.id)}<span class="knowledge-table-scope">${escapeHtml(scopeLabel(item))}</span>${item.status!=='active'?`<small class="knowledge-table-status">${escapeHtml(item.status)}</small>`:''}${item.shadowed?'<small>Superseded in current retrieval by another record.</small>':''}${item.recommendation?.recommended?'<small>Available for sharing review</small>':''}</td><td>${escapeHtml(item.category)}</td><td><span class="knowledge-priority-label" data-priority="${escapeHtml(item.priority??'normal')}">${escapeHtml(item.priority??'normal')}</span></td><td><span data-knowledge-layer="${item.layer==='local'?'local':'versioned'}">${item.layer==='local'?'Local':'Versioned'}</span></td></tr>`).join('')}</tbody></table></div>`;
}
function renderKnowledge() {
  const view = knowledgeView, item = view?.detail;
  const q = knowledgeFilters;
  const select = (name: string, choices: string[][], value: string) => `<select name="${name}" aria-label="${name}">${choices.map(([key,label])=>`<option value="${key}" ${value===key?'selected':''}>${label}</option>`).join('')}</select>`;
  let body = "";
  if (knowledgeConfirmation && item) {
    const change = knowledgeConfirmation, repository = change.mode === "repository-maintenance";
    body = `<article class="project-skill"><h2>${change.action==='retire'?'Retire knowledge?':'Review changes'}</h2><p class="knowledge-warning">${repository?'This modifies Git-tracked Shared / Versioned Knowledge for the project. Review the diff before committing.':'This changes Local Knowledge only.'} ${change.action==='retire'?'The record becomes historical and leaves normal retrieval. This is not secure erase; source sessions and history remain.':''}</p><h3>${escapeHtml(item.title)}</h3>${change.action==='edit'?`<div class="knowledge-comparison"><section><h3>Before</h3><p>${escapeHtml(item.title)}</p><div class="context-content">${escapeHtml(item.content)}</div>${item.category==='instruction'?`<p>${escapeHtml(item.priority)} · ${escapeHtml(scopeLabel(item))}</p>`:''}</section><section><h3>After</h3><p>${escapeHtml(change.title)}</p><div class="context-content">${escapeHtml(change.content)}</div>${item.category==='instruction'?`<p>${escapeHtml(change.priority??item.priority)} · ${escapeHtml(scopeLabel({...item,...change}))}</p>`:''}</section></div>`:''}<div class="actions">${knowledgeButton('confirm',repository?'Apply repository changes':change.action==='retire'?'Forget Local Knowledge':'Save Local Knowledge','',true)}${knowledgeButton('cancel-confirm','Cancel')}${message&&!busyAction?knowledgeButton('reload','Reload current (discard draft)',item.id):''}</div></article>`;
  } else if (knowledgeDraft && item) {
    body = `<form id="knowledge-edit-form" class="knowledge-form"><h2>${item.layer==='versioned'?'Repository maintenance':'Edit Local Knowledge'}</h2><p>${item.layer==='versioned'?'Saving will modify Git-tracked project knowledge.':'Versioned Knowledge will remain unchanged.'} ${item.category==='instruction'?'Critical means correctness, safety, compatibility or project invariants. Normal required instructions still rank by relevance and scope.':'Type and scope are preserved.'} Identity, relationships and checkpoint history are retained.</p><label>Title<input name="title" maxlength="200" required value="${escapeHtml(knowledgeDraft.title)}"></label><label>Statement<textarea name="content" rows="8" maxlength="10000" required>${escapeHtml(knowledgeDraft.content)}</textarea></label>${item.category==='instruction'?renderKnowledgeClassification(item,knowledgeDraft,select):''}<button class="primary" type="submit" ${busyAction?'disabled':''}>Review changes</button>${knowledgeButton('cancel-edit','Cancel')}</form>`;
  } else if (item) {
    const current = ['active','disputed'].includes(item.status);
    body = `<article class="project-skill knowledge-detail"><div class="knowledge-tags"><b data-knowledge-layer="${item.layer==='local'?'local':'versioned'}">${item.layer==='local'?'Local':'Shared / Versioned'}</b><span>${escapeHtml(item.category)}</span><span>${escapeHtml(scopeLabel(item))}</span><span>${escapeHtml(item.status)}</span></div><h2>${escapeHtml(item.title)}</h2><div class="context-content">${escapeHtml(item.content)}</div><p class="context-muted">Created ${escapeHtml(formatLastSync(item.createdAt))} · Updated ${escapeHtml(formatLastSync(item.updatedAt))}</p>${item.status==='disputed'?'<p class="knowledge-warning">This record is disputed. Editing its wording does not resolve the conflict automatically.</p>':''}<details><summary>Sources and relationships</summary><p>ID: ${escapeHtml(item.id)}</p>${renderProvenance(item)}<p>${escapeHtml((item.evidence??[]).map((e:any)=>`${e.kind}: ${e.ref}`).join('\n')||'No additional evidence recorded.')}</p><p>Supersedes: ${escapeHtml(item.supersedes.join(', ')||'None')}</p><p>Related: ${escapeHtml(item.related.join(', ')||'None')}</p><p>${escapeHtml((item.relations??[]).map((r:any)=>`${r.type}: ${r.target}`).join('\n'))}</p></details>${item.recommendation?.recommended?`<p>Available for sharing review · ${escapeHtml(item.recommendation.signals.join(' · '))}</p>`:''}<div class="actions">${current?knowledgeButton('edit',item.layer==='local'?'Edit':'Repository maintenance: Edit')+knowledgeButton('retire',item.layer==='local'?'Delete / forget':'Repository maintenance: Retire')+(item.layer==='local'?knowledgeButton('promote','Sync Memory',item.id):''):''}${knowledgeButton('reload','Reload item',item.id)}${knowledgeButton('list','Back to knowledge')}</div></article>`;
  } else {
    body = `<form id="knowledge-search-form" class="knowledge-filters"><label class="knowledge-search">Search knowledge<input name="query" value="${escapeHtml(q.query??'')}" placeholder="Search statements or topics"></label>${select('layer',[['','All layers'],['local','Local'],['versioned','Shared / Versioned']],q.layer??'')}${select('category',[['','All types'],['instruction','Rule'],['state','Fact / state'],['decision','Decision'],['lesson','Lesson'],['principle','Principle'],['invariant','Invariant'],['constraint','Constraint']],q.category??'')}${select('scope',[['','All scopes'],['global','Global'],['project','Project'],['path','Path']],q.scope??'')}<input name="path" aria-label="Scope path" placeholder="Path, e.g. docs" value="${escapeHtml(q.path??'')}">${select('history',[['current','Current'],['all','Include history']],q.includeHistorical?'all':'current')}<button type="submit" ${busyAction?'disabled':''}>Search</button></form><div class="knowledge-list">${view?.matches?.length?renderKnowledgeTableHtml(view.matches):busyAction?'<p role="status">Loading knowledge…</p>':!view?.counts?'<p class="context-muted">Knowledge could not be loaded. Choose Refresh to retry.</p>':`<p class="context-muted">${view?.counts?.local||view?.counts?.versioned?'No knowledge matches these filters. Clear the search or choose All layers.':'No knowledge yet. Ask your agent to remember a project fact, or finish a work session to begin local learning.'}</p>`}</div><div class="actions">${view?.offset?knowledgeButton('previous','Previous'):''}${view?.nextOffset!==null&&view?.nextOffset!==undefined?knowledgeButton('next','Next'):''}${knowledgeButton('list','Refresh')}</div><p class="context-muted">${view?.total??0} matching records${view?.total?` · Showing ${view.offset+1}–${view.offset+view.matches.length}`:''}</p>`;
  }
  host.innerHTML=`<main class="shell knowledge-shell"><section class="skills-hero">${brand('Knowledge','project intelligence')}</section><section class="panel"><p class="context-muted">Local is Git-ignored working state, accessible to your agent. Versioned is Git-shareable, not necessarily committed or pushed. Review repository changes before sharing.</p><div class="knowledge-summary"><span>Shared / Versioned Knowledge: <b>${view?.counts?.versioned??'—'}</b></span><span>Local Knowledge: <b>${view?.counts?.local??'—'}</b></span><span><b>${view?.counts?.recommended??'—'}</b> available for sharing review</span></div><div class="actions">${knowledgeButton('back',instructionReturn?'Back to omitted instructions':'Back to status')}${view?.counts?.local?knowledgeButton('promotions','Sync Memory'):''}</div>${message?`<p class="message" role="status" aria-live="polite">${escapeHtml(message)}</p>`:''}${body}</section></main>`;
  host.querySelectorAll<HTMLButtonElement>('button[data-knowledge-action]').forEach(button=>button.addEventListener('click',()=>void knowledgeAction(button.dataset.knowledgeAction!,button.dataset.id)));
  host.querySelector<HTMLFormElement>('#knowledge-search-form')?.addEventListener('submit',event=>{
    event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement);
    knowledgeFilters={query:String(data.get('query')??''),...Object.fromEntries(['layer','category','scope','path'].filter(k=>data.get(k)).map(k=>[k,String(data.get(k))])),includeHistorical:data.get('history')==='all',offset:0,limit:12};
    void knowledgeAction('list');
  });
  host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('#knowledge-edit-form input, #knowledge-edit-form textarea').forEach(field=>field.addEventListener('input',()=>{ if(knowledgeDraft) knowledgeDraft[field.name]=field.value; }));
  host.querySelector<HTMLFormElement>('#knowledge-edit-form')?.addEventListener('submit',event=>{
    event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement);
    knowledgeDraft={title:String(data.get('title')??''),content:String(data.get('content')??''),...(item.category==='instruction'?{priority:String(data.get('priority')),...(!item.applicability||item.applicability.kind==='legacy'?{scope:String(data.get('scope')),scopeRef:String(data.get('scopeRef')??'')||null,scopeKind:String(data.get('scopeKind')??'')||null}:{})}:{})};
    knowledgeConfirmation={...knowledgeDraft,action:'edit',mode:item.layer==='local'?'local':'repository-maintenance',id:item.id,revision:item.revision}; message='';render();
  });
}
async function knowledgeCall(name: string, args: any) {
  const result = await app.callServerTool({name,arguments:{projectRoot:knowledgeView?.root??state?.project.root,...args}});
  const payload = parseToolResult(result);
  if(result.isError || payload?.ok===false || !payload) throw new Error(payload?.message??payload?.error??'Knowledge operation failed. Reload and retry.');
  return payload;
}
async function knowledgeAction(action: string, id?: string) {
  if(busyAction) return;
  if(action==='back'){knowledgeView=null;knowledgeDraft=null;knowledgeConfirmation=null;if(instructionReturn){instructionReturn=false;await instructionAction('reload-review');return;}await loadStatus(state?.project.root??knowledgeRoot);return;}
  if(action==='edit'){knowledgeDraft={...knowledgeView.detail};message='';render();return;}
  if(action==='cancel-edit'){knowledgeDraft=null;message='';render();return;}
  if(action==='cancel-confirm'){knowledgeConfirmation=null;message='';render();return;}
  if(action==='retire'){const item=knowledgeView.detail;knowledgeConfirmation={id:item.id,revision:item.revision,action:'retire',mode:item.layer==='local'?'local':'repository-maintenance'};message='';render();return;}
  busyAction='knowledge';message=action==='confirm'?'Saving reviewed changes…':'Loading knowledge…';render();
  try {
    if(action==='promote'||action==='promotions'){
      const payload=await knowledgeCall(PRODERO_TOOLS.sync,{});adoptMemorySync(payload.result);message='';
    } else if(action==='confirm'){
      const payload=await knowledgeCall(PRODERO_TOOLS.knowledgeMutate,{...knowledgeConfirmation,approved:true});
      knowledgeView=payload.result;knowledgeDraft=null;knowledgeConfirmation=null;message='Saved. History is retained.';
    } else {
      const offset=action==='next'?knowledgeView.nextOffset:action==='previous'?Math.max(0,knowledgeView.offset-12):knowledgeFilters.offset??0;
      const payload=await knowledgeCall(PRODERO_TOOLS.knowledge,{...knowledgeFilters,offset,...(action==='view'||action==='reload'?{id}: {})});
      knowledgeView=payload.result;knowledgeRoot=knowledgeView.root;knowledgeDraft=null;knowledgeConfirmation=null;message='';
    }
  } catch(error){message=error instanceof Error?error.message:String(error);}
  finally{busyAction=null;render();}
}

function renderProjectSkill(item: any) {
  const detail = skillDetail?.id === item.id ? skillDetail : null;
  return `<article class="project-skill"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p>
    <small>Scope: ${escapeHtml(item.scope)} · Proposed from: ${item.origin === "session-inference" ? "project work sessions" : item.origin === "explicit-user" ? "a user-authored procedure" : "project Markdown"}</small>
    <p><b>When to use:</b> ${escapeHtml((item.triggers ?? []).join("; ") || item.description)}</p>
    <b>${item.status === "candidate" ? "Proposed procedure" : "Procedure"}</b>
    <div class="context-content">${escapeHtml(detail?.content ?? item.contentPreview ?? "").replace(/\n/g, "<br>")}</div>
    ${item.proposedReason ? `<p class="skill-reason"><b>Why proposed:</b> ${escapeHtml(item.proposedReason)}</p>` : ""}
    ${(item.references ?? []).length ? `<p><b>References:</b> ${escapeHtml(item.references.join("; "))}</p>` : ""}${renderProvenance(item)}
    <div class="actions"><button data-skill="${escapeHtml(item.id)}" data-review="get" ${busyAction ? "disabled" : ""}>View procedure</button>
    ${item.status === "active" ? `<button data-skill="${escapeHtml(item.id)}" data-review="recurate" ${busyAction ? "disabled" : ""}>Curate</button>` : ""}
    ${item.status === "candidate" ? `<button class="primary" data-skill="${escapeHtml(item.id)}" data-review="preview" ${busyAction ? "disabled" : ""}>Add Skill</button><button data-skill="${escapeHtml(item.id)}" data-review="dismiss" ${busyAction ? "disabled" : ""}>Dismiss</button>` : ""}</div></article>`;
}
function nextSkillsOffset(): number | null {
  const next = skillsView?.nextOffset;
  return Number.isSafeInteger(next) && next > (skillsView?.offset ?? 0) && next < skillsView?.total ? next : null;
}

function renderSkillPreview() {
  const draft = skillPreview.draft;
  const updating = skillPreview.disposition?.action === "update";
  const covered = skillPreview.disposition?.action === "covered";
  const related = (draft.relatedKnowledge ?? []).map((id: string) => skillPreview.relatedKnowledge?.find((k: any) => k.id === id) ?? { id, title: id });
  return `<article class="project-skill">${skillPreview.target ? `<p><b>${covered ? "Already covered by" : "Proposed update to"}:</b> ${escapeHtml(skillPreview.target.title)}</p>` : ""}<h2>${escapeHtml(draft.title)}</h2>${skillPreview.reasoningSummary ? `<p><b>Review note:</b> ${escapeHtml(skillPreview.reasoningSummary)}</p>` : ""}<h3>Purpose</h3><p>${escapeHtml(draft.description)}</p><p><b>Scope:</b> ${escapeHtml(draft.scope)}</p><h3>Use when</h3><ul>${draft.triggers.map((t: string) => `<li>${escapeHtml(t)}</li>`).join("") || `<li>${escapeHtml(draft.description)}</li>`}</ul><h3>Procedure</h3><div class="context-content">${escapeHtml(draft.content).replace(/\n/g, "<br>")}</div>${related.length ? `<h3>Related knowledge</h3><ul>${related.map((k: any) => `<li>${escapeHtml(k.title)} <small>${escapeHtml(k.id)}</small></li>`).join("")}</ul>` : ""}${draft.references?.length ? `<h3>References</h3><ul>${draft.references.map((r: string) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : ""}<h3>Based on</h3><p>${escapeHtml(skillDetail?.title ?? "Project skill candidate")}</p>${renderProvenance(skillDetail ?? {})}<p class="context-muted">${skillPreview.mode === "assisted" ? "Curated for reuse" : skillPreview.mode === "edited" ? "Your revised draft" : "Prepared from the candidate"}. ${updating ? "The active skill changes only after you choose Update Skill" : covered ? "No new skill will be created" : "Becomes active only after you choose Add Skill"}.</p>${skillPreview.notice ? `<p>${escapeHtml(skillPreview.notice)}</p>` : ""}<div class="actions">${covered ? `<button data-skills-action="inspect-existing" ${busyAction ? "disabled" : ""}>View existing skill</button>` : `<button class="primary" data-skills-action="approve" ${busyAction ? "disabled" : ""}>${updating ? "Update Skill" : "Add Skill"}</button>`}<button data-skills-action="edit" ${busyAction ? "disabled" : ""}>Edit</button>${skillDetail?.status === "candidate" ? `<button data-skills-action="dismiss-preview" ${busyAction ? "disabled" : ""}>Dismiss</button>` : ""}<button data-skills-action="cancel-preview" ${busyAction ? "disabled" : ""}>Cancel</button></div></article>`;
}
function renderSkillsView() {
  const previousForm = host.querySelector<HTMLFormElement>("#skill-form");
  const previousValues = previousForm ? [...new FormData(previousForm).entries()] : [];
  const focused = skillDetail?.id === focusedSkillId && skillDetail?.status === "active" ? skillDetail : null;
  const skills = (skillsView.skills ?? []).filter((item: any) => item.id !== focused?.id);
  host.innerHTML = `<main class="shell skills-shell"><section class="skills-hero">${brand(skillPreview ? (skillPreview.disposition?.action === "update" ? "Update Project Skill" : "New Project Skill") : "Project Skills", skillPreview ? (skillPreview.disposition?.action === "update" ? "update project skill" : "new project skill") : "repository procedures")}<p class="lead compact">${skillsView.counts.active} active · ${skillsView.counts.candidate} candidates</p></section>
    <section class="panel"><p class="context-muted">Created or promoted skills are Git-shareable project files. Your agent can create or update them; review the Git diff before commit/push.</p><div class="actions"><button data-skills-action="back" ${busyAction ? "disabled" : ""}>Project status</button>${!skillPreview ? `<button data-skills-action="create" class="primary" ${busyAction ? "disabled" : ""}>Create Skill</button>` : ""}</div>
    ${message ? `<div class="message" role="status" aria-live="polite">${escapeHtml(message)}</div>` : ""}
    ${skillFormOpen ? `<form id="skill-form" class="skill-form"><label>Title<input name="title" required maxlength="200"></label><label>Purpose<input name="description" required maxlength="1000"></label><label>Scope<input name="scope" value="project" required maxlength="300"></label><label>Use when (one per line)<textarea name="triggers" rows="2"></textarea></label><label>Procedure<textarea name="content" required rows="6" maxlength="20000"></textarea></label><label>Related knowledge IDs (one per line)<textarea name="relatedKnowledge" rows="2"></textarea></label><label>References (one per line)<textarea name="references" rows="2"></textarea></label><p>${skillPreview ? "Review your changes before adding the skill." : "Saved skills become active immediately."}</p><div class="actions"><button class="primary" type="submit" ${busyAction ? "disabled" : ""}>${skillPreview ? "Preview changes" : "Save Skill"}</button><button type="button" data-skills-action="cancel" ${busyAction ? "disabled" : ""}>Cancel</button></div></form>` : ""}
    ${skillPreview ? (skillFormOpen ? "" : renderSkillPreview()) : `
    ${focused ? `<section aria-label="${focusedSkillUpdated ? "Updated" : "Added"} Project Skill"><h2>${focusedSkillUpdated ? "Updated" : "Added"} Project Skill</h2>${renderProjectSkill(focused)}</section>` : ""}
    ${renderContextGroup("Active skills", skills.filter((item: any) => item.status === "active"), renderProjectSkill)}
    ${renderContextGroup("Candidate skills", skills.filter((item: any) => item.status === "candidate"), renderProjectSkill)}
    ${skills.some((item: any) => item.status === "dismissed") ? renderContextGroup("Dismissed skills", skills.filter((item: any) => item.status === "dismissed"), renderProjectSkill) : ""}
    ${skillDetail && !focused && !skills.some((item: any) => item.id === skillDetail.id) ? renderProjectSkill(skillDetail) : ""}
    <div class="actions">${skillsView.offset ? `<button data-skills-action="first" ${busyAction ? "disabled" : ""}>First page</button>` : ""}${nextSkillsOffset() !== null ? `<button data-skills-action="next" ${busyAction ? "disabled" : ""}>Next page</button>` : ""}</div>
    `}
    <footer><span>Repository procedures · reviewed by your team</span><b>prodero</b></footer></section></main>`;
  const initialValues = skillPreview && skillFormOpen ? Object.entries({ ...skillPreview.draft, triggers: skillPreview.draft.triggers.join("\n"), references: skillPreview.draft.references.join("\n"), relatedKnowledge: (skillPreview.draft.relatedKnowledge ?? []).join("\n") }) : [];
  for (const [name, value] of [...initialValues, ...previousValues]) {
    const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#skill-form [name="${name}"]`);
    if (field) field.value = String(value);
  }
  host.querySelectorAll<HTMLButtonElement>("button[data-skills-action]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.skillsAction;
    if (busyAction) return;
    if (action === "approve" && skillPreview) { void skillsAction("promote", { id: skillPreview.candidateId, approved: true, preview: skillPreview }); }
    else if (action === "dismiss-preview" && skillPreview) { void skillsAction("dismiss", { id: skillPreview.candidateId }); }
    else if (action === "inspect-existing" && skillPreview?.target) { const id = skillPreview.target.id; skillPreview = null; void skillsAction("get", { id }); }
    else if (action === "edit") { skillFormOpen = true; render(); }
    else if (action === "cancel-preview") { skillPreview = null; skillDetail = null; skillFormOpen = false; render(); }
    else if (action === "create" || action === "cancel") { skillFormOpen = action === "create"; render(); }
    else if (action === "back") { const root = skillsView.root; skillsView = null; skillDetail = null; skillPreview = null; skillFormOpen = false; void loadStatus(root); }
    else if (action === "next") {
      const offset = nextSkillsOffset();
      if (offset !== null) void skillsAction("list", { offset });
    }
    else if (action === "first") void skillsAction("list", { offset: 0 });
  }));
  host.querySelectorAll<HTMLButtonElement>("button[data-skill]").forEach((button) => button.addEventListener("click", () => void skillsAction(button.dataset.review!, { id: button.dataset.skill })));
  host.querySelector<HTMLFormElement>("#skill-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const draft = { title: data.get("title"), description: data.get("description"), scope: data.get("scope"), content: data.get("content"), triggers: String(data.get("triggers")).split(/\r?\n/).map((value) => value.trim()).filter(Boolean), relatedKnowledge: String(data.get("relatedKnowledge") ?? "").split(/\r?\n/).map(value => value.trim()).filter(Boolean), references: String(data.get("references") ?? "").split(/\r?\n/).map(value => value.trim()).filter(Boolean) };
    void skillsAction(skillPreview ? "preview" : "create", skillPreview ? { id: skillPreview.candidateId, draft, previousPreview: skillPreview } : draft);
  });
}
async function skillsAction(action: string, args: Record<string, any> = {}) {
  if (busyAction) return;
  if (action === "recurate") { action = "preview"; args.recurate = true; }
  const root = skillsView?.root ?? state?.project.root;
  // Keep an invalid form intact so a failed save does not lose the user's procedure.
  const draft = host.querySelector<HTMLFormElement>("#skill-form");
  const values = draft ? [...new FormData(draft).entries()] : [];
  busyAction = action; message = "Loading project skills…"; render();
  try {
    const name = action === "preview" ? PRODERO_TOOLS.skillPreview : action === "create" ? PRODERO_TOOLS.skillCreate : action === "promote" || action === "dismiss" ? PRODERO_TOOLS.skillReview : PRODERO_TOOLS.skills;
    const raw = await app.callServerTool({ name, arguments: { projectRoot: root, ...args, ...(action === "promote" || action === "dismiss" ? { action } : {}) } });
    const payload = parseToolResult(raw);
    if (raw.isError || !payload?.result) throw new Error(payload?.message ?? raw.content?.find((item) => item.type === "text")?.text ?? "Unable to update project skills.");
    if (action !== "get") skillsView = payload.result;
    if (action === "get" || action === "preview" || action === "promote") skillDetail = payload.skill;
    else skillDetail = null;
    if (action === "preview") { skillPreview = payload.preview; skillFormOpen = false; }
    focusedSkillUpdated = payload.uiState?.skillUpdated === true; focusedSkillId = payload.uiState?.focusSkillId ?? (payload.action === "skill-review" && payload.skill?.status === "active" ? payload.skill.id : null);
    if (action === "promote" || action === "create" || action === "dismiss") { skillFormOpen = false; skillPreview = null; }
    lifecycle = null;
    if (state && state.project.root === root) {
      state.project.skillCount = payload.result.counts.active;
      state.project.skillCandidateCount = payload.result.counts.candidate;
      state.project.skillDismissedCount = payload.result.counts.dismissed;
    }
    message = action === "promote" ? `Active project skill ${focusedSkillUpdated ? "updated" : "added"}: ${payload.skill.title}.` : action === "dismiss" ? "Candidate dismissed. Its procedure and sources are preserved." : action === "create" ? "Active project skill saved." : "";
  } catch (error) { message = error instanceof Error ? error.message : String(error); }
  finally {
    busyAction = null; render();
    if (skillFormOpen) for (const [name, value] of values) {
      const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#skill-form [name="${name}"]`);
      if (field) field.value = String(value);
    }
  }
}

function renderPlugins() {
  host.innerHTML = `<main class="shell migration"><section class="panel">${brand("Plugins", "optional capabilities")}<p>Optional capabilities available in this Prodero installation.</p>${pluginsView.plugins.map((plugin: any) => `<article class="project-skill"><h3>${escapeHtml(plugin.name)}</h3><p>${escapeHtml(plugin.description)}</p><small>v${escapeHtml(plugin.version)} · ${escapeHtml(plugin.capabilities.join(", "))}</small>${plugin.toolName ? `<button data-open-plugin="${escapeHtml(plugin.id)}">Open</button>` : `<p>${escapeHtml(plugin.actions.map((a: any) => a.id).join(", "))}</p>`}</article>`).join("") || "<p>No optional plugins installed.</p>"}${pluginsView.diagnostics.map((d: any) => `<p class="message attention-message">${escapeHtml(d.plugin)} · ${escapeHtml(d.phase)}: ${escapeHtml(d.message)}</p>`).join("")}${message ? `<p class="message">${escapeHtml(message)}</p>` : ""}<button data-plugins-back>Back to Prodero</button></section></main>`;
  host.querySelector<HTMLButtonElement>("[data-plugins-back]")?.addEventListener("click", () => { pluginsView = null; message = ""; render(); });
  host.querySelectorAll<HTMLButtonElement>("[data-open-plugin]").forEach(button => button.addEventListener("click", async () => {
    const plugin = pluginsView.plugins.find((p: any) => p.id === button.dataset.openPlugin);
    if (!plugin?.toolName) return;
    try {
      const response = await app.sendMessage({ role: "user", content: [{ type: "text", text: `Open the installed Prodero plugin using ${plugin.toolName} for project ${state?.project.root}.` }] });
      if (response.isError) throw new Error("Host could not open the plugin automatically.");
      message = "Plugin requested in the conversation.";
    } catch { message = `Ask the agent to open ${plugin.toolName}.`; }
    render();
  }));
}
let syncOptions={improve:true,share:true,repairLinks:true};
let syncPoll=0,syncPollEpoch=0;
let syncPromotionSelection: {workflow: string; ids: Set<string>} | null = null;
function renderMemorySync() {
  const w=memorySyncView, m=memorySyncPresentation(w);
  const selectionKey=JSON.stringify([w.root,w.id]);
  if(w.state==='awaiting_promotion_selection'&&syncPromotionSelection?.workflow!==selectionKey)
    syncPromotionSelection={workflow:selectionKey,ids:new Set(w.promotionCandidates.map((c:any)=>c.id))};
  const selectedPromotions=w.promotionCandidates.filter((c:any)=>syncPromotionSelection?.ids.has(c.id));
  const button=(action:string,label:string,primary=false)=>`<button data-memory-sync="${action}" ${primary?'class="primary"':''} ${busyAction?'disabled':''}>${label}</button>`;
  const jobs='';
  const selected=w.state==='awaiting_selection'?`<fieldset class="memory-sharing"><label class="memory-choice"><input type="checkbox" id="sync-improve-choice" ${syncOptions.improve?'checked':''}> <strong>Improve memory</strong></label><p>Process, compress and organize memory.</p>${w.brokenLinks?`<label class="memory-choice"><input type="checkbox" id="sync-repair-links-choice" ${syncOptions.repairLinks?'checked':''}> <strong>Fix ${w.brokenLinks} broken ${w.brokenLinks===1?'link':'links'}</strong></label><p>Review and remove links to missing memories. Original records are saved in history.</p>`:''}<label class="memory-choice"><input type="checkbox" id="sync-promotion-choice" ${syncOptions.share?'checked':''}> <strong>Share knowledge</strong></label><p>Review Local knowledge for Versioned files. Your agent can also change these files; review the Git diff before commit/push.</p></fieldset><div class="actions"><button data-memory-sync="select" class="primary" ${busyAction||!syncOptions.improve&&!syncOptions.share&&!(w.brokenLinks&&syncOptions.repairLinks)?'disabled':''}>Start Sync</button></div>`:'';
  let clarification='';
  if(w.clarification){
    const g=curationView.graphical,q=selectedQuestion();
    const reviewButton=(action:string,label:string)=>`<button data-review="${escapeHtml(action)}" ${busyAction?'disabled':''}>${escapeHtml(label)}</button>`;
    if(q&&!g.analysisPending){questionId=q.question.id;clarification=clarificationQuestionHtml(q,g,curationView.plan,reviewButton,true);}
    else if(g.analysisFailed)clarification=`<h2>I couldn't finish analyzing this answer.</h2><p>Your saved answers are retained. You can defer this question and continue.</p><div class="actions">${g.canRetryAnalysis?reviewButton('retry_analysis','Try again'):''}${reviewButton('pending-later','Answer later')}</div>`;
    else if(g.analysisPending)clarification=`<h2>Reviewing your answer…</h2><p>Your answer is saved.</p>${reviewDispatch?`<p role="status">${escapeHtml(reviewDispatch)}</p>`:''}${reviewButton('continue-chat','Continue analysis in chat')}${reviewButton('pending-later','Answer later')}`;
    else if(q){questionId=q.question.id;clarification=clarificationQuestionHtml(q,g,curationView.plan,reviewButton,true);}
  }else if(curationView?.syncWorkflowId===w.id)curationView=null;
  const promotion=w.state==='awaiting_promotion_selection'?`${w.promotionCandidates.length?`<div class="actions">${button('promotions-all','Select all')}${button('promotions-none','Deselect all')}</div>`:''}${w.promotionCandidates.map((c:any)=>`<label class="project-skill memory-choice"><input type="checkbox" data-sync-promotion="${escapeHtml(c.id)}" ${syncPromotionSelection?.ids.has(c.id)?'checked':''} ${busyAction?'disabled':''}> ${escapeHtml(c.title)}</label>`).join('')||'<p>No Local Knowledge is waiting for sharing review.</p>'}<div class="actions">${w.promotionCandidates.length?`<button data-memory-sync="promotions" class="primary" ${busyAction||!selectedPromotions.length?'disabled':''}>Review selected knowledge</button>`:'' }${button('complete','Finish without sharing')}</div>`:'';
  const sections=m.sections.map(section=>`<section class="memory-review"><h3>${escapeHtml(section.title===w.review?.preview?.summary?.label?m.reviewAreaLabel:section.title)}</h3>${section.items.map(i=>`<article>${i.title?`<h4>${escapeHtml(i.title)}</h4>`:''}<div class="context-content">${escapeHtml(i.body)}</div>${i.notes.map(n=>`<p class="context-muted">${escapeHtml(n)}</p>`).join('')}</article>`).join('')}</section>`).join('');
  const review=w.state==='awaiting_review'?`<div class="actions">${button('approve',w.review.kind==='promotion'?'Share reviewed knowledge':'Approve reviewed changes',true)}${button('skip','Skip this review')}</div>`:'';
  host.innerHTML=`<main class="shell skills-shell memory-sync"><section class="skills-hero">${brand('Sync Memory','improve and share')}${w.state==='awaiting_selection'?'':`<h2 role="status" aria-live="polite">${escapeHtml(m.graphicalHeadline)}</h2><p class="lead compact">${MEMORY_COPY.purpose}</p>`}</section><section class="panel">${m.notes.map(n=>`<p>${escapeHtml(n)}</p>`).join('')}${m.warnings.map(n=>`<p class="knowledge-warning" role="status">${escapeHtml(n)}</p>`).join('')}${m.metrics.length?`<div class="metrics">${m.metrics.map(v=>metric(v.value,v.label)).join('')}</div>`:''}${jobs}${selected}${clarification}${sections}${promotion}${review}${w.state==='semantic_work'?`<div class="actions">${button('agent','Continue improving memory',true)}${button('skip','Continue with other knowledge')}</div>`:''}${message?`<p class="message" role="status">${escapeHtml(message)}</p>`:''}<details class="memory-details"><summary>Details and diagnostics</summary>${['semantic_work','awaiting_clarification'].includes(w.state)?`<p>Continue in chat</p><pre class="context-content">${escapeHtml(w.clarification?.graphical?.continuationJobId?continuationMessage(w.clarification.graphical.continuationJobId):syncContinuationMessage(w))}</pre>`:''}<pre class="context-content">${escapeHtml(JSON.stringify({...w,semantic:undefined},null,2))}</pre>${w.jobs.filter((j:any)=>j.status==='failed').map((j:any,i:number)=>`<button data-sync-retry="${escapeHtml(j.id)}" ${busyAction?'disabled':''}>Retry incomplete analysis ${i+1}</button>`).join('')}</details><div class="actions">${['semantic_work','awaiting_clarification','applying'].includes(w.state)?button('inspect','Check progress'):''}${w.state==='stale'||w.state==='completed'?button('restart','Re-analyze memory'):''}${button('back','Back to Prodero')}</div></section></main>`;
  host.querySelectorAll<HTMLButtonElement>('[data-memory-sync]').forEach(b=>b.addEventListener('click',()=>void memorySyncAction(b.dataset.memorySync!)));
  host.querySelectorAll<HTMLInputElement>('#sync-improve-choice,#sync-promotion-choice,#sync-repair-links-choice').forEach(e=>e.addEventListener('change',()=>{syncOptions={repairLinks:host.querySelector<HTMLInputElement>('#sync-repair-links-choice')?.checked??syncOptions.repairLinks,improve:host.querySelector<HTMLInputElement>('#sync-improve-choice')!.checked,share:host.querySelector<HTMLInputElement>('#sync-promotion-choice')!.checked};render();}));
  host.querySelectorAll<HTMLInputElement>('[data-sync-promotion]').forEach(e=>e.addEventListener('change',()=>{if(!syncPromotionSelection)return;if(e.checked)syncPromotionSelection.ids.add(e.dataset.syncPromotion!);else syncPromotionSelection.ids.delete(e.dataset.syncPromotion!);render();}));
  host.querySelectorAll<HTMLButtonElement>('[data-review]').forEach(b=>b.addEventListener('click',()=>void knowledgeReviewAction(b.dataset.review!)));
  host.querySelector<HTMLTextAreaElement>('#curator-answer')?.addEventListener('input',()=>{answerDrafts[questionId]=host.querySelector<HTMLTextAreaElement>('#curator-answer')!.value;});
  host.querySelectorAll<HTMLButtonElement>('[data-sync-retry]').forEach(b=>b.addEventListener('click',()=>void memorySyncAction('retry',{candidateId:b.dataset.syncRetry})));
}
/** Ignore delayed host echoes from an older step; keep one authoritative Sync surface. */
function adoptMemorySync(next:any) {
  if(memorySyncView?.id===next.id&&memorySyncView.revision>=next.revision)return false;
  if(memorySyncView?.id!==next.id)syncOptions={improve:true,share:true,repairLinks:true};
  memorySyncView=next;
  if(next.clarification)curationView={...next.clarification,syncWorkflowId:next.id};
  else if(curationView?.syncWorkflowId===next.id)curationView=null;
  return true;
}
const syncContinuationMessage=(w:any)=>`Continue the started Prodero Sync Memory workflow ${w.id} for project ${w.root}. Inspect, then prepare the next candidate. If prepare returns a curation job, retrieve and submit it with prodero_curation_reasoning_prepare/propose, then inspect this same Sync workflow and continue independent work. For legacy transformation bundles use memory_sync prepare/propose. At awaiting_clarification, awaiting_promotion_selection or human_review_required, follow next.tool and next.arguments to present the saved human step once before stopping; never approve or publish for me. Do not start a session or scan other memory.`;
async function requestMemorySyncAgent() {
  const w=memorySyncView;
  const dispatch=app.sendMessage({role:'user',content:[{type:'text',text:syncContinuationMessage(w)}]});
  const response=await(typeof setTimeout==='function'?Promise.race([dispatch,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Host continuation timed out')),5000))]):dispatch);
  if(response.isError)throw new Error('Host could not resume the agent. Ask the agent to continue this Sync Memory workflow.');
  message='Your agent is reviewing memory. You can leave and continue later.';

}
async function memorySyncAction(action:string,extra:Record<string,unknown>={},continueAgent=false) {
  if(busyAction)return;
  if(action==='back'){syncPollEpoch++;curationView=null;const root=memorySyncView.root;memorySyncView=null;knowledgeView=null;await loadStatus(root);return;}
  const w=memorySyncView;
  if(action==='promotions-all'||action==='promotions-none'){
    syncPromotionSelection={workflow:JSON.stringify([w.root,w.id]),ids:new Set(action==='promotions-all'?w.promotionCandidates.map((c:any)=>c.id):[])};
    render();return;
  }
  const request:any={action,workflowId:w.id,revision:w.revision,...extra};
  if(action==='select'){request.improve=host.querySelector<HTMLInputElement>('#sync-improve-choice')?.checked??syncOptions.improve;request.share=host.querySelector<HTMLInputElement>('#sync-promotion-choice')?.checked??syncOptions.share;request.repairLinks=Boolean(w.brokenLinks)&&(host.querySelector<HTMLInputElement>('#sync-repair-links-choice')?.checked??syncOptions.repairLinks);if(!request.improve&&!request.share&&!request.repairLinks)return;}
  if(action==='promotions'){request.ids=w.promotionCandidates.filter((c:any)=>syncPromotionSelection?.ids.has(c.id)).map((c:any)=>c.id);if(!request.ids.length)return;}
  if(action==='approve'){request.reviewId=w.review.reviewId;request.approved=true;}
  if(action==='skip'&&w.review?.kind!=='link-repair')request.candidateId=w.jobs.find((j:any)=>j.selected&&['pending','semantic_work','awaiting_review'].includes(j.status))?.id;
  if(action==='inspect'){delete request.revision;}
  if(action==='restart'){request.action='start';request.restart=true;delete request.workflowId;delete request.revision;}
  busyAction='memory-sync';message='';render();
  try{
    if(action==='agent'){await requestMemorySyncAgent();syncPoll=0;pollMemorySync();return;}
    const response=await app.callServerTool({name:PRODERO_TOOLS.memorySync,arguments:{projectRoot:w.root,request}});
    const payload=parseToolResult(response);if(response.isError||!payload?.ok)throw new Error(payload?.message??payload?.error??'Memory Sync action failed; refresh before retry.');
    adoptMemorySync(payload.result);
    if(memorySyncView.state==='semantic_work'&&(['select','approve','skip','retry'].includes(action)||continueAgent))await requestMemorySyncAgent();
  }catch {
    // Core may have invalidated the saved review while refusing the action.
    // Read its authoritative state once; never retry an approval automatically.
    try {
      const response=await app.callServerTool({name:PRODERO_TOOLS.memorySync,arguments:{projectRoot:w.root,request:{action:'inspect',workflowId:w.id}}});
      const payload=parseToolResult(response);
      if(!response.isError&&payload?.ok)adoptMemorySync(payload.result);
    }catch { /* Keep the existing surface when the host is unavailable. */ }
    message=memorySyncView?.state==='stale'?'':memorySyncView?.state==='semantic_work'?'Your progress is saved. Ask your current agent to continue Sync Memory.':'Unable to finish this step. Your saved progress is retained. Try again.';
  }finally{busyAction=null;render();}
  if(action!=='inspect')syncPoll=0;pollMemorySync();
}
function pollMemorySync(){
 const epoch=++syncPollEpoch,id=memorySyncView?.id;
 if(!memorySyncView||!['semantic_work','awaiting_clarification'].includes(memorySyncView.state)||memorySyncView.clarification?.graphical?.activeQuestionCount&&!memorySyncView.clarification.graphical.analysisPending||syncPoll>=12||typeof setTimeout!=='function')return;
 setTimeout(()=>{if(epoch===syncPollEpoch&&id===memorySyncView?.id&&!busyAction){syncPoll++;void memorySyncAction('inspect');}},5000);
}
function renderPromotionReview() {
  const preview = promotionPreview;
  const labels: Record<string, string> = { new: "New knowledge", merge: "Merge into existing", supersede: "Update / supersede", covered: "Already covered", conflict: "Conflict requiring review" };
  const publishable = preview.actions.filter((action: any) => action.disposition !== "conflict").length;
  host.innerHTML = `<main class="shell skills-shell"><section class="skills-hero">${brand("Share Knowledge", "local → shared")}<p class="lead compact">Review changes to Git-shareable project files. Approval is a workflow step, not proof of human consent.</p></section><section class="panel">
    <div class="metrics">${metric(preview.actions.length, "reviewed")}${metric(preview.summary.new, "new")}${metric(preview.summary.merge, "merge")}${metric(preview.summary.supersede, "supersede")}${metric(preview.summary.covered, "covered")}${metric(preview.summary.conflict, "conflicts")}</div>
    ${preview.notice ? `<p class="message attention-message">${escapeHtml(preview.notice)}</p>` : ""}
    ${preview.actions.length ? preview.actions.map((action: any) => `<article class="project-skill"><small>${escapeHtml(labels[action.disposition] ?? action.disposition)} · ${action.recommended ? "recommended" : "selected"}</small><h3>${escapeHtml(action.draft?.title ?? action.before?.title ?? action.localIds.join(", "))}</h3><p>${escapeHtml(action.reason)}</p>${action.before ? `<details ${action.draft ? "open" : ""}><summary>Current Shared / Versioned Knowledge</summary><div class="context-content">${escapeHtml(action.before.content).replace(/\n/g, "<br>")}</div></details>` : ""}${action.draft ? `<details open><summary>${action.before ? "Proposed result" : "Proposed Shared / Versioned Knowledge"}</summary><div class="context-content">${escapeHtml(action.draft.content).replace(/\n/g, "<br>")}</div></details>` : ""}${action.targetId ? `<p><b>Versioned target:</b> <code>${escapeHtml(action.targetId)}</code></p>` : ""}${action.recommendationSignals.length ? `<details><summary>Why recommended</summary><ul>${action.recommendationSignals.map((signal: string) => `<li>${escapeHtml(signal)}</li>`).join("")}</ul></details>` : ""}</article>`).join("") : `<p class="context-muted">No Local Knowledge is suggested for sharing yet.</p>`}
    ${message ? `<div class="message" role="status">${escapeHtml(message)}</div>` : ""}<div class="actions">${publishable ? `<button class="primary" data-promotion-action="publish" ${busyAction ? "disabled" : ""}>${busyAction === "promotion-publish" ? "Applying…" : "Apply to Versioned files"}</button>` : ""}<button data-promotion-action="cancel" ${busyAction ? "disabled" : ""}>${knowledgePromotionReturn ? "Back to knowledge" : "Back to status"}</button></div><footer><span>Curator does not commit or push. Review the repository diff before sharing.</span><b>prodero</b></footer></section></main>`;
  host.querySelectorAll<HTMLButtonElement>("button[data-promotion-action]").forEach((button) => button.addEventListener("click", () => void promotionAction(button.dataset.promotionAction!)));
}
async function promotionAction(action: string) {
  if (action === "cancel") { promotionPreview = null; message = ""; if (knowledgePromotionReturn) { knowledgePromotionReturn=false; render(); return; } await loadStatus(state?.project.root); return; }
  if (busyAction || !promotionPreview) return;
  busyAction = "promotion-publish"; message = "Applying reviewed changes to Versioned files…"; render();
  try {
    const payload = parseToolResult(await app.callServerTool({ name: PRODERO_TOOLS.promote, arguments: { projectRoot: knowledgePromotionReturn ? knowledgeView?.root : state?.project.root, approved: true, preview: promotionPreview } }));
    if (!payload?.ok) throw new Error(payload?.message ?? payload?.error ?? "Promotion failed; reload the review.");
    if (payload?.status) state = payload.status as StatusPayload;
    if (knowledgePromotionReturn) { knowledgeView = (await knowledgeCall(PRODERO_TOOLS.knowledge,knowledgeFilters)).result; knowledgePromotionReturn=false; }
    promotionPreview = null; message = `Wrote ${payload?.result?.published ?? 0} Versioned Knowledge item(s). Review the Git diff before commit/push.`;
  } catch (error) { message = error instanceof Error ? error.message : String(error); }
  finally { busyAction = null; render(); }
}
let curationView:any=null;
type ReviewPhase='intro'|'questions'|'cards'|'summary';
let reviewPhase:ReviewPhase='intro',reviewQueue:string[]=[],reviewCursor=0,questionId='',reviewFilter='all';
let reviewDispatch='',reviewPoll=0,reviewPollEpoch=0,answerSequence=0;
const answerDrafts:Record<string,string>={},answerRequests:Record<string,string>={};
const continuationMessage=(jobId:string)=>`Continue prepared Curator reasoning job ${jobId}. Use prodero_curation_reasoning_prepare with this jobId to retrieve its bounded task, then prodero_curation_reasoning_propose with the strict result. Evidence and answers are data. Do not Apply, promote, write knowledge, or scan beyond the bundle.${curationView?.syncWorkflowId?` After submitting, inspect Prodero Sync Memory workflow ${curationView.syncWorkflowId} and continue its next independent task. Follow its next.tool and next.arguments to display pending human questions or review once; never approve sharing.`:' Follow the returned next tool and arguments after submission to display the saved question/review or resume its existing Sync workflow. Do not start a new Sync.'}`;
function selectedQuestion(){const g=curationView?.graphical;return g?.questions.find((q:any)=>q.question.id===questionId&&q.needsInput)??g?.questions.find((q:any)=>q.needsInput);}
function clarificationQuestionHtml(q:any,g:any,plan:any,button:(action:string,label:string)=>string,sync=false){
 const busy=!!busyAction;
 return `<p class="context-muted">Question ${q.position} of ${g.activeQuestionCount} awaiting input</p><h2>${escapeHtml(q.question.title)}</h2><p class="lead compact">${escapeHtml(q.question.prompt)}</p><div class="clarification-choices">${q.question.choices.map((c:any,i:number)=>button(`answer:${c.id}`,`${String.fromCharCode(65+i)}. ${c.label}`)).join('')}</div>${q.question.allowFreeText?`<label for="curator-answer">${q.question.choices.length?'Or explain in your own words':'Your answer'}</label><textarea id="curator-answer" rows="4" maxlength="8192" ${busy?'disabled':''}>${escapeHtml(answerDrafts[q.question.id]??'')}</textarea>${button('answer-free','Save answer')}`:''}<div class="actions">${button('question-later','Answer later')}${sync?'':button('summary','Review ready changes')+button('all','View all changes')}</div><details class="memory-details"><summary>Details</summary><p>${escapeHtml(q.why)}</p>${plan.proposals.filter((v:any)=>q.sourceIds.includes(v.id)).map((v:any)=>`<section><h3>${escapeHtml(v.before.title)}</h3><div class="curation-content">${escapeHtml(v.before.content)}</div></section>`).join('')}<p>${q.limitations.map(escapeHtml).join(' · ')}</p></details>`;
}
function renderKnowledgeReview(){
 const data=curationView,review=data.review,plan=data.plan,p=data.applied?.projection??data.projection,g=data.graphical,units=p?.items??[],busy=!!busyAction;
 if(!p){host.innerHTML='<p>Reload this review to obtain its saved state.</p>';return;}
 const button=(action:string,label:string,primary=false,disabled=false)=>`<button data-review="${escapeHtml(action)}" ${primary?'class="primary"':''} ${busy||disabled?'disabled':''}>${escapeHtml(label)}</button>`;
 const overview=`<p class="review-overview">${p.analyzedSourceCount} knowledge items analyzed</p><div class="metrics">${metric(p.readyChangeGroups,'changes ready')}${metric(p.needsInputNow,'need your input')}${metric(p.unchanged,'unchanged')}${p.deferredQuestions?metric(p.deferredQuestions,'questions deferred'):''}</div>`;
 const recordText=(records:any[])=>records.map(i=>`<section><h3>${escapeHtml(i.title)}</h3><div class="curation-content">${escapeHtml(i.content)}</div></section>`).join('');
 const jobId=data.continuationJobId??g?.continuationJobId;
 let content='';
 if(data.applied){content=`<h2>Knowledge updated</h2><p>${data.applied.appliedGroupCount??data.applied.applied.length} ${(data.applied.appliedGroupCount??data.applied.applied.length)===1?'change':'changes'} applied.</p><p>${p.deferredQuestions} ${p.deferredQuestions===1?'question remains':'questions remain'} for later.</p><div class="actions">${button('back','Done',true)}${data.applied.successor&&p.lifecycle!=='completed'?button('remaining','Continue review'):''}</div>`;}
 else if(p.lifecycle==='stale'||['stale_review','invalid_review'].includes(data.reviewError?.code)){content=`<h2>Knowledge changed since this review.</h2><div class="actions">${button('create','Review updated changes',true)}${button('back','Done')}</div>`;}
 else if(p.paused){content=`<h2>Review paused</h2><p>Your answers and decisions are saved.</p>${button('resume','Resume review',true)}`;}
 else if(review&&!review.snapshot.revision){content=`<h2>Saved review</h2><p>Your earlier decisions are preserved. Analyze current knowledge to continue with questions.</p>${button('create','Analyze current knowledge',true)}`;}
 else if(reviewPhase==='cards'){
  const unit=units.find((u:any)=>u.id===reviewQueue[reviewCursor]);
  const filters=`<nav class="actions" aria-label="Change filters">${[['all','All'],['ready','Ready changes'],['clarification','Needs clarification'],['deferred','Deferred'],['unchanged','Unchanged'],['applied','Applied']].map(([key,label])=>button(`filter:${key}`,label,key===reviewFilter)).join('')}</nav>`;
  if(!unit)content=`${filters}<p>No changes in this view.</p>${button('summary','Back to summary')}`;
  else{
   const proposals=unit.proposalIds.map((id:string)=>plan.proposals.find((v:any)=>v.id===id)),outputs=[...new Map(proposals.flatMap((v:any)=>v.outputs).map((v:any)=>[v.id,v])).values()];
   const question=g?.questions.find((q:any)=>q.unitIds.includes(unit.id));
   content=`${filters}<p>Knowledge ${reviewCursor+1} of ${reviewQueue.length}${unit.proposalIds.length>1?` · ${unit.proposalIds.length} linked knowledge items reviewed together`:''}</p><h2>${escapeHtml(proposals[0].before.title)}</h2>${unit.blocked?'<p>These changes depend on information that has not been resolved.</p>':''}`;
   if(unit.outcome==='unresolved')content+=`<h3>${unit.issue?.state==='deferred'?'Deferred clarification':'Needs clarification'}</h3>${question?button(`question:${question.question.id}`,'Go to question',true):g?.analysisFailed?'<p>Analysis could not produce a question or a safe change. Review the existing knowledge below, then keep it unchanged or defer this item.</p>':button('analyze','Continue analysis',true)}<details><summary>Supporting knowledge</summary>${recordText(proposals.map((v:any)=>v.before))}</details><div class="actions">${button('current','Keep current')}${button('deferred',question?'Answer later':'Defer review')}</div>`;
   else if(unit.outcome==='unchanged'||unit.execution==='applied')content+=`<p>${unit.execution==='applied'?'Applied':'Already current'}</p>${recordText(proposals.map((v:any)=>v.before))}`;
   else content+=`<div class="curation-comparison"><button class="review-choice ${unit.disposition==='keep_current'?'chosen':''}" data-review="current" ${busy?'disabled':''}><strong>Current · Keep current</strong>${recordText(proposals.map((v:any)=>v.before))}</button><button class="review-choice ${unit.disposition==='included'?'chosen':''}" data-review="suggested" ${busy?'disabled':''}><strong>Suggested · Use proposed change</strong>${recordText(outputs)}</button></div><div class="actions">${button('deferred','Defer change')}</div>`;
   content+=`<div class="actions">${button('previous','← Previous',false,reviewCursor===0)}${button('next-card','Next',false,reviewCursor+1>=reviewQueue.length)}${button('summary','Back to summary')}</div>`;
  }
 }else if(!review){content=`<p>Curator will resolve what it can and ask about missing project facts.</p>${button('create','Analyze',true)}`;}
 else if(reviewPhase==='intro'&&p.needsInputNow&&!g?.analysisPending&&!g?.analysisFailed){content=`<p>Only the questions that need your input come next.</p><div class="actions">${button('attention','Continue',true)}${button('all','View all changes')}</div>`;}
 else if((reviewPhase==='questions'||reviewPhase==='intro')&&(g?.analysisFailed||data.analysisNotice)&&!g?.analysisPending&&selectedQuestion()){
  const q=selectedQuestion();questionId=q.question.id;content=clarificationQuestionHtml(q,g,plan,button);
 } else if((reviewPhase==='questions'||reviewPhase==='intro')&&g?.analysisFailed&&!g.analysisPending&&!g.questions.length){
  content=`<h2>Analysis could not finish.</h2><p>No question or safe change was produced. Your knowledge has not been changed.</p>${g.canRetryAnalysis?'<p>You can retry analysis or review the existing knowledge yourself.</p>':'<p>Automatic retries are exhausted. Review the affected knowledge and choose Keep current to finish without changing it, or Defer review to return later.</p>'}<div class="actions">${button('filter:clarification','Review affected knowledge',true)}${g.canRetryAnalysis?button('retry_analysis','Try again'):''}${button('pause','Pause review')}${button('summary','Review summary')}</div>`;
 } else if((reviewPhase==='questions'||reviewPhase==='intro')&&(g?.analysisPending||g?.analysisFailed||g?.needsPreparation||data.analysisNotice)){
  content=`<h2>${g?.analysisFailed?"I couldn't finish analyzing this answer.":g?.analysisPending?(g?.questions.some((q:any)=>q.state==='answered_pending_analysis')?'Reviewing your answer…':'Analyzing knowledge…'):'More information is needed'}</h2><p>${g?.questions.some((q:any)=>q.state==='answered_pending_analysis')?'Answer saved. ':''}${escapeHtml(data.analysisNotice??'You can leave and return to this review.')}</p>${reviewDispatch?`<p role="status">${escapeHtml(reviewDispatch)}</p>`:''}<div class="actions">${jobId?button('continue-chat','Continue analysis in chat',true):g?.analysisFailed?(g.canRetryAnalysis?button('retry_analysis','Try again',true):'<p>Automatic retries are exhausted. Defer this question to continue; your answer is saved.</p>'):button('analyze','Continue analysis',true)}${button('reload','Refresh')}${button(g?.questions.length?'pending-later':'pause',g?.questions.length?'Answer later':'Pause review')}${button('summary','Review ready changes')}${button('all','View all changes')}</div>`;
 }else if(reviewPhase==='questions'&&selectedQuestion()){
  const q=selectedQuestion();questionId=q.question.id;
  content=clarificationQuestionHtml(q,g,plan,button);
 }else{
  reviewPhase='summary';
  content=`<h2>${p.readyChangeGroups?'Review ready':p.deferredQuestions?'Review saved for later':p.keptCurrent&&p.lifecycle==='completed'?'Review completed':p.unresolvedIssueCount||p.analysisPending||p.analysisFailed?'Review summary':'Knowledge looks current'}</h2><p>${g?.clarifiedWithYou??0} clarified with you.</p>${p.keptCurrent?`<p>${p.keptCurrent} kept unchanged by your choice.</p>`:''}${p.analysisPending?`<p>${p.analysisPending} awaiting analysis.</p>`:''}${p.analysisFailed?'<p>Some analysis could not be completed. Your answers are saved.</p>':''}${g?.repositoryChanges?`<p>${g.repositoryChanges} changes affect repository knowledge.</p>`:''}${g?.policyEffectChanges?`<p>${g.policyEffectChanges} changes adjust when knowledge applies.</p>`:''}${!p.readyChangeGroups&&!p.needsInputNow?'<p>No changes are ready to apply.</p>':''}<div class="actions">${p.readyChangeGroups?button(g?.packageReady?'apply':'summary',g?.packageReady?`Apply ${g.packageCount} ${g.packageCount===1?'change':'changes'}`:'Prepare ready changes',true):''}${p.needsInputNow?button('attention','Continue questions'):''}${button('all','View all changes')}${p.deferredQuestions?button(g?.deferredQuestionIds.length?'deferred-questions':'filter:deferred','Review deferred items'):''}${button('back','Done')}</div>${data.showDeferred?`<section><h3>Questions for later</h3>${g?.questions.filter((q:any)=>q.state==='deferred').map((q:any)=>`<p>${escapeHtml(q.question.title)}</p>${button(`reopen:${q.question.id}`,'Revisit question')}`).join('')??''}</section>`:''}${g?.packageReady?button('preview','Preview context impact'):''}${data.impact?`<section><h3>Estimated context impact</h3>${data.impact.map((row:any)=>`<p>${escapeHtml(row.task)}: ${row.before.requiredCandidateTokens} → ${row.after.requiredCandidateTokens} estimated required tokens</p>`).join('')}</section>`:''}`;
 }
 const details=`<details class="memory-details"><summary>Review details</summary><p>${escapeHtml(renderReviewProjection(p))}</p>${jobId?`<p>Manual continuation request</p><pre>${escapeHtml(continuationMessage(jobId))}</pre>`:''}<pre class="curation-content">${escapeHtml(JSON.stringify({revision:review?.snapshot.revision?.id,jobs:g?.jobs,dependencies:review?.snapshot.revision?.dependencies,result:data.applied,planEffects:plan.proposals.filter((v:any)=>v.changes.length).map((v:any)=>({title:v.before.title,layer:v.path?.startsWith('local/')?'Local':'Repository',effects:v.changes}))},null,2))}</pre></details>`;
 host.innerHTML=`<main class="shell skills-shell curation-shell"><section class="skills-hero">${brand('Review knowledge','Curator')}</section><section class="panel">${message?`<p class="message" role="status" aria-live="polite">${escapeHtml(message)}</p>`:''}${data.reviewError?button('reload','Reload saved decisions'):''}${overview}${content}${review?`<div class="actions">${button(p.paused?'resume':'pause',p.paused?'Resume review':'Pause review')}${button('reload','Refresh')}</div>`:''}${details}</section></main>`;
 host.querySelectorAll<HTMLButtonElement>('[data-review]').forEach(b=>b.addEventListener('click',()=>knowledgeReviewAction(b.dataset.review!)));
 const textarea=host.querySelector<HTMLTextAreaElement>('#curator-answer');textarea?.addEventListener('input',()=>{answerDrafts[questionId]=textarea.value;});
 document.onkeydown=event=>{if(reviewPhase!=='cards'||busy||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||(event.target as HTMLElement)?.closest?.('input,textarea,select,[contenteditable="true"]'))return;const action:Record<string,string>={ArrowLeft:'current',ArrowRight:'suggested',l:'deferred',L:'deferred',Backspace:'previous'};if(action[event.key]){event.preventDefault();return knowledgeReviewAction(action[event.key]);}};
}
async function dispatchCurationJob(id:string){
 if(!/^semantic_job_[a-f0-9]{40}$/.test(id))return;
 const saved=curationView?.graphical?.questions.some((q:any)=>q.state==='answered_pending_analysis')?'Answer saved. ':'';
 reviewDispatch=saved+'Continue analysis in chat if your agent does not start automatically.';
 try{if(typeof app.sendMessage!=='function')throw new Error('unsupported');const dispatch=app.sendMessage({role:'user',content:[{type:'text',text:continuationMessage(id)}]});const response=await(typeof setTimeout==='function'?Promise.race([dispatch,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('timeout')),5000))]):dispatch);if(response?.isError)throw new Error('unsupported');}
 catch{reviewDispatch=saved+'Automatic continuation is unavailable. Continue analysis in chat using the request in Details.';}
}
function pollCuration(){
 const epoch=++reviewPollEpoch,id=curationView?.review?.snapshot.reviewId;
 if(!curationView?.graphical?.analysisPending||reviewPoll>=12||typeof setTimeout!=='function')return;
 setTimeout(()=>{if(epoch===reviewPollEpoch&&id===curationView?.review?.snapshot.reviewId&&!busyAction){reviewPoll++;void knowledgeReviewAction('poll');}},5000);
}
async function knowledgeReviewAction(action:string){
 if(busyAction)return;
 const data=curationView,review=data.review,root=data.root,g=data.graphical,sync=Boolean(data.syncWorkflowId&&data.syncWorkflowId===memorySyncView?.id);
 if(action==='back'){reviewPollEpoch++;return curationAction({tool:PRODERO_TOOLS.open,arguments:{projectRoot:root}});}
 if(action==='remaining'&&data.applied?.successor){curationView={...data,applied:undefined};return knowledgeReviewAction('reload');}
 if(action==='all'||action.startsWith('filter:')){reviewFilter=action==='all'?'all':action.slice(7);reviewQueue=reviewFilter==='all'?data.projection.items.map((u:any)=>u.id):g?.filters[reviewFilter]??[];reviewCursor=0;reviewPhase='cards';message='';render();return;}
 if(action==='previous'||action==='next-card'){reviewCursor=Math.max(0,Math.min(reviewQueue.length-1,reviewCursor+(action==='previous'?-1:1)));render();return;}
 if(action==='deferred-questions'){data.showDeferred=true;reviewPhase='summary';render();return;}
 if(action.startsWith('question:')){const q=g.questions.find((v:any)=>v.question.id===action.slice(9));questionId=q.question.id;if(q.state==='deferred'||q.disposition==='keep_current')return knowledgeReviewAction(`reopen:${questionId}`);reviewPhase='questions';render();return;}
 if(action==='attention'){reviewPhase='questions';if(g?.needsPreparation)return knowledgeReviewAction('analyze');if(!data.projection.needsInputNow&&!g?.analysisPending)return knowledgeReviewAction('summary');render();pollCuration();return;}
 if(action==='continue-chat'){const id=data.continuationJobId??g?.continuationJobId;if(id){busyAction='curation';render();await dispatchCurationJob(id);busyAction=null;reviewPoll=0;render();if(sync)return memorySyncAction('inspect');pollCuration();}return;}
 let tool:string=PRODERO_TOOLS.curationReview,args:any={projectRoot:root},follow='';
 if(action==='create')args.action='create';
 else if(['reload','poll','preview'].includes(action))Object.assign(args,{action:action==='preview'?'preview':'inspect',reviewId:review.snapshot.reviewId});
 else{
  Object.assign(args,{reviewId:review.snapshot.reviewId,planHash:review.snapshot.planHash,decisionRevision:review.state.revision});
  const graphical=['summary','analyze','retry_analysis','question-later','pending-later','answer-free'].includes(action)||action.startsWith('answer:')||action.startsWith('reopen:');
  if(graphical){
   Object.assign(args,{reviewRevisionId:review.snapshot.revision.id,answerLogHash:g.answerLogHash,action});
   let q=selectedQuestion();
   if(action==='pending-later')q=g.questions.find((v:any)=>v.state==='answered_pending_analysis')??g.questions.find((v:any)=>v.needsInput);
   if(action.startsWith('reopen:')){q=g.questions.find((v:any)=>v.question.id===action.slice(7));args.action='question_reopen';}
   if(action==='question-later'||action==='pending-later'){if(!q){args={projectRoot:root,reviewId:review.snapshot.reviewId,planHash:review.snapshot.planHash,decisionRevision:review.state.revision,action:'pause'};}else args.action='question_later';}
   if(['answer-free'].includes(action)||action.startsWith('answer:')){
    if(!q||g.analysisPending)return;
    args.action='answer';if(action==='answer-free'){args.rawText=host.querySelector<HTMLTextAreaElement>('#curator-answer')?.value??answerDrafts[q.question.id]??'';if(!args.rawText.trim()){message='Please explain your answer.';render();return;}}else args.choiceId=action.slice(7);
    const key=JSON.stringify([review.snapshot.reviewId,q.question.id,args.choiceId,args.rawText]);args.requestId=answerRequests[key]??= `app_answer_${Date.now()}_${++answerSequence}`;if(q.answer)args.replacesAnswerId=q.answer.id;
   }
   if(q&&['answer','question_later','question_reopen'].includes(args.action)){args.questionId=q.question.id;args.questionVersion=q.question.version;}
  }else if(action==='apply'){
   if(reviewPhase!=='summary'||!g?.packageReady||!data.projection.canApply)return;tool=PRODERO_TOOLS.curationApply;Object.assign(args,{selectedIds:data.projection.selectedIds,reviewRevisionId:data.projection.reviewRevisionId,selectionHash:data.projection.selectionHash});
  }else if(action==='pause'||action==='resume')args.action=action;
  else{
   const u=data.projection.items.find((v:any)=>v.id===reviewQueue[reviewCursor]);if(!u||action==='suggested'&&!u.applicable||action==='deferred'&&u.outcome==='unchanged')return;
   if(action==='deferred'){args.action=u.outcome==='unresolved'?'defer_issue':'defer_change';args.unitId=u.id;}else{args.action='decide';args.decisions={[u.id]:action};}
  }
 }
 busyAction='curation';if(action!=='poll')message=action==='apply'?'Applying changes…':action==='answer-free'||action.startsWith('answer:')?'Saving your answer…':'Updating review…';render();
 try{
  const response=await app.callServerTool({name:tool,arguments:args}),payload=parseToolResult(response);
  if(curationView!==data)return;
  if(!payload||response.isError){if(payload?.action==='curation-review-error')data.reviewError=payload;throw new Error(payload?.message??'Unable to update this review. Your saved answers are retained.');}
  if(payload.action==='curation-applied'){curationView.applied=payload.result;if(payload.result.successor){curationView.review=payload.result.successor;curationView.plan=payload.result.successor.snapshot.plan;curationView.projection=payload.result.projection;}message='';}
  else if(payload.action==='curation'&&payload.review){
   curationView=sync?{...payload,syncWorkflowId:data.syncWorkflowId}:payload;message='';const next=payload.graphical;
   if(action!=='poll')reviewPoll=0;
   if(['current','suggested','deferred'].includes(action)){reviewCursor++;if(reviewCursor>=reviewQueue.length){reviewPhase='summary';follow='summary';}}
   else if(action==='summary'||action==='preview')reviewPhase='summary';
   else if(['analyze','answer','question_later','question_reopen','retry_analysis'].includes(args.action)||action==='poll'||action==='reload'||action==='resume')reviewPhase='questions';
   else if(action==='create')reviewPhase='intro';
   if(payload.continuationJobId){await dispatchCurationJob(payload.continuationJobId);reviewPhase='questions';}
   if(!sync&&reviewPhase!=='cards'&&action!=='preview'&&action!=='summary'&&!payload.projection.paused){
    if(next?.needsPreparation&&!next.analysisFailed&&!payload.analysisNotice&&['create','poll','reload'].includes(action))follow='analyze';
    else if(!payload.projection.needsInputNow&&!next?.analysisPending&&!next?.analysisFailed&&!payload.analysisNotice){reviewPhase='summary';if(payload.projection.readyChangeGroups&&!next?.packageReady)follow='summary';}
   }
  }else throw new Error('Unexpected review response. Reload saved decisions.');
 }catch(error){message=error instanceof Error?error.message:String(error);}
 finally{busyAction=null;render();}
 if(sync){syncPoll=0;return memorySyncAction('inspect',{},args.action==='question_later');}
 if(follow)return knowledgeReviewAction(follow);pollCuration();
}
function renderCuration(){
 if(curationView.appReviewAvailable)return renderKnowledgeReview();
 const view=buildViewModel(curationView), plan=curationView.plan;
 const projection=curationView.projection;
 const changed=plan.proposals.filter((p:any)=>projection?.items.some((u:any)=>u.proposalIds.includes(p.id)&&u.outcome!=='unchanged'));

 const impact=Array.isArray(curationView.result)?curationView.result:null;
 const body=(content:string)=>`<div class="curation-content">${escapeHtml(content)}</div>`;
 const cards=changed.map((p:any)=>`<article class="project-skill curation-card"><div class="curation-card-heading"><h3>${escapeHtml(p.before.title)}</h3><span>${projection.items.find((u:any)=>u.proposalIds.includes(p.id))?.issue?.state==='deferred'?'Deferred clarification':p.attention.length?'Needs clarification':'Proposed change'}</span></div><p class="context-muted">${escapeHtml(p.group)}</p>${p.attention.length?`<div class="knowledge-warning"><b>Kept unchanged</b><ul>${p.attention.map((n:string)=>`<li>${escapeHtml(n)}</li>`).join('')}</ul><p>No actionable suggestion is available yet. This unresolved issue remains in the saved review.</p></div>`:''}<div class="curation-comparison"><section><h4>Current knowledge</h4><p class="context-muted">${p.before.contextPolicy==='required'?'Required instruction':'Relevant when needed'} · ${escapeHtml(applicabilityLabel(p.before))}</p>${body(p.before.content)}</section><section><h4>${p.attention.length?'Proposal · not ready to apply':'Proposed knowledge'}</h4>${p.outputs.map((o:any)=>`<p class="context-muted">${o.contextPolicy==='required'?'Required instruction':'Relevant when needed'} · ${escapeHtml(applicabilityLabel(o))}</p>${body(o.content)}`).join('')}</section></div><details class="memory-details"><summary>Sources and analysis</summary><p>${escapeHtml(p.investigation?.explanation??'Based on the existing record.')}</p><ul>${p.evidence.map((e:string)=>`<li>${escapeHtml(e)}</li>`).join('')}</ul><p class="context-muted">Source: ${escapeHtml(p.sourceId)} · Revision: ${escapeHtml(p.revision)}</p></details></article>`).join('');
 host.innerHTML=`<main class="shell skills-shell curation-shell"><section class="skills-hero">${brand('Knowledge cleanup','review older knowledge')}<p class="lead compact">${changed.length?'Review what would change, then preview its effect on task context.':'No cleanup is needed.'}</p></section><section class="panel">${!curationView.trustedReviewAvailable&&changed.length?'<p class="message">This connection supports preview only. You can inspect suggestions and their impact, but cannot apply cleanup here. Pause this review to continue with your current knowledge.</p>':''}${message?`<p class="message" role="status" aria-live="polite">${escapeHtml(message)}</p>`:''}${curationView.deferred?'<p class="message" role="status">Cleanup postponed. Your knowledge is unchanged.</p>':''}<div class="metrics">${renderMetricsHtml(view)}</div><div class="actions">${view.actions.map((a,i)=>`<button data-curation="${i}" ${a.approval||a.arguments.action==='simulate'?'class="primary"':''} ${busyAction?'disabled':''}>${escapeHtml(a.label)}</button>`).join('')}</div>${impact?`<section class="curation-impact" role="status"><h2>Preview results</h2><p>No knowledge was changed. These values show the expected effect for example tasks.</p>${impact.map((row:any)=>`<article class="project-skill"><h3>${escapeHtml(row.task)}</h3><p>Required context: <b>${escapeHtml(String(row.before.requiredCandidateTokens))} → ${escapeHtml(String(row.after.requiredCandidateTokens))}</b> estimated tokens</p><p>Omitted instructions: ${escapeHtml(String(row.before.requiredOmissions))} → ${escapeHtml(String(row.after.requiredOmissions))}</p></article>`).join('')}</section>`:''}${cards}${projection?.unchanged?`<p class="context-muted">${projection.unchanged} older ${projection.unchanged===1?'record needs':'records need'} no changes.</p>`:''}</section></main>`;
 host.querySelectorAll<HTMLButtonElement>('[data-curation]').forEach(b=>b.addEventListener('click',()=>curationAction(view.actions[Number(b.dataset.curation)])));
}
async function curationAction(action:{tool:string;arguments:Record<string,unknown>}) {
 if(busyAction)return;
 busyAction='curation';
 message=action.arguments.action==='simulate'?'Calculating the effect on task context…':action.arguments.action==='defer'?'Postponing cleanup…':'Loading…';
 render();
 try {
   const call=async(tool:string,args:Record<string,unknown>)=>{
     const response=await app.callServerTool({name:tool,arguments:args});
     const payload=parseToolResult(response);
     if(response.isError||!payload||payload.ok===false)throw new Error(payload?.message??'Cleanup could not complete. Please try again.');
     return payload;
   };
   let payload=await call(action.tool,action.arguments);
   if(action.arguments.action==='defer') {
     curationView=payload;
     payload=await call('prodero_open',{projectRoot:payload.root});
   }
   if(payload.action==='curation')curationView=payload;
   else if(payload.project){
     curationView=null;state=payload;lifecycle=null;migrationView=null;memorySyncView=null;
     instructionReview=null;sessionReview=null;pluginsView=null;skillsView=null;promotionPreview=null;knowledgeView=null;
     adoptProjectTheme(payload);
   } else throw new Error('Unexpected cleanup response. Please try again.');
   message=action.arguments.action==='simulate'?'Preview ready. Your knowledge is unchanged.':action.arguments.action==='defer'?'Cleanup postponed. Your knowledge is unchanged.':'';
 }catch(error){message=error instanceof Error?error.message:String(error);}
 finally{busyAction=null;render();}
}
let migrationView:any=null;
function renderMigration() {
  const view=buildViewModel(migrationView);
  host.innerHTML=`<main class="shell lifecycle-shell"><section class="lifecycle-hero">${brand(view.title,"Update")}</section><section class="panel">${view.notices.map(n=>`<p>${escapeHtml(n)}</p>`).join("")}${message?`<p role="status">${escapeHtml(message)}</p>`:""}<div class="actions">${view.actions.map((a,i)=>`<button data-action="migration-${i}" ${busyAction?"disabled":""}>${escapeHtml(a.label)}</button>`).join("")}</div><details class="memory-details migration-details"><summary>Details</summary>${(view.diagnostics??[]).map(section=>`<section><h2>${escapeHtml(section.title)}</h2>${section.items.map(item=>`<article class="project-skill"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p>${item.notes.length?`<ul>${item.notes.map(note=>`<li>${escapeHtml(note)}</li>`).join("")}</ul>`:""}</article>`).join("")}</section>`).join("")}</details></section></main>`;
  view.actions.forEach((action,i)=>host.querySelectorAll<HTMLButtonElement>(`[data-action="migration-${i}"]`).forEach(button=>button.addEventListener("click",async()=>{
    if(busyAction)return;
    busyAction="migration";message=action.tool===PRODERO_TOOLS.migrate?"Updating project knowledge…":"Continuing…";render();
    try {
      const response=await app.callServerTool({name:action.tool,arguments:action.arguments});
      if(response.isError)throw new Error(parseToolResult(response)?.message ?? "Project update could not complete. Check progress for recovery information.");
      message="";
      app.ontoolresult?.(response as any);
      // Resume through the real lifecycle tool, retaining the exact original task.
      const payload=parseToolResult(response);
      if(payload?.action==="migration" && payload.completed && payload.plan.state==="current") {
        const resume=payload.resume ?? {tool:PRODERO_TOOLS.open,arguments:{projectRoot:payload.root}};
        const resumed=await app.callServerTool({name:resume.tool,arguments:resume.arguments});
        if(resumed.isError)throw new Error("Update completed. Continue to retry the original operation.");
        app.ontoolresult?.(resumed as any);
      }
    } catch(error) {
      message=error instanceof Error?error.message:String(error);
      // Refresh through Core after an uncertain/failed response. A rollback failure
      // must expose recovery instead of leaving a stale Update action on screen.
      if(migrationView)try {
        const refreshed=await app.callServerTool({name:PRODERO_TOOLS.migrate,arguments:{projectRoot:migrationView.root,action:"status",...(migrationView.resume?{resume:migrationView.resume}:{})}});
        const payload=parseToolResult(refreshed);
        if(!refreshed.isError && payload?.action==="migration")migrationView=payload;
      } catch { /* Keep the last known state and the original failure message. */ }
    }
    finally {busyAction=null;render();}
  })));
}
function render() {
  document.onkeydown=null;
  if(textPresentation) { host.innerHTML=""; return; }
  if(memorySyncView&&curationView?.syncWorkflowId===memorySyncView.id)return renderMemorySync();
  if(curationView)return renderCuration();
  if (migrationView) return renderMigration();
  if (memorySyncView) return renderMemorySync();
  if (instructionReview && !knowledgeView) return renderInstructionReview();
  if (sessionReview) return renderSessionReview();
  if (pluginsView) return renderPlugins();
  if (skillsView) return renderSkillsView();
  if (promotionPreview) return renderPromotionReview();
  if (knowledgeView) return renderKnowledge();
  if (lifecycle?.action === "prepare") return lifecycle.result?.uiState?.view === "attention" ? renderAttention(lifecycle) : renderContextReady(lifecycle);
  if (lifecycle?.action === "session-close") return renderSessionLearned(lifecycle);
  renderStatus();
}
/** Explicit user navigation only; adopt the completed result before rendering. */
async function loadStatus(root?: string) {
  const target = root ?? state?.project.root;
  statusRequest = (async () => {
    try {
      const response = await app.callServerTool({ name: PRODERO_TOOLS.statusDetails, arguments: target ? { projectRoot: target } : {} });
      const payload = parseToolResult(response);
      if (response.isError || !payload?.project || payload.phase !== "ready") throw new Error("Project status could not be loaded.");
      const bootstrap = state?.project.root === payload.project.root ? state?.bootstrap : undefined;
      state = { ...payload, ...(bootstrap ? { bootstrap } : {}) };
      lifecycle = null;
      message = "";
      adoptProjectTheme(payload);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      statusRequest = null;
      render();
    }
  })();
  return statusRequest;
}

async function act(action: string) {
  if (action === "plugins") {
    try { pluginsView = parseToolResult(await app.callServerTool({ name: PRODERO_TOOLS.plugins, arguments: {} })); message = ""; }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    render(); return;
  }
  if(action==="curation"||action==="curation-later"){await curationAction({tool:'prodero_curation',arguments:{projectRoot:state?.project.root,action:action==='curation'?'plan':'defer',...(action==='curation-later'?{planId:(state as any)?.curation?.planId}:{})}});return;}
  if (action === "knowledge") { knowledgeView = { root: state?.project.root }; knowledgeRoot = state?.project.root; lifecycle=null; await knowledgeAction("list"); return; }
  if (action === "skills") { await skillsAction("list"); return; }
  if (busyAction) return;
  busyAction = action; message = action === "init" ? "Initializing project intelligence…" : action === "sync" ? "Analyzing Sync Memory…" : "Checking the Prodero release…"; render();
  try {
    const root = state?.project.root;
    if (action === "init") { const initialized = parseToolResult(await app.callServerTool({ name: PRODERO_TOOLS.initialize, arguments: root ? { projectRoot: root } : {} })); if (initialized?.status) state = initialized.status as StatusPayload; lifecycle = null; message = "Prodero initialized."; }
    else if (action === "sync") {
      const reanalyze=state?.project.memoryOverview?.workflow?.state==='stale';
      const synced = parseToolResult(await app.callServerTool({ name: reanalyze?PRODERO_TOOLS.memorySync:PRODERO_TOOLS.sync, arguments: {...(root?{projectRoot:root}:{}),...(reanalyze?{request:{action:'start',restart:true}}:{})} }));
      if(!synced?.ok)throw new Error('Sync Memory could not start');
      adoptMemorySync(synced.result);lifecycle=null;message='';
    }
    else {
      const result = parseToolResult(await app.callServerTool({ name: PRODERO_TOOLS.update, arguments: root ? { projectRoot: root } : {} }));
      message = result?.message ?? "Update request completed.";
      if (result?.update && state) state.update = result.update;
      if (result?.restartRequired && state) state.update = { ...state.update, available: false, status: "restart-required" };
    }
  } catch (error) { message = error instanceof Error ? error.message : String(error); }
  finally { busyAction = null; render(); }
}

function receiveToolResult(result: any) {
  const payload = parseToolResult(result);
  textPresentation=payload?.presentation?.resolved === "text";
  const appearance=document.querySelector<HTMLElement>("#theme-settings");
  if(appearance)appearance.hidden=textPresentation;
  adoptProjectTheme(payload);
  if(textPresentation) { host.innerHTML=""; return; }
  if(payload?.action === "memory-sync"){if(!adoptMemorySync(payload.result))return;syncPoll=0;pollMemorySync();promotionPreview=null;instructionReview=null;skillsView=null;pluginsView=null;message="";render();return;}
  if(memorySyncView&&payload?.action==='curation'&&payload.review?.snapshot.plan.memorySyncSources){if(!busyAction)void memorySyncAction('inspect');return;}
  if(memorySyncView&&payload?.action==='curation-reasoning'){if(!busyAction)void memorySyncAction('inspect');return;}
  if(curationView&&payload?.action==='curation-applied'){curationView.applied=payload.result;message='';render();return;}
  if(curationView&&payload?.action==='curation-review-error'){curationView.reviewError=payload;message=payload.message;render();return;}
  if(payload?.action==='curation'&&(curationView?.root!==payload.root||curationView?.review?.snapshot.reviewId!==payload.review?.snapshot.reviewId)){
    reviewPhase='intro';reviewQueue=[];reviewCursor=0;
  }
  curationView=payload?.action==="curation"?payload:null;
  if(curationView){message="";render();return;}
  migrationView=payload?.action==="migration"?payload:null;
  if(migrationView){message="";render();return;}
  memorySyncView=null;
  if(payload?.action === "session-review"){adoptSessionReview(payload.result);sessionDraft=null;sessionDiscardAll=false;message="";render();return;}
  sessionReview=null;sessionDraft=null;
  if (payload?.uiState?.view === "knowledge") { knowledgeView=payload.result;knowledgeRoot=payload.result.root;knowledgeFilters=payload.result.options;knowledgeDraft=null;knowledgeConfirmation=null;promotionPreview=null;skillsView=null;pluginsView=null;lifecycle=null;message=""; }
  else if (payload?.uiState?.view === "promotion-review") { promotionPreview = payload.preview; skillsView = null; lifecycle = null; message = ""; }
  else if (payload?.uiState?.view === "skills") { knowledgeView=null; skillsView = payload.result; skillDetail = payload.skill ?? null; skillPreview = payload.preview ?? null; focusedSkillUpdated = payload.uiState?.skillUpdated === true; focusedSkillId = payload.uiState?.focusSkillId ?? (payload.action === "skill-review" && payload.skill?.status === "active" ? payload.skill.id : null); skillFormOpen = false; lifecycle = null; message = ""; }
  else if (payload?.action === "instruction-optimize") {instructionReview={...payload.result,items:[]};instructionOptimization=payload.result;knowledgeView=null;sessionReview=null;message="";}
  else if (payload?.action === "instruction-review") {instructionReview=payload.result;instructionOptimization=null;knowledgeView=null;sessionReview=null;message="";}
  else if (payload?.action === "prepare" || payload?.action === "session-close") { knowledgeView=null; skillsView=null; pluginsView=null; lifecycle = payload; instructionReview=null;instructionOptimization=null;instructionReturn=false; contextExpanded = false; message=""; }
  else if (payload?.product === "Prodero") {
    state = payload as StatusPayload; knowledgeView = null; skillsView = null; lifecycle = null; contextExpanded = false;
  }
  else if (payload?.status?.product === "Prodero") { state = payload.status as StatusPayload; lifecycle = null; }
  render();
}
app.ontoolresult = result => {
  receiveToolResult(result);
  const payload = parseToolResult(result);
  if (payload && !result.isError) cardDisclosure?.present(payload, host.querySelector('h1')?.textContent ?? 'Project Intelligence');
};
// The App may connect before its invocation completes. No project UI exists until toolresult.
app.onhostcontextchanged = context => themeController?.setHostTheme(context.theme);
Promise.resolve(app.connect()).then(() => themeController?.setHostTheme(app.getHostContext?.()?.theme));

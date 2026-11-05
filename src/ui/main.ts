import {applicabilityLabel} from "../core/applicability-label.js";
import { buildViewModel, renderMetricsHtml, MEMORY_COPY, UPDATE_INSTRUCTIONS } from "../presentation.js";
import { App } from "@modelcontextprotocol/ext-apps";
import { PRODERO_TOOLS } from "../contracts.js";
import { preparedContextSnapshot } from "../core/context-snapshot.js";
import "./themes.css";
import "./style.css";
import { themeController } from "./themes.js";
import { mountCardDisclosure } from './card-disclosure.js';
import './card-disclosure.css';

declare const __PRODERO_VERSION__: string;

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
let legacyMaintenance: any = null;
let curationView: any = null;
let sharingSelection = false;
const sharingIds = new Set<string>();
let knowledgeStale = false;
let knowledgeView: any = null;
let knowledgeRoot: string | undefined;
let knowledgeFilters: any = { query: '', offset: 0, limit: 12 };
let knowledgeDraft: any = null;
let knowledgeConfirmation: any = null;
let knowledgePromotionReturn = false;
let textPresentation = false;
const app = new App({ name: "Prodero Project Intelligence", version: __PRODERO_VERSION__ });
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
  },{source:settings.presentationSources?.theme,notice:settings.diagnostics?.map((d:any)=>`${d.code}: ${d.cause} ${d.recovery}`).join(' '),reset:async(root)=>{
    const result=await app.callServerTool({name:PRODERO_TOOLS.configSet,arguments:{projectRoot:root,key:"presentation.theme",reset:true}});
    if(result.isError)throw new Error(result.content?.find(c=>c.type==="text")?.text ?? "Could not reset checkout theme.");
    const saved=parseToolResult(result)?.projectSettings;
    if(!saved?.presentation)throw new Error("Theme reset result unavailable. Refresh settings before retrying.");
    return {theme:saved.presentation.theme,source:saved.presentationSources?.theme??"default"};
  }});
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
  ];
  return outcomes.some(([count]) => count > 0) ? `<p class="sync-outcomes">${outcomes.filter(([count]) => count > 0).map(([count, label, prefix]) => `<span>${prefix}${count} ${label}</span>`).join(" · ")}</p>` : "";
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
      ${result.review?.error?`<p class="session-review-warning" role="alert">Session details are unavailable: ${escapeHtml(result.review.error)}</p>`:""}
      ${message?`<p class="session-review-message" role="status">${escapeHtml(message)}</p>`:""}
      <div class="auto-sync ${pending ? "pending" : ""}"><b>${pending ? "↻" : "✓"}</b><span>${pending ? "Saving was deferred. Prodero will recover it before the next work session." : "Useful knowledge was saved automatically to Local Knowledge."}</span></div>
      ${sync?.sessionsProcessed > 1 ? `<p class="context-muted">Project memory and synchronization results cover ${sync.sessionsProcessed} sessions.</p>` : ""}
      ${sync ? `<details class="memory-details"><summary>Session details</summary><pre class="context-content">${escapeHtml(JSON.stringify({synchronization:sync},null,2))}</pre></details>`:''}
      <footer><span>Estimated · current contribution only</span><b>prodero</b></footer>
    </section></main>`;
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
  const established = (project.knowledgeCount ?? 0) > 0;
  const lead = established ? "Memory saves automatically." : MEMORY_COPY.automatic;
  const updateLabel = update?.available ? `${update.current} → ${update.latest}` : update?.status === "not-checked" ? "Not checked" : update?.source === "checking" ? "Checking…" : update?.status === "restart-required" ? "Restart required" : update?.status === "invalid" ? "Invalid release" : update?.status === "unavailable" ? "Unavailable" : "Current";
  const viewModel = buildViewModel(state!);
  const labels: Record<string,string> = {"Knowledge":"current memories","Local Knowledge":"Local Knowledge","Shared / Versioned Knowledge":"Shared / Versioned Knowledge","Active skills":"active skills"};
  const statusMetrics = Object.entries(labels).filter(([label])=>label!=="Conflicts" || project?.conflictCount).map(([label,display])=>{
    const value=viewModel.metrics.find(m=>m.label===label);
    return statusMetric(value ? Number(value.value):undefined,display,value?.detail);
  });
  host.innerHTML = `<main class="shell open-dashboard ${established?'established':''}"><section class="hero"><div class="hero-copy">${brand(`Project Intelligence ${initialized ? "connected" : "ready"}`, "Overview")}<div class="pulse ${healthy ? "" : "idle"}"><em></em>${pulseLabel}</div>
    <p class="lead">${lead}</p></div>
    <div class="hero-visual" aria-hidden="true"><div class="signal-map ${initialized ? "animated" : ""}" aria-hidden="true"><span class="node n1"></span><span class="node n2"></span><span class="node n3"></span><span class="node n4"></span><span class="line l1"></span><span class="line l2"></span><span class="line l3"></span><div class="core">P</div><div class="orbit orbit-a">knowledge</div><div class="orbit orbit-b">skills</div><div class="orbit orbit-c">sessions</div></div></div></section>
    <section class="panel"><div class="metrics status-metrics" style="--metric-count:${statusMetrics.length}">${statusMetrics.join("")}</div>
    ${(viewModel.conversation?.attention??[]).map(notice=>`<p class="message attention-message" role="alert">${escapeHtml(notice)}</p>`).join('')}
    ${message ? `<div class="message" role="status" aria-live="polite">${escapeHtml(message)}</div>` : ""}<div class="actions"><button data-action="knowledge" class="primary" ${busy ? "disabled" : ""}>Knowledge</button><button data-action="skills" ${busy ? "disabled" : ""}>Skills</button><button data-action="curate" ${busy?'disabled':''}>Curate Memory</button><button data-action="share" ${busy?'disabled':''}>Local → Versioned</button>${update?.available ? `<button data-action="update" ${busy ? "disabled" : ""}>${busyAction === "update" ? "Showing instructions…" : `Update available${update.latest ? `: ${escapeHtml(update.latest)}` : ""} · instructions`}</button>` : ""}</div>
      <details class="memory-details"><summary>Project details</summary><p>${MEMORY_COPY.automatic}</p>${renderBootstrap()}<p>${projectName} · Last automatic save: ${project?.lastSyncAt?escapeHtml(formatLastSync(project.lastSyncAt)):'No saved sessions yet'} · ${escapeHtml(updateLabel)}</p></details>
    <footer><span>Local-first</span><span>Auto-save on session close</span><span>Shared knowledge stays in Git</span><b>prodero</b></footer></section></main>`;
  host.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((button) => button.addEventListener("click", () => void act(button.dataset.action!)));
}

function knowledgeButton(action: string, label: string, id = "", primary = false) {
  return `<button type="button" data-knowledge-action="${action}" data-id="${escapeHtml(id)}" ${busyAction ? "disabled" : ""} ${primary ? 'class="primary"' : ''}>${label}</button>`;
}
function renderKnowledgeTableHtml(items: any[]) {
  return `<div class="knowledge-table-scroll" role="region" aria-label="Knowledge catalogue" tabindex="0"><table class="knowledge-table"><caption>Project knowledge</caption><colgroup><col class="knowledge-number"><col class="knowledge-name"><col class="knowledge-type"><col class="knowledge-priority"><col class="knowledge-layer"></colgroup><thead><tr><th scope="col">#</th><th scope="col">Knowledge</th><th scope="col">Type</th><th scope="col">Priority</th><th scope="col">Layer</th></tr></thead><tbody>${items.map((item,index)=>`<tr><th scope="row">${index+1}</th><td>${knowledgeButton('view',escapeHtml(item.title),item.id)}<span class="knowledge-table-scope">${escapeHtml(scopeLabel(item))}</span>${item.status!=='active'?`<small class="knowledge-table-status">${escapeHtml(item.status)}</small>`:''}${item.shadowed?'<small>Superseded in current retrieval by another record.</small>':''}</td><td>${escapeHtml(item.category)}</td><td><span class="knowledge-priority-label" data-priority="${escapeHtml(item.priority??'normal')}">${escapeHtml(item.priority??'normal')}</span></td><td><span data-knowledge-layer="${item.layer==='local'?'local':'versioned'}">${item.layer==='local'?'Local':'Versioned'}</span></td></tr>`).join('')}</tbody></table></div>`;
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
    const current = !knowledgeStale && ['active','disputed'].includes(item.status);
    body = `<article class="project-skill knowledge-detail"><div class="knowledge-tags"><b data-knowledge-layer="${item.layer==='local'?'local':'versioned'}">${item.layer==='local'?'Local':'Shared / Versioned'}</b><span>${escapeHtml(item.category)}</span><span>${escapeHtml(scopeLabel(item))}</span><span>${escapeHtml(item.status)}</span></div><h2>${escapeHtml(item.title)}</h2><div class="context-content">${escapeHtml(item.content)}</div><p class="context-muted">Created ${escapeHtml(formatLastSync(item.createdAt))} · Updated ${escapeHtml(formatLastSync(item.updatedAt))}</p>${item.status==='disputed'?'<p class="knowledge-warning">This record is disputed. Editing its wording does not resolve the conflict automatically.</p>':''}<details><summary>Sources and relationships</summary><p>ID: ${escapeHtml(item.id)}</p>${renderProvenance(item)}<p>${escapeHtml((item.evidence??[]).map((e:any)=>`${e.kind}: ${e.ref}`).join('\n')||'No additional evidence recorded.')}</p><p>Supersedes: ${escapeHtml(item.supersedes.join(', ')||'None')}</p><p>Related: ${escapeHtml(item.related.join(', ')||'None')}</p><p>${escapeHtml((item.relations??[]).map((r:any)=>`${r.type}: ${r.target}`).join('\n'))}</p></details><div class="actions">${current?knowledgeButton('edit',item.layer==='local'?'Edit':'Repository maintenance: Edit')+knowledgeButton('retire',item.layer==='local'?'Delete / forget':'Repository maintenance: Retire')+(item.layer==='local'?knowledgeButton('promote','Share knowledge',item.id):''):''}${knowledgeButton('reload','Reload item',item.id)}${knowledgeButton('list','Back to knowledge')}</div></article>`;
  } else if(!Array.isArray(view?.matches)) {
    body = `<p class="knowledge-unavailable">${busyAction?"Loading knowledge…":"Knowledge catalogue is unavailable. Refresh to load current records."}</p><div class="actions">${knowledgeButton("list","Refresh")}</div>`;
  } else {
    body = `<form id="knowledge-search-form" class="knowledge-filters"><label class="knowledge-search">Search knowledge<input name="query" value="${escapeHtml(q.query??'')}" placeholder="Search statements or topics"></label>${select('layer',[['','All layers'],['local','Local'],['versioned','Shared / Versioned']],q.layer??'')}${select('category',[['','All types'],['instruction','Rule'],['state','Fact / state'],['decision','Decision'],['lesson','Lesson'],['principle','Principle'],['invariant','Invariant'],['constraint','Constraint']],q.category??'')}${select('scope',[['','All scopes'],['global','Global'],['project','Project'],['path','Path']],q.scope??'')}<input name="path" aria-label="Scope path" placeholder="Path, e.g. docs" value="${escapeHtml(q.path??'')}">${select('history',[['current','Current'],['all','Include history']],q.includeHistorical?'all':'current')}<button type="submit" ${busyAction?'disabled':''}>Search</button></form><div class="knowledge-list">${view?.matches?.length?renderKnowledgeTableHtml(view.matches):busyAction?'<p role="status">Loading knowledge…</p>':!view?.counts?'<p class="context-muted">Knowledge could not be loaded. Choose Refresh to retry.</p>':`<p class="context-muted">${view?.counts?.local||view?.counts?.versioned?'No knowledge matches these filters. Clear the search or choose All layers.':'No knowledge yet. Ask your agent to remember a project fact, or finish a work session to begin local learning.'}</p>`}</div><div class="actions">${view?.offset?knowledgeButton('previous','Previous'):''}${view?.nextOffset!==null&&view?.nextOffset!==undefined?knowledgeButton('next','Next'):''}${knowledgeButton('list','Refresh')}</div><p class="context-muted">${view?.total??0} matching records${view?.total?` · Showing ${view.offset+1}–${view.offset+view.matches.length}`:''}</p>`;
  }
  const selection=sharingSelection&&!item&&!knowledgeStale&&Array.isArray(view?.matches)?`<section class="project-skill"><h2>Local → Versioned</h2><p>Select exact Local records. Previewing changes nothing; applying the reviewed proposal writes Git-shareable files.</p>${(view?.matches??[]).filter((i:any)=>i.layer==='local'&&['active','disputed'].includes(i.status)).map((i:any)=>`<label><input type="checkbox" data-share-id="${escapeHtml(i.id)}" ${sharingIds.has(i.id)?'checked':''} ${busyAction?'disabled':''}> ${escapeHtml(i.title)}</label>`).join('<br>')}<div class="actions">${sharingIds.size?knowledgeButton('promote-selected',`Preview ${sharingIds.size} selected record(s)`):'<span>Select records to preview.</span>'}</div></section>`:'';
  host.innerHTML=`<main class="shell knowledge-shell"><section class="skills-hero">${brand('Knowledge','project intelligence')}</section><section class="panel"><p class="context-muted">Local is Git-ignored working state, accessible to your agent. Versioned is Git-shareable, not necessarily committed or pushed. Review repository changes before sharing.</p>${knowledgeStale&&Array.isArray(view?.matches)?'<p class="knowledge-cache-warning" role="status">Showing cached results. Refresh the catalogue before selecting or editing records.</p>':''}<div class="knowledge-summary"><span>Shared / Versioned Knowledge: <b>${view?.counts?.versioned??'—'}</b></span><span>Local Knowledge: <b>${view?.counts?.local??'—'}</b></span></div><div class="actions">${knowledgeButton('back',instructionReturn?'Back to omitted instructions':'Back to status')}</div>${message?`<p class="message" role="status" aria-live="polite">${escapeHtml(message)}</p>`:''}${selection}${body}</section></main>`;
  host.querySelectorAll<HTMLInputElement>('input[data-share-id]').forEach(field=>field.addEventListener('change',()=>{if(field.checked)sharingIds.add(field.dataset.shareId!);else sharingIds.delete(field.dataset.shareId!);render();}));
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
  if(action==='back'){knowledgeView=null;knowledgeDraft=null;knowledgeConfirmation=null;sharingSelection=false;sharingIds.clear();if(instructionReturn){instructionReturn=false;await instructionAction('reload-review');return;}await loadStatus(state?.project.root??knowledgeRoot);return;}
  if(action==='edit'){knowledgeDraft={...knowledgeView.detail};message='';render();return;}
  if(action==='cancel-edit'){knowledgeDraft=null;message='';render();return;}
  if(action==='cancel-confirm'){knowledgeConfirmation=null;message='';render();return;}
  if(action==='retire'){const item=knowledgeView.detail;knowledgeConfirmation={id:item.id,revision:item.revision,action:'retire',mode:item.layer==='local'?'local':'repository-maintenance'};message='';render();return;}
  busyAction='knowledge';message=action==='confirm'?'Saving reviewed changes…':'Loading knowledge…';render();
  try {
    if(action==='promote'||action==='promote-selected'){
      const ids=action==='promote-selected'?[...sharingIds]:[id??knowledgeView?.detail?.id].filter(Boolean);
      if(!ids.length||ids.length>50)throw new Error('Select between 1 and 50 exact Local records to preview.');
      const payload=await knowledgeCall(PRODERO_TOOLS.promotionPreview,{ids});
      promotionPreview=payload.preview;knowledgePromotionReturn=true;message='';
    } else if(action==='confirm'){
      const payload=await knowledgeCall(PRODERO_TOOLS.knowledgeMutate,{...knowledgeConfirmation,approved:true});
      knowledgeView=payload.result;knowledgeStale=false;knowledgeDraft=null;knowledgeConfirmation=null;message='Saved. History is retained.';
    } else {
      const offset=action==='next'?knowledgeView.nextOffset:action==='previous'?Math.max(0,knowledgeView.offset-12):knowledgeFilters.offset??0;
      const payload=await knowledgeCall(PRODERO_TOOLS.knowledge,{...knowledgeFilters,offset,...(action==='view'||action==='reload'?{id}: {})});
      knowledgeView=payload.result;knowledgeStale=false;knowledgeRoot=knowledgeView.root;knowledgeFilters={...knowledgeView.options};knowledgeDraft=null;knowledgeConfirmation=null;message='';
    }
  } catch(error){if(['list','next','previous','view','reload'].includes(action))knowledgeStale=true;message=error instanceof Error?error.message:String(error);}
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
    const result=payload.result;
    if(!Number.isSafeInteger(result?.published)||result.published<0)throw new Error("Publication result is unavailable. Inspect the saved state before retrying.");
    if (payload?.status) state = payload.status as StatusPayload;
    const returnToKnowledge=knowledgePromotionReturn,selected=new Set(sharingIds),conflicts=Array.isArray(result.conflicts)?result.conflicts:[];
    sharingIds.clear();for(const id of conflicts)if(selected.has(id))sharingIds.add(id);
    promotionPreview=null;knowledgePromotionReturn=false;
    const confirmation=`Wrote ${result.published} Versioned Knowledge item(s).${conflicts.length?` ${conflicts.length} selected record(s) remain Local; inspect a fresh preview before any further write.`:''} Review the Git diff before commit/push.`;
    message=confirmation;
    if(returnToKnowledge)try{
      knowledgeView=(await knowledgeCall(PRODERO_TOOLS.knowledge,knowledgeFilters)).result;
      knowledgeFilters={...knowledgeView.options};knowledgeStale=false;
    }catch(error){knowledgeStale=true;message=confirmation+' List refresh failed: '+(error instanceof Error?error.message:String(error));}

  } catch (error) { message = error instanceof Error ? error.message : String(error); }
  finally { busyAction = null; render(); }
}
/** Explicit management only. Rendering never creates a review, stages choices or applies. */
function renderCuration() {
  const v=curationView,review=v.review,p=v.plan,projection=v.projection;
  const selectable=review?.snapshot.units??[];
  host.innerHTML=`<main class="shell knowledge-shell"><section class="skills-hero">${brand('Curate Memory','current knowledge preview')}<p class="lead compact">Review changes only when you choose. Original history is retained.</p></section><section class="panel">
    ${v.historyDiagnostics?.length?'<p class="context-muted">Some older reviews are unavailable or unsupported and are preserved. This fresh review inherits no old approvals.</p>':''}
    ${(p?.proposals??[]).map((item:any)=>{const unit=selectable.find((u:any)=>u.proposalIds.includes(item.id));return `<article class="project-skill"><h2>${escapeHtml(item.before.title)}</h2>${unit?`<label><input type="checkbox" data-curate-unit="${escapeHtml(unit.id)}" ${review.state.decisions[unit.id]==='suggested'?'checked':''} ${!unit.applicable||busyAction?'disabled':''}> Include this dependency group</label>`:''}<h3>Current knowledge</h3><div class="context-content">${escapeHtml(item.before.content)}</div><h3>Proposed knowledge</h3>${item.outputs.map((o:any)=>`<div class="context-content">${escapeHtml(o.content)}</div>`).join('')}<p>${escapeHtml(item.changes.join(', ')||'Original retained.')}</p>${item.attention?.length?`<p class="context-muted">Retained unless resolved: ${escapeHtml(item.attention.join(' '))}</p>`:''}</article>`;}).join('')||(p?'<p>No supported protected-knowledge changes are proposed. Eligible Local maintenance continues during work.</p>':busyAction?'<p>Loading current knowledge preview…</p>':'<p>Current knowledge preview is unavailable. Retry a fresh preview.</p>')}
    ${v.impact?'<p>Exact selected changes were simulated without changing project memory. Review the full before/after wording above before applying.</p>':''}
    ${message?`<p class="message" role="status">${escapeHtml(message)}</p>`:''}
    <div class="actions">${!review&&p?.proposals.some((i:any)=>i.changes.length&&!i.attention.length)?'<button data-curate-action="create">Choose changes</button>':''}${review&&projection?.canApply?'<button data-curate-action="preview">Preview selected changes</button>':''}${v.impact&&projection?.canApply?'<button data-curate-action="apply" class="primary">Apply reviewed changes</button>':''}<button data-curate-action="fresh" ${busyAction?'disabled':''}>Fresh preview</button><button data-curate-action="back" ${busyAction?'disabled':''}>Back to status</button></div></section></main>`;
  host.querySelectorAll<HTMLButtonElement>('button[data-curate-action]').forEach(button=>button.addEventListener('click',()=>void curationAction(button.dataset.curateAction!)));
  host.querySelectorAll<HTMLInputElement>('input[data-curate-unit]').forEach(field=>field.addEventListener('change',()=>void curationAction('decide',{unitId:field.dataset.curateUnit,selected:field.checked})));
}
async function curationAction(action:string,input:any={}) {
  if(busyAction)return;
  const root=curationView?.root??state?.project.root;
  if(action==='back'){curationView=null;await loadStatus(root);return;}
  busyAction='curate';message='';render();
  try{
    const review=curationView?.review,projection=curationView?.projection;
    const identity=review?{reviewId:review.snapshot.reviewId,planHash:review.snapshot.planHash,decisionRevision:review.state.revision}:{};
    const name=action==='fresh'?PRODERO_TOOLS.curation:action==='apply'?PRODERO_TOOLS.curationApply:PRODERO_TOOLS.curationReview;
    const args=action==='fresh'?{fresh:true}:action==='create'?{action:'create',fresh:true}:action==='decide'?{action:'decide',...identity,decisions:{[input.unitId]:input.selected?'suggested':'current'}}:action==='preview'?{action:'preview',reviewId:review.snapshot.reviewId}:{...identity,selectedIds:projection.selectedIds,reviewRevisionId:projection.reviewRevisionId,selectionHash:projection.selectionHash};
    const raw=await app.callServerTool({name,arguments:{projectRoot:root,...args}}),payload=parseToolResult(raw);
    if(raw.isError||!payload)throw new Error(payload?.message??payload?.error??'Curation preview could not be loaded. Original knowledge is retained.');
    const historyDiagnostics=curationView?.historyDiagnostics;
    curationView={...payload,historyDiagnostics:payload.historyDiagnostics??historyDiagnostics};
    if(action==='apply')message=`Applied ${payload.result?.applied?.length??0} reviewed change(s). Original history is retained.`;
  }catch(error){message=error instanceof Error?error.message:String(error);}
  finally{busyAction=null;render();}
}
/** Cached older App invocations remain readable without reviving a moderator queue. */
function renderLegacyMaintenance() {
  const payload=legacyMaintenance,result=payload.result??payload;
  const view=buildViewModel(payload);
  host.innerHTML=`<main class="shell lifecycle-shell"><section class="lifecycle-hero">${brand('Project memory','maintenance information')}</section><section class="panel"><p>Memory maintenance is handled during work. Original records and saved work are retained.</p>${(view.conversation?.attention??[]).map(issue=>`<p class="message attention-message" role="alert">${escapeHtml(issue)}</p>`).join('')}<details class="memory-details"><summary>Technical details</summary><pre class="context-content">${escapeHtml(JSON.stringify({action:payload.action,state:result.state,workflowId:result.id},null,2))}</pre></details></section></main>`;
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
  if(curationView)return renderCuration();
  if(legacyMaintenance)return renderLegacyMaintenance();
  if (migrationView) return renderMigration();
  if (instructionReview && !knowledgeView) return renderInstructionReview();
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
  if(action==='curate'){knowledgeView=null;curationView={root:state?.project.root};await curationAction('fresh');return;}
  if(action==='share'){sharingSelection=true;sharingIds.clear();knowledgeFilters={query:'',layer:'local',offset:0,limit:12};knowledgeView={root:state?.project.root};knowledgeRoot=state?.project.root;lifecycle=null;await knowledgeAction('list');return;}
  if (action === "plugins") {
    try { pluginsView = parseToolResult(await app.callServerTool({ name: PRODERO_TOOLS.plugins, arguments: {} })); message = ""; }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    render(); return;
  }
  if (action === "knowledge") { sharingSelection=false;sharingIds.clear();knowledgeView = { root: state?.project.root }; knowledgeRoot = state?.project.root; lifecycle=null; await knowledgeAction("list"); return; }
  if (action === "skills") { await skillsAction("list"); return; }
  if (busyAction) return;
  busyAction = action; message = action === "init" ? "Initializing project intelligence…" : "Showing update instructions…"; render();
  try {
    const root = state?.project.root;
    if (action === "init") {
      const response=await app.callServerTool({name: PRODERO_TOOLS.initialize,arguments:root?{projectRoot:root}:{}}),initialized=parseToolResult(response);
      if(response.isError||initialized?.ok===false||initialized?.status?.project?.initialized!==true)throw new Error(initialized?.message??initialized?.error??"Initialization could not be confirmed.");
      state = initialized.status as StatusPayload;lifecycle=null;message="Prodero initialized.";adoptProjectTheme(initialized);
    }
    else {
      const response = await app.callServerTool({ name: PRODERO_TOOLS.update, arguments: root ? { projectRoot: root } : {} });
      const result = parseToolResult(response);
      if(response.isError)throw new Error(result?.message ?? response.content?.find(c=>c.type==='text')?.text ?? 'Update instructions unavailable.');
      message = result?.instructionOnly === true ? result.message : UPDATE_INSTRUCTIONS;
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
  if(result?.isError&&!state&&!lifecycle&&!knowledgeView&&!curationView){host.innerHTML=`<main class="shell"><section class="panel"><h1>Prodero unavailable</h1><p role="alert">${escapeHtml(String(payload?.message??payload?.error??'The operation could not be completed.'))}</p></section></main>`;return;}
  if(payload?.userInitiatedManagement===true&&['curation','curation-applied'].includes(payload.action)){curationView=payload;legacyMaintenance=null;knowledgeView=null;skillsView=null;lifecycle=null;message='';render();return;}
  curationView=null;
  if(['memory-sync','curation','curation-question','curation-reasoning','curation-applied','curation-review-error','session-review'].includes(payload?.action)) {
    legacyMaintenance=payload;message='';render();return;
  }
  legacyMaintenance=null;
  migrationView=payload?.action==='migration'?payload:null;
  if(migrationView){message='';render();return;}
  if (payload?.uiState?.view === "knowledge") { knowledgeView=payload.result;knowledgeStale=false;knowledgeRoot=payload.result.root;knowledgeFilters=payload.result.options;knowledgeDraft=null;knowledgeConfirmation=null;promotionPreview=null;skillsView=null;pluginsView=null;lifecycle=null;message=""; }
  else if (payload?.uiState?.view === "promotion-review") { promotionPreview = payload.preview; skillsView = null; lifecycle = null; message = ""; }
  else if (payload?.uiState?.view === "skills") { knowledgeView=null; skillsView = payload.result; skillDetail = payload.skill ?? null; skillPreview = payload.preview ?? null; focusedSkillUpdated = payload.uiState?.skillUpdated === true; focusedSkillId = payload.uiState?.focusSkillId ?? (payload.action === "skill-review" && payload.skill?.status === "active" ? payload.skill.id : null); skillFormOpen = false; lifecycle = null; message = ""; }
  else if (payload?.action === "instruction-optimize") {instructionReview={...payload.result,items:[]};instructionOptimization=payload.result;knowledgeView=null;message="";}
  else if (payload?.action === "instruction-review") {instructionReview=payload.result;instructionOptimization=null;knowledgeView=null;message="";}
  else if (payload?.action === "prepare" || payload?.action === "session-close") { knowledgeView=null; skillsView=null; pluginsView=null; lifecycle = payload; instructionReview=null;instructionOptimization=null;instructionReturn=false; contextExpanded = false; message=""; }
  else if (payload?.product === "Prodero") {
    sharingSelection=false;sharingIds.clear();knowledgeStale=false;
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

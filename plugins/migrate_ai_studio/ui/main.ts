import { App } from '@modelcontextprotocol/ext-apps';
import '../../../src/ui/style.css';
import './style.css';
const app = new App({ name: 'AI Studio Knowledge Migration', version: '1.7.0' });
const host = document.querySelector<HTMLDivElement>('#app')!;
let root = '', pluginId = '', data: any = null, plan: any = null, receipt: any = null, busy = '', error = '';
const labels: Record<string, string> = { project_instruction: 'Instructions', durable_project_knowledge: 'Durable knowledge', skill_candidate: 'Skill candidates', temporary_execution_history: 'Ignored history', duplicate: 'Duplicates', stale: 'Stale', contradicted: 'Contradicted', uncertain: 'Uncertain' };
const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const count = (v: unknown) => new Intl.NumberFormat('en-US').format(Number(v) || 0);
const size = (v: unknown) => { const bytes = Number(v) || 0; return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; };
const eligible = (item: any) => ['project_instruction', 'durable_project_knowledge', 'skill_candidate'].includes(item.classification) && (plan.extractionMode === 'deterministic-memory-v1' || item.repositoryEvidence.length) && !plan.verification.issues.some((i: any) => i.severity === 'conflict' && (i.itemId === null || i.itemId === item.id));
function parse(result: any) { const value = result.structuredContent ?? JSON.parse(result.content.find((i: any) => i.type === 'text').text); if (result.isError || value.ok === false)
    throw new Error(value.error ?? 'Migration action failed'); return value; }
function accept(value: any) { root = value.projectRoot ?? root; pluginId = value.pluginId ?? pluginId; data = value.result; if (data?.plan) {
    plan = data.plan;
    receipt = data.receipt ?? null;
} if (data?.stage === 'detect' || data?.stage === 'estimate') {
    plan = null;
    receipt = null;
} }
function render() {
    const opened = new Set([...host.querySelectorAll<HTMLDetailsElement>('details[open][data-item]')].map(el => el.dataset.item));
    const stage = data?.stage ?? 'detect';
    const cost = plan?.costEstimate ?? data?.costEstimate ?? data?.auditPackage?.costEstimate;
    const steps = ['Detect', 'Audit', 'Review', 'Import', 'Verify'];
    const current = stage === 'verify' ? 4 : receipt ? 3 : plan ? 2 : stage === 'audit' ? 1 : 0;
    const completed = [Boolean(data?.detected || plan || data?.auditPackage), Boolean(plan || receipt || stage === 'verify'), Boolean(plan?.reviewed), Boolean(receipt), stage === 'verify' && data.valid === true];
    host.innerHTML = `<main class="shell migration"><header><div class="migration-direction"><span class="source-mark">AI Studio</span><span class="arrow" aria-label="to">→</span><span class="destination-mark">Prodero</span></div><h1>${stage === 'verify' && data.valid ? 'Migration Complete' : 'Knowledge Migration'}</h1><p>Distill useful project knowledge. Keep the original source unchanged.</p></header><ol class="migration-steps">${steps.map((s, i) => `<li class="${i === current ? 'current' : ''} ${completed[i] ? 'complete' : ''}" ${i === current ? 'aria-current="step"' : ''}><b>${completed[i] ? '✓' : i + 1}</b>${s}</li>`).join('')}</ol>
  ${error ? `<p role="alert" class="message attention-message">${escape(error)}</p>` : ''}${busy ? `<p role="status" class="message">${escape(busy)}…</p>` : ''}
  ${cost ? plan?.extractionMode === 'deterministic-memory-v1' || data?.extractionMode === 'deterministic-memory-v1' ? `<section class="migration-cost"><h2>Local extraction</h2><p><b>No model request</b></p><p>${count(cost.analyzedFiles)} structured memory files (${size(cost.analyzedBytes)}) are scanned locally. Integrity hashing covers ${count(cost.sourceFiles)} eligible AI Studio files. History, handoffs, run logs, transcripts, and memory indexes are excluded from extraction. Sensitive and Git-ignored files are excluded from tree hashing.</p></section>` : `<section class="migration-cost"><h2>Estimated model usage</h2><p><b>≈ ${count(cost.estimatedTotalTokens)} tokens</b> across two model requests: evidence audit, then classification, migration, and verification.</p><p>${count(cost.analyzedFiles)} files (${size(cost.analyzedBytes)}) are sent for semantic analysis. Integrity hashing covers ${count(cost.sourceFiles)} eligible source files (${size(cost.sourceBytes)}). Input: ≈ ${count(cost.estimatedInputTokens)} · output: ≈ ${count(cost.estimatedOutputTokens)}. ${cost.basis === 'measured-payloads' ? 'Calculated from the actual model payloads.' : 'Preflight estimate; actual usage depends on model output.'} Monetary cost depends on the host model.</p></section>` : ''}
  ${stage === 'verify' ? `<section><h2>${data.valid ? 'Migration complete' : 'Migration needs attention'}</h2><p>${data.imported} imported · ${data.skillsCreated} skills created · ${data.skipped} excluded · ${data.duplicates} duplicates</p>${data.issues.map((i: string) => `<p role="alert">${escape(i)}</p>`).join('')}<p>Semantic verification: ${escape(data.semanticStatus)}</p><button data-action="export-report">Export report</button></section>` : ''}
  ${stage === 'detect' ? `<section><h2>${data?.detected ? 'AI Studio detected' : 'Detect legacy knowledge'}</h2><p>${data ? `${data.files ?? 0} source files${data.truncated ? ' (count limited)' : ''}` : 'Loading source detection…'}</p>${data?.areas ? `<ul>${data.areas.filter((a: any) => a.files).map((a: any) => `<li>${escape(a.path)} · ${a.files}</li>`).join('')}</ul>` : ''}<button data-action="estimate" class="primary" ${busy || !data?.applicable ? 'disabled' : ''}>Estimate audit</button></section>` : ''}
  ${stage === 'estimate' ? `<section><h2>Ready to audit</h2><p>${escape(data.notice)} ${count(data.coverage?.uninspected)} source files are outside the bounded semantic sample; the full source tree is still protected by the migration digest.</p><button data-action="audit" class="primary" ${busy ? 'disabled' : ''}>Run audit</button></section>` : ''}
  ${plan ? `<section class="migration-summary">${Object.entries(labels).map(([key, label]) => `<div><span>${label}</span><b>${plan.items.filter((i: any) => i.classification === key).length}</b></div>`).join('')}</section><section><h2>Import preview</h2><p>Import writes Git-shareable knowledge and skills, including candidates. Approval is a workflow step. Curator does not commit or push; review the Git diff before sharing.</p><p>${plan.items.filter((i:any)=>i.include).length} records · Required 0 · Relevant ${plan.items.filter((i:any)=>i.include).length} · Scoped ${plan.items.filter((i:any)=>i.include&&i.applicability?.kind==="scoped").length} · Unresolved ${plan.items.filter((i:any)=>i.include&&(!i.applicability||i.applicability.kind==="unresolved")).length}</p><p>${[...new Set(plan.items.map((i:any)=>i.category))].map(c=>`${escape(c)} ${plan.items.filter((i:any)=>i.include&&i.category===c).length}`).join(" · ")}</p><p>${plan.extractionMode === 'deterministic-memory-v1' ? 'These entries were extracted from curated AI Studio project memory. Review the batch summary; expand individual records when useful.' : 'Imported knowledge remains Relevant; importing does not make it mandatory. Skills stay candidates unless you explicitly select activation.'}</p>${plan?.coverage ? `<p>${plan.coverage.uninspected} source files not inspected · ${plan.coverage.excluded.length} omitted from analysis · ${plan.coverage.existingOmitted} existing knowledge/skill entries not shown to the model.</p>` : ''}${plan.audit.warnings.map((w: string) => `<p class="message">${escape(w)}</p>`).join('')}${plan.items.map((item: any) => `<details class="migration-item" data-item="${escape(item.id)}" ${opened.has(item.id) ? 'open' : ''}><summary>${escape(item.title)} <small>${labels[item.classification]}</small></summary><dl><dt>Source</dt><dd>${item.source.map((s: any) => `${escape(s.path)}:${s.startLine}–${s.endLine}`).join('<br>')}</dd><dt>Repository evidence</dt><dd>${item.repositoryEvidence.map((s: any) => `${escape(s.path)}:${s.startLine}–${s.endLine}`).join('<br>') || (plan.extractionMode === 'deterministic-memory-v1' ? 'Not required for curated memory transfer' : 'Not established')}</dd><dt>Destination</dt><dd>${item.classification === 'skill_candidate' ? 'Prodero Project Skills' : item.classification === 'project_instruction' ? 'Prodero project instructions' : item.classification === 'durable_project_knowledge' ? 'Prodero project knowledge' : 'Excluded report item'}</dd><dt>Category / delivery</dt><dd>${escape(item.category)} · Relevant · Imported</dd><dt>Applies to</dt><dd>${escape(item.applicability?.kind==="scoped"?[...(item.applicability.subsystems??[]),...(item.applicability.paths??[]),...(item.applicability.taskKinds??[])].join(" · "):"Unresolved")}</dd><dt>Reason</dt><dd>${escape(item.reason)}</dd></dl><pre>${escape(item.content)}</pre>${item.skill ? `<p><b>Purpose:</b> ${escape(item.skill.description)}</p><p><b>Use when:</b> ${escape(item.skill.triggers.join('; '))}</p>` : ''}${item.warnings.map((w: string) => `<p>${escape(w)}</p>`).join('')}<label><input type="checkbox" data-include="${escape(item.id)}" ${item.include ? 'checked' : ''} ${busy || receipt || !eligible(item) ? 'disabled' : ''}> Include</label>${item.classification === 'skill_candidate' ? `<label><input type="checkbox" data-activate="${escape(item.id)}" ${item.activateSkill ? 'checked' : ''} ${busy || receipt || !item.include ? 'disabled' : ''}> Activate this reviewed skill</label>` : ''}</details>`).join('')}${plan.verification.issues.map((i: any) => `<p class="message">${escape(i.severity)}: ${escape(i.message)}</p>`).join('')}<div class="actions"><button data-action="review" ${busy || receipt ? 'disabled' : ''}>Review selections</button><button data-action="apply" class="primary" ${busy || receipt || !plan.reviewed ? 'disabled' : ''}>Import reviewed plan (${plan.items.filter((i: any) => i.include).length})</button><button data-action="export">Export plan</button></div></section>` : ''}
  ${receipt && stage !== 'verify' ? `<section><h2>Import applied</h2><p>${receipt.created.length} imported · ${receipt.duplicates.length} duplicates skipped. Verification is pending.</p><button data-action="verify" class="primary" ${busy ? 'disabled' : ''}>Verify migration</button></section>` : ''}
<footer><span>AI Studio remains read-only</span><b>prodero</b></footer></main>`;
    host.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(b => b.addEventListener('click', () => void act(b.dataset.action!)));
    host.querySelectorAll<HTMLInputElement>('[data-include]').forEach(el => el.addEventListener('change', () => { const i = plan.items.find((i: any) => i.id === el.dataset.include); i.include = el.checked; if (!i.include)
        i.activateSkill = false; plan.reviewed = false; render(); }));
    host.querySelectorAll<HTMLInputElement>('[data-activate]').forEach(el => el.addEventListener('change', () => { plan.items.find((i: any) => i.id === el.dataset.activate).activateSkill = el.checked; plan.reviewed = false; render(); }));
}
// Keep the server-authenticated proposal separate from mutable selection controls.
let originalPlan: any = null;
function download(value: any, name: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url); }
async function callPluginAction(action: string, input: any = {}) {
    return parse(await app.callServerTool({ name: `prodero_plugin_${pluginId}_${action}`, arguments: { projectRoot: root, input } }));
}
async function act(action: string) {
    if (action === 'export') {
        download(originalPlan, 'prodero-migration-plan.json');
        return;
    }
    if (action === 'export-report') {
        download({ plan: originalPlan, receipt, report: data }, 'prodero-migration-report.json');
        return;
    }
    busy = action === 'audit' ? 'Extracting durable project memory locally' : action === 'estimate' ? 'Scanning structured memory locally' : action;
    error = '';
    render();
    try {
        const input = action === 'review' ? { planId: originalPlan.planId, decisions: plan.items.map((i: any) => ({ id: i.id, include: i.include, activateSkill: i.activateSkill })) } : action === 'apply' ? { planId: originalPlan.planId, approvedPlanId: originalPlan.planId } : action === 'verify' ? { planId: originalPlan.planId, receipt, semantic: true } : {};
        const value = await callPluginAction(action, input);
        accept(value);
        if (data?.plan)
            originalPlan = structuredClone(data.plan);
    }
    catch (e) {
        error = e instanceof Error ? e.message : String(e);
    }
    finally {
        busy = '';
        render();
    }
}
app.ontoolresult = result => { try {
    accept(parse(result));
    if (data?.plan)
        originalPlan = structuredClone(data.plan);
    render();
}
catch (e) {
    error = String(e);
    render();
} };
render();
void app.connect();

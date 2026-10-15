import {sameApplicability,withApplicability} from "./applicability.js";
import { inferredKnowledge } from './knowledge-authority.js';
import { readConfig } from './storage.js';
import { knowledgePolicy, inheritKnowledgePolicy } from "./knowledge-policy.js";
import { reconcileCandidate, normalizeReconciliation, actionClassification } from './reconciliation.js';
import fs from 'node:fs/promises';
import { sessionCandidates, type ConsolidationResult } from './consolidation.js';
import { loadMemoryCatalog } from './memory-index.js';
import { renderKnowledge, parseKnowledge } from './memory.js';
import { exactKnowledge, semanticRisk, isExtractivelyGrounded } from './semantic-safety.js';
import { renderSkill, skillInputSchema, parseSkill, type ProjectSkill } from './skills.js';
import { sortableId } from './ids.js';
import { normalized, tokens } from './matching.js';
import { sha256 } from './storage.js';
import { safeProjectPath, fileHash, type PlannedWrite } from './sync-transaction.js';
import { estimateTokens, knowledgeText, MAX_CANONICAL_ITEM_TOKENS } from './telemetry.js';
import { INTELLIGENCE_LIMITS as L, IntelligenceError, intelligenceTelemetry, requestIntelligence,
  type IntelligenceProvider, type KnowledgeCandidate, type ProposedAction, type IntelligenceRecord,
  type ObservationEvidence, type AuditInput, type CanonicalProposal, distillSchema, auditSchema,
} from './intelligence.js';
import type { KnowledgeItem, SessionMemory } from './types.js';

const unique = (values: string[]) => [...new Set(values)].sort();
const sameBoundary = (a: Pick<CanonicalProposal, "category" | "scope" | "scopeRef" | "scopeKind" | "applicability">, b: Pick<CanonicalProposal, "category" | "scope" | "scopeRef" | "scopeKind" | "applicability">) => a.category === b.category && a.scope === b.scope && a.scopeRef === b.scopeRef && a.scopeKind === b.scopeKind && sameApplicability(a,b);
const priority = { contextual: 0, normal: 1, important: 2, critical: 3 };
export function observationEvidence(sessions: SessionMemory[]): ObservationEvidence[] {
  return sessions.flatMap(sessionCandidates).map((c) => ({ id: c.derivedFrom, sessionId: c.sessionId,
    kind: c.skill ? 'skill_candidate' : c.instructionCandidate ? 'instruction_candidate' : 'knowledge',
    title: c.title, content: c.content, category: c.category, scope: c.scope, scopeRef: c.scopeRef, scopeKind: c.scopeKind, priority: c.priority, applicability:c.applicability, supersedes: c.supersedes }));
}
export function observationKey(o: ObservationEvidence): string { return sha256(JSON.stringify(o)); }
export interface AssistedPlan { result: ConsolidationResult; writes: PlannedWrite[]; intelligence: ReturnType<typeof intelligenceTelemetry>; reasoning: IntelligenceRecord[]; instructionCandidates: KnowledgeCandidate[]; observationHashes: string[]; knowledgeBefore: KnowledgeItem[] }

/** Build a fully validated, in-memory canonical overlay; no canonical writes or provider filesystem access. */
export async function planAssistedSync(root: string, sessions: SessionMemory[], provider: IntelligenceProvider, now = new Date(), processed = new Set<string>(), options: { instructionIds?: string[] } = {}): Promise<AssistedPlan> {
  const evidence = observationEvidence(sessions).filter((o) => !processed.has(observationKey(o)));
  const catalog = await loadMemoryCatalog(root);
  const telemetry = intelligenceTelemetry(provider);
  telemetry.distillation.sessions = new Set(evidence.map((o) => o.sessionId)).size;
  telemetry.distillation.observations = evidence.length;
  const result: ConsolidationResult = { candidates: 0, created: [], createdSkills: [], skillCandidateTokensAdded: 0, updated: [], consolidated: [], superseded: [], duplicates: [], conflicts: [], conflictCount: 0, memoryFilesScanned: catalog.filesScanned, memoryBodiesIndexed: catalog.bodiesIndexed, memoryBodiesLoaded: 0, relatedCandidatesSelectedMax: 0, observationsProcessed: evidence.length, rawSessionTokens: 0, rawKnowledgeTokens: 0, rawSkillCandidateTokens: 0, canonicalTokensAdded: 0, compactedSegments: 0, conservativeMergesSkipped: 0 };
  for (const o of evidence) { const n = estimateTokens(o.content); result.rawSessionTokens += n; if (o.kind === 'skill_candidate') result.rawSkillCandidateTokens += n; else result.rawKnowledgeTokens += n; }
  const overlay = new Map<string, KnowledgeItem>();
  const originals = new Map<string, { hash: string | null; tokens: number }>();
  const touched = new Set<string>();
  const beforeItems = new Map<string, KnowledgeItem>();
  const changedActions: ProposedAction[] = [];
  const reasoning: IntelligenceRecord[] = [];
  const instructionCandidates: KnowledgeCandidate[] = [];
  const skillWrites: PlannedWrite[] = [];
  const allCandidates = new Map<string, KnowledgeCandidate>();
  const observationMap = new Map(evidence.map((o) => [o.id, o]));
  const timestamp = now.toISOString();
  const fail = (message: string): never => { throw new Error(`Invalid intelligence proposal: ${message}. No semantic plan was committed; sessions remain pending.`); };
  async function load(id: string) {
    if (overlay.has(id)) return overlay.get(id)!;
    const indexed = catalog.summaries.find((item) => item.id === id);
    if (!indexed) return fail('memory is absent from the unified catalog');
    const target = await safeProjectPath(root, indexed.relativePath);
    const body = await fs.readFile(target, "utf8");
    const before = sha256(body);
    const item = parseKnowledge(body, `${id}.md`, (await readConfig(root))?.knowledgeSchemaVersion);
    catalog.bodiesLoaded++;
    if (item.id !== id) fail('memory ID does not match filename');
    originals.set(id, { hash: before, tokens: estimateTokens(knowledgeText(item)) });
    beforeItems.set(id, structuredClone(item)); overlay.set(id, item); return item;
  }
  function validateCanonical(item: CanonicalProposal, sources: CanonicalProposal[]) {
    if (estimateTokens(knowledgeText(item)) > MAX_CANONICAL_ITEM_TOKENS) fail('canonical item exceeds size budget');
    if (!sources.every((s) => sameBoundary(item, s) && sameApplicability(item,s))) fail('scope/category escalation or incompatible boundary');
    if (priority[item.priority] > Math.max(...sources.map((s) => priority[s.priority]))) fail('priority escalation');
    if (/[\r\n]/.test(item.title)) fail('multiline title');
  }
  function mark(item: KnowledgeItem) { item.updatedAt = timestamp; touched.add(item.id); }
  function provenance(items: Array<KnowledgeItem | KnowledgeCandidate>) {
    return { evidence: items.flatMap((s) => "derivedFrom" in s ? (s.evidence ?? s.derivedFrom.map((ref) => ({ kind: "session_observation" as const, ref }))) : s.sources.map((ref) => ({ kind: "session_observation" as const, ref }))), sourceSessions: unique(items.flatMap((s) => 'sourceSessions' in s ? s.sourceSessions : s.sources.map((id) => observationMap.get(id)!.sessionId))), derivedFrom: unique(items.flatMap((s) => 'derivedFrom' in s ? s.derivedFrom : s.sources)) };
  }
  function create(candidate: KnowledgeCandidate, status: 'active' | 'disputed') {
    const id = sortableId('mem', now);
    const item: KnowledgeItem = { id,version:3,applicability:candidate.applicability??{kind:'legacy'}, title: candidate.title, content: candidate.content, scope: candidate.scope, scopeRef: candidate.scopeRef, scopeKind: candidate.scopeKind, category: candidate.category, priority: candidate.priority, status, createdAt: timestamp, updatedAt: timestamp, ...provenance([candidate]), supersedes: [], related: [] };
    Object.assign(item, withApplicability(inferredKnowledge(item),item.applicability!));
    validateCanonical(item, [candidate]); overlay.set(id, item); originals.set(id, { hash: null, tokens: 0 }); touched.add(id); result.created.push(id); return item;
  }
  async function related(candidate: KnowledgeCandidate) {
    // Rank the staged overlay and both stored layers together before bounding.
    const summaries = catalog.summaries.filter(m => !touched.has(m.id));
    const staged = [...touched].map(id => overlay.get(id)!).map(m => ({ ...m,
      tokens: [...tokens(`${m.title} ${m.content} ${m.scopeRef ?? ''}`)],
      normalizedTitle: normalized(m.title), normalizedContent: normalized(m.content) }));
    const shadowed = new Set([...summaries, ...staged].filter(m => ['active', 'disputed'].includes(m.status)).flatMap(m => m.supersedes));
    const queryTokens = tokens(`${candidate.title} ${candidate.content}`);
    const queryTitle = normalized(candidate.title), queryContent = normalized(candidate.content);
    const ordered = [...summaries, ...staged]
      .filter(m => ['active', 'disputed'].includes(m.status) &&
        (candidate.supersedes.includes(m.id) || (!shadowed.has(m.id) && sameBoundary(m, candidate))))
      .map(m => ({ id: m.id, score: (candidate.supersedes.includes(m.id) ? 10000 : 0)
        + m.tokens.filter(t => queryTokens.has(t)).length * 10
        + (queryTitle && m.normalizedTitle === queryTitle ? 1000 : 0)
        + (queryContent && m.normalizedContent === queryContent ? 2000 : 0) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(m => m.id);
    const bounded: KnowledgeItem[] = [];
    for (const id of ordered.slice(0, L.relatedMemories)) {
      const item = await load(id);
      if (!['active', 'disputed'].includes(item.status)) continue;
      if (estimateTokens(JSON.stringify({ candidate, related: [...bounded, item] })) <= L.reconcileInputTokens) bounded.push(item);
    }
    if (candidate.supersedes.some((id) => !bounded.some((m) => m.id === id))) fail('explicit supersession target absent from bounded context');
    result.relatedCandidatesSelectedMax = Math.max(result.relatedCandidatesSelectedMax, bounded.length);
    return bounded;
  }
  function apply(action: ProposedAction, available: Set<string>, candidate?: KnowledgeCandidate): string[] {
    action = normalizeReconciliation(action, Boolean(candidate));
    if (new Set(action.sources).size !== action.sources.length || action.sources.some((id) => !available.has(id))) fail('unknown, duplicate or out-of-area source ID');
    if (candidate && !action.sources.includes(candidate.id)) fail('candidate evidence omitted');
    if (candidate?.supersedes.length && !['SUPERSEDE', 'CONFLICT', 'UNCERTAIN'].includes(action.action)) fail('explicit supersession cannot be ignored');
    const memories = action.sources.filter((id) => id !== candidate?.id).map((id) => overlay.get(id) ?? fail('nonexistent memory'));
    if (memories.some((m) => !['active', 'disputed'].includes(m.status))) fail('illegal historical state transition');
    if (action.action !== 'SUPERSEDE' && action.replacements) fail('replacement evidence on a non-supersession action');
    if (action.action !== 'MERGE' && action.canonical !== null) fail('canonical content only allowed for MERGE');
    const targets: string[] = [];
    if (action.action === 'CREATE') {
      if (!candidate || memories.length) fail('CREATE sources');
      targets.push(create(candidate!, 'active').id);
    } else if (action.action === 'MERGE' || action.action === 'NO_CHANGE') {
      if (memories.length !== (candidate ? 1 : 2)) fail('merge/duplicate requires two sources');
      const incoming = candidate ?? memories[1]; const target = memories[0];
      if (!candidate && memories.some(m => m.contextPolicy !== target.contextPolicy || m.authority !== target.authority)) fail('merge changes context policy or authority');
      if(options.instructionIds && new Set(memories.map(m=>catalog.summaries.find(s=>s.id===m.id)!.layer)).size>1) fail('optimization cannot cross publication layers');
      if(options.instructionIds && memories.some(m=>(m.relations??[]).some(r=>r.type==='contradicts'))) fail('instruction conflict requires review');
      if (memories.some((m) => m.status !== 'active')) fail('cannot accept disputed knowledge via merge');
      if (!sameBoundary(incoming, target) || semanticRisk(incoming.content, target.content) || (incoming.category === 'instruction' && incoming.priority !== target.priority)) fail('unsafe semantic merge or duplicate');
      const targetVersioned = catalog.summaries.find((item) => item.id === target.id)?.layer === 'versioned';
      if (action.action === 'MERGE') {
        if (!action.canonical) fail('missing canonical merge');
        action.canonical!.applicability ??= target.applicability; action.canonical!.scopeKind ??= target.scopeKind;
        validateCanonical(action.canonical!, [incoming, target]);
        if (incoming.category === 'instruction' && action.canonical!.priority !== incoming.priority) fail('merge changes mandatory policy priority');
        if (!isExtractivelyGrounded(action.canonical!.content, [incoming.content, target.content])) fail("merge invents factual sentences");
        if (![incoming.content, target.content].every((content) => isExtractivelyGrounded(content, [action.canonical!.content]))) fail("merge drops source constraints");
        // Protected constraints cannot disappear from the combined result.
        if (semanticRisk(`${target.content}\n${incoming.content}`, action.canonical!.content)) fail('merge loses protected constraints');
        if (targetVersioned && candidate) {
          const local = create(candidate, 'active'); Object.assign(local, action.canonical!); inheritKnowledgePolicy(local, [target]);
          Object.assign(local, provenance([target, candidate])); local.supersedes = unique([...local.supersedes, target.id]); mark(local);
          result.consolidated.push(local.id); targets.push(target.id, local.id);
          reasoning.push({ phase: 'reconcile', action: action.action, sources: action.sources, targets, reason: action.reason, classification: actionClassification(action) });
          return targets;
        }
        Object.assign(target, action.canonical!); result.consolidated.push(target.id);
      } else {
        if (!isExtractivelyGrounded(incoming.content, [target.content])) fail("NO_CHANGE would discard new evidence");
        result.duplicates.push(target.id);
        if (targetVersioned && candidate) { targets.push(target.id); reasoning.push({ phase: 'reconcile', action: action.action, sources: action.sources, targets, reason: action.reason, classification: actionClassification(action) }); return targets; }
      }
      Object.assign(target, provenance([target, incoming]));
      if(!candidate) {
        const source=incoming as KnowledgeItem;
        target.supersedes=unique([...target.supersedes,...source.supersedes]);
        target.related=unique([...target.related,...source.related]);
        target.relations=[...new Map([...(target.relations??[]),...(source.relations??[])].map(r=>[`${r.type}:${r.target}`,r])).values()];
      }
      mark(target); targets.push(target.id);
      if (!candidate) { const incoming = memories[1]; incoming.status = action.action === 'MERGE' ? 'consolidated' : 'duplicate'; incoming.related = unique([...incoming.related, target.id]); mark(incoming); target.related = unique([...target.related, incoming.id]); targets.push(incoming.id); }
    } else if (action.action === 'SUPERSEDE') {
      if (!memories.length || (!candidate && memories.length !== 2)) fail('supersession sources');
      const newer = candidate ? create(candidate, 'active') : memories[0];
      const older = candidate ? memories : memories.slice(1);
      if (candidate) inheritKnowledgePolicy(newer, older);
      const allowed = candidate?.supersedes ?? newer.supersedes;
      const inferred = older.filter(old => !allowed.includes(old.id));
      if (action.replacements?.some(r => !inferred.some(old => old.id === r.target)) ||
          new Set(action.replacements?.map(r => r.target)).size !== (action.replacements?.length ?? 0)) fail('invalid replacement targets');
      for (const old of inferred) {
        const proof = action.replacements?.find(r => r.target === old.id);
        // The model decides semantic identity/completeness. Core verifies bounded IDs,
        // source authority, full old-body coverage and actual transition evidence.
        if (!candidate || !proof || !sameBoundary(candidate, old) ||
            exactKnowledge(proof.previousQuote) !== exactKnowledge(old.content) ||
            !candidate.content.includes(proof.replacementQuote) ||
            !candidate.content.includes(proof.transitionQuote) ||
            !/\b(now|no longer|implemented|completed|replaced|changed|migrated|previously|formerly)\b/i.test(proof.transitionQuote) ||
            !candidate.evidence.some(e => e.quote.includes(proof.transitionQuote))) fail('supersession lacks explicit evidence or validated transition');
      }
      for (const old of older) {
        if (catalog.summaries.find((item) => item.id === old.id)?.layer !== 'versioned') { old.status = 'superseded'; old.related = unique([...old.related, newer.id]); mark(old); result.superseded.push(old.id); }
        newer.supersedes = unique([...newer.supersedes, old.id, ...old.supersedes]); targets.push(old.id);
      }
      mark(newer); targets.push(newer.id);
    } else {
      if (action.action === 'LINK' && !memories.length) fail('LINK requires related knowledge');
      const items = candidate ? [...memories, create(candidate, action.action === 'LINK' ? 'active' : 'disputed')] : memories;
      if (!items.length) fail('empty conflict/uncertainty');
      for (const item of items) {
        const writable = catalog.summaries.find((candidate) => candidate.id === item.id)?.layer !== 'versioned';
        if (writable) {
          if (action.action !== 'LINK') { item.status = 'disputed'; result.conflicts.push(item.id); }
          item.related = unique([...item.related, ...items.filter((m) => m.id !== item.id).map((m) => m.id)]); mark(item);
        }
        targets.push(item.id);
      }
      if (action.action !== 'LINK') result.conflictCount++;
    }
    reasoning.push({ phase: candidate ? 'reconcile' : 'audit', action: action.action, sources: action.sources, targets, reason: action.reason, classification: actionClassification(action) });
    return targets;
  }
  function validateCandidate(c: KnowledgeCandidate, batch: ObservationEvidence[]) {
    if (allCandidates.has(c.id) || !/^candidate_[A-Za-z0-9_-]+$/.test(c.id)) fail('candidate ID');
    const sources = c.sources.map((id) => batch.find((o) => o.id === id) ?? fail('unknown observation reference'));
    if (unique(c.sources).length !== c.sources.length || sources.some((o) => o.kind !== c.kind)) fail('candidate source/type mismatch');
    if (c.kind !== 'knowledge' && sources.length !== 1) fail('review candidates retain one source identity');
    validateCanonical(c, sources);
    for (const source of sources) {
      if (!c.evidence.some((e) => e.source === source.id && source.content.includes(e.quote))) fail('missing exact source evidence');
    }
    if (c.evidence.some((e) => !sources.some((s) => s.id === e.source && s.content.includes(e.quote)))) fail('invented evidence quote');
    if (!isExtractivelyGrounded(c.content, sources.map((s) => s.content))) fail("unsupported factual sentence");
    if (semanticRisk(sources.map((s) => s.content).join('\n'), c.content)) fail('distillation changes protected constraints');
    const explicit = sources.flatMap((s) => s.supersedes);
    if (c.supersedes.some((id) => !explicit.includes(id))) fail('invented supersession');
    allCandidates.set(c.id, c);
  }
  async function saveCandidate(c: KnowledgeCandidate) {
    result.candidates++;
    if (c.kind === 'instruction_candidate') { instructionCandidates.push(c); return; }
    if (c.kind === 'skill_candidate') {
      const source = observationMap.get(c.sources[0])!;
      const id = `skill_${sha256(source.id).slice(0, 32)}`;
      const relative = `local/skills/${id}.md`; const target = await safeProjectPath(root, relative);
      const before = await fileHash(target);
      if (before) { if (!parseSkill(await fs.readFile(target, 'utf8'), `${id}.md`).derivedFrom.includes(source.id)) fail('skill provenance collision'); return; }
      const original = sessions.flatMap(sessionCandidates).find((o) => o.derivedFrom === source.id)!;
      const skill: ProjectSkill = { ...skillInputSchema.parse({ title: c.title, description: original.description ?? c.content.slice(0, 300), content: c.content, scope: c.scopeRef ?? 'project', triggers: original.triggers }), id, path: relative, status: 'candidate', origin: 'session-inference', sourceSessions: [source.sessionId], derivedFrom: [source.id], proposedReason: original.proposedReason ?? null, reviewedAt: null, reviewReason: null, createdAt: timestamp, updatedAt: timestamp };
      skillWrites.push({ path: relative, before: null, after: renderSkill(skill) }); result.createdSkills.push(id); result.skillCandidateTokensAdded += estimateTokens(skill.content); return;
    }
    const neighbors = await related(c);
    telemetry.reconciliation.comparisons += neighbors.length;
    const exact = !c.supersedes.length && neighbors.find((m) => m.status === 'active' && sameBoundary(m, c) && exactKnowledge(m.content) === exactKnowledge(c.content));
    const action = exact ? { action: 'NO_CHANGE' as const, sources: [c.id, exact.id], canonical: null, classification:'duplicate' as const, reason: 'Exact content equality; retain additional source evidence.' } : await reconcileCandidate(c, neighbors, provider, telemetry);
    telemetry.reconciliation.actions[action.action]++;
    apply(action, new Set([c.id, ...neighbors.map((m) => m.id)]), c);
    if (action.action !== 'NO_CHANGE') changedActions.push(action);
  }
  // Exact duplicates bypass both model phases and still retain source provenance.
  const pending: ObservationEvidence[] = [];
  for (const o of evidence) {
    if (o.kind !== 'knowledge') { pending.push(o); continue; }
    const c: KnowledgeCandidate = { ...o, id: `candidate_exact_${sha256(o.id).slice(0, 16)}`, sources: [o.id], evidence: [{ source: o.id, quote: o.content }] };
    const neighbors = await related(c);
    const exact = !o.supersedes.length && neighbors.find((m) => m.status === 'active' && sameBoundary(m, o) && exactKnowledge(m.content) === exactKnowledge(o.content));
    if (!exact) { pending.push(o); continue; }
    result.candidates++; telemetry.reconciliation.actions.NO_CHANGE++;
    apply({ action: 'NO_CHANGE', sources: [c.id, exact.id], canonical: null, classification:'duplicate', reason: 'Exact content equality; no model call needed.' }, new Set([c.id, exact.id]), c);
  }
  let batch: ObservationEvidence[] = [];
  async function flush() {
    if (!batch.length) return;
    const distilled = distillSchema.parse(await requestIntelligence(provider, 'distill', { observations: batch }, telemetry));
    // Batch-local model IDs are made globally unique without trusting them as disk IDs.
    const seen = new Set<string>();
    for (const c of distilled.candidates) { if (seen.has(c.id)) fail('duplicate candidate ID'); seen.add(c.id); c.id = `candidate_${telemetry.distillation.calls}_${c.id}`; c.applicability ??= batch.find(o=>c.sources.includes(o.id))?.applicability; c.scopeKind ??= batch.find(o=>c.sources.includes(o.id))?.scopeKind; validateCandidate(c, batch); }
    if (batch.some((o) => !distilled.candidates.some((c) => c.sources.includes(o.id)))) fail('distillation dropped an observation');
    telemetry.distillation.candidates += distilled.candidates.length;
    for (const c of distilled.candidates) await saveCandidate(c);
    batch = [];
  }
  for (const o of pending) {
    if (estimateTokens(JSON.stringify({ observations: [o] })) > L.distillInputTokens) throw new IntelligenceError('distill', 'single observation exceeds budget; preserve pending evidence');
    if (batch.length >= L.observationsPerBatch || estimateTokens(JSON.stringify({ observations: [...batch, o] })) > L.distillInputTokens) await flush();
    batch.push(o);
  }
  await flush();
  const instructionAudit = options.instructionIds;
  if(instructionAudit && (sessions.length || instructionAudit.length>L.auditItems || new Set(instructionAudit).size!==instructionAudit.length)) fail('invalid explicit instruction area');
  if(instructionAudit) for(const id of instructionAudit) {
    const summary=catalog.summaries.find(m=>m.id===id);
    if(!summary || summary.category!=='instruction' || summary.status!=='active') fail('instruction optimization requires current instructions');
  }
  const meaningful = changedActions.length;
  if (instructionAudit?.length || meaningful && (changedActions.some((a) => ['MERGE', 'SUPERSEDE', 'CONFLICT', 'LINK', 'UNCERTAIN'].includes(a.action)) || touched.size >= L.auditTriggerItems)) {
    const auditItems: KnowledgeItem[] = [];
    const changedIds = [...touched];
    const neighborIds = changedIds.flatMap((id) => {
      const item = overlay.get(id)!;
      return [...item.related, ...catalog.selectRelated({ ...item, explicitIds: item.related }, L.relatedMemories).map((m) => m.id)];
    });
    const ids = instructionAudit ?? unique([...changedIds, ...neighborIds]);
    const ordered = instructionAudit ?? unique(changedIds).concat(ids.filter((id) => !touched.has(id)));
    // The evidence and change records are bounded together with the neighborhood.
    const auditEvidence: ObservationEvidence[] = [];
    const changes: ProposedAction[] = [];
    const budgetFits = (items: KnowledgeItem[], ev = auditEvidence, acts = changes) => estimateTokens(JSON.stringify({ items, evidence: ev, changes: acts, truncated: true })) <= L.auditInputTokens;
    for (const id of ordered.slice(0, L.auditItems)) { const item = await load(id); if (!budgetFits([...auditItems, item])) break; auditItems.push(item); }
    const area = new Set(auditItems.map((i) => i.id));
    for (const e of evidence.filter((o) => auditItems.some((i) => i.derivedFrom.includes(o.id)))) { if (budgetFits(auditItems, [...auditEvidence, e])) auditEvidence.push(e); }
    for (const a of changedActions) { if (changes.length < L.auditItems && budgetFits(auditItems, auditEvidence, [...changes, a])) changes.push(a); }
    const truncated = auditItems.length < ids.length || auditEvidence.length < evidence.length || changes.length < changedActions.length;
    const input: AuditInput = { ...(instructionAudit ? {purpose:'instruction_optimization' as const} : {}), items: auditItems, evidence: auditEvidence, changes, truncated };
    telemetry.audit.triggered = true; telemetry.audit.items = auditItems.length; telemetry.audit.truncated = truncated;
    const audit = auditSchema.parse(await requestIntelligence(provider, 'audit', input, telemetry));
    if (audit.status === 'clean' && (audit.issues.length || audit.actions.length)) fail('clean audit contains issues/actions');
    if (audit.status === 'changes_proposed' && !audit.actions.length) fail('audit status/action mismatch');
    for (const issue of audit.issues) if (issue.sources.some((id) => !area.has(id))) fail('out-of-area audit issue');
    // Apply to the overlay; any later validation error discards the whole plan.
    for (const action of audit.actions) {
      if(instructionAudit && (!['MERGE','NO_CHANGE'].includes(action.action) || action.sources.some(id=>audit.issues.some(i=>i.kind!=='fragmentation' && i.kind!=='duplicate' && i.sources.includes(id))))) fail('optimization cannot resolve conflicts or change instruction authority');
      apply(action, area); telemetry.audit.applied++;
    }
    const unresolved = audit.issues.filter((issue) => !audit.actions.some((a) => ['MERGE', 'SUPERSEDE', 'NO_CHANGE'].includes(a.action) && issue.sources.every((id) => a.sources.includes(id))));
    for (const issue of instructionAudit ? [] : unresolved) apply({ action: 'UNCERTAIN', classification:issue.kind === 'contradiction' && issue.sources.length > 1 ? 'potential_conflict' : 'unresolved', sources: issue.sources, canonical: null, reason: issue.reason }, area);
    if (!instructionAudit && audit.status === 'uncertain' && !unresolved.length) {
      const activeIds = auditItems.filter((m) => ['active', 'disputed'].includes(m.status)).map((m) => m.id);
      if (activeIds.length) apply({ action: 'UNCERTAIN', sources: activeIds, canonical: null, reason: 'Audit could not establish coherence; retain all evidence.' }, area);
    }
    telemetry.audit.issues = audit.issues.length; telemetry.audit.proposed = audit.actions.length;
    telemetry.audit.status = unresolved.length || audit.status === 'uncertain' || truncated || auditItems.some((item) => item.status === 'disputed') || [...touched].some((id) => overlay.get(id)!.status === 'disputed') ? 'attention' : 'coherent';
  }
  const writes: PlannedWrite[] = [...skillWrites];
  for (const id of touched) {
    const item = overlay.get(id)!;
    if (originals.get(id)!.hash !== null) result.updated.push(id);
    // Existing bodies are retained unchanged on supersession; provenance is only unioned.
    writes.push({ path: options.instructionIds ? catalog.summaries.find(m=>m.id===id)!.relativePath : `local/memory/${id}.md`, before: originals.get(id)!.hash, after: renderKnowledge(item) });
    const delta = estimateTokens(knowledgeText(item)) - originals.get(id)!.tokens;
    result.canonicalTokensAdded += Math.max(0, delta);
  }
  for (const key of ['created', 'updated', 'consolidated', 'superseded', 'duplicates', 'conflicts'] as const) result[key] = unique(result[key]);
  result.memoryBodiesLoaded = catalog.bodiesLoaded;
  return { result, writes, intelligence: telemetry, reasoning, instructionCandidates, observationHashes: evidence.map(observationKey), knowledgeBefore: [...touched].flatMap((id) => beforeItems.has(id) ? [beforeItems.get(id)!] : []) };
}

import { ContextAllocation, marginalValue, REQUIRED_HARD_ITEMS, REQUIRED_HARD_TOKENS, RELEVANT_HARD_ITEMS } from './context-allocation.js';
import {buildTaskContext,evaluateApplicability,applicabilityOf,type TaskContextInput} from "./applicability.js";
import { RetrievalEvidenceCollector, type RetrievalEvidence } from "./memory-pressure.js";
import { readConfig } from "./storage.js";
import { pathScopeRelevant, isPathScope } from "./path-scope.js";
import { tokens } from "./matching.js";
import { conflictWarnings } from "./bootstrap.js";
import { listProjectSkills, skillContext, scoreSkill } from "./skills.js";
import { isStaleSummary, loadMemoryCatalog, memoryHealth, type KnowledgeSummary } from "./memory-index.js";
import { loadKnowledgeGraph } from "./knowledge-graph.js";
import { contextPressure, DEFAULT_CONTEXT_BUDGET_TOKENS, DEFAULT_REQUIRED_CONTEXT_BUDGET_TOKENS, safeRatio, TOKEN_COUNT_METHOD } from "./telemetry.js";
import type { ContextResult, ContextSelectionSignal, KnowledgePriority, OmittedContextCandidate } from "./types.js";

export const MAX_CONTEXT_REQUIRED_ITEMS = REQUIRED_HARD_ITEMS;
export const MAX_CONTEXT_RELEVANT_ITEMS = 8;
export const MAX_CONFIGURED_CONTEXT_ITEMS = 128;
export const MAX_CONTEXT_SKILLS = 4;
export const MAX_OMITTED_CONTEXT_DETAILS = 32;
export const MAX_GRAPH_EXPANSIONS = 4;
export const MAX_GRAPH_DEPTH = 2;
export const MAX_GRAPH_TRAVERSED_EDGES = 32;
export const DEFAULT_CONTEXT_BUDGET_ESTIMATED_TOKENS = DEFAULT_CONTEXT_BUDGET_TOKENS;
export const DEFAULT_REQUIRED_CONTEXT_BUDGET_ESTIMATED_TOKENS = DEFAULT_REQUIRED_CONTEXT_BUDGET_TOKENS;

const PRIORITY_SCORE: Record<KnowledgePriority, number> = { critical: 80, important: 40, normal: 20, contextual: 10 };
const RELEVANCE_PRIORITY_SCORE: Record<KnowledgePriority, number> = { critical: 8, important: 4, normal: 2, contextual: 1 };
const CATEGORY_ORDER = ["instruction", "principle", "invariant", "constraint", "decision", "lesson", "state"];

function lexicalScore(queryTokens: Set<string>, item: Pick<KnowledgeSummary, "title" | "tokens" | "scopeRef" | "priority">): { score: number; signals: ContextSelectionSignal[] } {
  if (!queryTokens.size) return { score: 0, signals: [] };
  const searchable = new Set(item.tokens);
  const titleTokens = tokens(item.title);
  const scopeTokens = tokens(item.scopeRef ?? "");
  const matched: string[] = [];
  const titleMatched: string[] = [];
  const scopeMatched: string[] = [];
  let queryScore = 0;
  for (const token of queryTokens) {
    if (!searchable.has(token)) continue;
    matched.push(token);
    queryScore += token.length > 6 ? 6 : 4;
    if (titleTokens.has(token)) titleMatched.push(token);
    if (scopeTokens.has(token)) scopeMatched.push(token);
  }
  if (!matched.length) return { score: 0, signals: [] };
  const signals: ContextSelectionSignal[] = [
    { kind: "query-token", label: `Query token overlap: ${matched.join(", ")}`, score: queryScore },
  ];
  if (titleMatched.length) signals.push({ kind: "title-token", label: `Title token match: ${titleMatched.join(", ")}`, score: titleMatched.length * 8 });
  if (scopeMatched.length) signals.push({ kind: "scope-token", label: `Scope token match: ${scopeMatched.join(", ")}`, score: scopeMatched.length * 10 });
  signals.push({ kind: "priority", label: `${item.priority[0].toUpperCase()}${item.priority.slice(1)} priority`, score: RELEVANCE_PRIORITY_SCORE[item.priority] });
  return { score: signals.reduce((total, signal) => total + signal.score, 0), signals };
}


/** Storage freshness is a small ranking hint, never evidence of semantic replacement.
 * UTC-day precision keeps identical daily snapshots stable across reads/cache rebuilds.
 */
function recencySignal(item: Pick<KnowledgeSummary, "updatedAt">, now: Date): ContextSelectionSignal {
  const dayMs = 86_400_000;
  const updatedDay = Math.floor(Date.parse(item.updatedAt) / dayMs);
  const today = Math.floor(now.getTime() / dayMs);
  if (!Number.isFinite(updatedDay) || !Number.isFinite(today)) return { kind: "recency", label: "Storage freshness unavailable", score: 0 };
  const ageDays = Math.max(0, today - updatedDay);
  const score = Math.round(0.5 * 30 / (30 + ageDays) * 1_000_000) / 1_000_000;
  return { kind: "recency", label: `Storage freshness: updated ${ageDays} UTC day(s) ago (${item.updatedAt}); not a fact-effective date`, score };
}

function requiredOrder(a: KnowledgeSummary, b: KnowledgeSummary): number {
  return Number(b.contextPolicy === "required") - Number(a.contextPolicy === "required")
    || PRIORITY_SCORE[b.priority] - PRIORITY_SCORE[a.priority]
    || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
    || a.title.localeCompare(b.title)
    || a.id.localeCompare(b.id);
}

type ContextCandidate = { item: KnowledgeSummary; score: number; signals: ContextSelectionSignal[]; stale: boolean; recencyTime?: number };
const recencyTie = (a: ContextCandidate, b: ContextCandidate) => (b.recencyTime ?? 0) - (a.recencyTime ?? 0);

function* diverseRank(candidates: ContextCandidate[], limit: number) {
  // Within each scope/category group the diversity penalty is identical. Sort
  // once, then compare group heads instead of repeatedly sorting the corpus.
  const groups = new Map<string, { items: ContextCandidate[]; cursor: number }>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.item.scopeRef ?? candidate.item.scope, candidate.item.category]);
    if (!groups.has(key)) groups.set(key, { items: [], cursor: 0 });
    groups.get(key)!.items.push(candidate);
  }
  const tie = (a:ContextCandidate,b:ContextCandidate) => b.score-a.score || recencyTie(a,b) || a.item.title.localeCompare(b.item.title) || a.item.id.localeCompare(b.item.id);
  for (const group of groups.values()) group.items.sort(tie);
  const scopeCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const utility = (c:ContextCandidate) => c.score*100 - (scopeCounts.get(c.item.scopeRef ?? c.item.scope) ?? 0)*120 - (categoryCounts.get(c.item.category) ?? 0)*30;
  let visited=0;
  while (groups.size && visited++ < limit) {
    let bestKey='', best:ContextCandidate|undefined;
    for(const [key,group] of groups) {
      const head=group.items[group.cursor];
      if(!best || utility(head)>utility(best) || (utility(head)===utility(best) && tie(head,best)<0)){best=head;bestKey=key;}
    }
    const group=groups.get(bestKey)!;
    const next=group.items[group.cursor++];
    if(group.cursor===group.items.length)groups.delete(bestKey);
    const scope = next.item.scopeRef ?? next.item.scope;
    const scopePenalty = (scopeCounts.get(scope) ?? 0) * 1.2;
    const categoryPenalty = (categoryCounts.get(next.item.category) ?? 0) * 0.3;
    const signals = [...next.signals];
    if (scopePenalty) signals.push({ kind: "scope-diversity", label: `Scope diversity penalty: ${scope}`, score: -scopePenalty });
    if (categoryPenalty) signals.push({ kind: "category-diversity", label: `Category diversity penalty: ${next.item.category}`, score: -categoryPenalty });
    const ranked = { ...next, signals, rankScore: next.score - scopePenalty - categoryPenalty };
    yield ranked;
    scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
    categoryCounts.set(next.item.category, (categoryCounts.get(next.item.category) ?? 0) + 1);
  }
}

export async function getContext(
  root: string,
  query?: string,
  options: { taskContext?:TaskContextInput; purpose?: ContextPurpose; persistCache?: boolean; pendingSessions?: number; contextBudgetTokens?: number; maxContextItems?: number; requiredContextBudgetTokens?: number; conflictCount?: number; now?: Date; onRetrievalEvidence?: (evidence: RetrievalEvidence) => void; onRequiredOmitted?: (items: OmittedContextCandidate[]) => void } = {},
): Promise<ContextResult> {
  const evidence = options.onRetrievalEvidence ? new RetrievalEvidenceCollector() : undefined;
  const catalog = await loadMemoryCatalog(root, options);
  const graph = await loadKnowledgeGraph(root, catalog, options);
  const now = options.now ?? new Date();
  const knownSubsystems=catalog.summaries.flatMap(i=>i.applicability?.kind==='scoped'?i.applicability.subsystems??[]:[]);
  const taskContext=buildTaskContext(query,options.taskContext,knownSubsystems,catalog.summaries.flatMap(i=>i.applicability?.kind==='scoped'?i.applicability.paths??[]:[]));
  const decisions=new Map(catalog.summaries.map(i=>[i.id,evaluateApplicability(i,taskContext,i.contextPolicy==='required'?'required':'relevant')]));
  const applies=(i:KnowledgeSummary)=>i.contextPolicy==='required'&&decisions.get(i.id)!.state==='applicable';
  const relevantApplies=(i:KnowledgeSummary)=>applicabilityOf(i).kind==='legacy'?evaluateApplicability(i,taskContext,'relevant').state==='applicable':decisions.get(i.id)!.state!=='not_applicable' && (i.contextPolicy!=='required'||decisions.get(i.id)!.state==='applicable');
  const shadowed = new Set(catalog.summaries.filter((item) => item.status === "active" || item.status === "disputed").flatMap((item) => item.supersedes));
  const active = catalog.summaries.filter((item) => {
    const eligible = item.status === "active" && !shadowed.has(item.id);
    if (!eligible) evidence?.observe(item, "filtered", shadowed.has(item.id) || item.status === "superseded" ? "superseded" : "inactive");
    return eligible;
  });
  const health = memoryHealth(catalog.summaries, now);
  const contextBudgetTokens = Math.max(1, Math.floor(options.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS));
  const requiredContextBudgetTokens = Math.min(contextBudgetTokens, Math.max(0, Math.floor(options.requiredContextBudgetTokens ?? DEFAULT_REQUIRED_CONTEXT_BUDGET_TOKENS)));
  const maxContextItems = Math.min(MAX_CONFIGURED_CONTEXT_ITEMS, Math.max(1, Math.floor(options.maxContextItems ?? MAX_CONTEXT_RELEVANT_ITEMS)));

  const allocation = new ContextAllocation(contextBudgetTokens, requiredContextBudgetTokens);
  const queryTokens = tokens(query ?? "");
  const requiredCandidates = active
    .filter((item) => applies(item))
    .sort((a, b) => Number(b.priority === "critical") - Number(a.priority === "critical")
      || lexicalScore(queryTokens, b).score - lexicalScore(queryTokens, a).score || requiredOrder(a, b));
  const requiredGlobalCandidateTokens = requiredCandidates.reduce((total, item) => total + item.estimatedTokens, 0);
  const requiredSummaries: KnowledgeSummary[] = [];
  const omittedRequired: OmittedContextCandidate[] = [];
  let requiredGlobalTokens = 0;
  let requiredGlobalOmittedByBudget = 0;
  let requiredGlobalOmittedByBudgetTokens = 0;
  let requiredGlobalOmittedByItemLimit = 0;
  let requiredGlobalOmittedByItemLimitTokens = 0;
  let omittedCritical = 0;
  for (const item of requiredCandidates) {
    let reason: OmittedContextCandidate["reason"] | null = null;
    const constraint=allocation.take('required',item.estimatedTokens);
    if(constraint)reason=constraint==='required-item-ceiling'?'item-limit':'budget';
    if (reason) {
      if (item.priority === "critical") omittedCritical += 1;
      if (reason === "budget") { requiredGlobalOmittedByBudget += 1; requiredGlobalOmittedByBudgetTokens += item.estimatedTokens; }
      else { requiredGlobalOmittedByItemLimit += 1; requiredGlobalOmittedByItemLimitTokens += item.estimatedTokens; }
      evidence?.observe(item, "required", reason === "budget" ? "required-budget" : "item-limit", PRIORITY_SCORE[item.priority], PRIORITY_SCORE[item.priority]);
      omittedRequired.push({ id: item.id, title: item.title, category: item.category, scope: item.scope, scopeRef: item.scopeRef, priority: item.priority, estimatedTokens: item.estimatedTokens, score: PRIORITY_SCORE[item.priority], rankScore: PRIORITY_SCORE[item.priority], signals: [{ kind: "priority", label: `${item.priority[0].toUpperCase()}${item.priority.slice(1)} priority`, score: PRIORITY_SCORE[item.priority] }], reason, constraint:constraint! });
      continue;
    }
    requiredSummaries.push(item);
    requiredGlobalTokens += item.estimatedTokens;
  }
  options.onRequiredOmitted?.(omittedRequired);
  const required = await Promise.all(requiredSummaries.map((item) => catalog.load(item.id)));
  const requiredSelection = Object.fromEntries(requiredSummaries.map((item) => [item.id, { estimatedTokens: item.estimatedTokens, applicability:decisions.get(item.id), ...lexicalScore(queryTokens, item), rankScore: lexicalScore(queryTokens, item).score }]));
  for (const item of requiredSummaries) {
    const selected = requiredSelection[item.id];
    evidence?.observe(item, "required", "selected", selected.score, selected.rankScore, selected.signals);
  }
  const requiredIds = new Set(requiredCandidates.map((item) => item.id));
  const requiredGlobalExcludedItems = requiredCandidates.length - requiredSummaries.length;
  const requiredGlobalExcludedTokens = requiredGlobalCandidateTokens - requiredGlobalTokens;
  let contextTokens = requiredGlobalTokens;

  const lexicalMatches = active
    .filter((item) => !requiredIds.has(item.id))
    .filter((item) => { const matches = relevantApplies(item); if (!matches) evidence?.observe(item, "filtered", "scope-mismatch"); return matches; })
    .map((item) => {
      const lexical = lexicalScore(queryTokens, item);
      const applicability=decisions.get(item.id)!;
      if(applicabilityOf(item).kind==='scoped'&&applicability.state==='applicable'){lexical.score+=10*applicability.matched;lexical.signals.push({kind:'scope-token',label:applicability.reasons.join('; '),score:10*applicability.matched});}
      if (isPathScope(item) && applicability.state==='applicable') { lexical.score += 10; lexical.signals.push({ kind: "scope-token", label: "Exact or descendant repository path", score: 10 }); }
      return { item, ...lexical, stale: isStaleSummary(item, now) };
    })
    .filter(({ item, score, signals }) => { if (score <= 0) evidence?.observe(item, "filtered", "no-match", score, null, signals); return score > 0; });
  const requiredSeedMatches = requiredSummaries
    .map((item) => ({ item, ...lexicalScore(queryTokens, item), stale: isStaleSummary(item, now) }))
    .filter(({ score }) => score > 0);
  const matchingRelevant: ContextCandidate[] = [...lexicalMatches];
  const graphCandidates = new Set([...matchingRelevant, ...requiredSeedMatches].map(({ item }) => item.id));
  const activeById = new Map(active.map((item) => [item.id, item]));
  const traversalSeeds = [...lexicalMatches, ...requiredSeedMatches].sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).slice(0, maxContextItems);
  const queue = traversalSeeds.map((seed) => ({ id: seed.item.id, depth: 0, seed }));
  let traversedEdges = 0;
  let expandedItems = 0;
  for (let cursor = 0; cursor < queue.length && expandedItems < MAX_GRAPH_EXPANSIONS && traversedEdges < MAX_GRAPH_TRAVERSED_EDGES; cursor += 1) {
    const current = queue[cursor];
    if (current.depth >= MAX_GRAPH_DEPTH) continue;
    const graphPathPriority = (id: string) => {
      const item = activeById.get(id);
      return item && isPathScope(item) && pathScopeRelevant(query ?? "", item) ? 1 : 0;
    };
    const edges = graph.neighbors(current.id).filter((edge) => edge.weight > 0)
      .sort((a, b) => graphPathPriority(b.to) - graphPathPriority(a.to) || b.weight - a.weight || a.type.localeCompare(b.type) || a.to.localeCompare(b.to));
    for (const edge of edges) {
      if (traversedEdges >= MAX_GRAPH_TRAVERSED_EDGES || expandedItems >= MAX_GRAPH_EXPANSIONS) break;
      traversedEdges += 1;
      const item = activeById.get(edge.to);
      if (!item || requiredIds.has(item.id) || graphCandidates.has(item.id) || !relevantApplies(item) || (applicabilityOf(item).kind==='scoped' && decisions.get(item.id)!.state==='unknown' && lexicalScore(queryTokens,item).score<=0)) continue;
      const graphScore = Math.max(1, current.seed.score * 0.25 + edge.weight / (current.depth + 1));
      const priorityScore = RELEVANCE_PRIORITY_SCORE[item.priority];
      const score = graphScore + priorityScore;
      matchingRelevant.push({
        item,
        score,
        stale: isStaleSummary(item, now),
        signals: [
          { kind: "graph-edge", label: `${edge.type} from ${current.seed.item.title} at depth ${current.depth + 1}`, score: graphScore },
          { kind: "priority", label: `${item.priority[0].toUpperCase()}${item.priority.slice(1)} priority`, score: priorityScore },
        ],
      });
      graphCandidates.add(item.id);
      expandedItems += 1;
      queue.push({ id: item.id, depth: current.depth + 1, seed: current.seed });
    }
  }
  // Purpose adjusts only already-retrieved candidates; it never admits unrelated knowledge.
  if (options.purpose === "explain") {
    for (const candidate of matchingRelevant) {
      if (!["decision", "lesson", "state"].includes(candidate.item.category)) continue;
      candidate.score += 2;
      candidate.signals.push({ kind: "purpose", label: "Explain: decisions, lessons and state history", score: 2 });
    }
  }
  // Apply only after lexical/path/graph eligibility and purpose scoring. Freshness
  // never admits unrelated records, alters graph expansion or ranks required rules.
  for (const candidate of matchingRelevant) {
    if (requiredIds.has(candidate.item.id)) continue;
    const recency = recencySignal(candidate.item, now);
    candidate.score += recency.score;
    candidate.signals.push(recency);
    const updated = Date.parse(candidate.item.updatedAt);
    // Same-day evidence still orders by update time; clock skew gets no future advantage.
    candidate.recencyTime = Number.isFinite(updated) ? Math.min(updated, now.getTime()) : 0;
  }
  const activeSkills = (await listProjectSkills(root)).filter((skill) => skill.status === "active");
  const projectSkillsTokens = activeSkills.reduce((total, skill) => total + skillContext(skill).estimatedTokens, 0);
  const matchingSkills = activeSkills.map((skill) => ({ skill, ...scoreSkill(query ?? "", skill) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  const skills: Array<ReturnType<typeof skillContext> & ReturnType<typeof scoreSkill>> = [];
  const omittedSkills:Array<{id:string;reason:string;estimatedTokens:number}>=[];
  let selectedSkillsTokens = 0;
  let omittedSkillsByBudget = 0;
  let omittedSkillsByItemLimit = 0;
  const skillBudgetTokens = Math.min(1_500, allocation.remaining);
  const strongSkill = (s:typeof matchingSkills[number])=>s.score>=14;
  function selectSkills(candidates:typeof matchingSkills) {
  for (const { skill, score, signals } of candidates) {
    const context = skillContext(skill);
    const constraint=allocation.take('skill',context.estimatedTokens);
    if(constraint){if(constraint==='skill-item-ceiling')omittedSkillsByItemLimit++;else omittedSkillsByBudget++;omittedSkills.push({id:skill.id,reason:constraint,estimatedTokens:context.estimatedTokens});continue;}
    skills.push({ ...context, score, signals });
    selectedSkillsTokens += context.estimatedTokens;
    contextTokens += context.estimatedTokens;
  }

  }
  selectSkills(matchingSkills.filter(strongSkill));
  const protectedSkillTokens=selectedSkillsTokens;

  const rankedIds = new Set<string>();
  const ranked = diverseRank(matchingRelevant, matchingRelevant.length);
  const relevant = [];
  const relevantSelection: ContextResult["selection"]["relevant"] = {};
  const omittedRelevant: OmittedContextCandidate[] = [];
  let omittedRelevantByBudget = 0;
  let omittedRelevantByItemLimit = 0;
  let omittedRelevantByMarginalValue=0;
  const suppliedTerms=new Set(requiredSummaries.flatMap(i=>i.tokens));
  const peakScore=matchingRelevant.reduce((peak,c)=>Math.max(peak,c.score),0);
  let outsideReason: 'item-limit'|'marginal-value'|'budget'='item-limit';
  const minimumRelevantCost=matchingRelevant.reduce((n,c)=>Math.min(n,c.item.estimatedTokens),Infinity);
  let selectedContextualTokens = 0;
  let staleRelevantItems = 0;
  for (const candidate of ranked) {
    rankedIds.add(candidate.item.id);
    let reason: OmittedContextCandidate["reason"] | null = null;
    const marginal=marginalValue(candidate.item.tokens,queryTokens,suppliedTerms,candidate.rankScore,peakScore);
    let constraint: ReturnType<ContextAllocation['take']>=null;
    if(candidate.item.estimatedTokens>allocation.remaining){reason='budget';omittedRelevantByBudget++;constraint='total-capacity';}
    else if(relevant.length>=maxContextItems&&!marginal.useful){reason='marginal-value';omittedRelevantByMarginalValue++;}
    else {constraint=allocation.take('relevant',candidate.item.estimatedTokens);if(constraint){reason=constraint==='relevant-item-ceiling'?'item-limit':'budget';if(reason==='item-limit')omittedRelevantByItemLimit++;else omittedRelevantByBudget++;}}
    if(relevant.length>=maxContextItems)candidate.signals.push({kind:'marginal-value',label:`New information terms: ${marginal.novelTerms}; fraction ${marginal.novelFraction.toFixed(2)}`,score:0});
    if (reason) {
      evidence?.observe(candidate.item, "contextual", reason === "budget" ? "context-budget" : reason === "marginal-value" ? "marginal-value" : "item-limit", candidate.score, candidate.rankScore, candidate.signals);
      if (omittedRelevant.length < MAX_OMITTED_CONTEXT_DETAILS) omittedRelevant.push({ id: candidate.item.id, title: candidate.item.title, category: candidate.item.category, scope: candidate.item.scope, scopeRef: candidate.item.scopeRef, priority: candidate.item.priority, estimatedTokens: candidate.item.estimatedTokens, score: candidate.score, rankScore: candidate.rankScore, signals: candidate.signals, reason, ...(constraint?{constraint}:{}) });
      if(allocation.remaining<minimumRelevantCost){outsideReason='budget';break;}
      if(relevant.length>=maxContextItems && candidate.rankScore<Math.max(12,peakScore*0.3)){outsideReason='marginal-value';break;}
      continue;
    }
    evidence?.observe(candidate.item, "contextual", "selected", candidate.score, candidate.rankScore, candidate.signals);
    relevant.push(await catalog.load(candidate.item.id));
    relevantSelection[candidate.item.id] = { applicability:decisions.get(candidate.item.id), estimatedTokens: candidate.item.estimatedTokens, score: candidate.score, rankScore: candidate.rankScore, signals: candidate.signals };
    selectedContextualTokens += candidate.item.estimatedTokens;
    contextTokens += candidate.item.estimatedTokens;
    if (candidate.stale) staleRelevantItems += 1;
    for(const token of candidate.item.tokens)suppliedTerms.add(token);
    if (relevant.length >= RELEVANT_HARD_ITEMS) break;
  }
  const outsideRankWindow = matchingRelevant.length - rankedIds.size;
  if(outsideReason==='budget')omittedRelevantByBudget+=outsideRankWindow;else if(outsideReason==='marginal-value')omittedRelevantByMarginalValue+=outsideRankWindow;else omittedRelevantByItemLimit+=outsideRankWindow;
  for (const candidate of matchingRelevant) if (!rankedIds.has(candidate.item.id)) evidence?.observe(candidate.item, "contextual", outsideReason==='budget'?'context-budget':outsideReason, candidate.score, null, candidate.signals);
  for (const candidate of matchingRelevant
    .filter(({ item }) => !rankedIds.has(item.id))
    .sort((a, b) => b.score - a.score || recencyTie(a, b) || a.item.title.localeCompare(b.item.title) || a.item.id.localeCompare(b.item.id))) {
    if (omittedRelevant.length >= MAX_OMITTED_CONTEXT_DETAILS) break;
    omittedRelevant.push({ id: candidate.item.id, title: candidate.item.title, category: candidate.item.category, scope: candidate.item.scope, scopeRef: candidate.item.scopeRef, priority: candidate.item.priority, estimatedTokens: candidate.item.estimatedTokens, score: candidate.score, rankScore: candidate.score, signals: candidate.signals, reason: outsideReason, ...(outsideReason==='item-limit'?{constraint:'relevant-item-ceiling' as const}:outsideReason==='budget'?{constraint:'total-capacity' as const}:{}) });
  }
  const omittedRelevantTotal = omittedRelevantByBudget + omittedRelevantByItemLimit + omittedRelevantByMarginalValue;

  selectSkills(matchingSkills.filter(s=>!strongSkill(s)));

  const projectKnowledgeTokens = active.reduce((total, item) => total + item.estimatedTokens, 0);
  const pressure = contextPressure(requiredGlobalCandidateTokens, requiredContextBudgetTokens);
  const attention = [];
  const relevantDisputes = catalog.summaries.filter((item) => item.status === "disputed" && !shadowed.has(item.id) && relevantApplies(item) && (applies(item) || lexicalScore(queryTokens, item).score > 0));
  if (relevantDisputes.length) attention.push({ kind: "conflict" as const, severity: "critical" as const, title: `${relevantDisputes.length} disputed knowledge item(s) match this task`, detail: relevantDisputes.slice(0, 2).map((item) => item.title).join(" vs ") });
  const instructionConflicts = conflictWarnings(catalog.summaries.filter(item => !shadowed.has(item.id) && ["active", "disputed"].includes(item.status) && applies(item)));
  const applicableRequired = catalog.summaries.filter(item=>!shadowed.has(item.id) && ['active','disputed'].includes(item.status) && applies(item));
  const applicableRequiredIds=new Set(applicableRequired.map(i=>i.id));
  const blockingConflict=applicableRequired.some(i=>i.status==='disputed' || i.relations.some(r=>r.type==='contradicts'&&applicableRequiredIds.has(r.target)));
  const unknownRequired=catalog.summaries.filter(i=>!shadowed.has(i.id)&&['active','disputed'].includes(i.status)&&i.contextPolicy==='required'&&decisions.get(i.id)!.state==='unknown');
  const policyReadiness={state:blockingConflict?'review-required' as const:unknownRequired.length?'context-needed' as const:requiredGlobalExcludedItems?'required-incomplete' as const:'ready' as const,blocking:blockingConflict||unknownRequired.length>0||requiredGlobalExcludedItems>0};
  if(unknownRequired.length)attention.push({kind:'memory-health' as const,severity:'important' as const,title:'Resolve task context before continuing',detail:`${unknownRequired.length} scoped required policies need task paths, subsystem or activity signals. The agent can enrich Task Context and retry Prepare; no knowledge approval is requested.`});
  if(blockingConflict)attention.push({kind:'conflict' as const,severity:'critical' as const,title:'Resolve required policies before continuing',detail:'Applicable required knowledge has an explicit conflict or unresolved dispute. Keep the original task and retry Prepare after the policy is resolved.'});
  if (instructionConflicts.length && !relevantDisputes.length) attention.push({ kind: "conflict" as const, severity: "critical" as const, title: "Required instruction conflicts", detail: instructionConflicts.join(" ") });
  if(requiredGlobalExcludedItems)attention.push({kind:"context-budget" as const,severity:"critical" as const,title:"Required context is incomplete",detail:`${requiredGlobalExcludedItems} applicable required records cannot be delivered within total capacity or safety ceilings. Do not proceed as if mandatory context were complete; inspect omissions and retry with a suitably scoped task or explicit capacity change.`});


  if (evidence) options.onRetrievalEvidence?.(evidence.finish(query ?? "", options.purpose ?? "work", { contextBudgetTokens, requiredContextBudgetTokens, maxRequiredItems: MAX_CONTEXT_REQUIRED_ITEMS, maxContextItems }));

  return {
    projectRoot: root,
    allocation: {version:2,required:{demandItems:requiredCandidates.length,demandTokens:requiredGlobalCandidateTokens,selectedItems:required.length,selectedTokens:requiredGlobalTokens,reserveTokens:requiredContextBudgetTokens,borrowedTokens:Math.max(0,requiredGlobalTokens-requiredContextBudgetTokens),complete:requiredGlobalExcludedItems===0&&unknownRequired.length===0&&!blockingConflict,hardTokens:REQUIRED_HARD_TOKENS,hardItems:REQUIRED_HARD_ITEMS},relevant:{candidates:matchingRelevant.length,selected:relevant.length,softTarget:maxContextItems,hardItems:RELEVANT_HARD_ITEMS,beyondTarget:Math.max(0,relevant.length-maxContextItems),omissions:{capacity:omittedRelevantByBudget,safety:omittedRelevantByItemLimit,marginalValue:omittedRelevantByMarginalValue},stopReason:omittedRelevantByItemLimit?'safety-ceiling':omittedRelevantByBudget?'capacity':omittedRelevantByMarginalValue?'marginal-value':'candidates-exhausted'},skills:{candidates:matchingSkills.length,selected:skills.length,tokens:selectedSkillsTokens,protectedTokens:protectedSkillTokens,omitted:omittedSkills},unusedTokens:allocation.remaining},
    policyReadiness,
    taskContext,
    applicability:{unknownRequired:unknownRequired.length,decisions:Object.fromEntries([...required,...relevant,...unknownRequired.slice(0,32),...active.filter(i=>!requiredIds.has(i.id)).slice(0,32)].map(i=>[i.id,decisions.get(i.id)!])),truncated:Math.max(0,unknownRequired.length-32)},
    purpose: options.purpose ?? "work",
    query: query?.trim() || null,
    required,
    relevant,
    skills,
    snapshot: { version: 1, sessionId: null, task: query?.trim() || null },
    selection: {
      required: requiredSelection,
      relevant: relevantSelection,
      omittedRequired: omittedRequired.slice(0, MAX_OMITTED_CONTEXT_DETAILS),
      omittedRelevant,
      omittedRelevantByMarginalValue,
      omittedRelevantByBudget,
      omittedRelevantByItemLimit,
      omittedRelevantDetailsTruncated: Math.max(0, omittedRelevantTotal - omittedRelevant.length),
      omittedSkillsByBudget,
      omittedSkillsByItemLimit,
      loadedKnowledgeItems: required.length + relevant.length,
      graphTraversal: { seedCount: traversalSeeds.length, traversedEdges, expandedItems, maxDepth: MAX_GRAPH_DEPTH, expansionLimit: MAX_GRAPH_EXPANSIONS },
    },
    warnings: [
      ...(options.pendingSessions ? [`${options.pendingSessions} session file(s) contain unsynchronized changes.`] : []),
      ...(requiredGlobalExcludedItems ? [`Required context was truncated (required-incomplete): ${requiredGlobalExcludedItems} applicable records exceeded total capacity or a hard safety ceiling.`] : []),
    ],
    attention,
    memoryHealth: health,
    knowledgeGraph: graph.diagnostics,
    metrics: {
      tokenCountMethod: TOKEN_COUNT_METHOD,
      estimated: true,
      projectKnowledgeTokens,
      requiredGlobalTokens,
      requiredGlobalCandidateTokens,
      requiredGlobalExcludedItems,
      requiredCriticalOmitted: omittedCritical,
      requiredNormalOmitted: requiredGlobalExcludedItems - omittedCritical,
      requiredGlobalExcludedTokens,
      requiredGlobalOmittedByBudget,
      requiredGlobalOmittedByBudgetTokens,
      requiredGlobalOmittedByItemLimit,
      requiredGlobalOmittedByItemLimitTokens,
      requiredContextBudgetTokens,
      selectedContextualTokens,
      selectedSkillsTokens,
      projectSkillsTokens,
      skillSelectivity: safeRatio(selectedSkillsTokens, projectSkillsTokens),
      contextTokens,
      contextBudgetTokens,
      contextSelectivity: safeRatio(requiredGlobalTokens + selectedContextualTokens, projectKnowledgeTokens),
      requiredGlobalPressure: pressure,
      staleRelevantItems,
    },
    agentUsage: null,
    limits: { maxSkills: MAX_CONTEXT_SKILLS, skillBudgetTokens, maxRequiredItems: MAX_CONTEXT_REQUIRED_ITEMS, maxRelevantItems: maxContextItems, contextBudgetTokens, requiredContextBudgetTokens, tokenCountMethod: TOKEN_COUNT_METHOD, estimated: true },
  };
}

export type ContextPurpose = "explain" | "work" | "review" | "debug";

/** Shared read-only Context Engine entry point. Lifecycle owns sync and session association. */
export async function prepareContext(root: string, options: {
  query?: string;
  taskContext?:TaskContextInput;
  purpose?: ContextPurpose;
  pendingSessions?: number;
  onRetrievalEvidence?: (evidence: RetrievalEvidence) => void;
  onRequiredOmitted?: (items: OmittedContextCandidate[]) => void;
} = {}): Promise<ContextResult> {
  const config = await readConfig(root);
  if (!config) throw new Error("Prodero is not initialized for this project.");
  return getContext(root, options.query, {
    ...options,
    persistCache: false,
    contextBudgetTokens: config.context?.max_tokens ?? config.context?.budgetTokens,
    maxContextItems: config.context?.max_items,
    requiredContextBudgetTokens: config.context?.required_max_tokens ?? config.context?.requiredBudgetTokens,
  });
}

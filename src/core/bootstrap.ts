import {applicabilityKey,buildTaskContext,evaluateApplicability,applicabilityLabel,type ApplicableRecord} from "./applicability.js";
import { loadMemoryCatalog, type KnowledgeSummary } from "./memory-index.js";
import { TOKEN_COUNT_METHOD } from "./telemetry.js";
import type { BootstrapContext, BootstrapInstruction, KnowledgeItem, KnowledgePriority } from "./types.js";

export const MAX_BOOTSTRAP_INSTRUCTIONS = 12;
export const DEFAULT_BOOTSTRAP_BUDGET_TOKENS = 1_000;

const PRIORITY_SCORE: Record<KnowledgePriority, number> = { critical: 80, important: 40, normal: 20, contextual: 10 };

function normalizedScope(value?: string): string | null {
  const scope = value?.trim().toLowerCase().replace(/^\.\//, "").replace(/\/$/, "");
  return scope || null;
}

export function instructionApplies(item:ApplicableRecord,scope?:string):boolean {
 return item.contextPolicy==='required' && evaluateApplicability(item,buildTaskContext(scope,{},item.applicability?.kind==='scoped'?item.applicability.subsystems:[],item.applicability?.kind==='scoped'?item.applicability.paths:[])).state==='applicable';
}

function orderInstructions(a: KnowledgeSummary, b: KnowledgeSummary): number {
  const aSpecific = a.scope === "global" ? 0 : 1;
  const bSpecific = b.scope === "global" ? 0 : 1;
  return Number(b.priority === "critical") - Number(a.priority === "critical")
    || bSpecific - aSpecific
    || PRIORITY_SCORE[b.priority] - PRIORITY_SCORE[a.priority]
    || a.title.localeCompare(b.title)
    || a.id.localeCompare(b.id);
}

function instructionView(item: KnowledgeItem, summary: KnowledgeSummary): BootstrapInstruction {
  return {
    id: item.id,
    title: item.title,
    content: item.content,
    applicability:item.applicability,
    appliesTo:applicabilityLabel(item),
    scope: item.scope,
    scopeRef: item.scopeRef,
    priority: item.priority,
    status: item.status === "disputed" ? "disputed" : "active",
    layer: summary.layer,
    kind: "instruction",
    contextPolicy: "required",
    authority: item.authority!,
    enforcement: "required",
    estimatedTokens: summary.estimatedTokens,
  };
}

export function conflictWarnings(candidates: KnowledgeSummary[]): string[] {
  const byId = new Map(candidates.map((item) => [item.id, item]));
  const pairs = new Map<string, [KnowledgeSummary, KnowledgeSummary]>();
  const addPair = (left: KnowledgeSummary, right: KnowledgeSummary) => {
    if (left.id === right.id) return;
    const [first, second] = [left, right].sort((a, b) => a.id.localeCompare(b.id));
    pairs.set(`${first.id}:${second.id}`, [first, second]);
  };
  for (const item of candidates) {
    for (const relation of item.relations) {
      if (relation.type === "contradicts" && byId.has(relation.target)) addPair(item, byId.get(relation.target)!);
    }
    if (item.status === "disputed") {
      for (const related of item.related) if (byId.get(related)?.status === "disputed") addPair(item, byId.get(related)!);
    }
  }
  const boundaries = new Map<string, KnowledgeSummary[]>();
  for (const item of candidates) {
    const key = `${applicabilityKey(item)}:${item.normalizedTitle}`;
    const group = boundaries.get(key) ?? [];
    group.push(item);
    boundaries.set(key, group);
  }
  for (const group of boundaries.values()) {
    for (let left = 0; left < group.length; left += 1) for (let right = left + 1; right < group.length; right += 1) {
      if (group[left].normalizedContent !== group[right].normalizedContent) addPair(group[left], group[right]);
    }
  }
  const paired = new Set([...pairs.values()].flatMap(([left, right]) => [left.id, right.id]));
  const warnings = [...pairs.values()]
    .sort(([a], [b]) => a.id.localeCompare(b.id))
    .map(([left, right]) => `Conflicting required instructions: ${left.title} (${left.id}) vs ${right.title} (${right.id}).`);
  for (const item of candidates.filter((candidate) => candidate.status === "disputed" && !paired.has(candidate.id)).sort(orderInstructions)) {
    warnings.push(`Disputed required instruction requires review: ${item.title} (${item.id}).`);
  }
  return warnings;
}

export async function getBootstrapContext(root: string, scope?: string): Promise<BootstrapContext> {
  const catalog = await loadMemoryCatalog(root);
  const shadowed = new Set(catalog.summaries.filter((item) => item.status === "active" || item.status === "disputed").flatMap((item) => item.supersedes));
  const candidates = catalog.summaries
    .filter((item) => (item.status === "active" || item.status === "disputed") && !shadowed.has(item.id) && instructionApplies(item, scope))
    .sort(orderInstructions);
  const warnings = conflictWarnings(candidates);
  const selected: KnowledgeSummary[] = [];
  let selectedTokens = 0;
  for (const item of candidates) {
    if (selected.length >= MAX_BOOTSTRAP_INSTRUCTIONS || selectedTokens + item.estimatedTokens > DEFAULT_BOOTSTRAP_BUDGET_TOKENS) continue;
    selected.push(item);
    selectedTokens += item.estimatedTokens;
  }
  const selectedIds = new Set(selected.map((item) => item.id));
  const omitted = candidates.filter((item) => !selectedIds.has(item.id));
  const omittedCritical = omitted.filter(item => item.priority === "critical").length;
  if (omittedCritical) warnings.push(`${omittedCritical} critical required instruction(s) were not loaded because Bootstrap Context is bounded to ${MAX_BOOTSTRAP_INSTRUCTIONS} items and ${DEFAULT_BOOTSTRAP_BUDGET_TOKENS} estimated tokens.`);
  const instructions = await Promise.all(selected.map(async (item) => instructionView(await catalog.load(item.id), item)));
  return {
    version: 1,
    projectRoot: root,
    scope: normalizedScope(scope),
    loaded: true,
    instructions,
    warnings,
    metrics: { scopedRequiredPolicies:catalog.summaries.filter(i=>i.contextPolicy==="required"&&["active","disputed"].includes(i.status)&&!shadowed.has(i.id)&&!instructionApplies(i)).length, candidateInstructions: candidates.length, loadedInstructions: instructions.length, omittedInstructions: omitted.length, estimatedTokens: selectedTokens, tokenCountMethod: TOKEN_COUNT_METHOD, estimated: true },
    limits: { maxInstructions: MAX_BOOTSTRAP_INSTRUCTIONS, budgetTokens: DEFAULT_BOOTSTRAP_BUDGET_TOKENS },
  };
}

export function emptyBootstrapContext(root: string, scope?: string): BootstrapContext {
  return {
    version: 1,
    projectRoot: root,
    scope: normalizedScope(scope),
    loaded: false,
    instructions: [],
    warnings: [],
    metrics: { candidateInstructions: 0, loadedInstructions: 0, omittedInstructions: 0, estimatedTokens: 0, tokenCountMethod: TOKEN_COUNT_METHOD, estimated: true },
    limits: { maxInstructions: MAX_BOOTSTRAP_INSTRUCTIONS, budgetTokens: DEFAULT_BOOTSTRAP_BUDGET_TOKENS },
  };
}

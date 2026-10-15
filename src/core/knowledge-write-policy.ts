import {sameApplicability} from "./applicability.js";
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseKnowledge, renderKnowledge } from './memory.js';
import { checkedDataPath } from './storage.js';
import { sha256 } from './storage.js';
import { evaluateKnowledgeTransition, inferredKnowledge, protectedKnowledge, sameProtection, coversProtection, KnowledgePolicyReviewRequired, summarizePolicyDecisions, type KnowledgeTransition } from './knowledge-authority.js';
import { loadMemoryCatalog } from './memory-index.js';
import type { PlannedWrite, PlannedMove } from './sync-transaction.js';
import type { KnowledgeItem } from './types.js';
const canonical = (p: string) => /^(memory|local\/memory|(local\/)?archive\/\d{4}_\d{2})\//.test(p);
/** Policy validation precedes the durable journal. Recovery replays the already
 * decided journal; it must not re-authorize a past decision from persisted prose. */
export async function protectKnowledgeWrites(root: string, writes: PlannedWrite[], exact = false, moves: PlannedMove[] = []) {
    writes=writes.map(w=>{if(!canonical(w.path))return w;const item=parseKnowledge(w.after,path.basename(w.path));return {...w,after:renderKnowledge({...item,version:3,applicability:item.applicability??{kind:'legacy'}})};});
    const proposed = writes.filter(w => canonical(w.path));
    if (!proposed.length)
        return { writes, policy: { ...summarizePolicyDecisions([]), createdIds: undefined as string[] | undefined, supersededIds: undefined as string[] | undefined, preservedIds: [] as string[] } };
    const parsed = new Map(proposed.map(w => [w.path, parseKnowledge(w.after, path.basename(w.path), 3)]));
    const catalog = await loadMemoryCatalog(root);
    const ids = new Set([...parsed.values()].flatMap(i => [i.id, ...i.supersedes, ...i.related, ...(i.relations ?? []).map(r => r.target)]));
    const current: KnowledgeItem[] = [];
    for (const id of ids)
        if (catalog.summaries.some(s => s.id === id))
            current.push(await catalog.load(id));
    const byId = new Map(current.map(i => [i.id, i]));
    const decisions: KnowledgeTransition[] = [], safe = new Map<string, KnowledgeItem>(), forks: PlannedWrite[] = [];
    const sourcesFor = (i: KnowledgeItem) => current.filter(s => i.supersedes.includes(s.id) || i.related.includes(s.id) || i.id === s.id || (i.relations ?? []).some(r => ['supersedes', 'consolidates'].includes(r.type) && r.target === s.id) || sameProtection(s, i));
    // Decide new records first, so a retirement cannot rely on a rejected replacement.
    for (const w of proposed)
        if (w.before === null) {
            const i = parsed.get(w.path)!;
            const move = moves.find(m => m.to === w.path);
            const original = move ? parseKnowledge(await fs.readFile(await checkedDataPath(root, move.from), 'utf8'), path.basename(move.from), 3) : undefined;
            const retirementCovered = !!original && [...parsed.values()].some(other => other.id !== i.id && other.status === 'active' && coversProtection(original, other) && evaluateKnowledgeTransition(root, other, byId.get(other.id), { sources: sourcesFor(other) }).decision === 'allowed');
            const d = evaluateKnowledgeTransition(root, i, original, { sources: sourcesFor(i), exact: exact || !!move, retirementCovered });
            decisions.push(d);
            if (d.blocking)
                throw new KnowledgePolicyReviewRequired(d);
            if (d.decision !== 'allowed') {
                d.item.supersedes = d.item.supersedes.filter(id => !protectedKnowledge(byId.get(id) ?? i));
                d.item.relations = (d.item.relations ?? []).filter(r => !['supersedes', 'consolidates', 'consolidated_into', 'superseded_by'].includes(r.type));
            }
            d.item.supersedes = d.item.supersedes.filter(id => { const source = byId.get(id); return !source || !protectedKnowledge(source) || coversProtection(source, d.item) || d.reasons.includes('trusted-current-operation'); });
            d.item.relations = (d.item.relations ?? []).filter(r => { const source = byId.get(r.target); return !['supersedes', 'consolidates'].includes(r.type) || !source || !protectedKnowledge(source) || coversProtection(source, d.item) || d.reasons.includes('trusted-current-operation'); });
            safe.set(w.path, d.item);
        }
    for (const w of proposed)
        if (w.before !== null) {
            const before = parseKnowledge(await fs.readFile(await checkedDataPath(root, w.path), 'utf8'), path.basename(w.path), 3), i = parsed.get(w.path)!;
            const retirementCovered = [...safe.values(), ...current.filter(c => !proposed.some(w => parsed.get(w.path)!.id === c.id)), ...proposed.filter(w => w.before !== null).map(w => parsed.get(w.path)!).filter(c => evaluateKnowledgeTransition(root, c, byId.get(c.id), { sources: sourcesFor(c) }).decision === 'allowed')].some(other => other.id !== i.id && other.status === 'active' && coversProtection(before, other) && (other.supersedes.includes(i.id) || other.related.includes(i.id) || (i.related ?? []).includes(other.id) || (other.relations ?? []).some(r => r.target === i.id && r.type === 'consolidates')));
            const replacementRequested=[...parsed.values()].some(other=>other.id!==i.id&&(other.supersedes.includes(i.id)||(other.relations??[]).some(r=>["supersedes","consolidates"].includes(r.type)&&r.target===i.id))&&!sameApplicability(other,before));
            const d = evaluateKnowledgeTransition(root, i, before, { exact, retirementCovered, replacementRequested, sources: sourcesFor(i) });
            decisions.push(d);
            if (d.blocking)
                throw new KnowledgePolicyReviewRequired(d);
            if (d.decision !== 'allowed' && i.content !== before.content) {
                const fork = evaluateKnowledgeTransition(root, inferredKnowledge({ ...i, id: `mem_policy_${sha256(JSON.stringify(i)).slice(0, 24)}`, status: 'active', supersedes: [], related: [before.id], relations: [{ type: 'related_to', target: before.id }] }), undefined, { sources: [before] }).item;
                forks.push({ path: `local/memory/${fork.id}.md`, before: null, after: renderKnowledge(fork) });
            }
            d.item.supersedes = d.item.supersedes.filter(id => { const source = byId.get(id); return before.supersedes.includes(id) || !source || !protectedKnowledge(source) || coversProtection(source, d.item) || d.reasons.includes('trusted-current-operation'); });
            d.item.relations = (d.item.relations ?? []).filter(r => { const source = byId.get(r.target); return (before.relations ?? []).some(old => old.type === r.type && old.target === r.target) || !['supersedes', 'consolidates'].includes(r.type) || !source || !protectedKnowledge(source) || coversProtection(source, d.item) || d.reasons.includes('trusted-current-operation'); });
            safe.set(w.path, d.item);
        }
    const policy = summarizePolicyDecisions(decisions);
    const preservedIds=decisions.filter(d=>d.decision==='review_recommended').map(d=>d.item.id);
    const result = writes.map(w => safe.has(w.path) ? { ...w, after: renderKnowledge(safe.get(w.path)!) } : w);
    const checkpoint = result.find(w => w.path.startsWith('checkpoints/'));
    if (checkpoint) {
        const c = JSON.parse(checkpoint.after);
        c.policyTransitions = policy;
        c.updatedMemory=(c.updatedMemory??[]).filter((id:string)=>!preservedIds.includes(id));
        c.createdMemory = [...new Set([...(c.createdMemory ?? []), ...forks.map(w => path.basename(w.path, '.md'))])];
        c.supersededMemory = (c.supersededMemory ?? []).filter((id: string) => [...safe.values()].some(i => i.id === id && i.status === 'superseded'));
        if (c.summary) {
            c.summary.consolidated=Math.max(0,(c.summary.consolidated??0)-preservedIds.length);
            c.summary.created = c.createdMemory.length;
            c.summary.superseded = c.supersededMemory.length;
        }
        checkpoint.after = JSON.stringify(c, null, 2) + '\n';
    }
    result.splice(Math.max(0, result.length - 1), 0, ...forks);
    const committed = checkpoint ? JSON.parse(checkpoint.after) : null;
    return { writes: result, policy: { ...policy, preservedIds, createdIds: committed?.createdMemory as string[] | undefined, supersededIds: committed?.supersededMemory as string[] | undefined } };
}

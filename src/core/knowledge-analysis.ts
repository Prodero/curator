/** Evidence-first proposals only. Classification never establishes authority. */
import { inferApplicability, buildTaskContext, type Applicability } from './applicability.js';
import type { KnowledgeCategory } from './types.js';
export const KNOWLEDGE_ANALYSIS_VERSION = 'evidence-3';
export interface AnalyzedPart {
    title: string;
    content: string;
    category: KnowledgeCategory;
    applicability: Applicability;
    evidence: string[];
    start: number;
    end: number;
    transient: boolean;
}
const transient = /\b(?:currently (?:fails?|blocked|broken)|temporary workaround|remains? blocked|planned work owns|discovery.*fails?)\b/i;
/** Keep exact text slices: no paraphrasing, dropped clauses or lexical authority. */
export function analyzeKnowledgeText(title: string, content: string): AnalyzedPart[] {
    const boundaries = [...content.matchAll(/^(?:Decision|Impact|Constraint|Correction|Guard Pattern|Workflow Note|Test-Quality Note|State|Lesson|Principle|Invariant):\s*$/gmi)];
    const chunks = boundaries.length > 1 ? boundaries.map((m, i) => ({ start: i === 0 ? 0 : m.index!, end: boundaries[i + 1]?.index ?? content.length, label: m[0].trim().slice(0, -1).toLowerCase() })) : [{ start: 0, end: content.length, label: boundaries[0]?.[0].trim().slice(0, -1).toLowerCase() ?? '' }];
    // Impact stays with its decision; split only lifecycle/category boundaries.
    const groups: typeof chunks = [];
    for (const c of chunks) {
        if ((c.label === 'impact' || c.label === 'constraint' && /\b(?:must|should|never|always|required|only|cannot|do not)\b/i.test(content.slice(groups.at(-1)?.start ?? 0, c.start))) && groups.length && !transient.test(content.slice(c.start, c.end)))
            groups.at(-1)!.end = c.end;
        else
            groups.push({ ...c });
    }
    const wholeContext = buildTaskContext(`${title}\n${content}`);
    const titleContext = buildTaskContext(title);
    const domain = titleContext.subsystems.length ? titleContext.subsystems : wholeContext.subsystems;
    return groups.filter(c => content.slice(c.start, c.end).trim()).map((c, i) => {
        const body = content.slice(c.start, c.end).trim();
        const historical = transient.test(body);
        const normative = /\b(?:must|should|never|always|required|only|cannot|do not|prohibit)\b/i.test(body);
        const category: KnowledgeCategory = historical ? 'state' : c.label==='principle'?'principle':c.label==='invariant'?'invariant': c.label === 'constraint' || c.label === 'guard pattern' ? 'constraint' : c.label === 'lesson' || c.label === 'correction' ? 'lesson' : c.label === 'decision' ? (normative ? 'instruction' : 'decision') : c.label === 'workflow note' || /^(?:Run |Use |Always |Never |Do not )/.test(body) ? 'instruction' : /\b(?:invariant|transactional invariant)\b/i.test(body) ? 'invariant' : /\b(?:must not|cannot|never persist|prohibit)\b/i.test(body) ? 'constraint' : /\b(?:uses?|chosen|canonical|decided|adopted)\b/i.test(body) ? 'decision' : 'state';
        let applicability = inferApplicability(body);
        // Named domain is stronger than incidental code identifiers. Preserve concrete paths
        // when no domain is established; avoid AND-ing incidental paths with a subsystem.
        // Titles are authored source metadata, not a built-in domain dictionary.
        // A single explicit identifier may name the work boundary; ambiguous titles
        // remain unresolved rather than inventing a preferred subsystem.
        const named = [...new Set(domain.filter(n => !['AI', 'PHP', 'CLI', 'HTTP', 'HTML', 'JSON', 'DB', 'SQL'].includes(n)))];
        if (named.length === 1)
            applicability = { kind: 'scoped', subsystems: named, ...(/\b(?:tests?|testing|harness)\b/i.test(title) ? { taskKinds: ['testing' as const] } : {}) };
        if (named.length > 1) applicability = { kind: 'unresolved' };
        const evidence = [`Source characters ${c.start}–${c.end}`, ...(c.label ? [`Explicit source field: ${c.label}`] : []), ...(historical ? ['Time-sensitive wording; retained as historical state'] : [])];
        if (applicability.kind === 'scoped')
            evidence.push(`Explicit work signals: ${JSON.stringify(applicability)}`);
        return { title: groups.length === 1 ? title : `${title.slice(0, 155)} · ${c.label || `part ${i + 1}`}`, content: body, category, applicability, evidence, start: c.start, end: c.end, transient: historical };
    });
}
export function importPreviewSummary(items: Array<{
    include?: boolean;
    category: string;
    applicability?: Applicability;
    source?: unknown[];
}>) {
    const selected = items.filter(i => i.include !== false);
    return { records: selected.length, categories: Object.fromEntries([...new Set(selected.map(i => i.category))].sort().map(c => [c, selected.filter(i => i.category === c).length])), required: 0, relevant: selected.length, projectWide: selected.filter(i => i.applicability?.kind === 'project').length, scoped: selected.filter(i => i.applicability?.kind === 'scoped').length, unresolved: selected.filter(i => !i.applicability || i.applicability.kind === 'unresolved').length };
}

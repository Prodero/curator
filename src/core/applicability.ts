import { z } from 'zod';
import { tokens } from './matching.js';
import { isPathScope, pathApplies, pathScopeRelevant, type Scoped } from './path-scope.js';
export const TASK_KINDS = ['implementation', 'testing', 'migration', 'deployment', 'documentation', 'review', 'debugging'] as const;
const names = z.array(z.string().trim().min(1).max(160)).min(1).max(16);
const paths = z.array(z.string().trim().min(1).max(300)).min(1).max(16).refine(a => a.every(p => !/[\0\r\n]/.test(p) && !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..') && !p.includes('//') && p !== '.' && !p.replace(/\/\*\*$/, '').includes('*')), 'Use repository-relative paths with optional terminal /**');
export const applicabilitySchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('legacy') }).strict(),
    z.object({ kind: z.literal('project') }).strict(),
    z.object({ kind: z.literal('unresolved') }).strict(),
    z.object({ kind: z.literal('scoped'), paths: paths.optional(), subsystems: names.optional(), taskKinds: z.array(z.enum(TASK_KINDS)).min(1).max(7).optional() }).strict(),
]);
export type Applicability = z.infer<typeof applicabilitySchema>;
export const taskContextInputSchema = z.object({ paths: paths.optional(), subsystems: names.optional(), taskKinds: z.array(z.enum(TASK_KINDS)).min(1).max(7).optional(), explicitTopics: names.optional() }).strict();
export type TaskContextInput = z.infer<typeof taskContextInputSchema>;
export interface TaskContext {
    taskText: string;
    paths: string[];
    subsystems: string[];
    taskKinds: typeof TASK_KINDS[number][];
    signals: Array<{
        dimension: string;
        value: string;
        source: 'argument' | 'task-text' | 'session';
        basis?: 'vocabulary' | 'identifier';
    }>;
    documentationOnly: boolean;
}
export interface ApplicabilityDecision {
    state: 'applicable' | 'not_applicable' | 'unknown';
    reasons: string[];
    matched: number;
}
export type ApplicableRecord = Scoped & {
    applicability?: Applicability;
    contextPolicy?: string;
};
const uniq = (v: string[]) => [...new Set(v)].sort();
const lower = (s: string) => s.toLowerCase().trim();
const cleanPath = (s: string) => s.replace(/\/\*\*$/, '').replace(/^\.\//, '').replace(/\/$/, '');
export function validateApplicability(value: unknown, policy?: string): Applicability {
    const a = applicabilitySchema.parse(value);
    if(policy==='required' && a.kind==='unresolved')throw new Error('Required knowledge needs an explicit applicability boundary');
    if (a.kind === 'scoped' && !a.paths?.length && !a.subsystems?.length && !a.taskKinds?.length)
        throw new Error('Scoped applicability needs at least one restriction');
    return a;
}
export function applicabilityOf(r: ApplicableRecord): Applicability { return r.applicability ?? { kind: 'legacy' }; }
export function scopeProjection(a: Applicability): Scoped {
    if (a.kind === 'project')
        return { scope: 'global', scopeRef: null };
    if (a.kind === 'unresolved')
        return { scope: 'task', scopeRef: 'unresolved' };
    if (a.kind === 'legacy')
        throw new Error('Legacy applicability retains its original scope');
    if (a.paths?.length)
        return { scope: 'module', scopeRef: cleanPath(a.paths[0]), scopeKind: 'path' };
    if (a.subsystems?.length)
        return { scope: 'module', scopeRef: a.subsystems[0], scopeKind: 'topic' };
    return { scope: 'task', scopeRef: a.taskKinds!.join(' ') };
}
export function withApplicability<T extends ApplicableRecord>(r: T, a: Applicability): T {
    a = validateApplicability(a,r.contextPolicy);
    return { ...r, ...(a.kind === 'legacy' ? {} : { scopeKind: undefined, ...scopeProjection(a) }), applicability: a };
}
export function applicabilityKey(r: ApplicableRecord): string {
    const a = applicabilityOf(r);
    return a.kind === 'legacy' ? (r.scope === 'global' ? JSON.stringify({ kind: 'project' }) : JSON.stringify(['legacy', r.scope, r.scopeRef, r.scopeKind ?? null])) : JSON.stringify(a.kind !== 'scoped' ? a : { kind: a.kind, paths: a.paths ? uniq(a.paths.map(cleanPath)) : [], subsystems: a.subsystems ? uniq(a.subsystems.map(lower)) : [], taskKinds: a.taskKinds ? uniq(a.taskKinds) : [] });
}
export const sameApplicability = (a: ApplicableRecord, b: ApplicableRecord) => applicabilityKey(a) === applicabilityKey(b);
/** Subset proof only; incomparable boundaries are not guessed equivalent. */
export function narrowsApplicability(before: ApplicableRecord, after: ApplicableRecord): boolean {
    if (sameApplicability(before, after))
        return true;
    const b = applicabilityOf(before), a = applicabilityOf(after);
    if (a.kind === 'legacy')
        return false;
    if (b.kind === 'project' || b.kind === 'unresolved')
        return a.kind === 'scoped';
    if (b.kind === 'legacy')
        return before.scope === 'global' && a.kind === 'scoped';
    if (a.kind !== 'scoped')
        return false;
    return (!b.paths || !!a.paths && a.paths.every(p => b.paths!.some(q => pathApplies(cleanPath(q), cleanPath(p))))) &&
        (!b.subsystems || !!a.subsystems && a.subsystems.every(s => b.subsystems!.map(lower).includes(lower(s)))) &&
        (!b.taskKinds || !!a.taskKinds && a.taskKinds.every(k => b.taskKinds!.includes(k)));
}
const kindPatterns: Record<typeof TASK_KINDS[number], RegExp> = { implementation: /\b(?:implement|implementation|develop|update|fix|add|refactor)\b/i, testing: /\b(?:test|tests|testing|unit|spec|harness)\b|тест/i, migration: /\bmigrat\w*\b|миграц/i, deployment: /\b(?:deploy\w*|release|rollout)\b|депло/i, documentation: /\b(?:readme|documentation|docs|document)\b|документ/i, review: /\b(?:review|audit)\b|аудит|ревью/i, debugging: /\b(?:debug\w*|investigate|diagnos\w*|troubleshoot)\b|диагност|расслед/i };
export function buildTaskContext(taskText = '', input: TaskContextInput = {}, knownSubsystems: string[] = [], knownPaths: string[] = []): TaskContext {
    input = taskContextInputSchema.parse(input);
    const signals: TaskContext['signals'] = [];
    const add = (dimension: string, value: string, source: 'argument' | 'task-text', basis?: 'vocabulary' | 'identifier') => signals.push({ dimension, value, source, ...(basis ? { basis } : {}) });
    for (const [dimension, values] of Object.entries(input))
        for (const v of values ?? [])
            add(dimension === 'explicitTopics' ? 'subsystems' : dimension, v, 'argument');
    const mentions = [...taskText.matchAll(/`([^`]+)`|"([^"\n]+)"|(?:^|\s)([\w@.-]+\/[\w@./*-]+|[\w.-]+\.(?:md|ts|tsx|js|php|py|json|sql|html|css)\b)/g)].map(m => m[1] ?? m[2] ?? m[3]);
    for (const p of mentions)
        if (paths.safeParse([p]).success)
            add('paths', cleanPath(p), 'task-text');
    for (const kind of TASK_KINDS)
        if (kindPatterns[kind].test(taskText))
            add('taskKinds', kind, 'task-text');
    for (const p of knownPaths)
        if (cleanPath(taskText.trim()) === cleanPath(p))
            add('paths', cleanPath(p), 'task-text');
    const queryTokens = tokens(taskText);
    for (const name of knownSubsystems)
        if ([...tokens(name)].length && [...tokens(name)].every(t => queryTokens.has(t)))
            add('subsystems', name, 'task-text', 'vocabulary');
    // Technical identifiers are usable narrow topics without a hardcoded project dictionary.
    for (const m of taskText.matchAll(/\b(?:[A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*)+|[A-Z]{2,}|[a-z]+_[a-z_]+)\b/g))
        if (!['README', 'SQL', 'API', 'UI'].includes(m[0]))
            add('subsystems', m[0], 'task-text', 'identifier');
    const values = (dimension: string) => uniq(signals.filter(s => s.dimension === dimension).map(s => s.value));
    if (signals.some(s => s.dimension === 'taskKinds' && s.value === 'documentation') && !/\b(?:implement|implementation|code|refactor)\b/i.test(taskText)) {
        for (let i = signals.length - 1; i >= 0; i--)
            if (signals[i].source === 'task-text' && signals[i].dimension === 'taskKinds' && signals[i].value === 'implementation')
                signals.splice(i, 1);
    }
    const kinds = values('taskKinds') as TaskContext['taskKinds'];
    const subsystems = values('subsystems');
    return { taskText, paths: values('paths'), subsystems, taskKinds: kinds, signals, documentationOnly: kinds.includes('documentation') && !kinds.some(k => ['testing', 'deployment', 'migration', 'debugging'].includes(k)) && !subsystems.length };
}
export function evaluateApplicability(record: ApplicableRecord, context: TaskContext, use: 'required' | 'relevant' = 'required'): ApplicabilityDecision {
    const a = applicabilityOf(record), yes = (why: string): ApplicabilityDecision => ({ state: 'applicable', reasons: [why], matched: 1 });
    if (a.kind === 'project')
        return yes('Applies throughout this project');
    if (a.kind === 'unresolved')
        return { state: 'unknown', reasons: ['Knowledge has no resolved work boundary'], matched: 0 };
    if (a.kind === 'legacy') {
        // Exact pre-v3 rules, including different historical Required/Relevant filtering.
        if (record.scope === 'global')
            return yes('Legacy global scope preserved');
        if (isPathScope(record))
            return { state: pathScopeRelevant(context.taskText, record) ? 'applicable' : 'not_applicable', reasons: ['Legacy path matching preserved'], matched: 0 };
        if (use === 'relevant')
            return yes('Legacy topic relevance retrieval preserved');
        const query = lower(context.taskText).replace(/^\.\//, '').replace(/\/$/, ''), ref = lower(record.scopeRef ?? '').replace(/^\.\//, '').replace(/\/$/, '');
        const matched = !!query && !!ref && (query === ref || query.startsWith(ref + '/') || record.scope === 'task' && [...tokens(query)].some(t => tokens(ref).has(t)));
        return { state: matched ? 'applicable' : 'not_applicable', reasons: ['Legacy scoped Required matching preserved'], matched: Number(matched) };
    }
    const results: Array<{
        state: ApplicabilityDecision['state'];
        reason: string;
    }> = [];
    if (a.paths) {
        const match = a.paths.some(p => context.paths.some(q => pathApplies(cleanPath(p), cleanPath(q))));
        results.push({ state: match ? 'applicable' : context.paths.length ? 'not_applicable' : 'unknown', reason: match ? 'Repository path matched' : context.paths.length ? 'Paths are outside the configured boundary' : `Task has no resolved path; needs ${a.paths.join(' or ')}` });
    }
    if (a.subsystems) {
        const otherResolved = context.signals.some(s => s.dimension === 'subsystems' && (s.source === 'argument' || s.basis === 'vocabulary'));
        const match = a.subsystems.some(s => context.subsystems.some(q => lower(s) === lower(q)));
        results.push({ state: match ? 'applicable' : otherResolved || context.documentationOnly ? 'not_applicable' : 'unknown', reason: match ? `Subsystem matched: ${a.subsystems.filter(s => context.subsystems.some(q => lower(q) === lower(s))).join(', ')}` : otherResolved || context.documentationOnly ? 'Task focus does not match the subsystem' : `Task has no resolved subsystem; needs ${a.subsystems.join(' or ')}` });
    }
    if (a.taskKinds) {
        const match = a.taskKinds.some(k => context.taskKinds.includes(k));
        results.push({ state: match ? 'applicable' : context.taskKinds.length ? 'not_applicable' : 'unknown', reason: match ? `Task kind matched: ${a.taskKinds.filter(k => context.taskKinds.includes(k)).join(', ')}` : context.taskKinds.length ? 'Task kind is outside the configured boundary' : `Task kind is unresolved; needs ${a.taskKinds.join(' or ')}` });
    }
    return { state: results.some(r => r.state === 'not_applicable') ? 'not_applicable' : results.some(r => r.state === 'unknown') ? 'unknown' : 'applicable', reasons: results.map(r => r.reason), matched: results.filter(r => r.state === 'applicable').length };
}
export function inferApplicability(content: string, context?: TaskContext): Applicability {
    const own = buildTaskContext(content);
    const c = own.paths.length || own.subsystems.length ? own : context ?? own;
    const a: Applicability = { kind: 'scoped', ...(c.paths.length ? { paths: c.paths.slice(0, 16) } : {}), ...(c.subsystems.length ? { subsystems: c.subsystems.slice(0, 16) } : {}), ...(c.taskKinds.length ? { taskKinds: c.taskKinds } : {}) };
    // No invented mandatory/global claim: unlocated ordinary knowledge stays task-bound.
    return a.paths || a.subsystems || a.taskKinds ? a : { kind: 'unresolved' };
}
export { applicabilityLabel } from "./applicability-label.js";

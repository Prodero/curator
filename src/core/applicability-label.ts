export function applicabilityLabel(r: {
    scope: string;
    scopeRef: string | null;
    scopeKind?: string;
    applicability?: {
        kind: string;
        subsystems?: string[];
        paths?: string[];
        taskKinds?: string[];
    };
}): string {
    const a = r.applicability ?? { kind: 'legacy' };
    if (a.kind === 'project')
        return 'Throughout this project';
    if (a.kind === 'unresolved')
        return 'Work context not yet resolved';
    if (a.kind === 'legacy')
        return r.scope === 'global' ? 'Throughout this project' : r.scopeRef ?? 'Work context not yet resolved';
    return [...(a.subsystems ?? []), ...(a.paths ?? []), ...(a.taskKinds ?? [])].join(' · ');
}

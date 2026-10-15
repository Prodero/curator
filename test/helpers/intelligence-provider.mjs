export function distilled(input) {
  return { candidates: input.observations.map((o, i) => ({ id: `candidate_${i}`, kind: o.kind, title: o.title, content: o.content, category: o.category, scope: o.scope, scopeRef: o.scopeRef, priority: o.priority, sources: [o.id], evidence: [{ source: o.id, quote: o.content }], supersedes: o.supersedes })) };
}
export function fakeProvider(overrides = {}) {
  const calls = [];
  const defaults = {
    distill: distilled,
    reconcile: ({ candidate }) => ({ actions: [{ action: 'CREATE', sources: [candidate.id], canonical: null, reason: 'New durable evidence.' }] }),
    audit: () => ({ status: 'clean', issues: [], actions: [] }),
  };
  return { name: 'deterministic-test-provider', calls, ...Object.fromEntries(Object.keys(defaults).map((phase) => [phase, async (input) => {
    calls.push({ phase, input: structuredClone(input) });
    return { output: await (overrides[phase] ?? defaults[phase])(input) };
  }])) };
}
export const canonical = (c) => ({ title: c.title, content: c.content, category: c.category, scope: c.scope, scopeRef: c.scopeRef, priority: c.priority });

import path from "node:path";
/** Untagged historical module scopes retain topic semantics unless visibly path-shaped. */
export interface Scoped { scope: string; scopeRef: string | null; scopeKind?: 'path' | 'topic' }
export function isPathScope(item: Scoped): boolean {
  return item.scope === 'module' && Boolean(item.scopeRef) && (item.scopeKind === 'path' || item.scopeKind !== 'topic' && /[/.]/.test(item.scopeRef!));
}
export function normalizeScopePath(value: string): string { return path.posix.normalize(value).replace(/^\.\//, '').replace(/\/$/, ''); }
export function pathApplies(reference: string, requested: string): boolean {
  const scope = normalizeScopePath(reference), target = normalizeScopePath(requested);
  return target === scope || target.startsWith(`${scope}/`);
}
export function pathScopeRelevant(query: string, item: Scoped): boolean {
  if (!isPathScope(item)) return true;
  const value = query.trim();
  if (pathApplies(item.scopeRef!, value)) return true;
  // A bare directory name in prose is thematic text. Quote it or name a descendant.
  const mentions = [...value.matchAll(/`([^`]+)`|"([^"\n]+)"|(?:^|\s)(\.?\/?[\w@.-]+\/[\w@./-]*)/g)].map(m => m[1] ?? m[2] ?? m[3]);
  return mentions.some(p => pathApplies(item.scopeRef!, p));
}
export function assertPathScope(item: Scoped): void {
  if (item.scopeKind !== 'path') return;
  const p = item.scopeRef;
  if (item.scope !== 'module' || !p || p.startsWith('/') || p.includes('\\') || p.split('/').some(c => c === '..' || c === '') || p === '.') throw new Error('Invalid repository path scope. Use a repository-relative file or directory.');
}

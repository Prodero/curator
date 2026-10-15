import { PRODERO_SCHEMA_VERSION } from "./constants.js";
import { loadMemoryCatalog } from "./memory-index.js";
import { loadKnowledgeGraph } from "./knowledge-graph.js";
import { checkedDataPath, ensureRuntimeDirectories, writeFileAtomic } from "./storage.js";
import { listProjectSkills, skillContext } from "./skills.js";

function line(item: { filename: string; title: string }): string { return `- [${item.title}](memory/${item.filename})`; }
export const MAX_INDEX_REQUIRED_ITEMS = 16;
export const MAX_INDEX_CONTEXTUAL_ITEMS = 128;

function diverseContextual<T extends { scope: string; scopeRef: string | null; title: string; id: string }>(items: T[], limit: number): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.scopeRef ?? item.scope;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const selected: T[] = [];
  for (let offset = 0; selected.length < limit; offset += 1) {
    let added = false;
    for (const [, group] of orderedGroups) {
      if (group[offset]) { selected.push(group[offset]); added = true; }
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

async function skillReferences(root: string) {
  return (await listProjectSkills(root)).filter((skill) => skill.status === "active").map(skillContext);
}

export async function buildIndex(root: string): Promise<string> {
  await ensureRuntimeDirectories(root);
  const catalog = await loadMemoryCatalog(root);
  const active = catalog.summaries.filter((item) => item.status === "active" && item.layer === "versioned");
  const local = catalog.summaries.filter((item) => item.status === "active" && item.layer === "local");
  const allRequired = active
    .filter((item) => item.scope === "global" && item.contextPolicy === "required")
    .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "critical" ? -1 : 1) || b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const required = allRequired.slice(0, MAX_INDEX_REQUIRED_ITEMS);
  const allRequiredIds = new Set(allRequired.map((item) => item.id));
  const allContextual = active
    .filter((item) => !allRequiredIds.has(item.id))
    .sort((a, b) => (a.scopeRef ?? a.scope).localeCompare(b.scopeRef ?? b.scope) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const contextual = diverseContextual(allContextual, MAX_INDEX_CONTEXTUAL_ITEMS);
  const skills = await skillReferences(root);
  const text = `---
prodero_schema: ${PRODERO_SCHEMA_VERSION}
kind: project-index
generated: true
---

# Prodero · Project Intelligence

> Compact router for progressive context loading. Open only references relevant to the current task.

## Required Global Context

${required.length ? required.map(line).join("\n") : "_No required global knowledge._"}${allRequired.length > required.length ? `\n\n_${allRequired.length - required.length} additional required item(s) are available through bounded context resolution._` : ""}

## Contextual Knowledge

${contextual.length ? contextual.map((item) => `${line(item)} — ${item.scope}${item.scopeRef ? `: ${item.scopeRef}` : ""}; ${item.category}; ${item.priority}`).join("\n") : "_No contextual knowledge._"}${allContextual.length > contextual.length ? `\n\n_${allContextual.length - contextual.length} additional contextual item(s) are available through query-ranked resolution._` : ""}

## Local Knowledge

- [Developer-local knowledge](local/index.md) — ignored by Git and retrieved together with Versioned Knowledge.

## Project Skills

${skills.length ? skills.slice(0, 32).map((skill) => `- [${skill.title}](${skill.path})`).join("\n") : "_No project skills._"}

## Loading Rules

1. Use bounded context resolution; required global knowledge is priority-ranked and budgeted.
2. Follow only bounded graph relationships selected by context resolution; never recursively load the graph or unrelated scopes.
3. Load relevant project skills; do not recursively load \`.prodero/\`.
4. Use session memory as the write path. Sync produces Git-ignored Local Knowledge.
5. Use the promotion review workflow for Versioned Knowledge. Review repository changes before committing or pushing; Prodero does neither.
`;
  await writeFileAtomic(await checkedDataPath(root, "index.md"), text);
  const localText = `# Prodero · Local Knowledge\n\n> Developer-local canonical knowledge. This directory is ignored by Git.\n\n${local.length ? local.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)).map((item) => `- [${item.title}](memory/${item.filename}) — ${item.scope}${item.scopeRef ? `: ${item.scopeRef}` : ""}; ${item.category}; ${item.priority}`).join("\n") : "_No active local knowledge._"}\n`;
  await writeFileAtomic(await checkedDataPath(root, "local", "index.md"), localText);
  await loadKnowledgeGraph(root, catalog);
  return text;
}

export { skillReferences };

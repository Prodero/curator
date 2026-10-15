import { fileURLToPath } from "node:url";
import { MANAGED_END, MANAGED_START, PRODERO_SCHEMA_VERSION } from "./constants.js";

// The same relative location works from src/core (dev) and dist/core (installed).
export const AGENT_INSTRUCTIONS_PATH = fileURLToPath(new URL("../../instructions/AGENTS.md", import.meta.url));
export const AGENTS_BLOCK = `${MANAGED_START}
Read and follow the instructions returned by prodero_instructions_read from the connected Prodero MCP server.
${MANAGED_END}`;

export const INDEX_TEMPLATE = `---
prodero_schema: ${PRODERO_SCHEMA_VERSION}
kind: project-index
generated: true
---

# Prodero · Project Intelligence

> Compact router for progressive context loading. Open only references relevant to the current task.

## Required Global Context

_No required global knowledge._

## Contextual Knowledge

_No contextual knowledge._

## Local Knowledge

- [Developer-local knowledge](local/index.md) — ignored by Git and retrieved together with Versioned Knowledge.

## Project Skills

_No project skills._

## Loading Rules

1. Use bounded context resolution; required global knowledge is priority-ranked and budgeted.
2. Follow only bounded graph relationships selected by context resolution; never recursively load the graph or unrelated scopes.
3. Load relevant project skills; do not recursively load \`.prodero/\`.
4. Use session memory for agent-inferred observations; normal learning and conversational remember default to Local Knowledge.
5. Use the promotion review workflow for Versioned Knowledge. Review repository changes before committing or pushing; Prodero does neither.
`;

export function replaceManagedBlock(existing: string): string {
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  if (start >= 0 && end >= start) {
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(end + MANAGED_END.length).trimStart();
    return `${before}${before ? "\n\n" : ""}${AGENTS_BLOCK}${after ? `\n${after}` : "\n"}`;
  }
  const prefix = existing.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${AGENTS_BLOCK}\n`;
}

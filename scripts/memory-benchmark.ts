import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildIndex, initializeProject, resolveProjectContext } from "../src/core/project.js";
import { writeKnowledge } from "../src/core/memory.js";

const SIZES = [100, 1_000, 10_000] as const;
const FIXED_TIME = "2026-09-02T00:00:00.000Z";

async function batches<T>(items: T[], operation: (item: T) => Promise<unknown>, size = 250): Promise<void> {
  for (let offset = 0; offset < items.length; offset += size) await Promise.all(items.slice(offset, offset + size).map(operation));
}

function item(index: number) {
  const target = index < 16;
  return {
    id: `mem_benchmark_${String(index).padStart(5, "0")}`,
    scope: "module" as const,
    scopeRef: target ? `runtime-${index % 4}` : `noise-${index}`,
    category: target ? "decision" as const : "lesson" as const,
    priority: "contextual" as const,
    status: "active" as const,
    title: target ? `Target retry worker ${index}` : `Unrelated fixture ${index}`,
    content: target ? `Deterministic retry worker queue policy target ${index}.` : `Isolated benchmark token_${index}.`,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    sourceSessions: ["benchmark"],
    derivedFrom: [`benchmark#${index}`],
    supersedes: [],
    related: [],
  };
}

async function benchmark(size: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `prodero-memory-benchmark-${size}-`));
  try {
    await fs.mkdir(path.join(root, ".git"));
    await initializeProject(root);
    const corpus = Array.from({ length: size }, (_, index) => item(index));
    await batches(corpus, (entry) => writeKnowledge(root, entry));

    const coldStarted = performance.now();
    await buildIndex(root);
    const coldIndexMs = performance.now() - coldStarted;
    const query = "deterministic retry worker queue policy target";
    const warmStarted = performance.now();
    const first = await resolveProjectContext(root, query);
    const warmContextMs = performance.now() - warmStarted;
    const repeat = await resolveProjectContext(root, query);
    const ids = first.relevant.map((entry) => entry.id);
    const repeatIds = repeat.relevant.map((entry) => entry.id);
    const hits = first.relevant.filter((entry) => entry.title.startsWith("Target")).length;
    if (JSON.stringify(ids) !== JSON.stringify(repeatIds)) throw new Error(`Non-deterministic ranking at ${size} items.`);
    if (first.metrics.contextTokens > first.limits.contextBudgetTokens) throw new Error(`Context budget exceeded at ${size} items.`);
    if (first.metrics.requiredGlobalTokens > first.limits.requiredContextBudgetTokens) throw new Error(`Required budget exceeded at ${size} items.`);
    return {
      items: size,
      coldIndexMs: Number(coldIndexMs.toFixed(2)),
      warmContextMs: Number(warmContextMs.toFixed(2)),
      selectedItems: first.relevant.length,
      precisionAt8: Number((hits / Math.max(1, first.relevant.length)).toFixed(3)),
      deterministicRepeat: true,
      contextTokens: first.metrics.contextTokens,
      contextBudgetTokens: first.limits.contextBudgetTokens,
      requiredTokens: first.metrics.requiredGlobalTokens,
      requiredBudgetTokens: first.limits.requiredContextBudgetTokens,
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const results = [];
for (const size of SIZES) results.push(await benchmark(size));
console.log(JSON.stringify({ benchmark: "deterministic-memory-quality-v1", corpusSeed: "fixed-index-order-v1", sizes: SIZES, results }, null, 2));

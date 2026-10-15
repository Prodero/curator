import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeKnowledge } from "../dist/core/memory.js";
import { initializeProject, prepareProject, resolveProjectContext } from "../dist/core/project.js";

const now = "2026-09-05T00:00:00.000Z";

async function fixture(prefix = "prodero-context-budget-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, ".git"));
  await initializeProject(root);
  return root;
}

function item(id, overrides = {}) {
  return {
    id,
    scope: "module",
    scopeRef: "context",
    category: "decision",
    priority: "important",
    status: "active",
    title: `Context budget ${id}`,
    content: `Deterministic context budget selection knowledge ${id}.`,
    createdAt: now,
    updatedAt: now,
    sourceSessions: [],
    derivedFrom: [],
    supersedes: [],
    related: [],
    ...overrides,
  };
}

async function configure(root, context) {
  const target = path.join(root, ".prodero", "config.json");
  const config = JSON.parse(await fs.readFile(target, "utf8"));
  config.context = context;
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`);
}

test("snake-case context token and item limits configure the existing resolver", async () => {
  const root = await fixture();
  await configure(root, { max_tokens: 120, max_items: 2, required_max_tokens: 40 });
  for (let index = 0; index < 6; index += 1) await writeKnowledge(root, item(`configured_${index}`));

  const context = await resolveProjectContext(root, "deterministic context budget selection knowledge");
  assert.equal(context.limits.contextBudgetTokens, 120);
  assert.equal(context.limits.maxRelevantItems, 2);
  assert.equal(context.limits.requiredContextBudgetTokens, 40);
  assert.ok(context.relevant.length <= 2);
  assert.ok(context.metrics.contextTokens <= 120);
});

test("required instructions do not compete with the normal knowledge item limit", async () => {
  const root = await fixture();
  await configure(root, { max_tokens: 10_000, max_items: 16, required_max_tokens: 1_000 });
  for (let index = 0; index < 5; index += 1) await writeKnowledge(root, item(`instruction_${index}`, {
    scope: "global", scopeRef: null, category: "instruction", priority: "critical",
    title: `Persistent instruction ${index}`, content: `Always apply persistent instruction ${index}.`,
  }));
  for (let index = 0; index < 16; index += 1) await writeKnowledge(root, item(`knowledge_${index}`));

  const context = await resolveProjectContext(root, "deterministic context budget selection knowledge");
  assert.equal(context.required.length, 5);
  assert.equal(context.relevant.length, 16);
  assert.equal(context.metrics.requiredGlobalOmittedByItemLimit, 0);
  assert.equal(context.selection.loadedKnowledgeItems, 21);
});

test("normal knowledge trimming is deterministic and keeps the highest-ranked items", async () => {
  const root = await fixture();
  await configure(root, { max_tokens: 10_000, max_items: 3, required_max_tokens: 800 });
  for (let index = 0; index < 8; index += 1) await writeKnowledge(root, item(`ranked_${index}`, {
    priority: index < 2 ? "critical" : "normal",
    title: `${index < 2 ? "Critical" : "Normal"} deterministic context ${String(index).padStart(2, "0")}`,
  }));

  const first = await resolveProjectContext(root, "deterministic context budget selection knowledge");
  const second = await resolveProjectContext(root, "deterministic context budget selection knowledge");
  assert.deepEqual(first.relevant.map(({ id }) => id), second.relevant.map(({ id }) => id));
  assert.equal(first.relevant.length, 3);
  assert.equal(first.relevant.filter(({ priority }) => priority === "critical").length, 2);
  assert.equal(first.selection.omittedRelevantByMarginalValue, 5);
});

test("required budget overflow produces warning and Attention while preserving ordinary limits", async () => {
  const root = await fixture();
  await configure(root, { max_tokens: 25, max_items: 4, required_max_tokens: 12 });
  await writeKnowledge(root, item("oversized_instruction", {
    scope: "global", scopeRef: null, category: "instruction", priority: "critical",
    title: "Oversized required instruction", content: "Always preserve this required instruction even though its body exceeds the deliberately tiny reserved budget.",
  }));
  await writeKnowledge(root, item("ordinary"));

  const prepared = await prepareProject(root, { task: "deterministic context budget selection knowledge" });
  assert.equal(prepared.context.required.length, 0);
  assert.equal(prepared.context.relevant.length, 1);
  assert.equal(prepared.context.metrics.requiredGlobalOmittedByBudget, 1);
  assert.match(prepared.context.warnings.join(" "), /Required context was truncated/);
  assert.equal(prepared.context.attention.some(({ kind, severity }) => kind === "context-budget" && severity === "critical"), true);
  assert.equal(prepared.uiState.view, "attention");
});

test("default and legacy context configuration remain compatible", async () => {
  const root = await fixture();
  let context = await resolveProjectContext(root, "context");
  assert.equal(context.limits.contextBudgetTokens, 6_000);
  assert.equal(context.limits.maxRelevantItems, 8);
  assert.equal(context.limits.requiredContextBudgetTokens, 2_000);

  await configure(root, { budgetTokens: 321, requiredBudgetTokens: 123 });
  context = await resolveProjectContext(root, "context");
  assert.equal(context.limits.contextBudgetTokens, 321);
  assert.equal(context.limits.maxRelevantItems, 8);
  assert.equal(context.limits.requiredContextBudgetTokens, 123);
});

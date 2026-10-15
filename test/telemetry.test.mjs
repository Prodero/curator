import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMemoryCatalog } from "../dist/core/memory-index.js";
import { writeKnowledge } from "../dist/core/memory.js";
import { closeProjectSession, initializeProject, prepareProject, recordProjectSession, resolveProjectContext, syncProject } from "../dist/core/project.js";
import { estimateTokens, knowledgeText, memoryCompression, safeRatio, TOKEN_COUNT_METHOD } from "../dist/core/telemetry.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-telemetry-test-"));
  await fs.mkdir(path.join(root, ".git"));
  await initializeProject(root);
  return root;
}

test("token counting is deterministic, local, model-neutral, and handles empty input", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("Привет"), 3);
  assert.equal(estimateTokens("same input"), estimateTokens("same input"));
  assert.equal(TOKEN_COUNT_METHOD, "estimated-utf8-bytes-div-4-v1");
});

test("compression semantics avoid negative compression and expose expansion neutrally", () => {
  assert.deepEqual(memoryCompression(0, 0), { kind: "unavailable", ratio: null });
  assert.deepEqual(memoryCompression(100, 20), { kind: "compression", ratio: 0.8 });
  assert.deepEqual(memoryCompression(100, 100), { kind: "unchanged", ratio: 0 });
  assert.equal(memoryCompression(100, 112).kind, "expansion");
  assert.ok(Math.abs(memoryCompression(100, 112).ratio - 0.12) < 1e-12);
  assert.equal(safeRatio(0, 0), 0);
});

test("context reports cached project, selected, budget, selectivity, and no invented agent usage", async () => {
  const root = await fixture();
  const now = "2026-09-02T00:00:00.000Z";
  const required = { id: "mem_required", scope: "global", scopeRef: null, category: "instruction", priority: "critical", status: "active", title: "Local lifecycle", content: "Lifecycle telemetry stays local.", createdAt: now, updatedAt: now, sourceSessions: [], derivedFrom: [], supersedes: [], related: [] };
  const relevant = { ...required, id: "mem_relevant", scope: "module", scopeRef: "mcp", priority: "contextual", title: "MCP lifecycle card", content: "Render lifecycle context inside the coding agent." };
  await writeKnowledge(root, required);
  await writeKnowledge(root, relevant);

  // Warm the disposable cache explicitly: context resolution itself is now read-only.
  await loadMemoryCatalog(root);
  const context = await resolveProjectContext(root, "MCP lifecycle card");
  const total = estimateTokens(knowledgeText(required)) + estimateTokens(knowledgeText(relevant));
  assert.equal(context.metrics.projectKnowledgeTokens, total);
  assert.equal(context.metrics.requiredGlobalTokens, estimateTokens(knowledgeText(required)));
  assert.equal(context.metrics.selectedContextualTokens, estimateTokens(knowledgeText(relevant)));
  assert.equal(context.metrics.contextTokens, total);
  assert.equal(context.metrics.contextBudgetTokens, 6_000);
  assert.equal(context.metrics.contextSelectivity, 1);
  assert.equal(context.metrics.estimated, true);
  assert.equal(context.agentUsage, null);

  const warm = await loadMemoryCatalog(root);
  assert.equal(warm.bodiesIndexed, 0, "warm metrics use cached per-memory token estimates");
  assert.ok(warm.summaries.every((item) => Number.isInteger(item.estimatedTokens)));
});

test("empty project selectivity is zero and never NaN or Infinity", async () => {
  const context = await resolveProjectContext(await fixture(), "anything");
  assert.equal(context.metrics.projectKnowledgeTokens, 0);
  assert.equal(context.metrics.contextTokens, 0);
  assert.equal(context.metrics.contextSelectivity, 0);
  assert.equal(Number.isFinite(context.metrics.contextSelectivity), true);
});

test("storage age remains observable without deciding fact currency or attention", async () => {
  const root = await fixture();
  const base = { scope: "module", scopeRef: "runtime", priority: "normal", status: "active", sourceSessions: ["source"], derivedFrom: ["source#one"], supersedes: [], related: [] };
  await writeKnowledge(root, { ...base, id: "mem_stale", category: "state", title: "Runtime retry state", content: "Runtime retry worker uses the legacy queue.", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" });
  await writeKnowledge(root, { ...base, id: "mem_fresh", category: "decision", title: "Runtime retry decision", content: "Runtime retry worker uses bounded jitter.", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" });
  const first = await resolveProjectContext(root, "runtime retry worker");
  const second = await resolveProjectContext(root, "runtime retry worker");
  assert.deepEqual(first.relevant.map((item) => item.id), second.relevant.map((item) => item.id));
  assert.equal(first.relevant[0].id, "mem_fresh");
  assert.equal(first.relevant.some((item) => item.id === "mem_stale"), true, "stale state is conservatively retained");
  assert.equal(first.metrics.staleRelevantItems, 1);
  assert.equal(first.memoryHealth.staleActiveItems, 1);
  assert.equal(first.attention.some((item) => item.kind === "stale-memory"), false);
});

test("required capacity failure stays bounded and explicitly blocks readiness", async () => {
  const root = await fixture();
  const configPath = path.join(root, ".prodero", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.context.max_tokens = 4;
  config.context.required_max_tokens = 4;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const now = "2026-09-02T00:00:00.000Z";
  await writeKnowledge(root, { id: "mem_pressure", scope: "global", scopeRef: null, category: "instruction", priority: "important", status: "active", title: "Required lifecycle rule", content: "This required global body intentionally exceeds the tiny configured budget.", createdAt: now, updatedAt: now, sourceSessions: [], derivedFrom: [], supersedes: [], related: [] });
  const prepared = await prepareProject(root, { task: "lifecycle pressure" });
  assert.equal(prepared.context.metrics.requiredGlobalPressure, "high");
  assert.equal(prepared.uiState.view, "attention");
  assert.equal(prepared.context.attention.some((item) => item.kind === "context-budget"), true);
  assert.equal(prepared.context.metrics.requiredGlobalOmittedByBudget, 1);
  assert.equal(prepared.context.metrics.requiredGlobalOmittedByItemLimit, 0);
  assert.equal(prepared.context.selection.omittedRequired[0].reason, "budget");
});

test("real optional host telemetry remains separate from Prodero metrics", async () => {
  const prepared = await prepareProject(await fixture(), { task: "host adapter", agentUsage: { inputTokens: 123, outputTokens: 45, totalTokens: 168, source: "supported-test-adapter" } });
  assert.equal(prepared.agentUsage.source, "supported-test-adapter");
  assert.equal(prepared.agentUsage.totalTokens, 168);
  assert.equal("totalTokens" in prepared.proderoMetrics, false);
});

test("sync telemetry measures only processed observations and current canonical contribution", async () => {
  const root = await fixture();
  const prepared = await prepareProject(root, { task: "telemetry sync", agent: "test" });
  const content = "Lifecycle telemetry records deterministic current-session contribution without provider usage.";
  await recordProjectSession(root, prepared.session.id, [{ type: "decision", title: "Lifecycle telemetry", content }]);
  const closed = await closeProjectSession(root, prepared.session.id);
  assert.equal(closed.learned.observations, 1);
  assert.equal(closed.learned.byType.decision, 1);
  assert.equal(closed.learned.rawSessionTokens, estimateTokens(content));
  assert.equal(closed.learned.syncState, "synchronized");
  assert.equal(closed.learned.synchronization, closed.synchronization);
  assert.equal(closed.agentUsage, null);

  const sync = closed.synchronization;
  assert.equal(sync.sessionsProcessed, 1);
  assert.equal(sync.observationsProcessed, 1);
  assert.equal(sync.knowledgeCreated, 1);
  assert.equal(sync.rawSessionTokens, estimateTokens(content));
  assert.ok(sync.canonicalTokensAdded > 0);
  assert.equal(sync.estimated, true);
  assert.ok(["compression", "expansion", "unchanged"].includes(sync.memoryCompression.kind));

  const noChange = await syncProject(root);
  assert.equal(noChange.sessionsProcessed, 0);
  assert.equal(noChange.rawSessionTokens, 0);
  assert.equal(noChange.canonicalTokensAdded, 0);
  assert.deepEqual(noChange.memoryCompression, { kind: "unavailable", ratio: null });
});

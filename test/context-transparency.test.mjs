import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preparedContextSnapshot } from "../dist/core/context-snapshot.js";
import { writeKnowledge } from "../dist/core/memory.js";
import { initializeProject, prepareProject, resolveProjectContext } from "../dist/core/project.js";
import { estimateTokens, knowledgeText } from "../dist/core/telemetry.js";

async function fixture(prefix = "prodero-context-transparency-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, ".git"));
  await initializeProject(root);
  return root;
}

function knowledge(overrides) {
  return {
    id: "mem_base", scope: "module", scopeRef: "mcp", category: "decision", priority: "important", status: "active",
    title: "MCP context transparency", content: "The lifecycle card exposes the exact prepared context snapshot.",
    createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
    sourceSessions: ["sess_source_a", "sess_source_b"], derivedFrom: ["sess_source_a#obs_1", "sess_source_a#obs_2", "sess_source_b#obs_3", "sess_source_b#obs_4"],
    supersedes: [], related: [], ...overrides,
  };
}

test("prepared snapshot separates exact required, relevant, and skill context with real signals and provenance", async () => {
  const root = await fixture();
  const required = knowledge({ id: "mem_required_snapshot", scope: "global", scopeRef: null, category: "instruction", priority: "critical", title: "Required snapshot rule", content: "Prepared context snapshots remain exact and session-bound." });
  const relevant = knowledge({ id: "mem_relevant_snapshot" });
  await writeKnowledge(root, required);
  await writeKnowledge(root, relevant);
  const skillBody = "# MCP transparency debugging\n\nInspect the exact lifecycle payload without rerunning retrieval.\n";
  await fs.writeFile(path.join(root, ".prodero", "skills", "mcp-transparency.md"), `---\nid: mcp-transparency\n---\n\n${skillBody}`);

  const prepared = await prepareProject(root, { task: "MCP context transparency debugging", agent: "test" });
  const snapshot = preparedContextSnapshot(prepared.context);
  assert.equal(snapshot, prepared.context, "inspection uses the exact resolver object rather than a second resolution");
  assert.equal(snapshot.snapshot.sessionId, prepared.session.id);
  assert.equal(snapshot.snapshot.task, "MCP context transparency debugging");
  assert.deepEqual(snapshot.required.map((item) => item.id), [required.id]);
  assert.deepEqual(snapshot.relevant.map((item) => item.id), [relevant.id]);
  assert.deepEqual(snapshot.skills.map((item) => item.title), ["MCP transparency debugging"]);
  assert.match(snapshot.skills[0].content, /without rerunning retrieval/);
  assert.equal(snapshot.selection.required[required.id].estimatedTokens, estimateTokens(knowledgeText(required)));
  assert.equal(snapshot.selection.relevant[relevant.id].estimatedTokens, estimateTokens(knowledgeText(relevant)));
  assert.equal(snapshot.skills[0].estimatedTokens, estimateTokens(skillBody.trim()));
  assert.ok(snapshot.selection.relevant[relevant.id].signals.some((signal) => signal.kind === "query-token"));
  assert.ok(snapshot.selection.relevant[relevant.id].signals.some((signal) => signal.kind === "title-token"));
  assert.ok(snapshot.selection.relevant[relevant.id].signals.some((signal) => signal.kind === "scope-token"));
  assert.ok(snapshot.selection.relevant[relevant.id].signals.some((signal) => signal.kind === "priority" && signal.score === 4));
  assert.deepEqual(snapshot.relevant[0].sourceSessions, relevant.sourceSessions);
  assert.deepEqual(snapshot.relevant[0].derivedFrom, relevant.derivedFrom);

  const exactBefore = JSON.stringify(snapshot);
  await writeKnowledge(root, { ...relevant, content: "Canonical memory changed after prepare." });
  await fs.rm(path.join(root, ".prodero", ".cache"), { recursive: true, force: true });
  assert.equal(JSON.stringify(preparedContextSnapshot(prepared.context)), exactBefore, "opening the inline snapshot performs no I/O or retrieval rerun");
});

test("saturation exposes correct omitted counts and bounded metadata without loading omitted bodies", async () => {
  const root = await fixture("prodero-context-saturation-");
  const configPath = path.join(root, ".prodero", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.context = { budgetTokens: 55, requiredBudgetTokens: 20 };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const items = Array.from({ length: 10 }, (_, index) => knowledge({
    id: `mem_saturated_${index}`, scopeRef: `mcp-${index % 2}`, priority: "normal", title: `MCP transparent context ${index}`,
    content: `MCP transparent context selection candidate ${index} carries enough body text to saturate the configured context budget.`,
    sourceSessions: [`sess_${index}`], derivedFrom: [`sess_${index}#obs_${index}`],
  }));
  for (const item of items) await writeKnowledge(root, item);
  const prepared = await prepareProject(root, { task: "MCP transparent context selection", agent: "test" });
  const snapshot = preparedContextSnapshot(prepared.context);
  assert.ok(snapshot.relevant.length < items.length);
  assert.equal(snapshot.selection.omittedRelevantByBudget, items.length - snapshot.relevant.length);
  assert.equal(snapshot.selection.omittedRelevantByItemLimit, 0);
  assert.equal(snapshot.selection.loadedKnowledgeItems, snapshot.required.length + snapshot.relevant.length);
  assert.equal(snapshot.selection.omittedRelevant.length, snapshot.selection.omittedRelevantByBudget);
  assert.ok(snapshot.selection.omittedRelevant.every((item) => item.reason === "budget" && !Object.hasOwn(item, "content")));
});

test("missing snapshot identity fails closed without resolving again", async () => {
  const root = await fixture("prodero-context-missing-snapshot-");
  const unresolved = await resolveProjectContext(root, "anything");
  assert.equal(preparedContextSnapshot(unresolved), null);
  const prepared = await prepareProject(root, { task: "anything", agent: "test" });
  delete prepared.context.snapshot;
  await fs.rm(path.join(root, ".prodero", ".cache"), { recursive: true, force: true });
  assert.equal(preparedContextSnapshot(prepared.context), null);
});

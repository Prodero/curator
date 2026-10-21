import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeProject, rememberProjectKnowledge, resolveProjectContext, searchProjectMemory, getProjectStatus } from "../dist/core/project.js";
import { listKnowledge, writeKnowledge } from "../dist/core/memory.js";
import { applyKnowledgePromotion, previewKnowledgePromotion } from "../dist/core/promotion.js";
import { loadKnowledgeGraph } from "../dist/core/knowledge-graph.js";
import { loadMemoryCatalog } from "../dist/core/memory-index.js";
import { buildIndex } from "../dist/core/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, PRODERO_TOOLS } from "../dist/server.js";

const exec = promisify(execFile);
async function fixture(git = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-promotion-"));
  if (git) await exec("git", ["-C", root, "init", "--quiet"]); else await fs.mkdir(path.join(root, ".git"));
  await initializeProject(root);
  return root;
}
function item(id, content, overrides = {}) {
  return { id, scope: "global", scopeRef: null, category: "decision", priority: "important", status: "active", title: "Knowledge policy", content, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", sourceSessions: ["sess_a", "sess_b"], derivedFrom: ["sess_a#obs_a", "sess_b#obs_b"], supersedes: [], related: [], relations: [], ...overrides };
}

test("normal learning is Local Knowledge, remains Git-clean, and unified retrieval sees both layers", async () => {
  const root = await fixture(true);
  await exec("git", ["-C", root, "config", "user.email", "test@example.invalid"]); await exec("git", ["-C", root, "config", "user.name", "Test"]);
  await exec("git", ["-C", root, "add", "."]); await exec("git", ["-C", root, "commit", "-m", "initialized"]);
  await writeKnowledge(root, item("mem_versioned", "Repository releases use signed tags."), false, "versioned");
  await buildIndex(root); await exec("git", ["-C", root, "add", ".prodero/memory/mem_versioned.md", ".prodero/index.md"]); await exec("git", ["-C", root, "commit", "-m", "versioned knowledge"]);
  const remembered = await rememberProjectKnowledge(root, { title: "Queue policy", content: "Background delivery uses the Cedar queue.", scope: "project", kind: "fact" });
  assert.equal((await loadMemoryCatalog(root)).summaries.find((entry) => entry.id === remembered.item.id).layer, "local");
  assert.equal((await exec("git", ["-C", root, "status", "--short"])).stdout, "", "remember, session and checkpoint writes stay ignored");
  assert.deepEqual((await searchProjectMemory(root, "signed release tags")).matches.map((match) => match.layer), ["versioned"]);
  assert.deepEqual((await searchProjectMemory(root, "Cedar background delivery")).matches.map((match) => match.layer), ["local"]);
  assert.ok((await resolveProjectContext(root, "change Cedar background delivery")).relevant.some((entry) => entry.id === remembered.item.id));
});

test("promotion preview is nonmutating and exact approval publishes reviewed Versioned Knowledge", async () => {
  const root = await fixture();
  await writeKnowledge(root, item("mem_local_new", "Deployment requires a successful smoke test."), false, "local");
  const before = await listKnowledge(root, "versioned");
  const preview = await previewKnowledgePromotion(root, { includeAll: true });
  assert.equal(preview.summary.new, 1); assert.deepEqual(await listKnowledge(root, "versioned"), before);
  await assert.rejects(applyKnowledgePromotion(root, preview, false), /workflow approval/);
  const applied = await applyKnowledgePromotion(root, preview, true);
  assert.equal(applied.published, 1); assert.equal((await listKnowledge(root, "versioned")).length, 1);
  assert.equal((await listKnowledge(root, "local"))[0].status, "consolidated");
  assert.equal((await applyKnowledgePromotion(root, preview, true)).alreadyApplied, true);
});

test("promotion detects team overlap, merges additive knowledge, and preserves supersession and conflicts", async () => {
  const root = await fixture();
  const existing = item("mem_team", "Clients use bounded retries.");
  await writeKnowledge(root, existing, false, "versioned");
  await writeKnowledge(root, item("mem_covered", existing.content), false, "local");
  await writeKnowledge(root, item("mem_merge", "Clients use bounded retries. Clients add jitter to retries."), false, "local");
  await writeKnowledge(root, item("mem_replace", "Clients use one retry with exponential backoff.", { supersedes: [existing.id] }), false, "local");
  const preview = await previewKnowledgePromotion(root, { includeAll: true });
  assert.ok(preview.actions.some((action) => action.disposition === "covered" && action.localIds.includes("mem_covered")));
  assert.ok(preview.actions.some((action) => action.disposition === "supersede" && action.targetId === existing.id));
  assert.ok(preview.actions.some((action) => action.disposition === "conflict" && action.targetId === existing.id), "competing writes to one team item are not published together");
});

test("approved additive promotion updates existing Versioned Knowledge without copying a competing item", async () => {
  const root = await fixture();
  await writeKnowledge(root, item("mem_team", "Clients use bounded retries."), false, "versioned");
  await writeKnowledge(root, item("mem_local", "Clients use bounded retries. Clients add jitter to retries."), false, "local");
  const preview = await previewKnowledgePromotion(root, { includeAll: true });
  assert.equal(preview.summary.merge, 1);
  const result = await applyKnowledgePromotion(root, preview, true);
  assert.deepEqual(result.updated, ["mem_team"]); assert.equal(result.created.length, 0);
  assert.match((await listKnowledge(root, "versioned"))[0].content, /jitter/);
  assert.equal((await listKnowledge(root, "local"))[0].status, "consolidated");
});

test("derived index and graph rebuild deterministically from Local plus Versioned Knowledge", async () => {
  const root = await fixture();
  await writeKnowledge(root, item("mem_v", "The API implements stable error codes."), false, "versioned");
  await writeKnowledge(root, item("mem_l", "Client handlers depend on stable error codes.", { relations: [{ type: "depends_on", target: "mem_v" }] }), false, "local");
  const first = await loadKnowledgeGraph(root, await loadMemoryCatalog(root));
  await fs.rm(path.join(root, ".prodero", ".cache"), { recursive: true, force: true });
  const second = await loadKnowledgeGraph(root, await loadMemoryCatalog(root));
  assert.equal(second.diagnostics.nodeCount, 2); assert.equal(second.diagnostics.cacheState, "missing");
  assert.deepEqual(second.edges, first.edges);
  const status = await getProjectStatus(root);
  assert.equal(status.localKnowledgeCount, 1); assert.equal(status.versionedKnowledgeCount, 1); assert.equal(status.promotionRecommendedCount, 1);
});

test("assisted promotion uses bounded semantic reconciliation and keeps the result review-only", async () => {
  const root = await fixture();
  await writeKnowledge(root, item("mem_v", "Workers use bounded retries."), false, "versioned");
  await writeKnowledge(root, item("mem_l", "Workers use bounded retries. Workers add jitter."), false, "local");
  const calls = [];
  const provider = { name: "promotion-test", async reconcile(input) { calls.push(input); return { output: { actions: [{ action: "MERGE", sources: [input.candidate.id, input.related[0].id], canonical: { title: "Knowledge policy", content: "Workers use bounded retries. Workers add jitter.", category: "decision", scope: "global", scopeRef: null, priority: "important" }, reason: "The local observation adds a retry constraint." }] } }; } };
  const preview = await previewKnowledgePromotion(root, { provider, includeAll: true });
  assert.equal(preview.mode, "assisted"); assert.equal(preview.summary.merge, 1); assert.equal(calls.length, 1);
  assert.equal((await listKnowledge(root, "versioned"))[0].content, "Workers use bounded retries.", "model reasoning cannot write before approval");
});

test("MCP and the existing App expose review-before-publish promotion", async () => {
  const root = await fixture();
  await writeKnowledge(root, item("mem_local", "Release branches require a green build."), false, "local");
  const server = createServer({projectRoot:root}); const client = new Client({ name: "promotion-mcp-test", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes(PRODERO_TOOLS.promotionPreview)); assert.ok(names.includes(PRODERO_TOOLS.promote));
    const reviewed = await client.callTool({ name: PRODERO_TOOLS.promotionPreview, arguments: { projectRoot: root, includeAll: true } });
    assert.equal(reviewed.structuredContent.uiState.view, "promotion-review"); assert.equal((await listKnowledge(root, "versioned")).length, 0);
    const published = await client.callTool({ name: PRODERO_TOOLS.promote, arguments: { projectRoot: root, approved: true, preview: reviewed.structuredContent.preview } });
    assert.equal(published.structuredContent.result.published, 1);
  } finally { await client.close(); await server.close(); }
  const ui = await fs.readFile(new URL("../src/ui/main.ts", import.meta.url), "utf8");
  assert.match(ui, /Local Knowledge/); assert.match(ui, /Curate Memory/); assert.match(ui, /PRODERO_TOOLS\.memorySync/); assert.match(ui, /PRODERO_TOOLS\.promote/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalized } from "../dist/core/matching.js";
import { writeKnowledge } from "../dist/core/memory.js";
import {
  buildIndex,
  createSession,
  getProjectStatus,
  initializeProject,
  listKnowledge,
  parseSession,
  prepareProject,
  recordProjectSession,
  resolveProjectContext,
  syncProject,
} from "../dist/core/project.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-memory-test-"));
  await fs.mkdir(path.join(root, ".git"));
  await initializeProject(root);
  return root;
}

async function writeSession(root, name, sections, metadata = {}) {
  const id = metadata.id ?? name;
  const body = Object.entries(sections).map(([heading, items]) => `## ${heading}\n\n${items.map((item) => `- ${item}`).join("\n")}`).join("\n\n");
  const content = `---\nid: ${id}\ncreated_at: 2026-09-02T00:00:00.000Z\nupdated_at: 2026-09-02T00:00:00.000Z\nstatus: ${metadata.status ?? "closed"}\nagent: codex\nbranch: test\nbase_commit: null\n---\n\n# Session\n\n${body}\n`;
  await fs.writeFile(path.join(root, ".prodero", "sessions", `${name}.md`), content);
  return content;
}

test("normalization preserves Unicode knowledge instead of collapsing it to an empty duplicate", () => {
  assert.notEqual(normalized("Архитектурное решение"), normalized("Проектное ограничение"));
});

test("session mutation rejects malformed Markdown with a diagnostic and preserves the file", async () => {
  const root = await fixture();
  const target = path.join(root, ".prodero", "sessions", "sess_malformed.md");
  const malformed = "---\nid: wrong-id\nstatus: broken\n---\n\n## Decisions\n- Preserve me.\n";
  await fs.writeFile(target, malformed);
  await assert.rejects(() => recordProjectSession(root, "sess_malformed", [{ type: "lesson", content: "Must not write." }]), /Invalid Prodero session/);
  assert.equal(await fs.readFile(target, "utf8"), malformed);
});

test("session memory requires English durable prose regardless of chat language", async () => {
  const root = await fixture();
  const session = await createSession(root, { agent: "codex" });
  await assert.rejects(() => recordProjectSession(root, session.id, [{ type: "decision", title: "Русское знание", content: "Всегда сохранять это решение." }]), /must be written in English/);
  const unchanged = await fs.readFile(path.join(root, ".prodero", "sessions", session.path), "utf8");
  assert.doesNotMatch(unchanged, /Русское знание/);
});

test("creates unique sortable sessions and parses all structured sections", async () => {
  const root = await fixture();
  const first = await createSession(root, { agent: "codex" });
  const second = await createSession(root, { agent: "codex" });
  assert.notEqual(first.id, second.id);
  assert.match(first.id, /^sess_\d{17}_[a-f0-9]{12}$/);
  assert.equal((await getProjectStatus(root)).sessionCount, 2);

  const content = await writeSession(root, "structured", {
    Decisions: ["Choose atomic Markdown."], Lessons: ["Keep writes append-friendly."], Discoveries: ["Agents work in parallel."],
    "Project State Changes": ["Sync now consolidates."], "Global Instruction Candidates": ["Prepare before substantial work."], "Skill Candidates": ["Verify MCP tools and Core together."],
  });
  const parsed = parseSession(content, "structured.md");
  assert.equal(parsed.sections.Decisions[0], "Choose atomic Markdown.");
  assert.equal(parsed.sections["Skill Candidates"].length, 1);
});

test("sync creates canonical knowledge once, preserves provenance, and checkpoints processed sessions immutably", async () => {
  const root = await fixture();
  await writeSession(root, "one", { Decisions: ["[scope=global priority=critical title=Atomic-memory] Canonical knowledge uses atomic Markdown files."] });
  await writeSession(root, "two", { Lessons: ["[scope=task scope_ref=mcp] MCP adapters should call Core directly."] });
  const first = await syncProject(root);
  assert.equal(first.sessions, 2);
  assert.equal(first.created, 2);
  const memory = await listKnowledge(root);
  assert.equal(memory.length, 2);
  assert.ok(memory.every((item) => item.sourceSessions.length === 1 && item.derivedFrom.length === 1));
  assert.ok(memory.every((item) => !item.content.startsWith("# ")));

  const checkpointPath = path.join(root, ".prodero", "checkpoints", `${first.checkpoint}.json`);
  const checkpointBefore = await fs.readFile(checkpointPath, "utf8");
  const manifest = JSON.parse(checkpointBefore);
  assert.equal(manifest.previousCheckpoint, null);
  assert.equal(manifest.sessions.length, 2);
  assert.equal(manifest.createdMemory.length, 2);
  assert.equal(manifest.consolidation, "deterministic-v1");

  const second = await syncProject(root);
  assert.equal(second.sessions, 0);
  assert.equal((await listKnowledge(root)).length, 2);
  assert.equal(await fs.readFile(checkpointPath, "utf8"), checkpointBefore);
});

test("deterministic fallback collapses exact duplicates and preserves uncertain lexical overlap", async () => {
  const root = await fixture();
  await writeSession(root, "a", { Decisions: ["Execution API v3 is canonical."] });
  await syncProject(root);
  await writeSession(root, "b", { Decisions: ["Execution API v3 is canonical.", "New integrations must use Execution API v3."] });
  const result = await syncProject(root);
  assert.equal(result.duplicates, 1);
  assert.equal(result.consolidated, 0);
  const memory = await listKnowledge(root);
  assert.equal(memory.length, 2);
  assert.deepEqual(memory[0].sourceSessions.sort(), ["a", "b"]);
  assert.ok(memory.some((item) => /New integrations/.test(item.content)));
});

test("deterministic compaction removes repeated segments while retaining every provenance reference", async () => {
  const root = await fixture();
  await writeSession(root, "first", { Decisions: ["Execution API v3 is canonical. Shared clients use bounded retries."] });
  await syncProject(root);
  await writeSession(root, "second", { Decisions: ["Execution API v3 is canonical. Shared clients use bounded retries. New callers use jitter."] });
  const result = await syncProject(root);
  const memory = await listKnowledge(root);
  assert.equal(memory.length, 1);
  assert.equal((memory[0].content.match(/Execution API v3 is canonical\./g) ?? []).length, 1);
  assert.match(memory[0].content, /New callers use jitter/);
  assert.deepEqual(memory[0].sourceSessions.sort(), ["first", "second"]);
  assert.equal(memory[0].derivedFrom.length, 2);
  assert.ok(result.diagnostics.compactedSegments >= 1);
});

test("explicit supersede replaces an active item and preserves both historical records", async () => {
  const root = await fixture();
  await writeSession(root, "old", { Decisions: ["[title=Execution-API] Execution API v2 is canonical."] });
  await syncProject(root);
  const old = (await listKnowledge(root))[0];
  await writeSession(root, "new", { Decisions: [`[title=Execution-API supersedes=${old.id}] Execution API v3 is now canonical and replaces v2.`] });
  const result = await syncProject(root);
  assert.equal(result.superseded, 1);
  const memory = await listKnowledge(root);
  assert.equal(memory.length, 2);
  assert.equal(memory.find((item) => item.id === old.id).status, "superseded");
  const current = memory.find((item) => item.id !== old.id);
  assert.equal(current.status, "active");
  assert.deepEqual(current.supersedes, [old.id]);
});

test("same-topic decisions await semantic reconciliation without inferring a conflict", async () => {
  const root = await fixture();
  await writeSession(root, "node", { Decisions: ["[title=Runtime] The runtime is Node.js."] });
  await syncProject(root);
  await writeSession(root, "deno", { Decisions: ["[title=Runtime] The runtime is Deno."] });
  const result = await syncProject(root);
  assert.equal(result.conflicts, 0);
  assert.equal((await listKnowledge(root)).filter((item) => item.status === "disputed").length, 0);
  assert.equal((await getProjectStatus(root)).conflictCount, 0);
  const context = await resolveProjectContext(root, "Runtime Node Deno");
  assert.equal(context.attention.some((item) => item.kind === "conflict" && item.severity === "critical"), false);
});

test("index is deterministic and routes without embedding knowledge bodies", async () => {
  const root = await fixture();
  await writeSession(root, "index", { Decisions: ["[scope=global priority=important title=Stable-contracts] Public contracts remain backward compatible and retain a secret body phrase."], Lessons: ["[scope=module scope_ref=ui title=Compact-status] Keep the status card compact."] });
  await syncProject(root);
  const first = await buildIndex(root);
  const second = await buildIndex(root);
  assert.equal(first, second);
  const local = await fs.readFile(path.join(root, ".prodero", "local", "index.md"), "utf8");
  assert.match(local, /Stable-contracts/);
  assert.match(local, /Compact-status/);
  assert.doesNotMatch(local, /secret body phrase/);
  assert.doesNotMatch(first, /Stable-contracts|Compact-status/, "tracked router does not churn as Local Knowledge changes");
});

test("context always returns required globals and filters irrelevant contextual memory", async () => {
  const root = await fixture();
  await writeKnowledge(root, { id: "mem_local_first", scope: "global", scopeRef: null, category: "instruction", priority: "critical", status: "active", title: "Local-first", content: "Prodero remains local-first and Git-native.", createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", sourceSessions: [], derivedFrom: [], supersedes: [], related: [] });
  await writeSession(root, "context", {
    Lessons: ["[scope=module scope_ref=mcp title=MCP-reload] Restart the MCP server after UI changes.", "[scope=module scope_ref=database title=Database-pool] Tune database connection pooling."],
  });
  await syncProject(root);
  const context = await resolveProjectContext(root, "change MCP UI reload behavior");
  assert.equal(context.required.length, 1);
  assert.ok(context.relevant.some((item) => item.scopeRef === "mcp"));
  assert.ok(!context.relevant.some((item) => item.scopeRef === "database"));
});

test("required and complete task context remain bounded as global memory grows", async () => {
  const root = await fixture();
  const configPath = path.join(root, ".prodero", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.context = { budgetTokens: 160, requiredBudgetTokens: 80 };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  for (let index = 0; index < 40; index += 1) await writeKnowledge(root, { id: `mem_rule_${index}`, scope: "global", scopeRef: null, category: "instruction", priority: index < 4 ? "critical" : "important", status: "active", title: `Rule-${String(index).padStart(2, "0")}`, content: `Required lifecycle rule ${index} keeps deterministic project memory bounded with provenance.`, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", sourceSessions: [], derivedFrom: [], supersedes: [], related: [] });
  const context = await resolveProjectContext(root, "lifecycle deterministic memory");
  assert.ok(context.required.length <= context.limits.maxRequiredItems);
  assert.ok(context.metrics.requiredGlobalTokens <= context.limits.contextBudgetTokens);
  assert.ok(context.metrics.contextTokens <= context.limits.contextBudgetTokens);
  assert.ok(context.metrics.requiredGlobalExcludedItems > 0);
  assert.ok(context.metrics.requiredGlobalOmittedByBudget > 0);
  assert.equal(context.metrics.requiredGlobalOmittedByItemLimit, 0);
  assert.ok(context.selection.omittedRequired.every((item) => item.reason === "budget"));
  assert.equal(context.required[0]?.priority, "critical", "critical required items rank first under pressure");
  const firstImportant = context.required.findIndex((item) => item.priority === "important");
  assert.ok(firstImportant === -1 || firstImportant >= context.required.filter((item) => item.priority === "critical").length);
});

test("required global omissions identify the item limit independently of token budget", async () => {
  const root = await fixture();
  const configPath = path.join(root, ".prodero", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.context = { budgetTokens: 10_000, requiredBudgetTokens: 10_000 };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  for (let index = 0; index < 132; index += 1) await writeKnowledge(root, { id: `mem_compact_${index}`, scope: "global", scopeRef: null, category: "instruction", priority: "important", status: "active", title: `Compact-${String(index).padStart(2, "0")}`, content: `Required compact rule ${index}.`, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", sourceSessions: [], derivedFrom: [], supersedes: [], related: [] });
  const context = await resolveProjectContext(root, "compact rules");
  assert.equal(context.required.length, context.limits.maxRequiredItems);
  assert.equal(context.metrics.requiredGlobalOmittedByBudget, 0);
  assert.equal(context.metrics.requiredGlobalOmittedByItemLimit, 4);
  assert.equal(context.metrics.requiredGlobalOmittedByItemLimitTokens, context.metrics.requiredGlobalExcludedTokens);
  assert.ok(context.selection.omittedRequired.every((item) => item.reason === "item-limit"));
  assert.equal(context.attention.some((item) => item.kind === "context-budget"), true);
});

test("prepare automatically syncs closed sessions, creates a new work session, and returns context", async () => {
  const root = await fixture();
  await writeSession(root, "finished", { Decisions: ["[scope=global priority=important title=Prepare-boundary] Prepare synchronizes completed work."] }, { status: "closed" });
  const prepared = await prepareProject(root, { task: "work on preparation boundary", agent: "codex" });
  assert.equal(prepared.automaticSync.sessions, 1);
  assert.equal(prepared.automaticSync.created, 1);
  assert.match(prepared.session.id, /^sess_/);
  assert.equal(prepared.context.required.length, 0);
  assert.equal(prepared.context.relevant.length, 1);
  assert.equal((await getProjectStatus(root)).pendingSessionCount, 0, "an empty active session is not pending until it records an observation");
  const reused = await prepareProject(root, { task: "continue preparation work", agent: "codex", sessionId: prepared.session.id });
  assert.equal(reused.session.id, prepared.session.id);
  assert.equal((await getProjectStatus(root)).sessionCount, 2, "closed source plus one reused active session");
});

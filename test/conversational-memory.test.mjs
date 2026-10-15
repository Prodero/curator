import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, PRODERO_MCP_INSTRUCTIONS, PRODERO_TOOLS } from "../dist/server.js";
import {
  forgetProjectKnowledge,
  initializeProject,
  listKnowledge,
  prepareProject,
  rememberProjectKnowledge,
  resolveProjectContext,
  searchProjectMemory,
} from "../dist/core/project.js";
import { listSessions } from "../dist/core/sessions.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-conversation-memory-"));
  await fs.mkdir(path.join(root, ".git"));
  await initializeProject(root);
  return root;
}

test("explicit remember is immediately durable and exact repeats deduplicate through normal consolidation", async () => {
  const root = await fixture();
  const first = await rememberProjectKnowledge(root, { title: "Database policy", content: "The project uses PostgreSQL for durable application data.", scope: "project", kind: "decision" });
  assert.equal(first.outcome, "created"); assert.match(first.checkpoint, /^chk_/); assert.equal(first.item.scope, "global"); assert.equal(first.item.priority, "normal");
  assert.equal((await listSessions(root)).find((session) => session.id === first.sessionId).status, "closed");
  assert.equal((await listKnowledge(root)).length, 1, "remember synchronizes immediately instead of waiting for prepare");

  const duplicate = await rememberProjectKnowledge(root, { title: "Database policy", content: "The project uses PostgreSQL for durable application data.", scope: "project", kind: "decision" });
  assert.equal(duplicate.outcome, "duplicate"); assert.equal(duplicate.item.id, first.item.id); assert.equal((await listKnowledge(root)).length, 1);
  assert.equal(duplicate.item.derivedFrom.length, 2, "deduplication retains both explicit user-observation provenance records");
});

test("remember merges additive knowledge and replaceId safely supersedes instead of creating a contradiction", async () => {
  const root = await fixture();
  const first = await rememberProjectKnowledge(root, { title: "Retry policy", content: "Clients use bounded retries.", kind: "rule" });
  const merged = await rememberProjectKnowledge(root, { title: "Retry policy", content: "Clients use bounded retries. Retries use jitter.", kind: "rule" });
  assert.equal(merged.outcome, "merged"); assert.equal(merged.item.id, first.item.id); assert.match(merged.item.content, /Retries use jitter/);

  const updated = await rememberProjectKnowledge(root, { content: "Clients use one retry with exponential backoff.", replaceId: first.item.id });
  assert.equal(updated.outcome, "updated"); assert.equal(updated.replacedId, first.item.id); assert.notEqual(updated.item.id, first.item.id);
  const all = await listKnowledge(root); const old = all.find((item) => item.id === first.item.id);
  assert.equal(old.status, "superseded"); assert.equal(updated.item.status, "active"); assert.deepEqual(updated.item.supersedes, [first.item.id]);
  assert.equal(all.filter((item) => item.status === "disputed").length, 0);
});

test("global, project, and path scopes stay bounded and path memory requires path relevance", async () => {
  const root = await fixture();
  const global = await rememberProjectKnowledge(root, { title: "Safety rule", content: "Never commit credentials.", scope: "global", kind: "rule" });
  const project = await rememberProjectKnowledge(root, { title: "Queue choice", content: "Background delivery uses the Cedar queue.", scope: "project", kind: "fact", importance: "important" });
  const scoped = await rememberProjectKnowledge(root, { title: "Legacy tests", content: "Run focused tests before modifying request handlers.", scope: "path", path: "src/legacy", kind: "rule" });
  assert.equal(global.item.priority, "normal"); assert.equal(project.item.priority, "important", "priority is independent of applicability"); assert.equal(scoped.item.scope, "module"); assert.equal(scoped.item.scopeRef, "src/legacy");

  const unrelated = await resolveProjectContext(root, "modify src/modern/request.ts handlers and run focused tests");
  assert.ok(!unrelated.required.some((item) => item.id === global.item.id));
  assert.equal(global.item.contextPolicy,"relevant");assert.equal(global.item.authority,"inferred");
  assert.ok(!unrelated.relevant.some((item) => item.id === scoped.item.id), "matching generic prose must not leak path-scoped context");
  const relevant = await prepareProject(root, { task: "modify src/legacy/request.php handlers" });
  assert.ok([...relevant.context.required, ...relevant.context.relevant].some((item) => item.id === scoped.item.id));
  const projectMatch = await resolveProjectContext(root, "change Cedar background delivery");
  assert.ok(projectMatch.relevant.some((item) => item.id === project.item.id));
  assert.equal((await searchProjectMemory(root, "rule credentials", { scope: "project" })).matches[0].id, global.item.id);
  assert.equal((await searchProjectMemory(root, "rule credentials", { scope: "global" })).matches[0].id, global.item.id);
  await assert.rejects(searchProjectMemory(root, "legacy tests", { scope: "path" }), /requires a repository-relative path/);
  assert.equal((await searchProjectMemory(root, "legacy tests", { scope: "path", path: "./src/legacy/" })).matches[0].id, scoped.item.id);
});

test("memory search survives disposable cache loss and forget retires canonical knowledge atomically", async () => {
  const root = await fixture();
  const remembered = await rememberProjectKnowledge(root, { title: "Renderer policy", content: "The report renderer escapes external HTML.", kind: "rule" });
  let search = await searchProjectMemory(root, "renderer external HTML");
  assert.deepEqual(search.matches.map((item) => item.id), [remembered.item.id]);
  await fs.rm(path.join(root, ".prodero", ".cache"), { recursive: true, force: true });
  search = await searchProjectMemory(root, "renderer external HTML");
  assert.deepEqual(search.matches.map((item) => item.id), [remembered.item.id], "canonical Markdown rebuilds the disposable search cache");

  const forgotten = await forgetProjectKnowledge(root, { id: remembered.item.id, reason: "The user explicitly retired this rule." });
  assert.equal(forgotten.forgotten, true); assert.match(forgotten.checkpoint, /^chk_/); assert.equal(forgotten.item.status, "deprecated");
  assert.equal((await searchProjectMemory(root, "renderer external HTML")).matches.length, 0);
  assert.equal((await searchProjectMemory(root, "renderer external HTML", { includeHistorical: true })).matches[0].status, "deprecated");
  assert.ok(![...(await resolveProjectContext(root, "renderer external HTML")).required, ...(await resolveProjectContext(root, "renderer external HTML")).relevant].some((item) => item.id === remembered.item.id));
  assert.equal((await forgetProjectKnowledge(root, { id: remembered.item.id })).alreadyHistorical, true, "forget is idempotent");
});

test("forget rejects ambiguous matches and non-English durable metadata without changing knowledge", async () => {
  const root = await fixture();
  const first = await rememberProjectKnowledge(root, { title: "API timeout", content: "The public API timeout is ten seconds.", kind: "fact" });
  const second = await rememberProjectKnowledge(root, { title: "Worker timeout", content: "The background worker timeout is thirty seconds.", kind: "fact" });
  await assert.rejects(forgetProjectKnowledge(root, { query: "timeout" }), /Forget is ambiguous/);
  await assert.rejects(forgetProjectKnowledge(root, { id: first.item.id, reason: "Устарело" }), /must be written in English/);
  const active = await listKnowledge(root);
  assert.equal(active.find((item) => item.id === first.item.id).status, "active");
  assert.equal(active.find((item) => item.id === second.item.id).status, "active");
});

test("MCP exposes simple conversational remember, search, update, and forget operations", async () => {
  const root = await fixture(); const server = createServer({projectRoot:root}); const client = new Client({ name: "memory-chat-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  try {
    const tools = (await client.listTools()).tools;
    for (const name of [PRODERO_TOOLS.remember, PRODERO_TOOLS.memorySearch, PRODERO_TOOLS.forget]) assert.ok(tools.some((tool) => tool.name === name));
    assert.match(PRODERO_MCP_INSTRUCTIONS, /prodero_remember[\s\S]*prodero_memory_search[\s\S]*prodero_forget/);
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: { projectRoot: root, ...args } });
      assert.notEqual(response.isError, true, response.content?.[0]?.text); return response.structuredContent.result;
    };
    const remembered = await call(PRODERO_TOOLS.remember, { content: "API responses use stable error codes.", title: "Error codes", scope: "project", kind: "rule" });
    const searched = await call(PRODERO_TOOLS.memorySearch, { query: "stable API error codes" }); assert.equal(searched.matches[0].id, remembered.item.id);
    const updated = await call(PRODERO_TOOLS.remember, { content: "API responses use versioned stable error codes.", replaceId: searched.matches[0].id });
    assert.equal(updated.replacedId, remembered.item.id);
    const forgotten = await call(PRODERO_TOOLS.forget, { id: updated.item.id }); assert.equal(forgotten.forgotten, true);
  } finally { await client.close(); await server.close(); }
});

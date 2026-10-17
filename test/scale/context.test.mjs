import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex, getFastProjectStatus, initializeProject, resolveProjectContext, syncProject } from "../../dist/core/project.js";
import { MAX_RELATED_MEMORY_CANDIDATES } from "../../dist/core/memory-index.js";
import { writeKnowledge } from "../../dist/core/memory.js";
import { discoverSessions } from "../../dist/core/session-index.js";

async function fixture(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, ".git"));
  await initializeProject(root);
  return root;
}

function sessionContent(id, observation) {
  return `---\nid: ${id}\ncreated_at: 2026-09-02T00:00:00.000Z\nupdated_at: 2026-09-02T00:00:00.000Z\nstatus: closed\nagent: scale-test\nbranch: test\nbase_commit: null\n---\n\n# Session\n\n## Decisions\n\n- [id=obs_${id} scope=task scope_ref=scale] ${observation}\n`;
}

async function batches(items, operation, size = 100) {
  for (let offset = 0; offset < items.length; offset += size) await Promise.all(items.slice(offset, offset + size).map(operation));
}

test("fast status remains independent of 10,000 canonical memory bodies", async () => {
  const root = await fixture("prodero-fast-status-scale-");
  const memory = path.join(root, ".prodero", "memory");
  const names = Array.from({ length: 10_000 }, (_, index) => `mem_fast_${String(index).padStart(5, "0")}.md`);
  await batches(names, (name) => fs.writeFile(path.join(memory, name), "not parsed by fast status\n"), 250);
  await fs.rm(path.join(root, ".prodero", ".cache"), { recursive: true, force: true });
  const timings = [];
  const status = await getFastProjectStatus(root, { instrument: (timing) => timings.push(timing) });
  assert.equal(status.initialized, true);
  assert.equal(status.canonicalStructure, true);
  assert.deepEqual(timings.map((timing) => timing.phase), ["fast-status"]);
  await assert.rejects(fs.stat(path.join(root, ".prodero", ".cache")), { code: "ENOENT" });
});

test("incremental discovery scans 1,000 files but reads and consolidates only 5 pending bodies on the warm path", async () => {
  const root = await fixture("prodero-session-scale-");
  const records = Array.from({ length: 1_000 }, (_, index) => {
    const id = `sess_scale_${String(index).padStart(4, "0")}`;
    const filename = `${id}.md`;
    const content = sessionContent(id, `Scale observation ${index}.`);
    return { id, filename, content, sha256: crypto.createHash("sha256").update(content).digest("hex") };
  });
  await batches(records, (record) => fs.writeFile(path.join(root, ".prodero", "sessions", record.filename), record.content));
  const checkpoint = {
    id: "chk_scale_baseline",
    createdAt: "2026-09-02T00:01:00.000Z",
    previousCheckpoint: null,
    sessions: records.slice(0, 995).map((record) => ({ id: record.id, path: record.filename, sha256: record.sha256 })),
    consolidation: "deterministic-v1",
    createdMemory: [], updatedMemory: [], supersededMemory: [], duplicateMemory: [], conflicts: [],
    summary: { sessions: 995, candidates: 995, created: 0, consolidated: 0, duplicates: 0, superseded: 0, conflicts: 0 },
  };
  await fs.writeFile(path.join(root, ".prodero", "checkpoints", "chk_scale_baseline.json"), `${JSON.stringify(checkpoint)}\n`);

  const warmed = await discoverSessions(root);
  assert.equal(warmed.sessions.length, 1_000);
  assert.equal(warmed.sessions.filter((session) => session.pending).length, 5);
  assert.equal(warmed.sessionBodiesRead, 1_000, "cold cache rebuild reads canonical files once");

  const first = await syncProject(root);
  assert.equal(first.sessions, 5);
  assert.equal(first.diagnostics.sessionFilesScanned, 1_000);
  assert.equal(first.diagnostics.sessionBodiesRead, 5);
  assert.equal(first.diagnostics.sessionBodiesConsolidated, 5);

  const second = await syncProject(root);
  assert.equal(second.sessions, 0);
  assert.equal(second.diagnostics.sessionBodiesRead, 0);
  assert.equal(second.diagnostics.sessionBodiesConsolidated, 0);

  await fs.rm(path.join(root, ".prodero", ".cache", "session-index.json"), { force: true });
  const rebuilt = await discoverSessions(root);
  assert.equal(rebuilt.sessionBodiesRead, 1_000);
  assert.equal(rebuilt.sessions.filter((session) => session.pending).length, 0, "checkpoints remain authoritative without cache");
});

test("canonical related-memory selection and returned contextual memory stay bounded with 1,000 items", async () => {
  const root = await fixture("prodero-memory-scale-");
  const now = "2026-09-02T00:00:00.000Z";
  const items = Array.from({ length: 1_000 }, (_, index) => ({
    id: `mem_scale_${String(index).padStart(4, "0")}`,
    scope: "module",
    scopeRef: index < 100 ? "execution" : `unrelated-${index}`,
    category: index < 100 ? "decision" : "lesson",
    priority: "contextual",
    status: "active",
    title: index < 100 ? `Execution retry policy ${index}` : `Isolated topic ${index}`,
    content: index < 100 ? `Execution engine retry behavior variant ${index}.` : `Unique isolated corpus token_${index}.`,
    createdAt: now, updatedAt: now, sourceSessions: [], derivedFrom: [], supersedes: [], related: [],
  }));
  await batches(items, (item) => writeKnowledge(root, item));
  await buildIndex(root); // Populate the rebuildable metadata/token cache before the incremental sync.

  const sessionId = "sess_memory_scale_candidate";
  const content = `---\nid: ${sessionId}\ncreated_at: ${now}\nupdated_at: ${now}\nstatus: closed\nagent: scale-test\nbranch: test\nbase_commit: null\n---\n\n# Session\n\n## Decisions\n\n- [id=obs_memory_scale scope=module scope_ref=execution priority=normal title="Execution retry decision"] Execution engine retry behavior uses bounded comparison.\n`;
  await fs.writeFile(path.join(root, ".prodero", "sessions", `${sessionId}.md`), content);
  const result = await syncProject(root);
  assert.equal(result.sessions, 1);
  assert.equal(result.diagnostics.memoryFilesScanned, 1_000);
  assert.equal(result.diagnostics.memoryBodiesIndexed, 0);
  assert.ok(result.diagnostics.relatedCandidatesSelectedMax <= MAX_RELATED_MEMORY_CANDIDATES);
  assert.ok(result.diagnostics.memoryBodiesLoaded <= MAX_RELATED_MEMORY_CANDIDATES);
  assert.equal(result.diagnostics.relatedCandidateLimit, MAX_RELATED_MEMORY_CANDIDATES);

  const context = await resolveProjectContext(root, "execution engine retry behavior");
  assert.ok(context.relevant.length <= 8);
  assert.equal(context.limits.maxRelevantItems, 8);
  assert.equal(context.limits.contextBudgetTokens, 6_000);
  assert.equal(context.metrics.estimated, true);
  assert.ok(!context.relevant.some((item) => item.scopeRef?.startsWith("unrelated-")));
});

test("context bounds are invariant at reproducible 100, 1,000, and 10,000 item scales", async () => {
  for (const size of [100, 1_000, 10_000]) {
    const root = await fixture(`prodero-context-${size}-`);
    const now = "2026-09-02T00:00:00.000Z";
    const items = Array.from({ length: size }, (_, index) => ({
      id: `mem_benchmark_${String(index).padStart(5, "0")}`,
      scope: "module", scopeRef: index < 16 ? `runtime-${index % 4}` : `noise-${index}`,
      category: index < 16 ? "decision" : "lesson", priority: "contextual", status: "active",
      title: index < 16 ? `Target retry worker ${index}` : `Unrelated fixture ${index}`,
      content: index < 16 ? `Deterministic retry worker queue policy target ${index}.` : `Isolated benchmark token_${index}.`,
      createdAt: now, updatedAt: now, sourceSessions: ["benchmark"], derivedFrom: [`benchmark#${index}`], supersedes: [], related: [],
    }));
    await batches(items, (item) => writeKnowledge(root, item), 250);
    const index = await buildIndex(root);
    assert.ok((index.match(/\]\(memory\//g) ?? []).length <= 144, "tracked router remains bounded");
    if (size > 128) assert.match(index, /additional contextual item/);
    const first = await resolveProjectContext(root, "deterministic retry worker queue policy target");
    const second = await resolveProjectContext(root, "deterministic retry worker queue policy target");
    assert.deepEqual(first.relevant.map((item) => item.id), second.relevant.map((item) => item.id));
    assert.equal(first.relevant.length, 8);
    assert.equal(first.relevant.every((item) => item.title.startsWith("Target")), true);
    assert.ok(first.metrics.contextTokens <= first.limits.contextBudgetTokens);
    assert.ok(first.metrics.requiredGlobalTokens <= first.limits.contextBudgetTokens);
  }
});

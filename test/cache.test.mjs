import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildIndex, getDetailedProjectStatus, getFastProjectStatus, initializeProject, prepareProject, resolveProjectContext, syncProject } from "../dist/core/project.js";
import { writeKnowledge } from "../dist/core/memory.js";
import { createServer, PRODERO_TOOLS } from "../dist/server.js";

const exec = promisify(execFile);

async function fixture(prefix = "prodero-cache-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, ".git"));
  await initializeProject(root);
  await writeKnowledge(root, {
    id: "mem_cache_fixture",
    scope: "global",
    scopeRef: null,
    category: "instruction",
    priority: "important",
    status: "active",
    title: "Cache recovery fixture",
    content: "Canonical knowledge remains authoritative when derived state is absent.",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    sourceSessions: [],
    derivedFrom: [],
    supersedes: [],
    related: [],
  });
  await buildIndex(root);
  return root;
}

async function canonicalSnapshot(root) {
  const files = [];
  async function visit(directory, relative = "") {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && entry.name === ".cache") continue;
      const next = path.join(relative, entry.name);
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, next);
      else files.push([next, await fs.readFile(target, "utf8")]);
    }
  }
  await visit(path.join(root, ".prodero"));
  return files;
}

test("derived cache is disposable, self-healing, atomic, and never required by fast status", async () => {
  const root = await fixture();
  const cache = path.join(root, ".prodero", ".cache");
  assert.equal((await fs.stat(cache)).isDirectory(), true, "cache is present after initialization");
  const canonicalBefore = await canonicalSnapshot(root);

  await fs.rm(cache, { recursive: true, force: true });
  const fastTimings = [];
  const fast = await getFastProjectStatus(root, { instrument: (timing) => fastTimings.push(timing) });
  assert.equal(fast.initialized, true);
  assert.equal(fast.canonicalStructure, true);
  await assert.rejects(fs.stat(cache), { code: "ENOENT" }, "fast status must not reconstruct derived state");
  assert.deepEqual(fastTimings.map((timing) => timing.phase), ["fast-status"]);

  const coldTimings = [];
  const cold = await getDetailedProjectStatus(root, { instrument: (timing) => coldTimings.push(timing) });
  assert.equal(cold.knowledgeCount, 1);
  assert.equal((await fs.stat(path.join(cache, "memory-index.json"))).isFile(), true);
  assert.equal((await fs.stat(path.join(cache, "session-index.json"))).isFile(), true);
  assert.equal(coldTimings.find((timing) => timing.phase === "memory-index")?.cache, "missing");
  assert.equal(coldTimings.find((timing) => timing.phase === "session-index")?.cache, "missing");
  const warmTimings = [];
  await getDetailedProjectStatus(root, { instrument: (timing) => warmTimings.push(timing) });
  assert.equal(warmTimings.find((timing) => timing.phase === "memory-index")?.cache, "warm");
  assert.equal(warmTimings.find((timing) => timing.phase === "memory-index")?.bodiesRead, 0);
  assert.equal(warmTimings.find((timing) => timing.phase === "session-index")?.cache, "warm");
  assert.equal(warmTimings.find((timing) => timing.phase === "session-index")?.bodiesRead, 0);

  await fs.rm(path.join(cache, "memory-index.json"));
  assert.equal((await getDetailedProjectStatus(root)).knowledgeCount, 1, "a missing memory index rebuilds lazily");
  await fs.rm(path.join(cache, "session-index.json"));
  assert.equal((await getDetailedProjectStatus(root)).sessionCount, 0, "a missing session index rebuilds lazily");

  await fs.writeFile(path.join(cache, "memory-index.json"), "{invalid");
  await fs.writeFile(path.join(cache, "session-index.json"), "{invalid");
  const invalidTimings = [];
  const recovered = await getDetailedProjectStatus(root, { instrument: (timing) => invalidTimings.push(timing) });
  assert.equal(recovered.knowledgeCount, 1);
  assert.equal(invalidTimings.find((timing) => timing.phase === "memory-index")?.cache, "invalid");
  assert.equal(invalidTimings.find((timing) => timing.phase === "session-index")?.cache, "invalid");
  const rebuiltMemory = await fs.readFile(path.join(cache, "memory-index.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(rebuiltMemory));

  await fs.rm(cache, { recursive: true, force: true });
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, "partial.tmp"), "disposable");
  await getDetailedProjectStatus(root);
  await getDetailedProjectStatus(root);
  assert.deepEqual(await canonicalSnapshot(root), canonicalBefore, "cache recovery must not rewrite canonical project intelligence");
  assert.equal((await fs.readdir(cache)).some((name) => name.includes(".tmp-")), false, "atomic rebuilds leave no temporary cache files");
  assert.match(await fs.readFile(path.join(root, ".gitignore"), "utf8"), /^\.prodero\/\.cache\/$/m);
});

test("prepare, context, and Sync recover when the working-tree cache is absent", async () => {
  const root = await fixture("prodero-cache-lifecycle-");
  const cache = path.join(root, ".prodero", ".cache");
  await fs.rm(cache, { recursive: true, force: true });
  assert.equal((await resolveProjectContext(root, "cache recovery")).required.length, 1);
  await fs.rm(cache, { recursive: true, force: true });
  assert.equal((await syncProject(root)).sessions, 0);
  await fs.rm(cache, { recursive: true, force: true });
  assert.match((await prepareProject(root, { task: "cache recovery", agent: "test" })).session.id, /^sess_/);
});

test("fast status stays readable while detailed status reports canonical corruption", async () => {
  const root = await fixture("prodero-canonical-attention-");
  await fs.writeFile(path.join(root, ".prodero", "config.json"), "{invalid canonical config");
  const fast = await getFastProjectStatus(root);
  assert.equal(fast.initialized, true);
  assert.equal(fast.schemaVersion, null);
  await assert.rejects(getDetailedProjectStatus(root), /JSON|Unexpected|Expected/i);
});

test("derived recovery does not hide corrupted canonical checkpoints", async () => {
  const root = await fixture("prodero-canonical-checkpoint-");
  const checkpoint = path.join(root, ".prodero", "checkpoints", "broken.json");
  await fs.writeFile(checkpoint, "{broken canonical checkpoint");
  await fs.rm(path.join(root, ".prodero", ".cache"), { recursive: true, force: true });
  await assert.rejects(getDetailedProjectStatus(root), /Invalid Prodero checkpoint: broken\.json/);
  assert.equal(await fs.readFile(checkpoint, "utf8"), "{broken canonical checkpoint");
});

test("a fresh real Git worktree supports side-effect-free fast status before explicit detailed status", async () => {
  const root = await fixture("prodero-worktree-source-");
  await exec("git", ["-C", root, "init"]);
  await exec("git", ["-C", root, "config", "user.email", "prodero-test@example.invalid"]);
  await exec("git", ["-C", root, "config", "user.name", "Prodero Test"]);
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-m", "fixture"]);
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-worktree-target-"));
  await fs.rmdir(worktree);
  await exec("git", ["-C", root, "worktree", "add", "--detach", worktree, "HEAD"]);
  const server = createServer({projectRoot:worktree});
  const client = new Client({ name: "prodero-worktree-test", version: "1.0.0" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const cache = path.join(worktree, ".prodero", ".cache");
    await assert.rejects(fs.stat(cache), { code: "ENOENT" });
    const before = (await exec("git", ["-C", worktree, "status", "--short"])).stdout;
    const fast = await client.callTool({ name: PRODERO_TOOLS.status, arguments: { projectRoot: worktree } });
    assert.equal(fast.structuredContent?.project.initialized, true);
    assert.equal(fast.structuredContent?.phase, "initial");
    await assert.rejects(fs.stat(cache), { code: "ENOENT" });
    const details = await client.callTool({ name: PRODERO_TOOLS.statusDetails, arguments: { projectRoot: worktree } });
    assert.equal(details.structuredContent?.project.knowledgeCount, 1);
    assert.equal(details.structuredContent?.phase, "ready");
    assert.equal((await fs.stat(path.join(cache, "memory-index.json"))).isFile(), true);
    assert.equal((await fs.stat(path.join(cache, "session-index.json"))).isFile(), true);
    assert.equal((await exec("git", ["-C", worktree, "status", "--short"])).stdout, before, "derived recovery must not modify tracked canonical state");
    assert.match((await exec("git", ["-C", worktree, "check-ignore", ".prodero/.cache/memory-index.json"])).stdout, /memory-index\.json/);
  } finally {
    await client.close();
    await server.close();
    await exec("git", ["-C", root, "worktree", "remove", "--force", worktree]);
  }
});

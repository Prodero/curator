import { readAgentInstructions } from "./helpers/agent-instructions.mjs";
import {planProjectMigration,applyProjectMigration} from '../dist/core/migrations.js';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoMigrateProject, getProjectStatus, initializeProject, syncProject } from "../dist/core/project.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-test-"));
  await fs.mkdir(path.join(root, ".git"));
  return root;
}

test("initializes the minimal Git-native Prodero structure and preserves AGENTS.md", async () => {
  const root = await fixture();
  const userContent = "# Existing agent rules\n\nKeep this before.\n\n<!-- prodero:start -->\nOld managed text.\n<!-- prodero:end -->\n\nKeep this after.\n";
  await fs.writeFile(path.join(root, "AGENTS.md"), userContent);

  const status = await initializeProject(root);
  assert.equal(status.initialized, true);
  assert.equal(status.schemaVersion, 8);
  assert.equal(status.knowledgeCount, 0);
  assert.equal(status.pendingSessionCount, 0);

  const expected = ["config.json", "index.md", "memory", "local", "sessions", "skills", "checkpoints", ".cache"];
  const entries = await fs.readdir(path.join(root, ".prodero"));
  for (const name of expected) assert.ok(entries.includes(name), `missing ${name}`);

  const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /Keep this before\./);
  assert.match(agents, /Keep this after\./);
  assert.match(agents, /<!-- prodero:start -->/);
  const instructions = await readAgentInstructions(root);
  assert.match(instructions, /When the user says `prodero`/);
  assert.match(instructions, /immediately call prodero_config_get/);
  assert.match(instructions, /If presentation.mode is text, call prodero_text with tool=prodero_open; otherwise call prodero_open/);
  assert.match(instructions, /`open prodero`/);
  assert.match(instructions, /`show prodero`/);
  assert.match(instructions, /prodero_status only for lightweight read-only status/);
  assert.doesNotMatch(instructions, /`\/prodero`/);
  assert.match(instructions, /Do not substitute repository\/docs inspection for a launch/);
  assert.match(instructions, /Only as the last file fallback[\s\S]*never the whole \.prodero directory/);

  const index = await fs.readFile(path.join(root, ".prodero", "index.md"), "utf8");
  assert.match(index, /Compact router/);
  assert.match(index, /Sync produces Git-ignored Local Knowledge/);

  const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.prodero\/\.cache\/$/m);
  assert.match(gitignore, /^\.prodero\/local\/$/m);
  assert.match(gitignore, /^\.prodero\/sessions\/\*$/m);
  assert.match(gitignore, /^!\.prodero\/sessions\/\.gitkeep$/m);
  assert.match(gitignore, /^\.prodero\/checkpoints\/\*$/m);
  assert.match(gitignore, /^!\.prodero\/checkpoints\/\.gitkeep$/m);
  const config = JSON.parse(await fs.readFile(path.join(root, ".prodero", "config.json"), "utf8"));
  assert.equal(config.context.max_tokens, 6_000);
  assert.equal(config.context.max_items, 8);
  assert.equal(config.context.required_max_tokens, 2_000);
});

test("repeated initialization is idempotent", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "AGENTS.md"), "User section.\n");
  await initializeProject(root);
  const beforeAgents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  const beforeConfig = await fs.readFile(path.join(root, ".prodero", "config.json"), "utf8");

  await initializeProject(root);
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), beforeAgents);
  assert.equal(await fs.readFile(path.join(root, ".prodero", "config.json"), "utf8"), beforeConfig);
  assert.match(beforeAgents, /^User section\.$/m);
  assert.equal((beforeAgents.match(/<!-- prodero:start -->/g) ?? []).length, 1);
  assert.equal((beforeAgents.match(/prodero_instructions_read/g) ?? []).length, 1);
  assert.doesNotMatch(beforeAgents, /`\/prodero`/);
});

test("schema migration backs up project data and normalizes legacy memory filenames", async () => {
  const root = await fixture();
  await initializeProject(root);
  const configPath = path.join(root, ".prodero", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.schemaVersion = 1;
  config.knowledgeSchemaVersion = 1;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await fs.writeFile(path.join(root, ".prodero", "memory", "legacy.md"), "---\nid: canonical-legacy\nscope: global\ncategory: decision\npriority: normal\nstatus: active\n---\n\n# Legacy\n\nStill readable.\n");
  const plan = await planProjectMigration(root);
  const result = await applyProjectMigration(root,{approved:true,planId:plan.planId});
  assert.equal(result.migrated, true);
  assert.equal(result.from, 1);
  assert.equal(result.to, 8);
  assert.ok(result.backup);
  assert.equal(await fs.stat(path.join(root, ".prodero", "memory", "canonical-legacy.md")).then(() => true), true);
  assert.equal((await getProjectStatus(root)).schemaVersion, 8);
});

test("sync checkpoints only unsynchronized session content", async () => {
  const root = await fixture();
  await initializeProject(root);
  const sessionPath = path.join(root, ".prodero", "sessions", "session-a.md");
  await fs.writeFile(sessionPath, "# Session A\n\n## Decisions\n\n- Use one boundary.\n");

  assert.equal((await getProjectStatus(root)).pendingSessionCount, 1);

  const first = await syncProject(root);
  assert.equal(first.sessions, 1);
  assert.equal(first.consolidation, "deterministic-v1");
  assert.equal(first.created, 1);
  assert.ok(first.checkpoint);

  const second = await syncProject(root);
  assert.equal(second.checkpoint, null);
  assert.equal(second.sessions, 0);
  assert.equal(second.diagnostics.sessionBodiesConsolidated, 0);

  await fs.appendFile(sessionPath, "\n## Discoveries\n\n- Another observation.\n");
  const third = await syncProject(root);
  assert.equal(third.sessions, 1);
  assert.notEqual(third.checkpoint, first.checkpoint);

  const status = await getProjectStatus(root);
  assert.equal(status.sessionCount, 1);
  assert.equal(status.checkpointCount, 2);
  assert.equal(status.pendingSessionCount, 0);
  assert.ok(status.lastSyncAt);
});

test("dogfooding tracks project intelligence but ignores runtime cache", async t => {
  // Synthetic project: this contract must not depend on developer Knowledge.
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-index-fixture-"));
  t.after(() => fs.rm(repository, { recursive: true, force: true }));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "--quiet", repository]);
  await initializeProject(repository);
  const { writeKnowledge } = await import("../dist/core/memory.js");
  const { buildIndex } = await import("../dist/core/index.js");
  await writeKnowledge(repository, {
    version: 3, id: "mem_synthetic_index", applicability: { kind: "project" },
    scope: "global", scopeRef: null, category: "decision", priority: "normal",
    contextPolicy: "relevant", authority: "inferred", status: "active",
    title: "Prodero memory lifecycle",
    content: "Synthetic router fixture. Session memory is the write path; deterministic Sync.",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    sourceSessions: [], derivedFrom: [], supersedes: [], related: [],
  }, true, "versioned");
  await buildIndex(repository);
  const index = await fs.readFile(path.join(repository, ".prodero", "index.md"), "utf8");
  assert.match(index, /Prodero memory lifecycle/);
  assert.match(index, /memory\/mem_/);
  assert.doesNotMatch(index, /Session memory is the write path; deterministic Sync/);
  const gitignore = await fs.readFile(path.join(repository, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.prodero\/\.cache\/$/m);
  const { stdout } = await import("node:child_process").then(({ execFile }) => new Promise((resolve, reject) => execFile("git", ["-C", repository, "check-ignore", ".prodero/.cache/probe"], (error, stdout) => error ? reject(error) : resolve({ stdout }))));
  assert.match(stdout, /.prodero\/\.cache\/probe/);
});

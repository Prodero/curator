import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function run(...args) {
  const { stdout } = await exec(process.execPath, [cli, ...args]);
  return JSON.parse(stdout);
}

test("CLI initializes, reports status, and syncs in a real temporary Git repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-cli-test-"));
  await exec("git", ["init", "--quiet", root]);
  await fs.writeFile(path.join(root, "AGENTS.md"), "# User instructions\n\nPreserve this.\n");

  const initialized = await run("init", `--root=${root}`);
  assert.equal(initialized.initialized, true);
  const agentsBefore = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  await run("init", `--root=${root}`);
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), agentsBefore);

  const status = await run("status", `--root=${root}`);
  assert.equal(status.version, "0.1.0");
  assert.equal(status.project.initialized, true);

  await fs.writeFile(path.join(root, ".prodero", "sessions", "cli-session.md"), "---\nstatus: closed\n---\n# CLI session\n\n## Lessons\n\n- Keep adapters thin.\n");
  const synced = await run("sync", `--root=${root}`);
  assert.equal(synced.state, "awaiting_selection");
  assert.equal(synced.recovery.sessions, 1);
  assert.equal(synced.recovery.created, 1);
  const fallback = await run("sync-sessions", `--root=${root}`);
  assert.equal(fallback.sessions, 0);
  assert.equal(fallback.consolidation, "deterministic-v1");
});

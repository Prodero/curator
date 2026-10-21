import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PRODERO_VERSION } from "../dist/core/constants.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));


test("CLI initializes, reports status, and syncs in a real temporary Git repository", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-cli-test-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'isolated-home');await fs.mkdir(home);
  const env={...process.env,HOME:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),XDG_STATE_HOME:path.join(home,'.local/state'),PRODERO_RELEASE_SOURCE:'none'};
  const run=async(...args)=>JSON.parse((await exec(process.execPath,[cli,...args],{env})).stdout);
  await exec("git", ["init", "--quiet", root]);
  await fs.writeFile(path.join(root, "AGENTS.md"), "# User instructions\n\nPreserve this.\n");

  const initialized = await run("init", `--root=${root}`);
  assert.equal(initialized.initialized, true);
  const agentsBefore = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  await run("init", `--root=${root}`);
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), agentsBefore);

  const status = await run("status", "--json", `--root=${root}`);
  assert.equal(status.version, PRODERO_VERSION);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageFixture } from './helpers/public-runtime.mjs';

// Normal suite: offline packaged checkout. Opt-in: install public latest exactly once
// into a fresh temporary prefix. Neither mode proves native client connectivity.
const registry = process.env.CURATOR_SETUP_REGISTRY === '1';
const guide = await fs.readFile(new URL('../setup.md', import.meta.url), 'utf8');
const block = name => {
  const section = guide.split(`<!-- curator:${name}:start -->`)[1]?.split(`<!-- curator:${name}:end -->`)[0];
  const body = section?.match(/```sh\n([\s\S]*?)\n```/)?.[1];
  assert.ok(body, `Missing executable guide block: ${name}`);
  return body;
};
async function snapshot(root) {
  const out = {};
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), key = path.relative(root, file);
      if (entry.isDirectory()) { out[key + '/'] = 'directory'; await walk(file); }
      else if (entry.isSymbolicLink()) out[key] = await fs.readlink(file);
      else out[key] = [await fs.readFile(file, 'base64'), (await fs.stat(file)).mtimeMs];
    }
  }
  await walk(root);
  return out;
}
const documents = output => {
  const found = [];
  // CLI emits one pretty JSON document per command. Split only at root boundaries.
  for (const text of output.trim().split(/\n(?=\{)/)) found.push(JSON.parse(text));
  return found;
};
const row = (result, host) => result.status || result.hosts.find(item => item.id === host);

test('apply block preserves failure without shell errexit and never calls status afterward', () => {
  const script = 'curator_cli() { if [ "$1" = install ]; then return 37; fi; printf status-ran; return 0; }\n' + block('apply-host');
  const result = spawnSync('/bin/sh', ['-c', script], { env: { CURATOR_HOST: 'codex' }, encoding: 'utf8' });
  assert.equal(result.status, 37);
  assert.equal(result.stdout, '');
});

test(`guide prompt route (${registry ? 'published npm package' : 'offline packaged fixture'}, not native connectivity)`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curator prompt route '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installHome = path.join(root, 'install home'), prefix = path.join(root, 'npm prefix');
  await fs.mkdir(installHome);
  const npmCli = registry ? process.env.CURATOR_TEST_NPM_CLI : path.join(root, 'npm fixture.cjs');
  assert.ok(npmCli, 'Registry mode requires an inspected CURATOR_TEST_NPM_CLI');
  if (!registry) await fs.writeFile(npmCli, "if(process.argv[2]!=='root') process.exit(91); console.log(process.env.CURATOR_PREFIX+'/lib/node_modules');\n");
  const base = {
    HOME: installHome, PATH: '/usr/bin:/bin', NODE_BIN: process.execPath, NPM_CLI: npmCli,
    CURATOR_PREFIX: prefix, CURATOR_HOST: 'codex',
    npm_config_cache: path.join(root, 'npm cache'), npm_config_userconfig: path.join(root, 'empty npmrc'),
    npm_config_globalconfig: path.join(root, 'empty global npmrc'), npm_config_update_notifier: 'false',
  };
  const run = (names, env = base, cwd = root) => spawnSync('/bin/sh', ['-c', block('runners') + '\n' + names.map(block).join('\n')], { env, cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
  const good = result => { assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr + result.stdout); return result.stdout; };
  let version;
  if (registry) {
    const release = JSON.parse(good(run(['release-metadata'])));
    assert.equal(release.name, '@prodero/curator');
    assert.match(release.version, /^\d+\.\d+\.\d+$/);
    assert.ok(release.engines.node);
    assert.ok(release['dist.integrity'] || release.dist?.integrity);
    version = release.version;
    base.CURATOR_VERSION = version;
    good(run(['pinned-install']));
    t.diagnostic(`Public latest resolved once and installed exactly: ${version}; Node ${process.version}`);
  } else {
    await packageFixture(path.join(prefix, 'lib/node_modules/@prodero/curator'), { full: true });
    version = JSON.parse(await fs.readFile(path.join(prefix, 'lib/node_modules/@prodero/curator/package.json'), 'utf8')).version;
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(prefix, 'lib/node_modules/@prodero/curator/package.json'), 'utf8')).version, version);
  for (const host of ['codex', 'claude']) await t.test(host + ' exact guide blocks preserve scope and reject conflicts', async () => {
    const home = path.join(root, host + ' home'), bin = path.join(home, 'host fixtures'), project = path.join(home, 'project with spaces');
    const codex = path.join(home, 'custom codex'), claude = path.join(home, 'custom claude');
    for (const dir of [home, bin, project, codex, claude]) await fs.mkdir(dir, { recursive: true });
    const marker = path.join(home, 'HOSTILE_COMMAND_EXECUTED');
    await fs.writeFile(path.join(bin, 'prodero'), '#!/bin/sh\nprintf invoked > "$HOME/HOSTILE_COMMAND_EXECUTED"\nexit 99\n', { mode: 0o700 });
    await fs.writeFile(path.join(bin, 'node'), '#!/bin/sh\nprintf invoked > "$HOME/HOSTILE_COMMAND_EXECUTED"\nexit 98\n', { mode: 0o700 });
    // Detection fixture only. This does not launch either real native client.
    await fs.writeFile(path.join(bin, host), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await fs.writeFile(path.join(project, 'AGENTS.md'), 'Project instructions must remain untouched.\n');
    await fs.writeFile(path.join(project, 'CLAUDE.md'), 'Project Claude instructions remain untouched.\n');
    await fs.writeFile(path.join(project, 'package.json'), '{"name":"untouched-project"}\n');
    const config = host === 'codex' ? path.join(codex, 'config.toml') : path.join(claude, '.claude.json');
    const instructions = path.join(host === 'codex' ? codex : claude, host === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
    await fs.writeFile(config, host === 'codex' ? 'model = "keep-me"\n[mcp_servers.other]\ncommand = "other-tool"\n' : JSON.stringify({ personal: 'keep-me', mcpServers: { other: { command: 'other-tool' } } }));
    await fs.writeFile(instructions, 'Keep personal instructions.\n');
    const env = { ...base, HOME: home, PATH: bin + ':/usr/bin:/bin', CURATOR_HOST: host,
      CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, XDG_STATE_HOME: path.join(home, 'private state') };
    const before = await snapshot(home), projectBefore = await snapshot(project);
    const inspect = good(run(['inspect-cli'], env, project));
    assert.ok(inspect.includes(version));
    assert.match(inspect, /--host/); assert.match(inspect, /--dry-run/); assert.match(inspect, /--yes/);
    const preview = JSON.parse(good(run(['preview-host'], env, project)));
    assert.equal(preview.ok, true);
    assert.deepEqual(await snapshot(home), before, 'inspect and dry-run must perform zero writes');
    const applied = documents(good(run(['apply-host'], env, project)));
    assert.equal(applied.length, 2);
    for (const result of applied) { assert.equal(result.ok, true); assert.equal(row(result, host).state, 'installed'); }
    const saved = await fs.readFile(config, 'utf8');
    assert.match(saved, /keep-me/); assert.match(saved, /other-tool/);
    assert.ok(saved.includes(path.dirname(process.execPath)), 'MCP pins the selected Node directory');
    assert.ok(saved.includes(await fs.realpath(prefix)), 'MCP uses exact package prefix despite spaces');
    assert.match(await fs.readFile(instructions, 'utf8'), /Keep personal instructions\./);
    assert.deepEqual(await snapshot(project), projectBefore, 'no project initialization');
    const entry = preview.plan.desired.entry;
    assert.equal(path.isAbsolute(entry.command), true);
    assert.equal(entry.env.PATH.split(':')[0], path.dirname(process.execPath));
    const launch = spawnSync(entry.command, ['--version'], { env: { ...env, ...entry.env }, cwd: project, encoding: 'utf8' });
    assert.equal(launch.status, 0, launch.stderr);
    assert.equal(launch.stdout.trim(), version);
    const installed = await snapshot(home);
    good(run(['preview-host', 'apply-host'], env, project));
    assert.deepEqual(await snapshot(home), installed, 'repeated install is a byte and mtime no-op');
    if (host === 'codex') await fs.writeFile(config, saved.replace(/\[mcp_servers\.prodero\][\s\S]*$/, '[mcp_servers.prodero]\ncommand = "unowned-conflict"\n'));
    else { const value = JSON.parse(saved); value.mcpServers.prodero.command = 'unowned-conflict'; await fs.writeFile(config, JSON.stringify(value)); }
    const conflicted = await snapshot(home);
    for (const name of ['preview-host', 'apply-host']) {
      const result = run([name], env, project);
      assert.notEqual(result.status, 0, 'conflicting registration must fail');
      assert.equal(JSON.parse(result.stdout).ok, false);
      assert.deepEqual(await snapshot(home), conflicted, 'conflict must not mutate files');
    }
    assert.equal(await fs.stat(marker).catch(() => null), null, 'unrelated prodero never executed');
  });
});

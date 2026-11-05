import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packageFixture, curatorCheckout } from './helpers/public-runtime.mjs';
import { parseTargetedInstall, runTargetedInstall } from '../dist/hosts/install-command.js';
import { machineIntegrations } from '../dist/hosts/manager.js';
import { LAUNCHER } from '../dist/hosts/adapters.js';
const exec = promisify(execFile);

async function tree(root) {
  const result = {};
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) result[path.relative(root, target)] = { bytes: (await fs.readFile(target)).toString('base64'), mtime: (await fs.stat(target)).mtimeMs };
    }
  }
  await visit(root); return result;
}
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'curator-prompt-install-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.codex'));
  await fs.writeFile(path.join(home, '.codex/config.toml'), '# unrelated\nmodel="fixture"\n');
  await fs.writeFile(path.join(home, '.claude.json'), '{"unrelated":true}\n');
  await fs.mkdir(path.join(home, 'project'));
  await fs.writeFile(path.join(home, 'project/AGENTS.md'), 'Unrelated project instructions\n');
  await packageFixture(path.join(home, 'package'));
  const env = { HOME: home, PATH: '', CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: '', XDG_STATE_HOME: path.join(home, '.local/state') };
  const options = { home, env, entryPoint: path.join(home, 'package/dist/cli.js') };
  return { home, options, run: (...args) => runTargetedInstall(args, options) };
}

test('targeted install strictly requires one explicit host and one intent', () => {
  for (const args of [[], ['--yes'], ['--host', 'codex'], ['--host', 'codex', '--yes', '--dry-run'], ['--host', 'cursor', '--yes'], ['codex', '--yes'], ['--all', '--yes'], ['--host', 'codex', '--host', 'claude', '--yes'], ['--host', 'codex', '--yes', '--yes'], ['--host', 'codex', '--dry-run', '--json', '--json'], ['--host', 'codex', '--dry-run', '--root', '/tmp'], ['--host', 'codex', '--force']]) assert.throws(() => parseTargetedInstall(args));
  assert.deepEqual(parseTargetedInstall(['--json', '--host', 'claude', '--dry-run']), { host: 'claude', dryRun: true, json: true });
});

for (const host of ['codex', 'claude']) test(`${host}: read-only preview, selected-host apply and unchanged rerun`, async t => {
  const f = await fixture(t), before = await tree(f.home), projectBefore = await tree(path.join(f.home, 'project'));
  const preview = await f.run('--host', host, '--dry-run');
  assert.equal(preview.ok, true); assert.equal(preview.wouldChange, true); assert.equal(preview.changed, false); assert.equal(preview.restartRequired, null);
  assert.equal(preview.plan.operation, 'configure'); assert.deepEqual(preview.plan.desired.entry.args, ['mcp']); assert.match(preview.plan.desired.launcher, /prodero:global-start/);
  assert.deepEqual(await tree(f.home), before);
  const applied = await f.run('--host', host, '--yes');
  assert.equal(applied.ok, true); assert.equal(applied.outcome, 'configured'); assert.equal(applied.restartRequired, true); assert.equal(applied.connectivity, 'not-tested'); assert.equal(Object.hasOwn(applied, 'changed'), false);
  const other = host === 'codex' ? '.claude.json' : '.codex/config.toml';
  assert.deepEqual((await tree(f.home))[other], before[other]);
  assert.deepEqual(await tree(path.join(f.home, 'project')), projectBefore);
  const installed = await tree(f.home);
  const again = await f.run('--host', host, '--yes');
  assert.equal(again.outcome, 'already-configured'); assert.equal(again.changed, false); assert.equal(again.wouldChange, false);
  assert.equal(again.restartRequired, null); assert.match(again.message, /earlier restart or reconnect may still be pending/);
  assert.equal(again.plan.operation, 'preserve');
  assert.deepEqual(await tree(f.home), installed);
});

test('invalid config, unowned entry and pending recovery block preview and apply without writes', async t => {
  const f = await fixture(t), config = path.join(f.home, '.codex/config.toml');
  for (const content of ['broken = [', '[mcp_servers.prodero]\ncommand="custom"\n']) {
    await fs.writeFile(config, content); const before = await tree(f.home);
    for (const intent of ['--dry-run', '--yes']) { const r = await f.run('--host', 'codex', intent); assert.equal(r.ok, false); assert.equal(r.outcome, 'blocked'); assert.equal(r.wouldChange, false); }
    assert.deepEqual(await tree(f.home), before);
  }
  await fs.writeFile(config, '# valid\n');
  const dir = path.join(f.home, '.local/state/prodero/host-integrations/codex'); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'pending.json'), '{}');
  const before = await tree(f.home), r = await f.run('--host', 'codex', '--yes');
  assert.equal(r.status.state, 'recovery-required'); assert.equal(r.ok, false); assert.deepEqual(await tree(f.home), before);
});

test('absent host does not become a successful installation', async t => {
  const f = await fixture(t); await fs.rm(path.join(f.home, '.codex'), { recursive: true });
  const before = await tree(f.home);
  for (const intent of ['--dry-run', '--yes']) { const r = await f.run('--host', 'codex', intent); assert.equal(r.ok, false); assert.equal(r.status.state, 'not-detected'); }
  assert.deepEqual(await tree(f.home), before);
});

test('manual dev integration stays a no-op and managed dev is preserved', async t => {
  const f = await fixture(t), config = path.join(f.home, '.codex/config.toml');
  await fs.writeFile(config, '[mcp_servers.prodero-dev]\ncommand="custom"\n'); await fs.writeFile(path.join(f.home, '.codex/AGENTS.md'), LAUNCHER);
  const before = await tree(f.home), manual = await f.run('--host', 'codex', '--yes');
  assert.equal(manual.ok, true); assert.equal(manual.outcome, 'already-configured'); assert.equal(manual.status.state, 'externally-configured'); assert.deepEqual(await tree(f.home), before);
  assert.equal(manual.plan.operation, 'preserve'); assert.equal(manual.plan.desired, null); assert.equal(manual.restartRequired, null);
  await fs.writeFile(config, '# valid\n'); await fs.rm(path.join(f.home, '.codex/AGENTS.md')); await machineIntegrations('install', 'codex', f.options);
  const receiptPath = path.join(f.home, '.local/state/prodero/host-integrations/codex/receipt.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')), packageEntry = receipt.entry;
  receipt.format = 2; receipt.entry = { ...packageEntry, args: ['mcp', '--dev'] }; receipt.runtime = { mode: 'dev', packageEntry, devRoot: path.join(f.home, 'checkout'), devEntry: receipt.entry };
  receipt.installedConfig = receipt.installedConfig.replace('args = ["mcp"]', 'args = ["mcp","--dev"]'); receipt.mcpBlock = receipt.mcpBlock.replace('args = ["mcp"]', 'args = ["mcp","--dev"]');
  await fs.writeFile(config, receipt.installedConfig); await fs.writeFile(receiptPath, JSON.stringify(receipt));
  const devBefore = await tree(f.home), dev = await f.run('--host', 'codex', '--yes');
  assert.equal(dev.ok, true); assert.equal(dev.status.runtimeMode, 'dev'); assert.equal(dev.changed, false); assert.deepEqual(await tree(f.home), devBefore);
  assert.deepEqual(dev.plan.desired.entry.args, ['mcp', '--dev']); assert.equal(dev.restartRequired, null);
});

test('CLI emits exactly one JSON error and feature help while preserving settings', async t => {
  const f = await fixture(t), cli = path.join(curatorCheckout, 'dist/cli.js');
  const env = { ...process.env, ...f.options.env };
  const before = await tree(f.home);
  for (const args of [['--host', 'codex', '--json'], ['--host', 'cursor', '--yes', '--json'], ['--all', '--yes', '--json'], ['--host', 'codex', '--yes', '--json']]) {
    await assert.rejects(exec(process.execPath, [cli, 'install', ...args], { env, cwd: path.join(f.home, 'project') }), error => {
      assert.equal(error.code, 1); assert.equal(error.stderr, ''); assert.equal(JSON.parse(error.stdout).ok, false); return true;
    });
  }
  const help = await exec(process.execPath, [cli, 'install', '--help'], { env }); assert.match(help.stdout, /--host <codex\|claude> --dry-run/);
  assert.deepEqual(await tree(f.home), before);
});

test('packaged CLI runs JSON preview, apply, no-op and conflict in isolated HOME', async t => {
  const f = await fixture(t), packageRoot = path.join(f.home, 'package');
  await fs.cp(path.join(curatorCheckout, 'dist'), path.join(packageRoot, 'dist'), { recursive: true });
  await fs.copyFile(path.join(curatorCheckout, 'prodero.release.json'), path.join(packageRoot, 'prodero.release.json'));
  await fs.symlink(path.join(curatorCheckout, 'node_modules'), path.join(packageRoot, 'node_modules'), 'dir');
  const command = path.join(packageRoot, 'bin/prodero'), env = { ...process.env, ...f.options.env };
  const invoke = async intent => {
    const result = await exec(process.execPath, [command, 'install', '--host', 'codex', intent, '--json'], { env, cwd: path.join(f.home, 'project') });
    assert.equal(result.stderr, ''); return JSON.parse(result.stdout);
  };
  const before = await tree(f.home), projectBefore = await tree(path.join(f.home, 'project'));
  assert.equal((await invoke('--dry-run')).wouldChange, true); assert.deepEqual(await tree(f.home), before);
  assert.equal((await invoke('--yes')).outcome, 'configured');
  const installed = await tree(f.home);
  assert.equal((await invoke('--yes')).outcome, 'already-configured'); assert.deepEqual(await tree(f.home), installed);
  assert.deepEqual(await tree(path.join(f.home, 'project')), projectBefore);
  await fs.writeFile(path.join(f.home, '.codex/config.toml'), '[mcp_servers.prodero]\ncommand="custom"\n');
  const conflicted = await tree(f.home);
  await assert.rejects(invoke('--yes'), error => { assert.equal(error.code, 1); const result = JSON.parse(error.stdout); assert.equal(result.outcome, 'blocked'); assert.equal(result.status.state, 'conflicted'); return true; });
  assert.deepEqual(await tree(f.home), conflicted);
});

import {packageFixture} from './helpers/public-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as toml } from 'smol-toml';
import { machineIntegrations } from '../dist/hosts/manager.js';
import { switchRuntime } from '../dist/hosts/runtime.js';
import { runInstallWizard } from '../dist/hosts/wizard.js';
import { LAUNCHER } from '../dist/hosts/adapters.js';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-runtime-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  async function write(relative, text) { const file = path.join(home, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
  await packageFixture(path.join(home,'package'));
  await write('package/dist/cli.js', '// packaged fixture');
  await write('package/dist/hosts/runtime.js', '// runtime switching support');
  await write('checkout/package.json', JSON.stringify({ name: '@prodero/cli', scripts: { 'mcp:dev': 'node --import tsx scripts/mcp-dev.ts' } }));
  for (const file of ['src/cli.ts', 'scripts/mcp-dev.ts', 'scripts/mcp-dev-launcher.mjs', 'node_modules/tsx/package.json']) await write('checkout/' + file, '{}');
  await write('bin/npm-cli.js', '// npm fixture');
  await fs.symlink('npm-cli.js', path.join(home, 'bin/npm'));
  await write('.codex/config.toml', '# User settings\nmodel = "fixture"\n');
  await write('.claude.json', '{ "custom": true }\n');
  const env = { HOME: home, PATH: path.join(home, 'bin') };
  const options = { home, env, entryPoint: path.join(home, 'package/dist/cli.js'), workspace: home };
  return { home, write, options, checkout: path.join(home, 'checkout'), packageRoot: path.join(home, 'package'),
    config: host => path.join(home, host === 'codex' ? '.codex/config.toml' : '.claude.json'),
    launcher: host => path.join(home, host === 'codex' ? '.codex/AGENTS.md' : '.claude/CLAUDE.md'),
    receipt: host => path.join(home, '.local/state/prodero/host-integrations', host, 'receipt.json'),
    install: host => machineIntegrations('install', host, options),
    status: host => machineIntegrations('status', host, options),
  };
}
async function bytes(file) { return fs.readFile(file, 'utf8'); }
async function snapshot(root) {
  const result = {};
  async function visit(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name), key = path.relative(root, file);
      if (item.isDirectory()) await visit(file);
      else result[key] = item.isSymbolicLink() ? await fs.readlink(file) : await bytes(file);
    }
  }
  await visit(root); return result;
}
// Receipts are JSON values; TOML tables may have null prototypes (smol-toml 1.9).
const jsonValue = value => JSON.parse(JSON.stringify(value));
const entry = (host, text) => host === 'codex' ? toml(text).mcp_servers?.prodero : JSON.parse(text).mcpServers?.prodero;

for (const host of ['codex', 'claude']) {
  test(`${host}: package → dev → package, idempotency, legacy receipt and host isolation`, async t => {
    const f = await fixture(t), other = host === 'codex' ? 'claude' : 'codex';
    await f.install(host); await f.install(other);
    const otherBefore = await Promise.all([f.config(other), f.launcher(other), f.receipt(other)].map(bytes));
    const legacy = JSON.parse(await bytes(f.receipt(host)));
    assert.equal(legacy.format, 1);
    const previewBefore = await snapshot(f.home);
    const preview = await switchRuntime(host, 'dev', { ...f.options, checkout: f.checkout, dryRun: true });
    assert.equal(preview.changed, true); assert.deepEqual(await snapshot(f.home), previewBefore);
    await switchRuntime(host, 'dev', { ...f.options, checkout: f.checkout });
    const devReceipt = JSON.parse(await bytes(f.receipt(host)));
    assert.equal(devReceipt.format, 2); assert.equal(devReceipt.runtime.mode, 'dev');
    assert.equal(devReceipt.originalConfig, legacy.originalConfig);
    assert.deepEqual(devReceipt.entry, jsonValue(entry(host, await bytes(f.config(host)))));
    assert.deepEqual(devReceipt.entry.args, ['mcp','--dev']);
    assert.equal((await f.status(host)).hosts[0].state, 'installed');
    assert.equal((await f.status(host)).hosts[0].runtimeMode, 'dev');
    const before = await snapshot(f.home);
    assert.equal((await switchRuntime(host, 'dev', f.options)).changed, false);
    await f.install(host); // An ordinary reinstall must not silently leave development mode.
    assert.deepEqual(await snapshot(f.home), before);
    let wizard = '';
    await runInstallWizard({ interactive: false, write: s => { wizard += s; }, question: async () => null }, f.options);
    assert.match(wizard, /Installed · dev/);
    await switchRuntime(host, 'package', f.options);
    assert.deepEqual(jsonValue(entry(host, await bytes(f.config(host)))), legacy.entry);
    assert.equal((await f.status(host)).hosts[0].runtimeMode, 'package');
    await switchRuntime(host,'dev',f.options);
    assert.equal(JSON.parse(await bytes(f.receipt(host))).runtime.devRoot,await fs.realpath(f.checkout));
    assert.deepEqual(entry(host,await bytes(f.config(host))).args,['mcp','--dev']);
    assert.deepEqual(await Promise.all([f.config(other), f.launcher(other), f.receipt(other)].map(bytes)), otherBefore);
    await machineIntegrations('uninstall', host, f.options);
    assert.equal(await bytes(f.config(host)), legacy.originalConfig);
  });

  test(`${host}: explicit manual dev migration preserves originals and unrelated settings`, async t => {
    const f = await fixture(t);
    const original = host === 'codex'
      ? '# keep\n[mcp_servers.prodero-dev]\ncommand = "npm"\nargs = ["run", "mcp:dev"]\n[mcp_servers.other]\ncommand = "other"\n'
      : '{ "custom": true, "mcpServers": {"prodero-dev":{"command":"npm","args":["run","mcp:dev"]},"other":{"command":"other"}} }\n';
    await fs.writeFile(f.config(host), original);
    await fs.mkdir(path.dirname(f.launcher(host)), { recursive: true });
    await fs.writeFile(f.launcher(host), LAUNCHER + '\nUser instructions\n');
    const options = { ...f.options, packageRoot: f.packageRoot, checkout: f.checkout };
    const before = await snapshot(f.home);
    assert.equal((await switchRuntime(host, 'dev', { ...options, dryRun: true })).migration, true);
    await assert.rejects(switchRuntime(host, 'dev', options), /HOST_ADOPTION_REQUIRED/);
    assert.deepEqual(await snapshot(f.home), before);
    await switchRuntime(host, 'dev', { ...options, adoptDev: true });
    const config = await bytes(f.config(host));
    assert.doesNotMatch(config, /prodero-dev/); assert.match(config, /other/);
    assert.match(await bytes(f.launcher(host)), /User instructions/);
    await switchRuntime(host, 'package', f.options);
    assert.equal((await f.status(host)).ok, true);
    await machineIntegrations('uninstall', host, f.options);
    assert.equal(await bytes(f.config(host)), original);
    assert.equal(await bytes(f.launcher(host)), LAUNCHER + '\nUser instructions\n');
  });

  test(`${host}: edited ownership and recovery state cannot be bypassed`, async t => {
    const f = await fixture(t); await f.install(host);
    await fs.writeFile(f.launcher(host), LAUNCHER.replace('immediately', 'never'));
    let before = await snapshot(f.home);
    await assert.rejects(switchRuntime(host, 'dev', { ...f.options, checkout: f.checkout, adoptDev: true }), /HOST_CONFLICT/);
    assert.deepEqual(await snapshot(f.home), before);
    await fs.writeFile(f.launcher(host), LAUNCHER + '\n');
    await f.write(`.local/state/prodero/host-integrations/${host}/pending.json`, '{}');
    before = await snapshot(f.home);
    await assert.rejects(switchRuntime(host, 'dev', { ...f.options, checkout: f.checkout }), /HOST_RECOVERY_REQUIRED/);
    assert.deepEqual(await snapshot(f.home), before);
  });

  test(`${host}: workspace override blocks a misleading global switch`, async t => {
    const f = await fixture(t); await f.install(host);
    await f.write(host === 'codex' ? 'project/.codex/config.toml' : 'project/.mcp.json', host === 'codex' ? '[mcp_servers.prodero]\ncommand="custom"' : '{"mcpServers":{"prodero":{"command":"custom"}}}');
    const before = await snapshot(f.home);
    await assert.rejects(switchRuntime(host, 'dev', { ...f.options, checkout: f.checkout, workspace: path.join(f.home, 'project') }), /HOST_SCOPE_CONFLICT/);
    assert.deepEqual(await snapshot(f.home), before);
  });
}

test('missing runtime and invalid selectors fail before writing', async t => {
  const f = await fixture(t); await f.install('codex');
  const before = await snapshot(f.home);
  for (const [host, mode, extra, error] of [
    ['all', 'dev', {}, /HOST_UNKNOWN/], ['codex', 'other', {}, /HOST_RUNTIME_MODE/],
    ['codex', 'dev', { checkout: 'relative' }, /HOST_UNSUPPORTED_PATH/],
    ['codex', 'dev', {}, /HOST_RUNTIME_MISSING/],
    ['codex', 'package', { packageRoot: f.checkout }, /HOST_RUNTIME_MISSING|HOST_UNPACKAGED_RUNTIME/],
    ['codex', 'dev', { checkout: f.packageRoot }, /HOST_RUNTIME_MISSING/],
  ]) await assert.rejects(switchRuntime(host, mode, { ...f.options, ...extra }), error);
  assert.deepEqual(await snapshot(f.home), before);
});

test('package removal leaves dev mode intact; explicit new package root repairs the target', async t => {
  const f = await fixture(t); await f.install('codex');
  await switchRuntime('codex', 'dev', { ...f.options, checkout: f.checkout });
  await fs.rename(f.packageRoot, path.join(f.home, 'replacement'));
  const before = await snapshot(f.home);
  await assert.rejects(switchRuntime('codex', 'package', f.options), /HOST_RUNTIME_MISSING/);
  assert.deepEqual(await snapshot(f.home), before);
  await switchRuntime('codex', 'package', { ...f.options, packageRoot: path.join(f.home, 'replacement') });
  assert.match(entry('codex', await bytes(f.config('codex'))).command, /replacement/);
});

test('runtime switching does not inspect or validate the other host override', async t => {
  const f = await fixture(t); await f.install('codex');
  await switchRuntime('codex', 'dev', { ...f.options, env: { ...f.options.env, CLAUDE_CONFIG_DIR: 'invalid-relative' }, checkout: f.checkout });
  assert.equal((await f.status('codex')).hosts[0].runtimeMode, 'dev');
});

test('failed receipt write rolls back the config and preserves the original receipt', async t => {
  const f = await fixture(t); await f.install('codex');
  const config = await bytes(f.config('codex')), receipt = await bytes(f.receipt('codex'));
  const rename = fs.rename;
  let failed = false;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === f.receipt('codex') && !failed) { failed = true; throw new Error('fixture write failure'); }
    return rename(from, to);
  });
  await assert.rejects(switchRuntime('codex', 'dev', { ...f.options, checkout: f.checkout }), /fixture write failure/);
  mock.mock.restore();
  assert.equal(await bytes(f.config('codex')), config);
  assert.equal(await bytes(f.receipt('codex')), receipt);
  assert.equal(await fs.stat(path.join(path.dirname(f.receipt('codex')), 'pending.json')).catch(() => null), null);
  assert.equal((await f.status('codex')).hosts[0].state, 'installed');
});

test('packages predating runtime receipts cannot be selected', async t => {
  const f = await fixture(t); await f.install('codex');
  await fs.rm(path.join(f.packageRoot, 'dist/hosts/runtime.js'));
  const before = await snapshot(f.home);
  await assert.rejects(switchRuntime('codex', 'dev', { ...f.options, checkout: f.checkout }), /HOST_RUNTIME_UNSUPPORTED/);
  assert.deepEqual(await snapshot(f.home), before);
});

test('a disabled Codex dev alias remains disabled during managed switching', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.config('codex'), '\n[mcp_servers.prodero-dev]\ncommand="npm"\nenabled=false\n');
  await f.install('codex');
  await switchRuntime('codex', 'dev', { ...f.options, checkout: f.checkout });
  assert.equal(toml(await bytes(f.config('codex'))).mcp_servers['prodero-dev'].enabled, false);
  assert.equal((await f.status('codex')).hosts[0].runtimeMode, 'dev');
});

test('checkout paths with spaces remain a single argument and missing workspaces are rejected', async t => {
  const f = await fixture(t); await f.install('codex');
  const checkout = path.join(f.home, 'development checkout');
  await fs.rename(f.checkout, checkout);
  const before = await snapshot(f.home);
  await assert.rejects(switchRuntime('codex', 'dev', { ...f.options, checkout, workspace: path.join(f.home, 'missing') }), /HOST_SCOPE_CONFLICT/);
  assert.deepEqual(await snapshot(f.home), before);
  await switchRuntime('codex', 'dev', { ...f.options, checkout });
  assert.deepEqual(entry('codex', await bytes(f.config('codex'))).args, ['mcp','--dev']);
  assert.equal(JSON.parse(await bytes(f.receipt('codex'))).runtime.devRoot, await fs.realpath(checkout));
});

test('CLI requires one explicit host, previews and switches without JSON', async t => {
  const f = await fixture(t); await f.install('codex');
  const run = args => promisify(execFile)(process.execPath, [path.resolve('dist/cli.js'), 'runtime', ...args], { cwd: f.home, env: { ...process.env, ...f.options.env, CODEX_HOME: path.join(f.home, '.codex'), XDG_STATE_HOME: path.join(f.home, '.local/state') } });
  for (const args of [['dev'], ['dev', '--host', 'all'], ['dev', '--host', 'codex', '--host', 'claude'], ['package', '--host', 'codex', '--checkout', f.checkout]]) await assert.rejects(run(args));
  const before = await snapshot(f.home);
  const preview = await run(['dev', '--host', 'codex', '--checkout', f.checkout, '--dry-run']);
  assert.match(preview.stdout, /No files changed/); assert.doesNotMatch(preview.stdout, /"ok"/);
  assert.deepEqual(await snapshot(f.home), before);
  assert.match((await run(['dev', '--host', 'codex', '--checkout', f.checkout])).stdout, /Configured: package → dev/);
});

for (const host of ['codex', 'claude']) test(`${host}: reinstall upgrades only the receipt-owned npm dev launcher and preserves uninstall originals`, async t => {
  const f=await fixture(t);await f.install(host);await switchRuntime(host,'dev',{...f.options,checkout:f.checkout});
  const receipt=JSON.parse(await bytes(f.receipt(host))),originalConfig=receipt.originalConfig;
  const legacy={...receipt.entry,command:process.execPath,args:[await fs.realpath(path.join(f.home,'bin/npm-cli.js')),'--prefix',receipt.runtime.devRoot,'run','--silent','mcp:dev']};
  const current=await bytes(f.config(host));
  const replacement=host==='codex'
    ? current.replace('command = '+JSON.stringify(receipt.entry.command),'command = '+JSON.stringify(legacy.command)).replace('args = '+JSON.stringify(receipt.entry.args),'args = '+JSON.stringify(legacy.args))
    : JSON.stringify({...JSON.parse(current),mcpServers:{...JSON.parse(current).mcpServers,prodero:legacy}},null,2)+'\n';
  receipt.entry=legacy;receipt.runtime.devEntry=legacy;receipt.installedConfig=replacement;
  if(host==='codex')receipt.mcpBlock=replacement.slice(replacement.indexOf('# prodero:mcp-start'),replacement.indexOf('# prodero:mcp-end')+'# prodero:mcp-end'.length);
  await fs.writeFile(f.config(host),replacement);await fs.writeFile(f.receipt(host),JSON.stringify(receipt,null,2)+'\n');
  assert.equal((await f.status(host)).hosts[0].state,'outdated');
  assert.equal((await f.install(host)).ok,true);
  const updated=JSON.parse(await bytes(f.receipt(host)));
  assert.equal(updated.runtime.mode,'dev');assert.deepEqual(updated.entry,updated.runtime.devEntry);
  assert.deepEqual(updated.entry.args,['mcp','--dev']);
  const after=await snapshot(f.home);await f.install(host);assert.deepEqual(await snapshot(f.home),after);
  await machineIntegrations('uninstall',host,f.options);assert.equal(await bytes(f.config(host)),originalConfig);
});

test('Codex manual dev with a native env child table migrates atomically and restores exact originals', async t => {
  const f=await fixture(t);
  const original='# keep\n[mcp_servers.prodero-dev]\ncommand="npm"\nargs=["run","mcp:dev"]\n\n[mcp_servers.prodero-dev.env]\nPRODERO_DEBUG_PRESENTATION="1"\nPRODERO_DEBUG_PRESENTATION_FILE="/tmp/synthetic-prodero-trace.log"\n\n[mcp_servers.other]\ncommand="keep-other"\n';
  await fs.writeFile(f.config('codex'),original);
  await fs.mkdir(path.dirname(f.launcher('codex')),{recursive:true});
  await fs.writeFile(f.launcher('codex'),LAUNCHER+'\n');
  const options={...f.options,checkout:f.checkout,packageRoot:f.packageRoot};
  const before=await snapshot(f.home);
  assert.equal((await switchRuntime('codex','dev',{...options,dryRun:true})).migration,true);
  assert.deepEqual(await snapshot(f.home),before);
  await switchRuntime('codex','dev',{...options,adoptDev:true});
  const config=toml(await bytes(f.config('codex')));
  assert.equal(config.mcp_servers['prodero-dev'],undefined);
  assert.deepEqual(jsonValue(config.mcp_servers.other),{command:'keep-other'});
  assert.deepEqual(config.mcp_servers.prodero.args,['mcp','--dev']);
  const receipt=JSON.parse(await bytes(f.receipt('codex')));
  assert.equal(receipt.originalConfig,original);
  assert.equal((await switchRuntime('codex','dev',options)).changed,false);
  await machineIntegrations('uninstall','codex',f.options);
  assert.equal(await bytes(f.config('codex')),original);
});

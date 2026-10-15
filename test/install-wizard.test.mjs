import {packageFixture} from './helpers/public-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { runInstallWizard } from '../dist/hosts/wizard.js';
import { machineIntegrations } from '../dist/hosts/manager.js';
import { LAUNCHER } from '../dist/hosts/adapters.js';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-wizard-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.codex'));
  await fs.writeFile(path.join(home, '.codex/config.toml'), '# Personal settings\n');
  await fs.writeFile(path.join(home, '.claude.json'), '{}\n');
  await packageFixture(path.join(home,'package'));
  const options = { home, env: { HOME: home, PATH: '' }, entryPoint: path.join(home,'package/dist/cli.js') };
  const run = async (answers, interactive = true, onQuestion) => {
    let output = '', questions = 0;
    const code = await runInstallWizard({ interactive, write: text => { output += text; }, question: async prompt => {
      questions++; await onQuestion?.(prompt, questions);
      assert.ok(answers.length, `Unexpected question: ${prompt}`);
      return answers.shift();
    } }, options);
    return { code, output, questions };
  };
  return { home, options, run };
}

test('wizard chooses only the requested agent, confirms, and shows installed state', async t => {
  const f = await fixture(t);
  const result = await f.run(['1', 'y', '0']);
  assert.equal(result.code, 0);
  assert.match(result.output, /Codex\s+Installed/);
  assert.match(result.output, /Restart Codex/);
  assert.match(result.output, /Claude Code\s+Not configured/);
  assert.equal(await fs.readFile(path.join(f.home, '.claude.json'), 'utf8'), '{}\n');
  assert.ok(await fs.stat(path.join(f.home, '.local/state/prodero/host-integrations/codex/receipt.json')));
  const before = await fs.readFile(path.join(f.home, '.codex/config.toml'), 'utf8');
  const again = await f.run(['1', 'yes']);
  assert.equal(again.code, 0);
  assert.match(again.output, /Claude Code\s+Installed/);
  assert.equal(await fs.readFile(path.join(f.home, '.codex/config.toml'), 'utf8'), before);
});

test('invalid selection, declined confirmation, empty selection and EOF never install', async t => {
  const f = await fixture(t);
  for (const answers of [['99', '1x', '1', '', ''], [null], ['1', null]]) {
    const result = await f.run(answers);
    assert.equal(result.code, 0);
    assert.equal(await fs.stat(path.join(f.home, '.local')).catch(() => null), null);
    assert.equal(await fs.readFile(path.join(f.home, '.codex/config.toml'), 'utf8'), '# Personal settings\n');
  }
});

test('noninteractive wizard shows readable status without prompting or writes', async t => {
  const f = await fixture(t);
  const result = await f.run([], false);
  assert.equal(result.code, 1);
  assert.equal(result.questions, 0);
  assert.match(result.output, /interactive terminal/);
  assert.doesNotMatch(result.output, /"ok"|"hosts"/);
  assert.equal(await fs.stat(path.join(f.home, '.local')).catch(() => null), null);
});

test('wizard reports conflicts and still allows installing another agent', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.home, '.codex/AGENTS.md'), LAUNCHER);
  const result = await f.run(['1', 'y']);
  assert.equal(result.code, 1);
  assert.match(result.output, /Configuration needs review/);
  assert.match(result.output, /\.codex\/AGENTS.md/);
  assert.match(result.output, /Prodero is installed for Claude Code/);
  assert.equal(await fs.readFile(path.join(f.home, '.codex/AGENTS.md'), 'utf8'), LAUNCHER);
});

test('configuration changed while confirming is rechecked and not overwritten', async t => {
  const f = await fixture(t);
  const changed = '[mcp_servers.prodero]\ncommand = "custom"\n';
  const result = await f.run(['1', 'y'], true, async (_, n) => {
    if (n === 2) await fs.writeFile(path.join(f.home, '.codex/config.toml'), changed);
  });
  assert.equal(result.code, 1);
  assert.equal(await fs.readFile(path.join(f.home, '.codex/config.toml'), 'utf8'), changed);
  assert.equal(await fs.stat(path.join(f.home, '.local')).catch(() => null), null);
});

test('wizard offers updates for managed integrations', async t => {
  const f = await fixture(t);
  await packageFixture(path.join(f.home,'old'));
  await machineIntegrations('install', 'codex', { ...f.options, entryPoint: path.join(f.home,'old/dist/cli.js') });
  const result = await f.run(['1', 'y', '0']);
  assert.equal(result.code, 0);
  assert.match(result.output, /Update Codex/);
  assert.ok((await fs.readFile(path.join(f.home, '.codex/config.toml'), 'utf8')).includes(path.join(f.home,'package/bin/prodero')));
});

test('prodero-dev is recognized without ownership or duplicate installation', async t => {
  const f = await fixture(t);
  const config = '[mcp_servers.prodero-dev]\ncommand = "npm"\nargs = ["run", "mcp:dev"]\n';
  await fs.writeFile(path.join(f.home, '.codex/config.toml'), config);
  await fs.writeFile(path.join(f.home, '.codex/AGENTS.md'), LAUNCHER);
  const result = await f.run(['0']);
  assert.match(result.output, /Already configured \(prodero-dev, manual\)/);
  assert.doesNotMatch(result.output, /Install for Codex/);
  assert.equal((await machineIntegrations('install', 'codex', f.options)).hosts[0].state, 'externally-configured');
  assert.equal(await fs.readFile(path.join(f.home, '.codex/config.toml'), 'utf8'), config);
  assert.equal(await fs.stat(path.join(f.home, '.local')).catch(() => null), null);
  await fs.rm(path.join(f.home, '.codex/AGENTS.md'));
  const incomplete = await machineIntegrations('install', 'codex', f.options);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.hosts[0].state, 'external-incomplete');
});

test('disabled dev server permits installation; enabling it detects duplicate servers', async t => {
  const f = await fixture(t);
  const configPath = path.join(f.home, '.codex/config.toml');
  await fs.writeFile(configPath, '[mcp_servers.prodero-dev]\nenabled = false\ncommand = "npm"\n');
  assert.equal((await machineIntegrations('install', 'codex', f.options)).ok, true);
  const text = await fs.readFile(configPath, 'utf8');
  await fs.writeFile(configPath, text.replace('enabled = false', 'enabled = true'));
  assert.equal((await machineIntegrations('install', 'codex', f.options)).hosts[0].state, 'conflicted');
  assert.equal(await fs.readFile(configPath, 'utf8'), text.replace('enabled = false', 'enabled = true'));
  assert.equal((await machineIntegrations('uninstall', 'codex', f.options)).ok, true);
});

test('CLI rejects removed install selectors and fails safely without a terminal', async t => {
  const f = await fixture(t);
  const cli = path.resolve('dist/cli.js');
  const env = { ...process.env, HOME: f.home, CODEX_HOME: path.join(f.home, '.codex'), CLAUDE_CONFIG_DIR: '', XDG_STATE_HOME: path.join(f.home, '.local/state') };
  for (const args of [['install', 'codex'], ['install', '--all'], ['install']]) {
    await assert.rejects(promisify(execFile)(process.execPath, [cli, ...args], { env }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout + error.stderr, /interactive (wizard|terminal)/);
      return true;
    });
  }
  assert.equal(await fs.stat(path.join(f.home, '.local')).catch(() => null), null);
});

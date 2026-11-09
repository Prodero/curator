import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publishedDocs, renderHostedGuide } from '../scripts/sync-setup-guide.mjs';

const guide = await fs.readFile(new URL('../setup.md', import.meta.url), 'utf8');
const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
const script = fileURLToPath(new URL('../scripts/sync-setup-guide.mjs', import.meta.url));
const snippet = name => {
  const body = guide.match(new RegExp(`<!-- curator:${name}:start -->\\s*\`\`\`sh\\n([\\s\\S]*?)\\n\`\`\`\\s*<!-- curator:${name}:end -->`))?.[1];
  assert.ok(body, `Guide must contain its ${name} command`);
  return body;
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curator-latest-guide-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('new-install examples follow latest without a release-number edit', () => {
  for (const document of [guide, readme]) {
    assert.match(document, /npm install --global @prodero\/curator@latest/);
    assert.doesNotMatch(document, /npm install[^\n]*@prodero\/curator@\d/);
  }
  assert.match(guide, /exact stable SemVer version/);
  assert.match(guide, /metadata is unavailable, invalid or points to a prerelease/);
  assert.match(guide, /does not authorize an upgrade, downgrade, runtime switch or relocation/);
  assert.match(guide, /installed package\/CLI version equals `CURATOR_VERSION`/);
  assert.match(guide, /A mismatch blocks configuration/);
});

test('metadata lookup uses the public latest tag; installation uses only the reviewed exact version', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const env = { PATH: root, HOME: root, CURATOR_VERSION: '42.17.9' };
  const run = (name, environment = env) => spawnSync('/bin/sh', ['-c', snippet(name)], { env: environment, encoding: 'utf8' });
  const metadata = run('release-metadata');
  assert.equal(metadata.status, 0, metadata.stderr);
  const fields = metadata.stdout.trim().split('\n');
  assert.equal(fields[0], 'view');
  for (const field of ['--registry=https://registry.npmjs.org/', '@prodero/curator@latest', 'name', 'version', 'engines', 'dist.integrity', '--json']) assert.ok(fields.includes(field));
  const install = run('pinned-install');
  assert.equal(install.status, 0, install.stderr);
  const args = install.stdout.trim().split('\n');
  assert.equal(args[0], 'install');
  for (const arg of ['--global', '--registry=https://registry.npmjs.org/', '--engine-strict', '--omit=dev', '--ignore-scripts', '@prodero/curator@42.17.9']) assert.ok(args.includes(arg));
  assert.doesNotMatch(install.stdout, /latest/);
  const unset = run('pinned-install', { PATH: root, HOME: root });
  assert.notEqual(unset.status, 0);
  assert.equal(unset.stdout, '', 'Missing approval target must not invoke npm');
});

test('hosted guide preserves source except for stable published-package documentation links', () => {
  const rendered = renderHostedGuide(guide);
  assert.equal(rendered.split(publishedDocs).join(''), guide);
  assert.doesNotMatch(rendered, /\]\(docs\//);
  assert.match(rendered, /@latest\/docs\/COMPATIBILITY\.md#hosts/);
  assert.equal(renderHostedGuide(rendered), rendered);
  assert.equal(renderHostedGuide('[External](https://example.com/docs/x.md)\n[Anchor](#install)'), '[External](https://example.com/docs/x.md)\n[Anchor](#install)');
});

test('sync check detects drift without writing; sync is idempotent and refuses source/symlinks', async t => {
  const root = await fixture(t), destination = path.join(root, 'setup.md');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.notEqual(run('--check', destination).status, 0);
  assert.equal(await fs.stat(destination).catch(() => null), null);
  assert.equal(run(destination).status, 0);
  assert.equal(await fs.readFile(destination, 'utf8'), renderHostedGuide(guide));
  const before = (await fs.stat(destination)).mtimeMs;
  assert.equal(run('--check', destination).status, 0);
  assert.equal(run(destination).status, 0);
  assert.equal((await fs.stat(destination)).mtimeMs, before);
  await fs.writeFile(destination, 'drift');
  assert.notEqual(run('--check', destination).status, 0);
  assert.equal(await fs.readFile(destination, 'utf8'), 'drift');
  assert.notEqual(run(fileURLToPath(new URL('../setup.md', import.meta.url))).status, 0);
  const link = path.join(root, 'linked.md');
  await fs.symlink(destination, link);
  assert.notEqual(run(link).status, 0);
  assert.equal(await fs.readFile(destination, 'utf8'), 'drift');
});

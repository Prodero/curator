import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverTests, partitionTests } from '../scripts/run-tests.mjs';
import { needsIntegration, gateMode } from '../scripts/ci-policy.mjs';
import { validatePackage } from '../scripts/validate-package.mjs';

test('test partition is exhaustive and disjoint; new unknown suites default to ordinary', async t => {
  const all = await discoverTests();
  const { ordinary, scale } = partitionTests(all);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual([...ordinary, ...scale].sort(), all);
  assert.equal(ordinary.some(file => scale.includes(file)), false);
  assert.deepEqual(scale, ['test/scale/context.test.mjs', 'test/scale/importer.test.mjs', 'test/scale/intelligence.test.mjs', 'test/scale/memory-pressure.test.mjs']);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curator-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'unknown'));
  await fs.writeFile(path.join(root, 'unknown/new.test.mjs'), '');
  await fs.writeFile(path.join(root, 'unknown/helper.mjs'), '');
  assert.equal((await discoverTests(root)).length, 1);
  assert.deepEqual(partitionTests(['test/new-feature.test.mjs']).ordinary, ['test/new-feature.test.mjs']);
  const bodies = await Promise.all(scale.map(file => fs.readFile(file, 'utf8')));
  assert.equal(bodies.reduce((count, body) => count + (body.match(/^test\(/gm) ?? []).length, 0), 7);
});

test('only explicitly safe documentation paths omit artifact integration; unknown bases fail closed', async t => {
  for (const files of [undefined, [], ['src/core/memory.ts'], ['src/mcp/server.ts'], ['bin/prodero'], ['instructions/AGENTS.md'], ['package.json'], ['package-lock.json'], ['scripts/run-tests.mjs'], ['.github/workflows/release-gate.yml'], ['test/new.test.mjs'], ['new-runtime.cjs'], ['docs/helper.js'], ['docs/subdir/unknown.md']]) {
    assert.equal(needsIntegration(files), true, JSON.stringify(files));
  }
  assert.equal(needsIntegration(['README.md', 'docs/RELEASING.md', 'docs/images/overview.png']), false);
  assert.equal(needsIntegration(['README.md', 'src/core/project.ts']), true);
  // A rename from runtime to docs must include both sides in the diff.
  assert.equal(needsIntegration(['src/runtime.ts', 'docs/runtime.md']), true);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curator-policy-diff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = () => { git('add', '.'); git('-c', 'user.name=CI fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic policy fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '--quiet');
  await fs.mkdir(path.join(root, 'src')); await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'src/runtime.ts'), 'fixture');
  await fs.writeFile(path.join(root, 'README.md'), 'fixture');
  const base = commit();
  await fs.rename(path.join(root, 'src/runtime.ts'), path.join(root, 'docs/runtime.md'));
  const renamed = commit();
  const output = path.join(root, '.git/github-output');
  const policy = fileURLToPath(new URL('../scripts/ci-policy.mjs', import.meta.url));
  const classify = async sha => {
    await fs.writeFile(output, '');
    execFileSync(process.execPath, [policy], { cwd: root, env: { ...process.env, CI_BASE_SHA: sha, GITHUB_OUTPUT: output }, stdio: 'pipe' });
    return fs.readFile(output, 'utf8');
  };
  assert.equal(await classify(base), 'integration=true\n', 'renames include their unsafe source');
  await fs.writeFile(path.join(root, 'README.md'), 'updated fixture'); commit();
  assert.equal(await classify(renamed), 'integration=false\n', 'verified documentation-only diff');
  for (const unavailable of ['', '0'.repeat(40), '1'.repeat(40)]) assert.equal(await classify(unavailable), 'integration=true\n');

});

test('workflow routes branch/PR to fast, tags/manual to full and never cancels release/manual runs', async () => {
  const workflow = await fs.readFile('.github/workflows/release-gate.yml', 'utf8');
  const condition = job => workflow.match(new RegExp(`  ${job}:\\n    if: (.+)`))[1];
  const group = workflow.match(/^  group: \$\{\{ github.workflow \}\}-\$\{\{ (.+) \}\}$/m)[1];
  const cancel = workflow.match(/^  cancel-in-progress: \$\{\{ (.+) \}\}$/m)[1];
  const evaluate = (expression, github) => Function('github', 'startsWith', `return (${expression});`)(github, (value, prefix) => value.startsWith(prefix));
  for (const [event, ref] of [['push', 'refs/heads/main'], ['pull_request', 'refs/pull/3/merge'], ['push', 'refs/tags/v0.1.1'], ['workflow_dispatch', 'refs/heads/main']]) {
    const github = { workflow: 'Release gate', event_name: event, ref, event: { pull_request: event === 'pull_request' ? { number: 3 } : {} }, run_id: 123 };
    assert.equal(evaluate(condition('fast'), github), gateMode(event, ref) === 'fast');
    assert.equal(evaluate(condition('gate'), github), gateMode(event, ref) === 'full');
    assert.equal(evaluate(cancel, github), gateMode(event, ref) === 'fast');
    if (gateMode(event, ref) === 'full') {
      assert.equal(evaluate(group, github), 123);
      assert.equal(evaluate(group, { ...github, run_id: 124 }), 124);
    } else {
      assert.equal(evaluate(group, github), event === 'pull_request' ? 3 : ref);
      if (event === 'pull_request') assert.equal(evaluate(group, { ...github, event: { pull_request: { number: 4 } } }), 4);
    }
  }
  assert.match(workflow, /tags: \['\*\*'\]/);
  assert.match(workflow, /branches: \['\*\*'\]/);
  assert.match(workflow, /node-version: '22\.14\.0'/);
  assert.match(workflow, /CI_BASE_SHA: \$\{\{ github.event.pull_request.base.sha \|\| github.event.before \}\}/);
});

test('package validation catches a README image omitted from the tarball and accepts its inclusion', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curator-package-links-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = ['LICENSE', 'README.md', 'ARCHITECTURE.md', 'docs/COMPATIBILITY.md', 'dist-ui/index.html', 'plugins/migrate_ai_studio/ui/dist/index.html'];
  for (const file of names) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), file === 'README.md' ? '![overview](docs/images/overview.png)' : 'fixture');
  }
  const pack = { files: names.map(path => ({ path })) };
  await assert.rejects(validatePackage(root, pack, () => false), /Broken packaged doc link/);
  await fs.mkdir(path.join(root, 'docs/images'));
  await fs.writeFile(path.join(root, 'docs/images/overview.png'), 'fixture');
  pack.files.push({ path: 'docs/images/overview.png' });
  await validatePackage(root, pack, () => false);
});

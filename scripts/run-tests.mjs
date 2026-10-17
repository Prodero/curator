import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export async function discoverTests(directory = 'test') {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discoverTests(name));
    else if (entry.isFile() && name.endsWith('.test.mjs')) files.push(name);
  }
  return files.sort();
}

export function partitionTests(files) {
  return {
    ordinary: files.filter(file => !file.startsWith('test/scale/')),
    scale: files.filter(file => file.startsWith('test/scale/')),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'full';
  if (!['fast', 'full'].includes(mode) || process.argv.length > 3) throw new Error('Usage: node scripts/run-tests.mjs [fast|full]');
  const all = await discoverTests();
  const { ordinary, scale } = partitionTests(all);
  const selected = mode === 'full' ? all : ordinary;
  if (!selected.length || !scale.length) throw new Error('Expected ordinary and scale test suites');
  console.log(`Test mode: ${mode}; ${selected.length}/${all.length} files; scale files: ${scale.length}; concurrency: ${mode === 'fast' ? 2 : 1}`);
  const result = spawnSync(process.execPath, ['--test', `--test-concurrency=${mode === 'fast' ? 2 : 1}`, ...selected], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

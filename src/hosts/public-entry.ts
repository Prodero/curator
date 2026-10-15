import fs from 'node:fs/promises';
import path from 'node:path';
import type { Entry } from './adapters.js';
import { fail } from './files.js';

/** Public package executable, never resolved through the current workspace/PATH. */
export function publicEntry(host: 'codex' | 'claude', cli: string, env: NodeJS.ProcessEnv = process.env): Entry {
  const command = path.resolve(path.dirname(cli), '../bin/prodero');
  const paths = [path.dirname(process.execPath), ...(env.PATH ?? '').split(path.delimiter), '/usr/bin', '/bin'];
  const PATH = [...new Set(paths.filter(p => path.isAbsolute(p)))].join(path.delimiter);
  return { ...(host === 'claude' ? {type: 'stdio'} : {}), command, args: ['mcp'], env: {PATH} };
}
export async function verifyPublicEntry(entry: Entry): Promise<string> {
  if (!path.isAbsolute(entry.command) || path.basename(entry.command) !== 'prodero') fail('HOST_RUNTIME_MISSING', 'Expected an absolute public Prodero executable.');
  const executable = await fs.realpath(entry.command).catch(() => fail('HOST_RUNTIME_MISSING', 'Public Prodero executable is missing. Install the updated package.'));
  const root = path.resolve(path.dirname(executable), '..');
  let metadata;
  try { metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); }
  catch { fail('HOST_RUNTIME_MISSING', 'Cannot read the installed Prodero package.'); }
  if (!['@prodero/curator', '@prodero/cli'].includes(metadata.name ?? '') || metadata.bin?.prodero !== './bin/prodero' || executable !== path.join(root, 'bin/prodero')) fail('HOST_RUNTIME_UNSUPPORTED', 'The package does not expose the supported public Prodero executable.');
  if (await fs.stat(path.join(root, 'src/cli.ts')).catch(() => null)) fail('HOST_UNPACKAGED_RUNTIME', 'Use an installed Prodero package for the public executable, not a source checkout.');
  await fs.access(executable, fs.constants.X_OK).catch(() => fail('HOST_RUNTIME_MISSING', 'Public Prodero executable is not executable.'));
  if (!(await fs.stat(executable)).isFile() || !(await fs.readFile(executable, 'utf8')).startsWith('#!/usr/bin/env node\n')) fail('HOST_RUNTIME_UNSUPPORTED', 'Unsupported public Prodero executable.');
  for (const relative of ['dist/cli.js', 'dist/hosts/runtime.js']) if (!(await fs.stat(path.join(root, relative)).catch(() => null))?.isFile()) fail('HOST_RUNTIME_UNSUPPORTED', 'The installed package is missing runtime switching support.');
  // The saved PATH must resolve the shebang to this installation's Node, even in GUI hosts.
  const first = entry.env?.PATH?.split(path.delimiter)[0];
  if (!first || !path.isAbsolute(first) || await fs.realpath(path.join(first, 'node')).catch(() => null) !== await fs.realpath(process.execPath)) fail('HOST_RUNTIME_MISSING', 'The public launcher requires the current Node executable on its managed PATH.');
  return root;
}

export async function resolveNpmCli(env: NodeJS.ProcessEnv): Promise<string> {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(p => path.isAbsolute(p))) {
    const candidate = await fs.realpath(path.join(dir, 'npm')).catch(() => null);
    if (candidate && /\.(?:c?js|mjs)$/.test(candidate) && (await fs.stat(candidate)).isFile()) return candidate;
  }
  return fail('HOST_RUNTIME_MISSING', 'Cannot resolve an npm JavaScript executable for development builds.');
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters, block, replaceBlock, LAUNCHER, GLOBAL_START, GLOBAL_END, MCP_START, MCP_END, type Entry } from './adapters.js';
import { environment, expectedEntry, inspect, receiptSchema, type MachineOptions, type Receipt } from './manager.js';
import { verifyPublicEntry, resolveNpmCli } from './public-entry.js';
import { read, fail, transact } from './files.js';

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export interface RuntimeOptions extends MachineOptions {
  checkout?: string;
  packageRoot?: string;
  workspace?: string;
  dryRun?: boolean;
  adoptDev?: boolean;
}

async function packageEntry(host: 'codex' | 'claude', entry: Entry, env: NodeJS.ProcessEnv): Promise<Entry> {
  // Accept historical receipt targets only to migrate them to the public executable.
  const cli = entry.args.length === 2 && entry.args[1] === 'mcp' && path.isAbsolute(entry.args[0])
    ? entry.args[0] : path.resolve(path.dirname(entry.command), '../dist/cli.js');
  const adapter = {id: host} as Parameters<typeof expectedEntry>[0];
  const result = expectedEntry(adapter, cli, env);
  await verifyPublicEntry(result);
  return result;
}

async function readPackage(root: string): Promise<{ name?: string; scripts?: Record<string, string> }> {
  try { return JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); }
  catch { return fail('HOST_RUNTIME_MISSING', 'Cannot read the selected runtime package.json. No settings changed.'); }
}

async function developmentEntry(host: 'codex' | 'claude', checkout: string, env: NodeJS.ProcessEnv) {
  if (!path.isAbsolute(checkout)) fail('HOST_UNSUPPORTED_PATH', '--checkout must be an absolute Prodero repository path.');
  const root = await fs.realpath(checkout).catch(() => fail('HOST_RUNTIME_MISSING', 'Development checkout does not exist.'));
  const metadata = await readPackage(root);
  if (!['@prodero/curator', '@prodero/cli'].includes(metadata.name ?? '') || !metadata.scripts?.['mcp:dev']) fail('HOST_RUNTIME_MISSING', 'Select a Prodero checkout with an mcp:dev script.');
  for (const relative of ['src/cli.ts', 'scripts/mcp-dev.ts', 'scripts/mcp-dev-launcher.mjs', 'node_modules/tsx/package.json']) {
    if (!(await fs.stat(path.join(root, relative)).catch(() => null))?.isFile()) fail('HOST_RUNTIME_MISSING', 'Development source or dependencies are missing. Install checkout dependencies first.');
  }
  await resolveNpmCli(env);
  return { root };
}

/** Refuse to silently switch a global registration shadowed by workspace policy. */
async function checkWorkspace(host: 'codex' | 'claude', workspace: string, globalConfig: string, nativeConfig: string) {
  if (!path.isAbsolute(workspace)) fail('HOST_UNSUPPORTED_PATH', '--workspace must be absolute.');
  workspace = await fs.realpath(workspace).catch(() => fail('HOST_SCOPE_CONFLICT', 'The selected workspace does not exist.'));
  if (!(await fs.stat(workspace)).isDirectory()) fail('HOST_SCOPE_CONFLICT', 'The selected workspace is not a directory.');
  const globalReal = await fs.realpath(globalConfig).catch(() => globalConfig);
  for (let dir = path.resolve(workspace);; dir = path.dirname(dir)) {
    const relatives = host === 'codex' ? ['.codex/config.toml'] : ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json'];
    for (const relative of relatives) {
      const file = path.join(dir, relative);
      if (file === globalConfig || await fs.realpath(file).catch(() => null) === globalReal) continue;
      const text = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        return fail('HOST_SCOPE_CONFLICT', 'Cannot inspect workspace MCP overrides. No settings changed.');
      });
      if (/prodero/i.test(text)) fail('HOST_SCOPE_CONFLICT', `Workspace Prodero settings in ${file} require review before switching the user-level connection.`);
    }
    if (dir === path.dirname(dir)) break;
  }
  if (host === 'claude') {
    const projects = JSON.parse(nativeConfig).projects ?? {};
    for (const [project, settings] of Object.entries(projects)) {
      const relative = path.relative(project, workspace);
      if ((relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) && /prodero/i.test(JSON.stringify(settings))) {
        fail('HOST_SCOPE_CONFLICT', 'Claude project-specific Prodero settings require review before switching the user-level connection.');
      }
    }
  }
}

/** Explicit single-host operation. Never discovers a target host or updates the running process. */
export async function switchRuntime(hostId: string, mode: string, options: RuntimeOptions = {}) {
  if (hostId !== 'codex' && hostId !== 'claude') fail('HOST_UNKNOWN', 'Choose exactly one host: codex or claude.');
  if (mode !== 'package' && mode !== 'dev') fail('HOST_RUNTIME_MODE', 'Choose package or dev.');
  if (options.packageRoot && !path.isAbsolute(options.packageRoot)) fail('HOST_UNSUPPORTED_PATH', '--package-root must be absolute.');
  const ctx = environment(options);
  const host = (await adapters(ctx.home, ctx.env, hostId))[0];
  const view = await inspect(host, ctx, false, true);
  await checkWorkspace(hostId, options.workspace ?? process.cwd(), host.config, view.text);
  const { receipt } = view;
  const migrating = !receipt && ['externally-configured', 'external-incomplete'].includes(view.base.state);
  if (!receipt && !migrating) fail('HOST_NOT_INSTALLED', 'Configure this agent with prodero install before switching runtimes.');
  if (migrating && !options.adoptDev && !options.dryRun) fail('HOST_ADOPTION_REQUIRED', 'Preview with --dry-run, then use --adopt-dev to migrate this manual prodero-dev registration.');
  const stored = receipt?.format === 2 ? receipt.runtime : undefined;
  const selectedPackage = options.packageRoot
    ? expectedEntry(host, path.join(options.packageRoot, 'dist/cli.js'))
    : stored?.packageEntry ?? receipt?.entry ?? expectedEntry(host, fileURLToPath(new URL('../cli.js', import.meta.url)));
  const packaged = await packageEntry(hostId, selectedPackage, ctx.env);
  let devRoot = stored?.devRoot ?? null, devEntry = stored?.devEntry ?? null;
  if (mode === 'dev') {
    const checkout = options.checkout ?? devRoot;
    if (!checkout) fail('HOST_RUNTIME_MISSING', 'Supply --checkout with the absolute Prodero repository path.');
    const development = await developmentEntry(hostId, checkout, ctx.env);
    devRoot = development.root;
    let explicit = false;
    const other = hostId === 'codex' ? 'claude' : 'codex';
    const saved = await read(ctx.home, path.join(ctx.state, other, 'receipt.json'));
    if (saved !== null) {
      const otherReceipt = receiptSchema.parse(JSON.parse(saved));
      explicit = otherReceipt.format === 2 && Boolean(otherReceipt.runtime.devRoot) && otherReceipt.runtime.devRoot !== devRoot;
    }
    devEntry = {...packaged, args: ['mcp', '--dev', ...(explicit ? ['--checkout', devRoot!] : [])]};
  }
  const entry = mode === 'dev' ? devEntry! : packaged;
  const config = host.edit(migrating ? host.removeAlternate(view.text) : view.text, entry);
  const launcher = replaceBlock(view.launcher ?? '', GLOBAL_START, GLOBAL_END, LAUNCHER);
  const next: Receipt = {
    format: 2, host: hostId, config: host.config, launcherPath: view.launcherPath,
    entry, launcher: LAUNCHER, mcpBlock: hostId === 'codex' ? block(config, MCP_START, MCP_END)!.text : null,
    originalConfig: receipt ? receipt.originalConfig : view.config,
    originalLauncher: receipt ? receipt.originalLauncher : view.launcher,
    installedConfig: config, installedLauncher: launcher,
    runtime: { mode, packageEntry: packaged, devRoot, devEntry },
  };
  receiptSchema.parse(next);
  host.inspectConfig(config);
  const unchanged = receipt?.format === 2 && stable(receipt.runtime) === stable(next.runtime) && stable(host.entry(view.text)) === stable(entry) && launcher === view.launcher;
  const plan = { host: hostId, mode, previousMode: stored?.mode ?? (migrating ? 'manual-dev' : 'package'), changed: !unchanged, migration: migrating,
    config: host.config, launcher: view.launcherPath, runtimePath: mode === 'dev' ? devRoot! : packaged.command, restartRequired: true };
  if (options.dryRun || unchanged) return { ...plan, dryRun: Boolean(options.dryRun) };
  await transact(ctx.home, view.dir, [
    { path: host.config, before: view.config, after: config },
    { path: view.launcherPath, before: view.launcher, after: launcher },
    { path: view.receiptPath, before: view.saved, after: JSON.stringify(next, null, 2) + '\n' },
  ]);
  return { ...plan, dryRun: false };
}

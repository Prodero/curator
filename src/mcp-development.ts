import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LocalStdioContext } from './mcp-workspace.js';
import { environment, receiptSchema } from './hosts/manager.js';
import { resolveNpmCli } from './hosts/public-entry.js';
import { read, fail } from './hosts/files.js';

/** Read installation state only to choose runtime CODE, never workspace authority. */
export async function developmentRoot(explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    if (!path.isAbsolute(explicit)) fail('HOST_UNSUPPORTED_PATH', '--checkout must be absolute.');
    return fs.realpath(explicit);
  }
  const {home, state} = environment({});
  const executable = await fs.realpath(fileURLToPath(new URL('../bin/prodero', import.meta.url)));
  const roots = new Set<string>();
  for (const host of ['codex', 'claude']) {
    const dir = path.join(state, host);
    const saved = await read(home, path.join(dir, 'receipt.json'));
    if (saved === null) continue;
    let receipt;
    try { receipt = receiptSchema.parse(JSON.parse(saved)); }
    catch { fail('HOST_UNSUPPORTED_CONFIG', 'Invalid integration receipt. Repair the managed integration before using --dev.'); }
    if (receipt.host !== host) fail('HOST_UNSUPPORTED_CONFIG', 'Integration receipt host mismatch.');
    if (receipt.format !== 2 || !receipt.runtime.devRoot || !receipt.runtime.devEntry) continue;
    const dev = receipt.runtime.devEntry;
    // An explicit multi-checkout entry does not compete with an ordinary --dev entry.
    if (JSON.stringify(dev.args) !== JSON.stringify(['mcp', '--dev']) || await fs.realpath(dev.command).catch(() => null) !== executable) continue;
    if (await read(home, path.join(dir, 'pending.json')) !== null || await fs.lstat(path.join(dir, 'lock')).catch(() => null)) fail('HOST_RECOVERY_REQUIRED', 'Integration update is incomplete. Reconnect after recovery.');
    const {runtime} = receipt;
    const stable = (value: unknown): string => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
    if (stable(receipt.entry) !== stable(runtime.mode === 'dev' ? runtime.devEntry : runtime.packageEntry)) fail('HOST_UNSUPPORTED_CONFIG', 'Inconsistent runtime receipt.');
    const root = runtime.devRoot!;
    if (!path.isAbsolute(root) || await fs.realpath(root).catch(() => null) !== root) fail('HOST_RUNTIME_MISSING', 'Saved development checkout was moved or replaced. Select it again with prodero runtime dev.');
    roots.add(root);
  }
  if (roots.size !== 1) fail('HOST_RUNTIME_MISSING', roots.size ? 'Multiple development checkouts are configured. Use an explicit --checkout or switch the host runtime again.' : 'No managed development checkout for this executable. Run prodero runtime dev --host HOST --checkout PATH.');
  return [...roots][0];
}
export async function startDevelopmentRuntime(localStdio: LocalStdioContext, options: {projectRoot?: string; checkout?: string}) {
  const root = await developmentRoot(options.checkout);
  let metadata;
  try { metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); }
  catch { fail('HOST_RUNTIME_MISSING', 'Cannot read development runtime metadata.'); }
  if (metadata.name !== '@prodero/cli') fail('HOST_RUNTIME_MISSING', 'Development runtime must be a Prodero checkout.');
  const npmCli = await resolveNpmCli(process.env);
  const entry = path.join(root, 'scripts/mcp-dev-launcher.mjs');
  const { startDevelopmentServer } = await import(pathToFileURL(entry).href);
  // In-process transfer of the captured object: never serialize authority into env or tool metadata.
  await startDevelopmentServer(localStdio, options.projectRoot, npmCli);
}

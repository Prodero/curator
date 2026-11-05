import { PRODERO_VERSION } from '../core/constants.js';
import { publicDiagnostic } from '../core/diagnostics.js';
import { adapters, LAUNCHER } from './adapters.js';
import { environment, inspect, machineIntegrations, type HostStatus, type MachineOptions } from './manager.js';
import { verifyPublicEntry } from './public-entry.js';

export const installHelp = `Usage: prodero install
       prodero install --host <codex|claude> --dry-run [--json]
       prodero install --host <codex|claude> --yes [--json]

Without arguments, open the interactive installation wizard.
--dry-run inspects one host without writes. --yes applies to that host only;
use it after reviewing the preview and obtaining permission for these changes.
This configures MCP and a minimal global launcher, with private local backups.
It does not install npm packages, initialize projects or test connectivity.
Restart or reconnect the selected host after applying.`;

export function parseTargetedInstall(args: string[]) {
  let host: 'codex' | 'claude' | undefined, dryRun = false, yes = false, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`Specify ${flag} only once.`);
    seen.add(flag);
    if (flag === '--dry-run') { dryRun = true; continue; }
    if (flag === '--yes') { yes = true; continue; }
    if (flag === '--json') { json = true; continue; }
    if (flag === '--host') {
      const value = args[++i];
      if (value !== 'codex' && value !== 'claude') throw new Error('Specify exactly one --host: codex or claude.');
      host = value; continue;
    }
    throw new Error('Unsupported install argument. Run prodero install without arguments for the interactive wizard, or use prodero install --help.');
  }
  if (!host) throw new Error('Specify exactly one --host: codex or claude.');
  if (dryRun === yes) throw new Error('Specify exactly one of --dry-run or --yes. Preview first; --yes acknowledges permission to change the selected host settings.');
  return { host, dryRun, json };
}

const allowed = (host: HostStatus) => ['installed', 'outdated', 'externally-configured'].includes(host.state)
  || (host.detected && host.state === 'not-configured');

/** Use the same ownership checks and transaction as the interactive wizard. */
export async function runTargetedInstall(args: string[], options: MachineOptions = {}) {
  const { host, dryRun } = parseTargetedInstall(args);
  const inspection = await machineIntegrations('status', host, options);
  const before = inspection.hosts[0];
  if (!before) throw new Error('Selected host inspection returned no result.');
  const ctx = environment(options);
  const [adapter] = await adapters(ctx.home, ctx.env, host);
  const actionable = before.state === 'outdated' || (before.detected && before.state === 'not-configured');
  let desired = null;
  // A preview must also reject missing/source-checkout executables before suggesting apply.
  if (allowed(before) && before.state !== 'externally-configured') {
    const view = await inspect(adapter, ctx);
    await verifyPublicEntry(view.desired);
    desired = { entry: view.desired, launcher: LAUNCHER };
  }
  const applied = !dryRun && actionable ? await machineIntegrations('install', host, options) : inspection;
  const status = applied.hosts[0];
  const ok = applied.ok && allowed(status);
  const outcome = !ok ? 'blocked' : dryRun ? 'preview' : actionable ? 'configured' : 'already-configured';
  return {
    ok, version: PRODERO_VERSION, scope: 'machine' as const, action: 'install' as const,
    host, dryRun, outcome, status,
    plan: {
      configPath: adapter.config, launcherPath: adapter.launcher,
      backupDirectory: `${ctx.state}/${host}`,
      managedServer: 'prodero',
      operation: !ok ? 'blocked' : actionable ? 'configure' : 'preserve',
      desired,
      projectChanges: false, packageChanges: false,
    },
    wouldChange: ok && actionable,
    // The manager rechecks configuration during apply and may observe a concurrent no-op.
    ...(!dryRun && actionable ? {} : { changed: false as const }),
    // Saved configuration cannot prove whether an earlier restart has happened.
    restartRequired: !dryRun && actionable && ok ? true : null,
    connectivity: 'not-tested' as const,
    message: !ok ? status.message : dryRun
      ? actionable ? 'Preview only. Applying configures this host MCP server and global launcher with private local backups. No files changed. Current restart state is unknown.' : 'Preview only. Existing integration is preserved; no changes needed. An earlier restart or reconnect may still be pending.'
      : actionable ? 'Saved settings inspected. Restart or reconnect this host, then verify Curator through its MCP tools. Connectivity has not been tested.'
      : 'Existing integration preserved. No settings changed. An earlier restart or reconnect may still be pending. Connectivity has not been tested.',
  };
}

export async function installCommand(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(installHelp); return 0; }
  const json = args.includes('--json');
  try {
    const result = await runTargetedInstall(args);
    const plain = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
    console.log(json ? JSON.stringify(result, null, 2) : [
      `Prodero ${result.version} · ${result.status.name} · ${result.outcome}`,
      `Configuration: ${result.status.state}${result.status.support === 'experimental' ? ' · Experimental' : ''}`,
      `Settings: ${plain(result.plan.configPath)}`,
      `Global launcher: ${plain(result.plan.launcherPath)}`,
      `Private backups: ${plain(result.plan.backupDirectory)}`,
      ...(result.plan.desired ? [
        `Managed registration: ${plain(JSON.stringify(result.plan.desired.entry))}`,
        `Global launcher text:\n${result.plan.desired.launcher}`,
      ] : []),
      plain(result.message),
      'Server connectivity: not tested.',
    ].join('\n'));
    return result.ok ? 0 : 1;
  } catch (error) {
    const result = { ok: false, version: PRODERO_VERSION, scope: 'machine', action: 'install', error: { code: 'PRODERO_INSTALL_FAILED', message: publicDiagnostic(error) } };
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.error(`[prodero] ${result.error.message}`);
    return 1;
  }
}

import { switchRuntime, type RuntimeOptions } from './runtime.js';

const help = `Usage: prodero runtime <dev|package> --host <codex|claude> [options]

  --checkout PATH      Absolute Prodero checkout path (required for first dev switch)
  --package-root PATH  Absolute installed package directory (if not already recorded)
  --workspace PATH     Workspace to check for overrides (defaults to current directory)
  --dry-run            Show the plan without changing any files
  --adopt-dev          Explicitly migrate a manual prodero-dev registration

Only the named host is changed. Restart that host after switching.
Use prodero install for initial setup; runtime switching never installs packages.`;

export async function runtimeCommand(args: string[]): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(help); return; }
  const mode = args[0];
  if (!['dev', 'package'].includes(mode)) throw new Error(help);
  let host: string | undefined;
  const options: RuntimeOptions = {};
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`Specify ${flag} only once.`);
    seen.add(flag);
    if (flag === '--dry-run') { options.dryRun = true; continue; }
    if (flag === '--adopt-dev') { options.adoptDev = true; continue; }
    if (!['--host', '--checkout', '--package-root', '--workspace'].includes(flag)) throw new Error(help);
    const value = args[++i];
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
    if (flag === '--host') host = value;
    else if (flag === '--checkout') options.checkout = value;
    else if (flag === '--package-root') options.packageRoot = value;
    else options.workspace = value;
  }
  if (!host || !['codex', 'claude'].includes(host)) throw new Error('Specify exactly one --host: codex or claude.');
  if (mode === 'package' && options.checkout) throw new Error('--checkout is only used with runtime dev.');
  const result = await switchRuntime(host, mode, options);
  const safe = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  console.log(`\nProdero · ${host === 'codex' ? 'Codex' : 'Claude Code'} runtime\n`);
  console.log(`${result.dryRun ? 'Preview' : result.changed ? 'Configured' : 'Already configured'}: ${result.previousMode} → ${result.mode}`);
  console.log(`Runtime: ${safe(result.runtimePath)}\nSettings: ${safe(result.config)}`);
  if (result.migration) console.log('Migration: replace the manual prodero-dev registration with managed prodero; retain private originals for uninstall.');
  if (result.dryRun) console.log(`No files changed.${result.migration ? ' Apply with --adopt-dev after reviewing this migration.' : ''}`);
  else console.log('Restart or reconnect this agent to load the selected runtime. The running server has not been restarted.');
}

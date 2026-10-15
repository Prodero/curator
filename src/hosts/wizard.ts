import { createInterface } from 'node:readline/promises';
import { PRODERO_VERSION } from '../core/constants.js';
import { machineIntegrations, type HostStatus, type MachineOptions } from './manager.js';

export interface WizardIO {
  interactive: boolean;
  write(text: string): void;
  question(prompt: string): Promise<string | null>;
}

const labels: Record<string, string> = {
  installed: 'Installed',
  'externally-configured': 'Already configured (prodero-dev, manual)',
  'external-incomplete': 'Manual setup needs attention',
  'not-configured': 'Not configured',
  'not-detected': 'Agent not found',
  outdated: 'Update available',
  conflicted: 'Configuration needs review',
  'unsupported-configuration': 'Cannot read or update configuration',
  'recovery-required': 'Recovery required',
  unsupported: 'Not supported yet',
};
const actionable = (host: HostStatus) => host.state === 'outdated' || (host.detected && host.state === 'not-configured');
const needsAttention = (host: HostStatus) => ['conflicted', 'unsupported-configuration', 'recovery-required', 'external-incomplete'].includes(host.state);
// Native paths can contain terminal control characters. Never render those as commands.
const printable = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

export async function runInstallWizard(io: WizardIO, options: MachineOptions = {}): Promise<number> {
  io.write(`\n  Prodero ${PRODERO_VERSION} · Installation\n`);
  io.write('  Configure Prodero for your coding agents.\n');
  let result = await machineIntegrations('status', undefined, options);
  while (true) {
    io.write('\n  Agent          Prodero status\n  ───────────────────────────────────────────────────────────\n');
    for (const host of result.hosts) {
      io.write(`  ${host.name.padEnd(15)}${labels[host.state] ?? host.state}${host.runtimeMode === 'dev' ? ' · dev' : ''}${host.support === 'experimental' ? ' · Experimental' : ''}\n`);
      if (needsAttention(host) || host.state === 'externally-configured') {
        io.write(`    ${printable(host.message).replace(/^HOST_[A-Z_]+: /, '')}\n`);
      }
    }
    io.write('\n  Status reflects saved settings; server connectivity is not tested.\n');
    const available = result.hosts.filter(actionable);
    if (!io.interactive) {
      io.write('\n  Open an interactive terminal and run prodero install to choose an agent.\n  No settings were changed.\n');
      return 1;
    }
    if (!available.length) {
      io.write(needsAttentionIn(result.hosts)
        ? '\n  Review the settings above, then run prodero install again.\n'
        : '\n  No agents need installation. Run prodero install again after adding an agent.\n');
      return needsAttentionIn(result.hosts) ? 1 : 0;
    }
    io.write('\n  Choose an action\n');
    available.forEach((host, index) => io.write(`  ${index + 1}. ${host.state === 'outdated' ? 'Update' : 'Install for'} ${host.name}${host.support === 'experimental' ? ' (experimental)' : ''}\n`));
    io.write('  0. Finish\n\n');
    const answer = (await io.question('  Selection [0]: '))?.trim();
    if (answer === null || answer === undefined || answer === '' || answer === '0') {
      io.write('\n  Finished.\n');
      return needsAttentionIn(result.hosts) ? 1 : 0;
    }
    if (!/^[1-9]\d*$/.test(answer) || !available[Number(answer) - 1]) {
      io.write('\n  Enter a number from the menu.\n');
      continue;
    }
    const selected = available[Number(answer) - 1];
    io.write(`\n  ${selected.state === 'outdated' ? 'Update' : 'Install'} Prodero for ${selected.name}\n`);
    io.write('  This configures the MCP server and global launch instruction.\n  Existing unrelated settings are preserved; changes are backed up locally.\n');
    if (selected.support === 'experimental') io.write('  Claude Code support is experimental.\n');
    const confirmation = (await io.question('  Continue? [y/N]: '))?.trim().toLowerCase();
    if (confirmation !== 'y' && confirmation !== 'yes') {
      io.write('\n  Cancelled. No settings were changed for this agent.\n');
      if (confirmation === undefined) return 0;
      continue;
    }
    io.write(`\n  Configuring ${selected.name}…\n`);
    const installed = await machineIntegrations('install', selected.id, options);
    const host = installed.hosts.find(item => item.id === selected.id)!;
    if (host.state === 'installed') {
      io.write(`  ✓ Prodero is installed for ${selected.name}.\n  Restart ${selected.name}, open a repository and type prodero.\n`);
    } else {
      io.write(`  ${printable(host.message)}\n`);
    }
    // Re-read the settings after each action, including failures and concurrent edits.
    result = await machineIntegrations('status', undefined, options);
    if (!installed.ok) return 1;
  }
}

function needsAttentionIn(hosts: HostStatus[]) { return hosts.some(needsAttention); }

export async function installWizard(): Promise<number> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return runInstallWizard({ interactive, write: text => process.stdout.write(text), question: async () => null });
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  terminal.on('close', () => abort.abort());
  terminal.on('SIGINT', () => terminal.close());
  try {
    return await runInstallWizard({
      interactive,
      write: text => process.stdout.write(text),
      async question(prompt) {
        if (abort.signal.aborted) return null;
        try { return await terminal.question(prompt, { signal: abort.signal }); }
        catch (error) { if (abort.signal.aborted) return null; throw error; }
      },
    });
  } finally { terminal.close(); }
}

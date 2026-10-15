import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/server.js';
import type { LocalStdioContext } from '../src/mcp-workspace.js';

export async function startDevelopmentServer(localStdio: LocalStdioContext, projectRoot?: string, npmCli?: string) {
  const checkout = fileURLToPath(new URL('../', import.meta.url));
  if (!npmCli || !path.isAbsolute(npmCli) || !/\.(?:c?js|mjs)$/.test(npmCli)) throw new Error('Development runtime requires an absolute npm JavaScript executable.');
  for (const script of ['build:instructions', 'ui:build']) {
    const build = spawnSync(process.execPath, [npmCli, 'run', '--silent', script], {
      cwd: checkout, stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`Prodero ${script} build failed with exit code ${build.status ?? 'unknown'}.`);
  }
  const server = createServer({ localStdio, projectRoot });
  await server.connect(new StdioServerTransport());
}

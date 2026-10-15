// Internal runtime loader. The public prodero executable owns launch-context capture.
import { tsImport } from 'tsx/esm/api';
export async function startDevelopmentServer(localStdio, projectRoot, npmCli) {
  if (!localStdio) throw new Error('Use prodero mcp --dev to start the development runtime.');
  const runtime = await tsImport('./mcp-dev.ts', import.meta.url);
  await runtime.startDevelopmentServer(localStdio, projectRoot, npmCli);
}

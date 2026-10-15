import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { explicitProjectRoot } from './core/project-root.js';

type Root = Readonly<{ path: string; canonical: string }>;
/** Created by the local stdio entrypoint, never from protocol/tool input. */
export interface LocalStdioContext {
  readonly cwd: Root;
  readonly claudeProject?: Root;
  readonly invalidClaudeProject: boolean;
  readonly indirectLaunch: boolean;
}
function pin(value: string): Root {
  if (!value.trim() || !path.isAbsolute(value)) throw new Error('Project root must be an absolute existing directory.');
  try {
    const canonical = realpathSync(value);
    if (!statSync(canonical).isDirectory()) throw new Error();
    return Object.freeze({ path: path.resolve(value), canonical });
  } catch { throw new Error('Project root is not an existing directory.'); }
}
/** Capture before build/npm can change the workspace. PWD and INIT_CWD are never read. */
export function captureLocalStdioContext(): LocalStdioContext {
  let claudeProject: Root | undefined, invalidClaudeProject = false;
  if (process.env.CLAUDE_PROJECT_DIR !== undefined) {
    try { claudeProject = pin(process.env.CLAUDE_PROJECT_DIR); }
    catch { invalidClaudeProject = true; }
  }
  return Object.freeze({ cwd: pin(process.cwd()), claudeProject, invalidClaudeProject,
    // npm scripts execute in their package, not necessarily in the host workspace.
    // This flag only disables launch authority; environment data never grant it.
    indirectLaunch: Boolean(process.env.npm_lifecycle_event) });
}
async function canonical(value: string): Promise<string> {
  if (!value.trim() || !path.isAbsolute(value)) throw new Error('Project root must be an absolute existing directory.');
  const root = await fs.realpath(value).catch(() => null);
  if (!root || !(await fs.stat(root).catch(() => null))?.isDirectory()) throw new Error('Project root is not an existing directory.');
  return root;
}
async function recheck(root: Root): Promise<Root> {
  if (await canonical(root.path) !== root.canonical) throw new Error('PRODERO_ROOT_UNAUTHORIZED: Workspace boundary changed. Reconnect from the intended workspace.');
  return root;
}
type Authority = Readonly<{ roots: readonly Root[]; primary?: Root }>;
type Operation = { authority?: Promise<Authority>; selected?: Promise<Root> };

/** One lazy authority snapshot and selected root per tools/call, including Apps/plugins/text. */
export function installWorkspaceBoundary(server: McpServer, options: { projectRoot?: string; localStdio?: LocalStdioContext }) {
  const fixed = options.projectRoot === undefined ? undefined : pin(options.projectRoot);
  const launch = options.localStdio;
  // Remember identities only to detect replacement; this map never grants access.
  const hostIdentities = new Map<string, Root>();
  const operations = new AsyncLocalStorage<Operation>();
  const register = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => register(schema, (request, extra) =>
    request.method === 'tools/call' ? operations.run({}, () => handler(request, extra)) : handler(request, extra));

  async function authority(): Promise<Authority> {
    if (fixed) return { roots: [await recheck(fixed)], primary: fixed };
    const client = server.server.getClientVersion()?.name;
    const claude = client === 'claude-code';
    if (server.server.getClientCapabilities()?.roots) {
      let roots;
      try { roots = (await server.server.listRoots()).roots; }
      catch { throw new Error('PRODERO_WORKSPACE_UNAVAILABLE: Cannot read MCP workspace roots. Reconnect the host.'); }
      const unique = new Map<string, Root>();
      try {
        for (const {uri} of roots) {
          const url = new URL(uri);
          if (url.protocol !== 'file:') throw new Error();
          const value = path.resolve(fileURLToPath(url));
          const real = await canonical(value);
          const prior = hostIdentities.get(value);
          if (prior && prior.canonical !== real) throw new Error('Host root was replaced.');
          const root = prior ?? Object.freeze({path: value, canonical: real});
          hostIdentities.set(value, root);
          if (!unique.has(real)) unique.set(real, root);
        }
      } catch { throw new Error('PRODERO_WORKSPACE_UNAVAILABLE: MCP workspace roots must be file URIs for existing directories.'); }
      // Empty/revoked/invalid negotiated roots never fall back to launch context.
      if (!unique.size) throw new Error('PRODERO_WORKSPACE_UNAVAILABLE: No MCP workspace roots are authorized by the host.');
      let primary: Root | undefined;
      if (claude && launch?.invalidClaudeProject) throw new Error('PRODERO_WORKSPACE_UNAVAILABLE: Invalid host project context. Reconnect the host.');
      if (claude && launch?.claudeProject) {
        await recheck(launch.claudeProject);
        primary = unique.get(launch.claudeProject.canonical);
        // Primary removal is legitimate revocation; never restore it through env.
      }
      return { roots: [...unique.values()], primary };
    }
    if (claude && launch?.claudeProject && !launch.invalidClaudeProject) {
      const root = await recheck(launch.claudeProject);
      return { roots: [root], primary: root };
    }
    if (client === 'codex-mcp-client' && launch && !launch.indirectLaunch) {
      const root = await recheck(launch.cwd);
      return { roots: [root], primary: root };
    }
    throw new Error('PRODERO_WORKSPACE_UNAVAILABLE: No trusted MCP workspace context. Use a supported local host and the direct Prodero launcher; reconnect after updating the integration.');
  }
  return async function workspaceRoot(explicit?: string): Promise<string> {
    const operation = operations.getStore();
    if (!operation) throw new Error('PRODERO_WORKSPACE_UNAVAILABLE: Project access requires an MCP operation context.');
    const allowed = await (operation.authority ??= authority());
    const selectedCanonical = explicit === undefined ? undefined : await canonical(explicit);
    if (!operation.selected) {
      operation.selected = (async () => {
        const selected = selectedCanonical === undefined
          ? allowed.primary ?? (allowed.roots.length === 1 ? allowed.roots[0] : undefined)
          : allowed.roots.find(root => root.canonical === selectedCanonical);
        if (!selected) throw new Error(selectedCanonical === undefined
          ? 'Missing or ambiguous MCP workspace roots. Select an authorized root with projectRoot.'
          : 'PRODERO_ROOT_UNAUTHORIZED: projectRoot is outside the host-authorized workspace boundary.');
        await recheck(selected);
        await explicitProjectRoot(selected.path);
        return selected;
      })();
    }
    const selected = await operation.selected;
    if (selectedCanonical !== undefined && selectedCanonical !== selected.canonical) throw new Error('PRODERO_ROOT_UNAUTHORIZED: An operation cannot switch workspace boundaries.');
    await recheck(selected);
    return selected.path;
  };
}

#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { captureLocalStdioContext, type LocalStdioContext } from "./mcp-workspace.js";
import { planProjectMigration, applyProjectMigration } from "./core/migrations.js";
import { buildViewModel, renderText } from "./presentation.js";
import { runMemorySync } from './core/memory-sync.js';
import { machineIntegrations } from "./hosts/manager.js";
import { installWizard } from "./hosts/wizard.js";
import { runtimeCommand } from "./hosts/runtime-command.js";
import { buildMemoryTransformationBundle } from "./core/memory-transformation-bundle.js";
import { getMemoryIntelligencePlan } from "./core/memory-intelligence.js";
import { publicDiagnostic } from "./core/diagnostics.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import {
  autoMigrateProject,
  getProjectStatus,
  initializeProject,
  prepareProject,
  recallProject,
  PRODERO_VERSION,
  resolveProjectContext,
  syncProject,
} from "./core/project.js";
import { cliProjectRoot, explicitProjectRoot } from "./core/project-root.js";
import { checkForUpdate, installLatest } from "./core/update.js";

const help = `Prodero ${PRODERO_VERSION}

Usage: prodero <command> [--root /absolute/project]
  mcp, --stdio            Start MCP in the host workspace; --dev loads the saved development runtime
  migrate [status]        Review or apply the project knowledge update with backup
  init                    Initialize the selected project
  install                 Open the interactive agent installation wizard
  runtime <mode> --host HOST Switch one agent between package and dev (runtime --help)
  uninstall [host] [--all] Remove managed host integration; preserve projects
  status                  Show version and machine host integrations
  status --root PATH      Show existing project status
  memory-bundle <id>       Inspect one read-only transformation bundle (JSON)
  memory-plan             Inspect deterministic memory candidates (read-only JSON)
  sync                    Start/resume Sync Memory (JSON; continue through MCP)
  sync-sessions           Low-level deterministic closed-session recovery
  recall <query>          Recall project knowledge without a session
  context [query]         Inspect retrieved context
  prepare [task]          Prepare context and start a session
  check-update            Show installed/latest npm version and update instruction
  update                  Show manual npm update instructions (does not install)
  help, --help            Show this help
  --version               Show the installed version

--root accepts an absolute existing directory, as --root PATH or --root=PATH.
Without --root, project commands require a Git or initialized Prodero ancestor.
MCP uses negotiated host roots or supported local host launch context. --root is an optional hard boundary.`;

function parse(argv: string[]) {
  let command: string | undefined, root: string | undefined, query: string | undefined;
  let helpRequested = false, all = false, dev = false, checkout: string | undefined, host: string | undefined;
  const commands = new Set(["install", "uninstall", "mcp", "--stdio", "init", "migrate", "status", "memory-plan", "memory-bundle", "sync", "sync-sessions", "context", "recall", "prepare", "check-update", "update", "help", "--version"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { helpRequested = true; continue; }
    if (arg === "--dev") { if (dev) throw new Error("Specify --dev only once."); dev = true; continue; }
    if (arg === "--checkout") { if (checkout !== undefined) throw new Error("Specify --checkout only once."); checkout = argv[++i]; if (!checkout || checkout.startsWith("--")) throw new Error("--checkout requires a directory."); continue; }
    if (arg === "--all") { if (all) throw new Error("Specify --all only once."); all = true; continue; }
    if (arg === "--root" || arg.startsWith("--root=")) {
      if (root !== undefined) throw new Error("Specify --root only once.");
      root = arg === "--root" ? argv[++i] : arg.slice(7);
      if (!root || root.startsWith("--")) throw new Error("--root requires an absolute project directory.");
    } else if (!command && commands.has(arg)) command = arg;
    else if (arg.startsWith("-")) throw new Error("Unknown flag. Run prodero --help.");
    else if (!command) throw new Error("Unknown command. Run prodero --help.");
    else if (command === "install") throw new Error("Run prodero install without arguments; choose an agent in the interactive wizard.");
    else if (command === "uninstall" && host === undefined) host = arg;
    else if (["migrate", "prepare", "context", "recall", "memory-bundle"].includes(command) && query === undefined) query = arg;
    else throw new Error("Unexpected argument. Run prodero --help.");
  }
  command ??= "help";
  if (all && command === "install") throw new Error("Run prodero install without --all; choose an agent in the interactive wizard.");
  if (all && (command !== "uninstall" || host)) throw new Error("Use --all only with uninstall and without a host name.");
  if (root !== undefined && ["install", "uninstall", "help", "--version", "check-update", "update"].includes(command)) throw new Error(`--root is not used by ${command}.`);
  if ((dev || checkout !== undefined) && !["mcp", "--stdio"].includes(command)) throw new Error("--dev and --checkout are only supported for MCP.");
  if (checkout !== undefined && !dev) throw new Error("--checkout requires --dev.");
  return { dev, checkout, command: helpRequested ? "help" : command, root, query, host: all ? "all" : host };
}

async function run(localStdio?: LocalStdioContext) {
  if (process.argv[2] === 'runtime') { await runtimeCommand(process.argv.slice(3)); return; }
  const { command, root, query, host, dev, checkout } = parse(process.argv.slice(2));
  if (command === "help") { console.log(help); return; }
  if (command === "--version") { console.log(PRODERO_VERSION); return; }
  if (command === "install") { process.exitCode = await installWizard(); return; }
  if (command === "uninstall" || (command === "status" && root === undefined)) {
    const result = await machineIntegrations(command === "status" ? "status" : command, host);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "mcp" || command === "--stdio") localStdio ??= captureLocalStdioContext();
  const rootArg = command === "mcp" || command === "--stdio" ? (root === undefined ? undefined : await explicitProjectRoot(root)) : ["update", "check-update"].includes(command) ? undefined : await cliProjectRoot(root);
  if (command === "--stdio" || command === "mcp") {
    if (dev) {
      const { startDevelopmentRuntime } = await import('./mcp-development.js');
      await startDevelopmentRuntime(localStdio!, { projectRoot: rootArg, checkout });
      return;
    }
    const server = createServer({ projectRoot: rootArg, localStdio });
    await server.connect(new StdioServerTransport());
    return;
  }

  if (command === "migrate") {
    if(query && query!=="status")throw new Error("Use prodero migrate or prodero migrate status.");
    let plan=await planProjectMigration(rootArg!);
    if(query!=="status" && (plan.safeToApply || plan.state==="recovery-required")) {
      const result=await applyProjectMigration(rootArg!,{approved:true,planId:plan.planId,recover:plan.state==="recovery-required"});
      plan=result.plan;
    }
    console.log(renderText(buildViewModel({action:"migration",root:rootArg,plan}),true));
    if(plan.blocked)process.exitCode=1;
    return;
  }

  if (command === "init") {
    console.log(JSON.stringify(await initializeProject(rootArg), null, 2));
    return;
  }

  if (["status","prepare"].includes(command)) {
    const plan=await planProjectMigration(rootArg!);
    if(plan.state!=="current") {(plan.blocked?console.error:console.log)(renderText(buildViewModel({action:"migration",root:rootArg,plan,resume:{tool:"prodero_prepare",arguments:{projectRoot:rootArg,task:query}}}),true));process.exitCode=1;return;}
  }
  if (command === "status") {
    const project = await getProjectStatus(rootArg);
    if (project.initialized) await autoMigrateProject(project.root);
    console.log(JSON.stringify({ version: PRODERO_VERSION, project: await getProjectStatus(project.root), update: await checkForUpdate() }, null, 2));
    return;
  }

  if (command === "memory-bundle") {
    if (!query) throw new Error("memory-bundle requires one planner candidate ID");
    console.log(JSON.stringify(await buildMemoryTransformationBundle(rootArg!, query)));
    return;
  }

  if (command === "memory-plan") {
    console.log(JSON.stringify(await getMemoryIntelligencePlan(rootArg!), null, 2));
    return;
  }

  if (command === "sync") {
    console.log(JSON.stringify(await runMemorySync(rootArg!, {action:"start"}), null, 2));
    return;
  }
  if (command === "sync-sessions") {
    console.log(JSON.stringify(await syncProject(rootArg, { onlyClosed: true }), null, 2));
    return;
  }

  if (command === "recall") {
    console.log(JSON.stringify(await recallProject(rootArg, query ?? ""), null, 2));
    return;
  }

  if (command === "context") {
    console.log(JSON.stringify(await resolveProjectContext(rootArg, query), null, 2));
    return;
  }

  if (command === "prepare") {
    console.log(JSON.stringify(await prepareProject(rootArg, { task: query, agent: "cli" }), null, 2));
    return;
  }

  if (command === "update") {
    console.log(JSON.stringify(await installLatest(), null, 2));
    return;
  }

  if (command === "check-update") {
    console.log(JSON.stringify(await checkForUpdate(), null, 2));
    return;
  }


}

export async function main(localStdio?: LocalStdioContext) {
  await run(localStdio).catch((error) => {
  console.error(`[prodero] ${publicDiagnostic(error)}`);
  process.exitCode = 1;
  });
}
// Compatibility for direct CLI execution; importing from the public binary never auto-starts.
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) await main();

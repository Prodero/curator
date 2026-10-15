import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PRODERO_TOOLS } from "../src/contracts.js";
import { createServer } from "../src/server.js";

const run = promisify(execFile);
const keep = process.argv.includes("--keep");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-playground-"));
await run("git", ["init", "--quiet", root]);
await fs.writeFile(path.join(root, "AGENTS.md"), "# Playground user instructions\n\nPreserve this content.\n");

const server = createServer({projectRoot:root});
const client = new Client({ name: "prodero-playground", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  return result.structuredContent as Record<string, any> | undefined;
}

try {
  const before = payload(await client.callTool({ name: PRODERO_TOOLS.status, arguments: { projectRoot: root } }));
  const initialized = payload(await client.callTool({ name: PRODERO_TOOLS.initialize, arguments: { projectRoot: root } }));
  const prepared = payload(await client.callTool({ name: PRODERO_TOOLS.prepare, arguments: { projectRoot: root, task: "verify MCP memory lifecycle", agent: "playground" } }));
  const sessionId = prepared!.result.session.id;
  const recorded = payload(await client.callTool({ name: PRODERO_TOOLS.sessionRecord, arguments: { projectRoot: root, sessionId, entries: [{ type: "decision", content: "MCP and CLI call the same Prodero Core operations.", title: "Shared-Core", scopeHint: "global", importanceHint: "important" }] } }));
  const closed = payload(await client.callTool({ name: PRODERO_TOOLS.sessionClose, arguments: { projectRoot: root, sessionId } }));
  const next = payload(await client.callTool({ name: PRODERO_TOOLS.prepare, arguments: { projectRoot: root, task: "change MCP Core integration", agent: "playground" } }));
  const context = payload(await client.callTool({ name: PRODERO_TOOLS.context, arguments: { projectRoot: root, task: "change MCP Core integration" } }));

  const configPath = path.join(root, ".prodero", "config.json");
  const legacyConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  legacyConfig.schemaVersion = 1;
  await fs.writeFile(configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`);
  const migrated = payload(await client.callTool({ name: PRODERO_TOOLS.status, arguments: { projectRoot: root } }));

  console.log(JSON.stringify({
    repository: root,
    before: before?.project,
    initialized: initialized?.status?.project,
    prepared: prepared?.result?.session,
    recorded: recorded?.result?.recorded,
    closed: closed?.result?.session,
    sync: next?.result?.automaticSync,
    context: context?.result,
    after: next?.result?.project,
    migration: migrated?.migration,
    retained: keep,
  }, null, 2));
} finally {
  await client.close();
  await server.close();
  if (!keep) await fs.rm(root, { recursive: true, force: true });
}

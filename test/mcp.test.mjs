import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { getProjectStatus } from "../dist/core/project.js";
import { listKnowledge } from "../dist/core/memory.js";
import { createServer, PRODERO_LIFECYCLE_RESOURCE_URI, PRODERO_MCP_INSTRUCTIONS, PRODERO_RESOURCE_URI, PRODERO_TOOLS, PRODERO_TOOL_NAMES } from "../dist/server.js";

const exec = promisify(execFile);

test("View context is a local disclosure action and never calls context resolution", async () => {
  const checkout = fileURLToPath(new URL("..", import.meta.url));
  const source = await fs.readFile(path.join(checkout, "src", "ui", "main.ts"), "utf8");
  const start = source.indexOf("function renderContextInspector");
  const end = source.indexOf("function renderMemoryCompression");
  const contextUi = source.slice(start, end);
  assert.match(contextUi, /preparedContextSnapshot\(context\)/);
  assert.match(contextUi, /contextExpanded = !contextExpanded/);
  assert.doesNotMatch(contextUi, /callServerTool|PRODERO_TOOLS\.context|resolveProjectContext/);
});

test("zero-project status opens onboarding and initializes through the existing MCP path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-zero-state-"));
  await exec("git", ["-C", root, "init", "--quiet"]);
  const server = createServer();
  const client = new Client({ name: "prodero-zero-state-test", version: "1.0.0" }, { capabilities: { roots: { listChanged: false } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(root).href, name: "empty test repository" }] }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    const openTool = tools.tools.find((tool) => tool.name === PRODERO_TOOLS.open);
    assert.match(openTool?.description ?? "", /UI\/auto launch requests/);
    assert.match(openTool?.description ?? "", /text-mode project use prodero_text with tool=prodero_open/);
    assert.match(openTool?.description ?? "", /Bootstrap Context/);
    assert.match(openTool?.description ?? "", /Does not create a session/);
    assert.doesNotMatch(openTool?.description ?? "", /Codex|Claude|Cursor/);

    await assert.rejects(fs.stat(path.join(root, ".prodero")), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.join(root, "AGENTS.md")), { code: "ENOENT" });
    const before = await client.callTool({ name: PRODERO_TOOLS.status, arguments: {} });
    assert.equal(before.structuredContent?.project.root, root, "bare status resolves the current repository from standard MCP roots");
    assert.equal(before.structuredContent?.project.git, true);
    assert.equal(before.structuredContent?.project.agentsFile, false, "missing AGENTS.md is a normal zero-project state");
    assert.equal(before.structuredContent?.project.initialized, false);
    assert.equal(before.structuredContent?.hydrationRequired, false);
    await assert.rejects(fs.stat(path.join(root, ".prodero")), { code: "ENOENT" }, "status onboarding must not create canonical or cache state");

    const initialized = await client.callTool({ name: PRODERO_TOOLS.initialize, arguments: {} });
    assert.equal(initialized.structuredContent?.action, "initialized");
    assert.equal(initialized.structuredContent?.status.product, "Prodero");
    assert.equal(initialized.structuredContent?.status.phase, "ready");
    assert.equal(initialized.structuredContent?.status.project.initialized, true, "initialize returns the normal status used by the same App");
    assert.equal((await fs.stat(path.join(root, ".prodero"))).isDirectory(), true);
    assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), /<!-- prodero:start -->/);

    const agentsBefore = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    await client.callTool({ name: PRODERO_TOOLS.initialize, arguments: {} });
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), agentsBefore, "repeated UI initialization stays idempotent");
  } finally {
    await client.close();
    await server.close();
  }
});

test("onboarding UI calls initialize and replaces zero state with returned status", async () => {
  const checkout = fileURLToPath(new URL("..", import.meta.url));
  const source = await fs.readFile(path.join(checkout, "src", "ui", "main.ts"), "utf8");
  assert.match(source, /function renderOnboarding/);
  assert.match(source, /NEW PROJECT DETECTED/);
  assert.match(source, /Git repository/);
  assert.match(source, /AGENTS\.md/);
  assert.match(source, /Not initialized/);
  assert.match(source, /Prodero will create/);
  assert.match(source, /managed AGENTS instructions/);
  assert.match(source, /project intelligence foundation/);
  assert.match(source, /name: PRODERO_TOOLS\.initialize/);
  assert.match(source, /state = initialized\.status as StatusPayload/);
});

test("MCP registers Prodero tools, status, and the App resource", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-mcp-test-"));
  await fs.mkdir(path.join(root, ".git"));

  const timings = [];
  const server = createServer({ projectRoot:root, instrument: (timing) => timings.push(timing) });
  const client = new Client({ name: "prodero-test", version: "1.0.0" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    const discoveredPlugins = (await client.callTool({ name: PRODERO_TOOLS.plugins, arguments: {} })).structuredContent.plugins;
    const pluginTools = discoveredPlugins.filter(plugin => plugin.ui).flatMap(plugin => [plugin.toolName, ...plugin.actions.map(action => action.toolName)]);
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [...PRODERO_TOOL_NAMES, ...pluginTools].sort());
    const statusTool = tools.tools.find((tool) => tool.name === "prodero_status");
    assert.equal(statusTool?._meta?.ui, undefined, "fast status does not open a provisional App");
    assert.match(statusTool?.description ?? "", /lightweight read-only/);
    assert.equal(tools.tools.find((tool) => tool.name === PRODERO_TOOLS.open)?._meta?.ui?.resourceUri, PRODERO_RESOURCE_URI);
    assert.equal(tools.tools.find((tool) => tool.name === PRODERO_TOOLS.statusDetails)?._meta?.ui, undefined, "details hydrate the existing card without opening another App");
    for (const name of [PRODERO_TOOLS.prepare, PRODERO_TOOLS.sessionClose]) {
      assert.equal(tools.tools.find((tool) => tool.name === name)?._meta?.ui?.resourceUri, PRODERO_LIFECYCLE_RESOURCE_URI);
    }
    assert.equal(tools.tools.find((tool) => tool.name === PRODERO_TOOLS.sync)?._meta?.ui?.resourceUri, PRODERO_RESOURCE_URI, "Sync Memory opens the workflow");
    assert.equal(tools.tools.find((tool) => tool.name === PRODERO_TOOLS.context)?._meta?.ui, undefined, "tiny context lookup does not force lifecycle UI");
    assert.equal(client.getInstructions(), PRODERO_MCP_INSTRUCTIONS);
    assert.match(client.getInstructions() ?? "", /immediately call prodero_config_get/);
    assert.match(client.getInstructions() ?? "", /Do not ask what the user wants to do with Prodero/);
    // Verify the naming guidance reaches hosts through the MCP handshake.
    // This checks the instruction contract, not whether a host/model obeys it.
    const naming = (client.getInstructions() ?? "").split("For conversation naming, ")[1]?.split("Before substantial work")[0];
    assert.ok(naming, "handshake includes conversation naming guidance");
    assert.match(naming, /`prodero` or `Open Prodero` are not substantive tasks/);
    assert.match(naming, /After the first substantive user request, infer a short descriptive title from that request/);
    assert.match(naming, /supported host-provided capability available to the agent.*only the current conversation\/thread/);
    assert.match(naming, /at most once per conversation.*preserve an explicitly user-chosen title/);
    assert.match(naming, /unavailable or fails, silently continue.*without asking the user or retrying/);
    assert.match(naming, /Never modify host internal files or databases or invent unsupported commands/);
    assert.doesNotMatch(naming, /Codex|Claude|Cursor|set_thread_title|\/rename|thread\/name\/set/);

    const before = await client.callTool({ name: PRODERO_TOOLS.status, arguments: { projectRoot: root } });
    assert.equal(before.structuredContent?.product, "Prodero");
    assert.equal(before.structuredContent?.phase, "initial");
    assert.equal(before.structuredContent?.project.initialized, false);
    assert.equal(before.structuredContent?.project.knowledgeCount, undefined);
    assert.deepEqual(timings.map((timing) => timing.phase), ["fast-status", "first-tool-response"], "one status call performs no detailed work or internal retry");

    await fs.writeFile(path.join(root, "AGENTS.md"), "# User content\n\nPreserve this.\n");
    const initialized = await client.callTool({ name: PRODERO_TOOLS.initialize, arguments: { projectRoot: root } });
    assert.equal(initialized.structuredContent?.status.project.initialized, true);
    assert.equal((await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).includes("Preserve this."), true);
    const agentsBefore = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    await client.callTool({ name: PRODERO_TOOLS.initialize, arguments: { projectRoot: root } });
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), agentsBefore);

    const cache = path.join(root, ".prodero", ".cache");
    await fs.rm(cache, { recursive: true, force: true });
    const coldFast = await client.callTool({ name: PRODERO_TOOLS.status, arguments: { projectRoot: root } });
    assert.equal(coldFast.structuredContent?.phase, "initial");
    await assert.rejects(fs.stat(cache), { code: "ENOENT" }, "the MCP fast response must precede cache reconstruction");
    const coldDetails = await client.callTool({ name: PRODERO_TOOLS.statusDetails, arguments: { projectRoot: root } });
    assert.equal(coldDetails.structuredContent?.phase, "ready");
    assert.equal((await fs.stat(path.join(cache, "memory-index.json"))).isFile(), true);
    assert.equal((await fs.stat(path.join(cache, "session-index.json"))).isFile(), true);

    const prepared = await client.callTool({ name: PRODERO_TOOLS.prepare, arguments: { projectRoot: root, task: "change MCP status UI", agent: "codex" } });
    assert.match(prepared.structuredContent?.result.session.id, /^sess_/);
    assert.match(prepared.structuredContent?.result.session.path, /^\.prodero\/sessions\//);
    assert.equal(prepared.structuredContent?.result.context.metrics.estimated, true);
    assert.equal(prepared.structuredContent?.result.context.snapshot.sessionId, prepared.structuredContent?.result.session.id);
    assert.equal(prepared.structuredContent?.result.agentUsage, null);
    assert.match(prepared.content[0].text, /^Prodero prepared \d+ relevant knowledge item\(s\) and \d+ skill\(s\) for this task\.$/);
    const context = await client.callTool({ name: PRODERO_TOOLS.context, arguments: { projectRoot: root, task: "MCP UI" } });
    assert.equal(context.structuredContent?.action, "context");

    await fs.writeFile(path.join(root, ".prodero", "sessions", "mcp-session.md"), "---\nstatus: closed\n---\n# MCP session\n\n## Discoveries\n\n- Shared Core works.\n");
    const pending = await client.callTool({ name: PRODERO_TOOLS.statusDetails, arguments: { projectRoot: root } });
    assert.equal(pending.structuredContent?.phase, "ready");
    assert.equal(pending.structuredContent?.project.pendingSessionCount, 1);
    const synced = await client.callTool({ name: PRODERO_TOOLS.sync, arguments: { projectRoot: root } });
    assert.equal(synced.structuredContent?.result.recovery.sessions, 1);
    assert.equal(synced.structuredContent?.result.state, "awaiting_selection");
    assert.equal(synced.structuredContent?.result.recovery.created, 1);
    assert.equal((await getProjectStatus(root)).pendingSessionCount, 0);
    assert.equal((await getProjectStatus(root)).checkpointCount, 1);

    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === PRODERO_RESOURCE_URI));
    assert.ok(resources.resources.some((resource) => resource.uri === PRODERO_LIFECYCLE_RESOURCE_URI));
    const resource = await client.readResource({ uri: PRODERO_RESOURCE_URI });
    assert.match(resource.contents[0].text, /Prodero · Project Intelligence/);
    for (const toolName of [PRODERO_TOOLS.open, PRODERO_TOOLS.status, PRODERO_TOOLS.statusDetails, PRODERO_TOOLS.initialize, PRODERO_TOOLS.sync, PRODERO_TOOLS.checkUpdate, PRODERO_TOOLS.update]) assert.match(resource.contents[0].text, new RegExp(toolName));
    assert.doesNotMatch(resource.contents[0].text, /Record Decision|Close Session/);
    assert.match(resource.contents[0].text, /Context Ready/);
    assert.match(resource.contents[0].text, /View context/);
    assert.match(resource.contents[0].text, /Prepared context/);
    assert.match(resource.contents[0].text, /Provided to agent/);
    assert.match(resource.contents[0].text, /Additional matches/);
    assert.match(resource.contents[0].text, /Why selected/);
    assert.match(resource.contents[0].text, /Retrieval was not rerun/);
    assert.match(resource.contents[0].text, /Session Learned/);
    assert.match(resource.contents[0].text, /Attention/);
    assert.match(resource.contents[0].text, /Analyzing…/);
    assert.doesNotMatch(resource.contents[0].text, /Preparing project intelligence/);
    assert.match(resource.contents[0].text, /NEW PROJECT DETECTED/);
    assert.match(resource.contents[0].text, /Prodero will create/);
    assert.match(resource.contents[0].text, /managed AGENTS instructions/);
    assert.doesNotMatch(resource.contents[0].text, /Retry details/);
    assert.doesNotMatch(resource.contents[0].text, /hydrateAfterVisiblePaint/);
    assert.doesNotMatch(resource.contents[0].text, /queueMicrotask/, "microtasks cannot guarantee that the loading shell was painted");
    assert.match(resource.contents[0].text, /Sync Memory/);
    assert.match(resource.contents[0].text, /full context window or billing usage/);
    assert.doesNotMatch(resource.contents[0].text, /total model tokens|provider cost/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP server starts over stdio", async () => {
  const checkout = fileURLToPath(new URL("..", import.meta.url));
  const transport = new StdioClientTransport({ command: path.join(checkout, "bin/prodero"), args: ["mcp", "--dev", "--checkout", checkout], cwd: checkout, stderr: "pipe" });
  const client = new Client({ name: "prodero-stdio-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === PRODERO_TOOLS.status));
    assert.equal(client.getInstructions(), PRODERO_MCP_INSTRUCTIONS);
  } finally {
    await client.close();
  }
});

test("MCP records batched observations, closes idempotently, and prepare auto-syncs provenance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-mcp-session-test-"));
  await fs.mkdir(path.join(root, ".git"));
  const server = createServer({projectRoot:root});
  const client = new Client({ name: "prodero-session-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await client.callTool({ name: PRODERO_TOOLS.initialize, arguments: { projectRoot: root } });
    const prepared = await client.callTool({ name: PRODERO_TOOLS.prepare, arguments: { projectRoot: root, task: "implement session recording", agent: "codex" } });
    const sessionId = prepared.structuredContent.result.session.id;

    const recorded = await client.callTool({ name: PRODERO_TOOLS.sessionRecord, arguments: {
      projectRoot: root,
      sessionId,
      entries: [
        { type: "decision", content: "Session writes use atomic Markdown replacement.", title: "Atomic session writes", scopeHint: "global", importanceHint: "important" },
        { type: "lesson", content: "Batch related durable observations to reduce tool noise.", scopeHint: "task", scopeRef: "sessions" },
      ],
    } });
    assert.equal(recorded.structuredContent.result.recorded.length, 2);
    assert.ok(recorded.structuredContent.result.recorded.every((entry) => /^obs_/.test(entry.id)));
    const markdown = await fs.readFile(path.join(root, ".prodero", "sessions", `${sessionId}.md`), "utf8");
    assert.match(markdown, /## Decisions/);
    assert.match(markdown, /id=obs_/);
    assert.match(markdown, /Atomic session writes/);

    const activePrepare = await client.callTool({ name: PRODERO_TOOLS.prepare, arguments: { projectRoot: root, task: "continue work", agent: "codex", sessionId } });
    assert.equal(activePrepare.structuredContent.result.session.id, sessionId);
    assert.equal(activePrepare.structuredContent.result.automaticSync.sessions, 0, "active session must not auto-sync");

    const closed = await client.callTool({ name: PRODERO_TOOLS.sessionClose, arguments: {
      projectRoot: root,
      sessionId,
      finalEntries: [{ type: "state_change", content: "Agent-native session recording is available through MCP.", title: "MCP session recording" }],
    } });
    assert.equal(closed.structuredContent.result.session.status, "closed");
    assert.equal(closed.structuredContent.result.recorded.length, 1);
    assert.equal(closed.structuredContent.result.learned.observations, 3);
    assert.equal(closed.structuredContent.result.learned.syncState, "synchronized");
    const duplicateClose = await client.callTool({ name: PRODERO_TOOLS.sessionClose, arguments: { projectRoot: root, sessionId } });
    assert.equal(duplicateClose.structuredContent.result.alreadyClosed, true);
    const rejected = await client.callTool({ name: PRODERO_TOOLS.sessionRecord, arguments: { projectRoot: root, sessionId, entries: [{ type: "lesson", content: "Must fail." }] } });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /closed/i);

    const next = await client.callTool({ name: PRODERO_TOOLS.prepare, arguments: { projectRoot: root, task: "atomic session MCP work", agent: "codex" } });
    assert.equal(next.structuredContent.result.automaticSync.sessions, 0);
    assert.notEqual(next.structuredContent.result.session.id, sessionId);
    const memory = await listKnowledge(root);
    assert.ok(memory.some((item) => item.sourceSessions.includes(sessionId)));
    assert.ok(memory.some((item) => item.derivedFrom.some((source) => source.startsWith(`${sessionId}#obs_`))));
  } finally {
    await client.close();
    await server.close();
  }
});

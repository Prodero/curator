import { readAgentInstructions } from "./helpers/agent-instructions.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { compareVersions, checkForUpdate, installLatest, updateInstructions, LocalCheckoutReleaseSource, LocalManifestReleaseSource, UnconfiguredReleaseSource } from "../dist/core/update.js";
import { initializeProject, refreshProjectIntegration } from "../dist/core/project.js";
import { MIGRATIONS, migrateProject, migrationPlan } from "../dist/core/migrations.js";
import { loadMemoryCatalog } from "../dist/core/memory-index.js";
import { loadKnowledgeGraph } from "../dist/core/knowledge-graph.js";
import { renderKnowledge, writeKnowledge } from "../dist/core/memory.js";
import { readConfig, writeConfig } from "../dist/core/storage.js";
import { createServer, PRODERO_TOOLS } from "../dist/server.js";
import { PRODERO_VERSION, NEXT_RUNTIME_VERSION } from "./helpers/runtime-version.mjs";

async function releaseFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-release-"));
  const artifact = Buffer.from("deterministic prodero release artifact\n");
  await fs.writeFile(path.join(root, "release.tgz"), artifact);
  const release = options.release ?? {
    version: options.version ?? "0.2.0", schemaVersion: options.schemaVersion ?? 8, releaseId: "release-0.2.0",
    publishedAt: "2026-09-05T00:00:00.000Z", artifact: { locator: "release.tgz", integrity: `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}` },
  };
  await fs.writeFile(path.join(root, "manifest.json"), `${JSON.stringify({ formatVersion: 1, release, ...(options.outcome ? { simulation: { outcome: options.outcome, message: options.message } } : {}) }, null, 2)}\n`);
  return { root, source: new LocalManifestReleaseSource(path.join(root, "manifest.json"), path.join(root, "state")) };
}

test("strict semantic version comparison handles precedence and rejects malformed versions", () => {
  assert.equal(PRODERO_VERSION, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.equal(compareVersions(NEXT_RUNTIME_VERSION, PRODERO_VERSION), 1, "the fake available release must be a semantic upgrade");
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0+build.7"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.throws(() => compareVersions("1.0", "1.0.0"), /Invalid semantic version/);
});

test("update checks report installed, available, current, unavailable, and invalid releases", async () => {
  const newer = await releaseFixture();
  assert.deepEqual(await checkForUpdate(newer.source, "0.1.0"), {
    current: "0.1.0", latest: "0.2.0", available: true, source: "local-manifest", status: "update-available",
    installedSchemaVersion: 8, availableSchemaVersion: 8, manualUpdateCommand: "prodero update", developmentOnly: true,
  });
  const current = await releaseFixture({ version: "0.1.0", release: { ...(await newer.source.latest()), version: "0.1.0", releaseId: "release-current" } });
  assert.equal((await checkForUpdate(current.source, "0.1.0")).status, "current");
  assert.equal((await checkForUpdate(new UnconfiguredReleaseSource(), "0.1.0")).status, "unavailable");
  const invalid = await releaseFixture({ release: { version: "next", schemaVersion: 5 } });
  const invalidCheck = await checkForUpdate(invalid.source, "0.1.0");
  assert.equal(invalidCheck.status, "invalid"); assert.equal(invalidCheck.latest, null); assert.match(invalidCheck.error, /PRODERO_INVALID_ARGUMENT/);
});

test("successful local update verifies and stages a release without touching project knowledge", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-update-project-"));
  await fs.mkdir(path.join(project, ".git")); await initializeProject(project);
  const item = { id: "mem_update_safety", scope: "global", scopeRef: null, category: "decision", priority: "important", status: "active", title: "Update safety", content: "Runtime updates never rewrite project knowledge.", createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z", sourceSessions: ["sess_source"], derivedFrom: ["sess_source#obs"], supersedes: [], related: [], relations: [] };
  await writeKnowledge(project, item, false, "versioned"); await writeKnowledge(project, { ...item, id: "mem_update_local", title: "Local safety" }, false, "local");
  const versionedBefore = await fs.readFile(path.join(project, ".prodero/memory/mem_update_safety.md"), "utf8");
  const localBefore = await fs.readFile(path.join(project, ".prodero/local/memory/mem_update_local.md"), "utf8");
  const fixture = await releaseFixture();
  const result = await installLatest(fixture.source, "0.1.0");
  assert.equal(result.ok, true); assert.equal(result.status, "restart-required"); assert.equal(result.restartRequired, true);
  assert.equal(result.installedVersion, "0.1.0", "the supplied synthetic installed version remains unchanged");
  assert.equal(result.availableVersion, "0.2.0"); assert.match(result.message, /Restart the Prodero MCP runtime/);
  const pending = JSON.parse(await fs.readFile(path.join(fixture.root, "state/pending.json"), "utf8"));
  assert.equal(pending.release.version, "0.2.0"); assert.equal((await fs.stat(pending.stagedPath)).isFile(), true);
  assert.equal(await fs.readFile(path.join(project, ".prodero/memory/mem_update_safety.md"), "utf8"), versionedBefore);
  assert.equal(await fs.readFile(path.join(project, ".prodero/local/memory/mem_update_local.md"), "utf8"), localBefore);
});

test("failed and interrupted updates leave no activation marker", async () => {
  for (const outcome of ["failed", "interrupted"]) {
    const fixture = await releaseFixture({ outcome, message: `${outcome} fixture` });
    const result = await installLatest(fixture.source, "0.1.0");
    assert.equal(result.ok, false); assert.equal(result.status, outcome); assert.equal(result.restartRequired, false);
    await assert.rejects(fs.stat(path.join(fixture.root, "state/pending.json")), { code: "ENOENT" });
  }
  const fixture = await releaseFixture();
  const manifest = JSON.parse(await fs.readFile(path.join(fixture.root, "manifest.json"), "utf8"));
  manifest.release.artifact.integrity = `sha256:${"0".repeat(64)}`;
  await fs.writeFile(path.join(fixture.root, "manifest.json"), JSON.stringify(manifest));
  const result = await installLatest(fixture.source, "0.1.0");
  assert.equal(result.status, "failed"); assert.match(result.message, /integrity verification failed/);
  await assert.rejects(fs.stat(path.join(fixture.root, "state/pending.json")), { code: "ENOENT" });
});

test("a development checkout becomes a same-version one-click update after its sources change", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-local-checkout-"));
  await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "scripts"));
  await fs.writeFile(path.join(root, "src/index.ts"), "export const build = 1;\n");
  await fs.writeFile(path.join(root, "scripts/build.mjs"), "import fs from 'node:fs/promises'; await fs.writeFile('built.txt', 'ok\\n');\n");
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "local-prodero-fixture", version: "0.1.0", scripts: { build: "node scripts/build.mjs" } }, null, 2)}\n`);
  await fs.writeFile(path.join(root, "prodero.release.json"), '{"formatVersion":1,"schemaVersion":8}\n');
  const source = new LocalCheckoutReleaseSource(root);
  assert.equal((await checkForUpdate(source, "0.1.0")).available, false);
  await fs.writeFile(path.join(root, "src/index.ts"), "export const build = 2;\n");
  const checked = await checkForUpdate(source, "0.1.0");
  assert.equal(checked.available, true); assert.equal(checked.latest, "0.1.0"); assert.equal(checked.source, "local-checkout");
  const result = await installLatest(source, "0.1.0");
  assert.equal(result.status, "restart-required"); assert.equal(await fs.readFile(path.join(root, "built.txt"), "utf8"), "ok\n");
});

test("local release metadata exposes a future schema bump before runtime restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-local-schema-"));
  await fs.mkdir(path.join(root, "src")); await fs.writeFile(path.join(root, "src/index.ts"), "export {};\n");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"schema-fixture","version":"0.2.0","scripts":{"build":"node -e \\\"\\\""}}\n');
  await fs.writeFile(path.join(root, "prodero.release.json"), '{"formatVersion":1,"schemaVersion":8}\n');
  const source = new LocalCheckoutReleaseSource(root);
  await fs.writeFile(path.join(root, "prodero.release.json"), '{"formatVersion":1,"schemaVersion":9}\n');
  const checked = await checkForUpdate(source, "0.1.0");
  assert.equal(checked.available, true); assert.equal(checked.availableSchemaVersion, 9);
});

test("schema migration preserves both knowledge layers and sessions while invalidating disposable indexes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-update-migration-"));
  await fs.mkdir(path.join(root, ".git")); await initializeProject(root);
  const base = { id: "mem_versioned", scope: "global", scopeRef: null, category: "decision", priority: "important", status: "active", title: "Versioned", content: "Versioned knowledge remains byte-identical.", createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z", sourceSessions: ["sess_source"], derivedFrom: ["sess_source#obs"], supersedes: [], related: [], relations: [] };
  await writeKnowledge(root, base, false, "versioned"); await writeKnowledge(root, { ...base, id: "mem_local", title: "Local", content: "Local knowledge remains byte-identical." }, false, "local");
  const sessionPath = path.join(root, ".prodero/sessions/preserved-session.md"); await fs.writeFile(sessionPath, "preserved session\n");
  await loadMemoryCatalog(root); await loadKnowledgeGraph(root);
  await fs.writeFile(path.join(root, ".prodero/.cache/session-index.json"), "{}\n");
  const before = await Promise.all([path.join(root, ".prodero/memory/mem_versioned.md"), path.join(root, ".prodero/local/memory/mem_local.md"), sessionPath].map((file) => fs.readFile(file, "utf8")));
  const config = await readConfig(root); config.schemaVersion = 4; await writeConfig(root, config);
  assert.deepEqual(migrationPlan(4).map((step) => ({ from: step.from, to: step.to, modifiesVersionedKnowledge: step.modifiesVersionedKnowledge })), [{ from: 4, to: 5, modifiesVersionedKnowledge: false }, {from:5,to:6,modifiesVersionedKnowledge:false}, {from:6,to:7,modifiesVersionedKnowledge:false}, {from:7,to:8,modifiesVersionedKnowledge:false}]);
  const migrated = await migrateProject(root, config); assert.equal(migrated.migrated, true); assert.equal(migrated.to, 8); assert.ok(migrated.backup);
  const after = await Promise.all([path.join(root, ".prodero/memory/mem_versioned.md"), path.join(root, ".prodero/local/memory/mem_local.md"), sessionPath].map((file) => fs.readFile(file, "utf8")));
  assert.deepEqual(after, before);
  for (const name of ["memory-index.json", "session-index.json", "knowledge-graph.json"]) assert.ok(await fs.stat(path.join(root, ".prodero/.cache", name)));
  const catalog = await loadMemoryCatalog(root); const graph = await loadKnowledgeGraph(root, catalog);
  assert.equal(catalog.summaries.length, 2); assert.equal(graph.diagnostics.nodeCount, 2);
});

test("a migration cannot silently rewrite Versioned Knowledge unless its descriptor declares it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-migration-guard-"));
  await fs.mkdir(path.join(root, ".git")); await initializeProject(root);
  const memoryPath = path.join(root, ".prodero/memory/guard.md"); await writeKnowledge(root, {id:"guard",category:"state",scope:"global",scopeRef:null,priority:"normal",status:"active",title:"Guard",content:"Original",createdAt:"2026-09-01T00:00:00Z",updatedAt:"2026-09-01T00:00:00Z",sourceSessions:[],derivedFrom:[],supersedes:[],related:[]});
  const originalBytes=await fs.readFile(memoryPath,"utf8");
  const config = await readConfig(root); config.schemaVersion = 4; await writeConfig(root, config);
  const original = MIGRATIONS[4];
  MIGRATIONS[4] = { ...original, modifiesVersionedKnowledge: false, run: async (stage) => fs.writeFile(path.join(stage,".prodero/memory/guard.md"), "unexpected\n") };
  try { await assert.rejects(migrateProject(root, config), /modified Versioned Knowledge without declaring it/); }
  finally { MIGRATIONS[4] = original; }
  assert.equal(await fs.readFile(memoryPath, "utf8"), originalBytes);
  assert.equal((await readConfig(root)).schemaVersion, 4);
});

test("MCP update checks use the injected source but update instructions never invoke its installation hooks", async () => {
  const fixture = await releaseFixture({version:NEXT_RUNTIME_VERSION}); const server = createServer({ releaseSource: fixture.source });
  const client = new Client({ name: "update-test", version: "1.0.0" }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const checked = await client.callTool({ name: PRODERO_TOOLS.checkUpdate, arguments: {} });
    assert.equal(checked.structuredContent.update.current, PRODERO_VERSION); assert.equal(checked.structuredContent.update.latest, NEXT_RUNTIME_VERSION); assert.equal(checked.structuredContent.update.available,true);
    fixture.source.latest=()=>{throw new Error('instructions must not check or stage');};fixture.source.stage=()=>{throw new Error('instructions must not check or stage');};
    const tool=(await client.listTools()).tools.find(t=>t.name===PRODERO_TOOLS.update);assert.equal(tool.annotations.readOnlyHint,true);assert.match(tool.title,/Instructions/);assert.match(tool.description,/never installs/);
    const updated = await client.callTool({ name: PRODERO_TOOLS.update, arguments: {} });
    assert.equal(updated.isError,undefined);assert.equal(updated.structuredContent.status, "manual-update"); assert.equal(updated.structuredContent.restartRequired, false);assert.equal(updated.structuredContent.instructionOnly,true);
    assert.match(updated.content[0].text.replace(/\n│ ?/g,' '),/terminal, run prodero update/);assert.match(updated.content[0].text.replace(/\n│ ?/g,' '),/close your MCP hosts/);assert.match(updated.content[0].text.replace(/\n│ ?/g,' '),/restart and reconnect/);assert.match(updated.content[0].text.replace(/\n│ ?/g,' '),/migration separately/);
    await assert.rejects(fs.access(path.join(fixture.root,'state')),{code:'ENOENT'});
  } finally { await client.close(); await server.close(); }
});

test("explicit MCP update leaves stale project integration untouched while the separate refresh API still works", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-project-refresh-"));
  await fs.mkdir(path.join(root, ".git")); await initializeProject(root);
  const memoryPath = path.join(root, ".prodero/memory/preserved.md"); await writeKnowledge(root, {id:"preserved",category:"state",scope:"global",scopeRef:null,priority:"normal",status:"active",title:"Preserved",content:"Versioned knowledge bytes",createdAt:"2026-09-01T00:00:00Z",updatedAt:"2026-09-01T00:00:00Z",sourceSessions:[],derivedFrom:[],supersedes:[],related:[]});
  await fs.writeFile(path.join(root, "AGENTS.md"), "# User instructions\n\n<!-- prodero:start -->\nstale managed instructions\n<!-- prodero:end -->\n\n# Keep this\n");
  const before = await fs.readFile(memoryPath, "utf8");
  const refresh = await refreshProjectIntegration(root);
  assert.ok(refresh.changedFiles.includes("AGENTS.md")); assert.ok(refresh.changedFiles.includes(".prodero/index.md"));
  const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(await readAgentInstructions(root), /Normal session learning and conversational remember operations produce Local Knowledge/);
  assert.match(agents, /# User instructions/); assert.match(agents, /# Keep this/); assert.equal(await fs.readFile(memoryPath, "utf8"), before);

  await fs.writeFile(path.join(root, "AGENTS.md"), agents.replace("prodero_instructions_read", "Stale pointer:"));
  const staleAgents=await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),configBefore=await fs.readFile(path.join(root,'.prodero/config.json'),'utf8');
  const currentFixture = await releaseFixture({ version: PRODERO_VERSION });
  const server = createServer({ projectRoot:root, releaseSource: currentFixture.source }); const client = new Client({ name: "refresh-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const updated = await client.callTool({ name: PRODERO_TOOLS.update, arguments: { projectRoot: root } });
    assert.equal(updated.structuredContent.status, "manual-update");assert.equal(updated.structuredContent.projectMaintenance,undefined);
    assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),staleAgents);assert.equal(await fs.readFile(path.join(root,'.prodero/config.json'),'utf8'),configBefore);assert.equal(await fs.readFile(memoryPath,'utf8'),before);
  } finally { await client.close(); await server.close(); }
});

test("MCP update with a development release never stages runtime or schedules deferred project maintenance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-deferred-refresh-"));
  await fs.mkdir(path.join(root, ".git")); await initializeProject(root);
  const fixture = await releaseFixture(); const server = createServer({ projectRoot:root, releaseSource: fixture.source });
  const client = new Client({ name: "deferred-refresh-test", version: "1.0.0" }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const updated = await client.callTool({ name: PRODERO_TOOLS.update, arguments: { projectRoot: root } });
    assert.equal(updated.structuredContent.status, "manual-update");assert.equal(updated.structuredContent.instructionOnly,true);assert.equal(updated.structuredContent.projectMaintenance,undefined);
    await assert.rejects(fs.stat(path.join(root, ".prodero/.cache/runtime-maintenance.json")),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(fixture.root,'state')),{code:'ENOENT'});
  } finally { await client.close(); await server.close(); }
});

test('instructions are inert across npm, unconfigured and custom source identities',()=>{
 for(const id of ['npm','unconfigured','local-manifest','local-checkout','custom-source']){
  const source={id,latest(){throw new Error('must not read release');},stage(){throw new Error('must not install');}};
  const result=updateInstructions(source,'0.1.0');assert.equal(result.command,'prodero update');assert.equal(result.installedVersion,'0.1.0');assert.equal(result.availableVersion,null);assert.equal(result.restartRequired,false);assert.equal(result.instructionOnly,true);
 }
});

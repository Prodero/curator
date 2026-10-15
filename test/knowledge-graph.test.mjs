import { fakeProvider } from './helpers/intelligence-provider.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeProjectSession,
  getDetailedProjectStatus,
  initializeProject,
  prepareProject,
  recordProjectSession,
  rememberProjectKnowledge,
  resolveProjectContext,
} from "../dist/core/project.js";
import { loadKnowledgeGraph } from "../dist/core/knowledge-graph.js";
import { writeKnowledge } from "../dist/core/memory.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-knowledge-graph-"));
  await fs.mkdir(path.join(root, ".git"));
  await initializeProject(root);
  return root;
}

const graphPath = (root) => path.join(root, ".prodero", ".cache", "knowledge-graph.json");

test("derived graph rebuilds deterministically and explicit relationships expand relevant context", async () => {
  const root = await fixture();
  const protocol = await rememberProjectKnowledge(root, { title: "Queue protocol", content: "The queue protocol uses durable acknowledgements.", scope: "project", kind: "decision" });
  const worker = await rememberProjectKnowledge(root, {
    title: "Delivery worker", content: "Delivery workers use bounded retries.", scope: "project", kind: "decision",
    relationships: [{ type: "depends_on", target: protocol.item.id }],
  });
  const first = JSON.parse(await fs.readFile(graphPath(root), "utf8"));
  assert.ok(first.edges.some((edge) => edge.from === worker.item.id && edge.to === protocol.item.id && edge.type === "depends_on" && edge.inferred === false));

  const context = await resolveProjectContext(root, "change delivery workers and bounded retries");
  assert.ok(context.relevant.some((item) => item.id === worker.item.id));
  assert.ok(context.relevant.some((item) => item.id === protocol.item.id), "the dependency is useful even without lexical overlap");
  assert.ok(context.selection.relevant[protocol.item.id].signals.some((signal) => signal.kind === "graph-edge"));
  assert.equal(context.selection.graphTraversal.expandedItems, 1);

  await fs.rm(path.join(root, ".prodero", ".cache"), { recursive: true, force: true });
  const rebuilt = await loadKnowledgeGraph(root);
  const second = JSON.parse(await fs.readFile(graphPath(root), "utf8"));
  assert.deepEqual(second, first);
  assert.equal(rebuilt.diagnostics.cacheState, "missing");
  await fs.writeFile(graphPath(root), "not-json\n");
  const recovered = await loadKnowledgeGraph(root);
  assert.equal(recovered.diagnostics.cacheState, "invalid");
  assert.deepEqual(JSON.parse(await fs.readFile(graphPath(root), "utf8")), first);
});

test("graph traversal preserves path relevance and remains strictly bounded", async () => {
  const root = await fixture();
  const targets = [];
  for (let index = 0; index < 7; index += 1) {
    targets.push(await rememberProjectKnowledge(root, { title: `Dependency ${index}`, content: `Dependency ${index} owns isolated behavior ${index}.`, scope: "project", kind: "fact" }));
  }
  const legacy = await rememberProjectKnowledge(root, { title: "Legacy codec", content: "The legacy codec uses a fixed wire header.", scope: "path", path: "src/legacy", kind: "fact" });
  const hub = await rememberProjectKnowledge(root, {
    title: "Release coordinator", content: "The release coordinator validates deployment manifests.", scope: "project", kind: "rule",
    relationships: [...targets.map((target) => ({ type: "depends_on", target: target.item.id })), { type: "depends_on", target: legacy.item.id }],
  });

  const unrelated = await resolveProjectContext(root, "change release coordinator deployment manifests");
  assert.equal(unrelated.selection.graphTraversal.expandedItems, 4);
  assert.ok(!unrelated.relevant.some((item) => item.id === legacy.item.id), "a graph edge cannot bypass path relevance");
  assert.ok(unrelated.selection.graphTraversal.traversedEdges <= 32);
  assert.ok(unrelated.relevant.filter((item) => targets.some((target) => target.item.id === item.id)).length <= 4);

  const scoped = await resolveProjectContext(root, "change release coordinator in src/legacy/codec.ts");
  assert.ok(scoped.relevant.some((item) => item.id === legacy.item.id));
  assert.ok(scoped.relevant.some((item) => item.id === hub.item.id), "inferred instructions participate in relevance retrieval");
  assert.ok(!scoped.required.some((item) => item.id === hub.item.id));
});

test("supersession, contradiction, provenance, and scope become typed graph edges", async () => {
  const root = await fixture();
  const old = await rememberProjectKnowledge(root, { title: "API mode", content: "The API uses compatibility mode.", kind: "decision" });
  const replacement = await rememberProjectKnowledge(root, { content: "The API uses strict mode.", replaceId: old.item.id });

  const prepared = await prepareProject(root, { task: "record conflicting transport decisions" });
  await recordProjectSession(root, prepared.session.id, [
    { type: "decision", title: "Transport state", content: "The transport is enabled.", scopeHint: "global", importanceHint: "normal" },
    { type: "decision", title: "Transport state", content: "The transport is disabled.", scopeHint: "global", importanceHint: "normal" },
  ]);
  const configPath=path.join(root,'.prodero/config.json');
  const config=JSON.parse(await fs.readFile(configPath,'utf8'));config.knowledgeEngine={mode:'assisted'};
  await fs.writeFile(configPath,JSON.stringify(config));
  const provider=fakeProvider({reconcile:({candidate,related})=>{
    const old=related.find(m=>m.title==='Transport state');
    return {actions:[{action:old?'CONFLICT':'CREATE',classification:old?'potential_conflict':'independent',sources:[candidate.id,...(old?[old.id]:[])],canonical:null,reason:'Incompatible claims about the same transport state.'}]};
  }});
  await closeProjectSession(root, prepared.session.id, [], false);
  await (await import("../dist/core/project.js")).syncProject(root, { provider });

  const graph = await loadKnowledgeGraph(root);
  assert.ok(graph.edges.some((edge) => edge.from === replacement.item.id && edge.to === old.item.id && edge.type === "supersedes"));
  assert.ok(graph.edges.some((edge) => edge.type === "contradicts"));
  assert.ok(graph.edges.some((edge) => edge.from === replacement.item.id && edge.type === "learned_from" && edge.to.startsWith("session:")));
  const status = await getDetailedProjectStatus(root);
  assert.equal(status.knowledgeGraph.conflictEdges, 1);
  assert.equal(status.knowledgeGraph.brokenReferences, 0);
});

test("consolidation preserves explicit relationships while merging compatible knowledge", async () => {
  const root = await fixture();
  const dependency = await rememberProjectKnowledge(root, { title: "Storage boundary", content: "Storage writes are atomic.", kind: "decision" });
  const first = await rememberProjectKnowledge(root, { title: "Commit protocol", content: "Commits validate their inputs.", kind: "rule" });
  const merged = await rememberProjectKnowledge(root, {
    title: "Commit protocol", content: "Commits validate their inputs. Commits persist through the storage boundary.", kind: "rule",
    relationships: [{ type: "depends_on", target: dependency.item.id }],
  });
  assert.equal(merged.item.id, first.item.id);
  assert.deepEqual(merged.item.relations, [{ type: "depends_on", target: dependency.item.id }]);
  const graph = await loadKnowledgeGraph(root);
  assert.ok(graph.edges.some((edge) => edge.from === first.item.id && edge.to === dependency.item.id && edge.type === "depends_on"));

  const replacement = await rememberProjectKnowledge(root, { content: "Storage writes use atomic replacement and directory-local rename.", replaceId: dependency.item.id });
  const redirected = await loadKnowledgeGraph(root);
  assert.ok(redirected.edges.some((edge) => edge.from === first.item.id && edge.to === replacement.item.id && edge.type === "depends_on" && edge.inferred));
  const context = await resolveProjectContext(root, "change commit protocol input validation");
  assert.ok(context.relevant.some((item) => item.id === replacement.item.id));
  assert.ok(!context.relevant.some((item) => item.id === dependency.item.id), "superseded targets never return as current context");
});

test("graph diagnostics expose stale rebuilds and broken canonical references", async () => {
  const root = await fixture();
  const remembered = await rememberProjectKnowledge(root, { title: "Diagnostic node", content: "Graph diagnostics remain compact.", kind: "fact" });
  remembered.item.relations = [{ type: "depends_on", target: "mem_missing_reference" }];
  await writeKnowledge(root, remembered.item, false, "local");
  const graph = await loadKnowledgeGraph(root);
  assert.equal(graph.diagnostics.cacheState, "stale");
  assert.equal(graph.diagnostics.brokenReferences, 1);
  const status = await getDetailedProjectStatus(root);
  assert.equal(status.knowledgeGraph.brokenReferences, 1);
});

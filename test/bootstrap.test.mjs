import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, PRODERO_TOOLS } from "../dist/server.js";
import { initializeProject, prepareProject, rememberCurrentUserRule, rememberProjectKnowledge } from "../dist/core/project.js";
import { writeKnowledge } from "../dist/core/memory.js";
import { listSessions } from "../dist/core/sessions.js";
import { lifecycleUi } from "./helpers/lifecycle-ui.mjs";

const rememberRule=(root,input)=>rememberCurrentUserRule(root,input,{...input,turnId:'fixture-user-turn',userText:input.content,mandatory:true});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-bootstrap-"));
  await fs.mkdir(path.join(root, ".git"));
  await initializeProject(root);
  return root;
}

async function connected(root) {
  const server = createServer({projectRoot:root});
  const client = new Client({ name: "bootstrap-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args = {}) => client.callTool({ name, arguments: { projectRoot: root, ...args } });
  return { server, client, call };
}

test("open loads only applicable required instructions without creating a session", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const globalRule = await rememberRule(root, { title: "Language", content: "Always respond in Russian.", scope: "global", kind: "rule", importance: "critical" });
  const projectRule = await rememberRule(root, { title: "Checks", content: "Run focused checks before reporting completion.", scope: "project", kind: "rule", importance: "critical" });
  const pathRule = await rememberRule(root, { title: "Legacy path", content: "Review compatibility before editing legacy handlers.", scope: "path", path: "src/legacy", kind: "rule" });
  const decision = await rememberProjectKnowledge(root, { title: "Runtime", content: "The runtime uses Node.js.", scope: "global", kind: "decision", importance: "critical" });
  const sessionsBefore = (await listSessions(root)).length;
  const { server, client, call } = await connected(root);
  t.after(async () => { await client.close(); await server.close(); });

  const opened = await call(PRODERO_TOOLS.open);
  const bootstrap = opened.structuredContent.bootstrap;
  assert.equal(bootstrap.loaded, true);
  assert.deepEqual(bootstrap.instructions.map((item) => item.id).sort(), [globalRule.item.id, projectRule.item.id].sort());
  assert.ok(!bootstrap.instructions.some((item) => item.id === decision.item.id), "decisions stay out of bootstrap even when critical");
  assert.ok(!bootstrap.instructions.some((item) => item.id === pathRule.item.id), "path instructions require an applicable scope");
  assert.ok(bootstrap.instructions.every((item) => item.kind === "instruction" && item.enforcement === "required"));
  assert.equal((await listSessions(root)).length, sessionsBefore, "open does not create a work session");
  assert.deepEqual((await call(PRODERO_TOOLS.open)).structuredContent.bootstrap, bootstrap, "bootstrap selection is deterministic");

  const scoped = (await call(PRODERO_TOOLS.open, { scope: "src/legacy/request.ts" })).structuredContent.bootstrap;
  assert.ok(scoped.instructions.some((item) => item.id === pathRule.item.id));
  assert.equal((await listSessions(root)).length, sessionsBefore);

  const status = await call(PRODERO_TOOLS.status);
  assert.equal(status.structuredContent.bootstrap, undefined, "status remains independent of bootstrap retrieval");
  assert.equal((await listSessions(root)).length, sessionsBefore);
});

test("legacy instruction memory gains enforcement semantics and prepare works without open", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = new Date().toISOString();
  await writeKnowledge(root, {
    id: "mem_legacy_instruction", scope: "global", scopeRef: null, category: "instruction", priority: "normal", status: "active",
    title: "Legacy language preference", content: "Always answer in the user's preferred language.", createdAt: now, updatedAt: now,
    sourceSessions: ["sess_legacy"], derivedFrom: ["sess_legacy#obs_1"], supersedes: [], related: [],
  }, false, "versioned");

  const prepared = await prepareProject(root, { task: "inspect bootstrap behavior", agent: "test" });
  const legacy = prepared.context.required.find((item) => item.id === "mem_legacy_instruction");
  assert.ok(legacy, "normal-priority legacy instructions are independently required by prepare");
  assert.equal(legacy.kind, "instruction");
  assert.equal(legacy.enforcement, "required");
});

test("open exposes conflicting required instructions instead of choosing one", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const common = { scope: "global", scopeRef: null, category: "instruction", priority: "critical", status: "disputed", createdAt: now, updatedAt: now, sourceSessions: ["sess_conflict"], supersedes: [] };
  await writeKnowledge(root, { ...common, id: "mem_language_a", title: "Response language", content: "Always respond in Russian.", derivedFrom: ["sess_conflict#obs_a"], related: ["mem_language_b"] }, false, "versioned");
  await writeKnowledge(root, { ...common, id: "mem_language_b", title: "Response language", content: "Always respond in English.", derivedFrom: ["sess_conflict#obs_b"], related: ["mem_language_a"] }, false, "versioned");
  const { server, client, call } = await connected(root);
  t.after(async () => { await client.close(); await server.close(); });

  const bootstrap = (await call(PRODERO_TOOLS.open)).structuredContent.bootstrap;
  assert.deepEqual(bootstrap.instructions.map((item) => item.id).sort(), ["mem_language_a", "mem_language_b"]);
  assert.ok(bootstrap.instructions.every((item) => item.status === "disputed"));
  assert.match(bootstrap.warnings.join("\n"), /Conflicting required instructions: Response language/);
});

test("open UI clearly presents loaded Bootstrap Context and warnings", async () => {
  const ui = await lifecycleUi();
  const payload = {
    product: "Prodero", action: "open", phase: "initial", hydrationRequired: false, runtimeVersion: "0.1.0",
    project: { root: "/tmp/project", name: "project", initialized: true, git: true, agentsFile: true, schemaVersion: 5, canonicalStructure: true },
    update: { current: "0.1.0", latest: null, available: false, source: "checking" },
    bootstrap: { loaded: true, scope: null, instructions: [{ id: "mem_language", title: "Language", content: "Always respond in Russian.", scope: "global", scopeRef: null, priority: "critical", kind: "instruction", enforcement: "required" }], warnings: ["Conflicting required instructions require review."], metrics: { estimatedTokens: 14, omittedInstructions: 0 } },
  };
  const html = ui.render(payload);
  for (const label of ["Bootstrap Context", "Loaded · 1 required instruction", "model-visible, not system-level", "Language", "Always respond in Russian.", "required · global", "Conflicting required instructions require review."]) assert.ok(html.includes(label), label);
});


test('explicit chat rule survives a fresh MCP connection and loads as Required at startup',async t=>{
 const root=await fixture();t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const first=await connected(root);
 const content='Always communicate with the user in Russian. Write code, documentation, and commit messages in English.';
 const userInstruction='запомни всегда говори в чате со мной по русски, а код, документацию и коммиты по английски';
 const r=await first.call(PRODERO_TOOLS.remember,{content,title:'Language preferences',kind:'rule',required:true,userInstruction});
 assert.equal(r.isError,undefined,JSON.stringify(r));
 assert.equal(r.structuredContent.result.item.contextPolicy,'required');assert.equal(r.structuredContent.result.item.authority,'explicit_user');
 assert.equal(r.structuredContent.result.item.applicability.kind,'project');
 assert.ok(r.structuredContent.result.item.evidence.some(e=>e.ref==='chat-user-request: '+userInstruction));
 await first.client.close();await first.server.close();
 const next=await connected(root);t.after(async()=>{await next.client.close();await next.server.close();});
 const b=(await next.call(PRODERO_TOOLS.open)).structuredContent.bootstrap;
 assert.deepEqual(b.instructions.map(i=>i.content),[content]);assert.equal(b.guidance,undefined);
 const prepared=await prepareProject(root,{task:'Edit README.md'});assert.ok(prepared.context.required.some(i=>i.id===r.structuredContent.result.item.id));
});

test('chat Required is explicit and scoped; ordinary Relevant rules stay out of startup',async t=>{
 const root=await fixture();t.after(()=>fs.rm(root,{recursive:true,force:true}));const {server,client,call}=await connected(root);t.after(async()=>{await client.close();await server.close();});
 const content='Use isolated fixtures when testing billing.';
 for(const fields of [{required:true,kind:'rule'},{required:true,kind:'fact',userInstruction:'Remember this fact.'},{kind:'rule',userInstruction:'Remember this rule.'}]){
  assert.equal((await call(PRODERO_TOOLS.remember,{content,...fields})).isError,true);
 }
 await call(PRODERO_TOOLS.remember,{content:'Prefer short replies.',kind:'rule',scope:'project'});
 const saved=await call(PRODERO_TOOLS.remember,{content,kind:'rule',required:true,userInstruction:'Always use isolated fixtures for billing tests.',scope:'path',path:'src/billing'});
 assert.equal(saved.structuredContent.result.item.contextPolicy,'required');
 assert.equal((await call(PRODERO_TOOLS.open)).structuredContent.bootstrap.instructions.length,0);
 assert.deepEqual((await call(PRODERO_TOOLS.open,{scope:'src/billing/test.ts'})).structuredContent.bootstrap.instructions.map(i=>i.content),[content]);
});

test('an explicit chat request can replace a previously Relevant language preference',async t=>{
 const root=await fixture();t.after(()=>fs.rm(root,{recursive:true,force:true}));const {server,client,call}=await connected(root);t.after(async()=>{await client.close();await server.close();});
 const content='Always communicate in Russian.';
 const previous=(await call(PRODERO_TOOLS.remember,{content,kind:'rule',scope:'project'})).structuredContent.result.item;
 const saved=await call(PRODERO_TOOLS.remember,{content,kind:'rule',scope:'project',required:true,userInstruction:'Make this language rule mandatory.',replaceId:previous.id});
 assert.equal(saved.isError,undefined,JSON.stringify(saved));assert.equal(saved.structuredContent.result.item.contextPolicy,'required');
 assert.equal((await call(PRODERO_TOOLS.open)).structuredContent.bootstrap.instructions[0].content,content);
});

test('open and prepare accept stored Markdown credential-field headings', async t => {
  const root = await fixture();
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const content = 'Harmless prose such as a `Privacy and authorization:` heading followed by `Automatic...` is documentation.';
  await rememberRule(root, {title:'Screening documentation',content,scope:'global',kind:'rule'});
  const {server,client,call} = await connected(root);
  t.after(async()=>{await client.close();await server.close();});
  for (let i=0;i<2;i++) {
    const opened=await call(PRODERO_TOOLS.open);
    assert.notEqual(opened.isError,true);
    assert.ok(opened.structuredContent.bootstrap.instructions.some(item=>item.content===content));
  }
  const prepared=await prepareProject(root,{task:'Check screening documentation'});
  assert.ok(prepared.context.required.some(item=>item.content===content));
});

test('open accepts stored PHP scope-resolution references', async t => {
 const root=await fixture();t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await rememberProjectKnowledge(root,{title:'Model queries',content:'Replaced direct SQL in api_token::assertIssuable with user::getRow and self::getList.',scope:'project'});
 const {server,client,call}=await connected(root);t.after(async()=>{await client.close();await server.close();});
 for(let i=0;i<2;i++) assert.notEqual((await call(PRODERO_TOOLS.open)).isError,true);
});

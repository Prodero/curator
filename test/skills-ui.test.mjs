import * as presentation from "../dist/presentation.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import * as contracts from "../dist/contracts.js";
import * as snapshots from "../dist/core/context-snapshot.js";

// Small DOM adapter: execute the real UI handlers against real MCP/Core operations.
// Layout/paint is intentionally outside this contract test.
class Element {
  listeners = new Map();
  constructor(attributes = {}) {
    this.attributes = attributes;
    this.dataset = Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value]));
    this.value = attributes.value ?? "";
  }
  addEventListener(event, callback) { this.listeners.set(event, callback); }
  click() { this.listeners.get("click")?.({ currentTarget: this }); }
}
class Host {
  elements = [];
  set innerHTML(html) {
    this.html = html;
    this.elements = [...html.matchAll(/<(button|input|textarea|form)\b([^>]*)>/g)].map((match) => {
      const attributes = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((attr) => [attr[1], attr[2]]));
      const element = new Element(attributes); element.tag = match[1]; return element;
    });
    const form = this.elements.find((element) => element.tag === "form");
    if (form) form.fields = this.elements.filter((element) => element.attributes.name);
  }
  get innerHTML() { return this.html; }
  querySelectorAll(selector) {
    const attr = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]/);
    return this.elements.filter((element) => (!selector.startsWith("button") || element.tag === "button") && (!attr || Object.hasOwn(element.attributes, attr[1]) && (attr[2] === undefined || element.attributes[attr[1]] === attr[2])));
  }
  querySelector(selector) {
    if (selector === "#skill-form") return this.elements.find((element) => element.tag === "form") ?? null;
    return this.querySelectorAll(selector)[0] ?? null;
  }
}
class FormDataStub {
  constructor(form) { this.values = form.fields.map((field) => [field.attributes.name, field.value]); }
  entries() { return this.values.values(); }
  get(name) { return this.values.find(([key]) => key === name)?.[1] ?? null; }
}

test("Skills pagination only sends valid offsets, stops on the last page and allows retry after proxy failure", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-skills-pages-"));
  const server = createServer({projectRoot:root});
  const client = new Client({ name: "skills-pages", version: "1.0" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const call = (name, args = {}) => client.callTool({ name, arguments: { projectRoot: root, ...args } });
  await fs.mkdir(path.join(root, ".git"));
  await call(contracts.PRODERO_TOOLS.initialize);
  for (let i = 0; i < 21; i++) await call(contracts.PRODERO_TOOLS.skillCreate, {
    title: `Procedure ${String(i).padStart(2, "0")}`, description: "Pagination fixture", content: "Run project checks.", scope: "project", triggers: [],
  });
  const host = new Host();
  const calls = [];
  let app, failNext = false;
  class AppStub {
    constructor() { app = this; }
    connect() {}
    async callServerTool(request) {
      calls.push(request);
      if (failNext) { failNext = false; throw new Error("MCP error -32000: MCP proxy request failed"); }
      return client.callTool(request);
    }
  }
  const source = await fs.readFile(new URL("../src/ui/main.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const sandbox = vm.createContext({ exports: {}, require: (id) => id === "./card-disclosure.js" ? {mountCardDisclosure:()=>undefined} : id === "@modelcontextprotocol/ext-apps" ? { App: AppStub } : id.includes("contracts") ? contracts : id.includes("context-snapshot") ? snapshots : id.includes("presentation") ? presentation : {}, document: { querySelector: () => host }, FormData: FormDataStub });
  vm.runInContext(code, sandbox);
  const settle = async () => {
    for (let i = 0; i < 200 && vm.runInContext("busyAction !== null", sandbox); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(vm.runInContext("busyAction", sandbox), null);
  };
  const first = await call(contracts.PRODERO_TOOLS.skills);
  app.ontoolresult(first);
  assert.match(host.innerHTML, /Procedure 00/);
  assert.doesNotMatch(host.innerHTML, /Procedure 20/);
  assert.equal(host.querySelector('button[data-skills-action="first"]'), null);
  failNext = true;
  host.querySelector('button[data-skills-action="next"]').click(); await settle();
  assert.match(host.innerHTML, /MCP proxy request failed/);
  assert.match(host.innerHTML, /Procedure 00/);
  const staleNextButton = host.querySelector('button[data-skills-action="next"]');
  staleNextButton.click(); await settle();
  assert.equal(calls.at(-1).arguments.offset, 20);
  assert.match(host.innerHTML, /Procedure 20/);
  assert.doesNotMatch(host.innerHTML, /Procedure 00|MCP proxy request failed/);
  assert.equal(host.querySelector('button[data-skills-action="next"]'), null);
  const completedCalls = calls.length;
  staleNextButton.click(); await settle();
  assert.equal(calls.length, completedCalls, "a stale Next button must not send a null offset");
  host.querySelector('button[data-skills-action="first"]').click(); await settle();
  assert.equal(calls.at(-1).arguments.offset, 0);
  assert.match(host.innerHTML, /Procedure 00/);

  // Missing, null or malformed page metadata must not create a phantom Next button.
  for (const nextOffset of [undefined, null, "20", -1, 0, 0.5, 21, NaN, Infinity]) {
    const payload = structuredClone(first);
    if (nextOffset === undefined) delete payload.structuredContent.result.nextOffset;
    else payload.structuredContent.result.nextOffset = nextOffset;
    app.ontoolresult(payload);
    assert.equal(host.querySelector('button[data-skills-action="next"]'), null, `invalid nextOffset: ${nextOffset}`);
  }
  assert.ok(calls.every(({ arguments: args }) => args.projectRoot === root && Number.isSafeInteger(args.offset) && args.offset >= 0));
});

test("existing App opens Skills, promotes/dismisses candidates, saves explicit skills and retains failed drafts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-skills-ui-"));
  const server = createServer({projectRoot:root});
  const client = new Client({ name: "skills-ui", version: "1.0" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const calls = [];
  const call = async (name, args = {}) => client.callTool({ name, arguments: { projectRoot: root, ...args } });
  await fs.mkdir(path.join(root, ".git"));
  await call(contracts.PRODERO_TOOLS.initialize);
  const prepared = (await call(contracts.PRODERO_TOOLS.prepare)).structuredContent;
  await call(contracts.PRODERO_TOOLS.sessionRecord, { sessionId: prepared.result.session.id, entries: [
    { type: "skill_candidate", title: "Review alpha", content: "1. Inspect alpha.\n2. Run checks.", proposedReason: "Repeated twice." },
    { type: "skill_candidate", title: "Review beta", content: "Inspect beta." },
  ] });
  await call(contracts.PRODERO_TOOLS.sessionClose, { sessionId: prepared.result.session.id, sync: true });
  const host = new Host();
  let app;
  class AppStub {
    constructor() { app = this; }
    connect() {}
    async callServerTool(request) { calls.push(request); return client.callTool(request); }
  }
  const source = await fs.readFile(new URL("../src/ui/main.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const sandbox = vm.createContext({ exports: {}, require: (id) => id === "./card-disclosure.js" ? {mountCardDisclosure:()=>undefined} : id === "@modelcontextprotocol/ext-apps" ? { App: AppStub } : id.includes("contracts") ? contracts : id.includes("context-snapshot") ? snapshots : id.includes("presentation") ? presentation : {}, document: { querySelector: () => host }, FormData: FormDataStub, requestAnimationFrame: (callback) => callback(), setTimeout });
  vm.runInContext(code, sandbox);
  app.ontoolresult(await call(contracts.PRODERO_TOOLS.statusDetails));
  assert.match(host.innerHTML, /<strong>0<\/strong><span>active skills<\/span><small>2 candidates<\/small>/);
  const settle = async () => {
    for (let i = 0; i < 100 && vm.runInContext("busyAction !== null || statusRequest !== null", sandbox); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(vm.runInContext("busyAction", sandbox), null);
  };
  host.querySelector('button[data-action="skills"]').click(); await settle();
  assert.match(host.innerHTML, /Candidate skills/);
  assert.match(host.innerHTML, /Why proposed/);
  assert.match(host.innerHTML, /Repeated twice/);
  assert.match(host.innerHTML, /sess_/);
  host.querySelector('button[data-review="preview"]').click(); await settle();
  assert.match(host.innerHTML, /NEW PROJECT SKILL/);
  assert.match(host.innerHTML, /0 active · 2 candidates/);
  assert.equal(calls.at(-1).name, contracts.PRODERO_TOOLS.skillPreview);
  host.querySelector('button[data-skills-action="edit"]').click();
  host.querySelector('#skill-form [name="title"]').value = "Review alpha carefully";
  const revise = host.querySelector("#skill-form");
  revise.listeners.get("submit")({ preventDefault() {}, currentTarget: revise }); await settle();
  assert.match(host.innerHTML, /Review alpha carefully/);
  assert.match(host.innerHTML, /0 active · 2 candidates/);
  host.querySelector('button[data-skills-action="approve"]').click(); await settle();
  assert.match(host.innerHTML, /1 active · 1 candidates/);
  assert.equal(calls.at(-1).name, contracts.PRODERO_TOOLS.skillReview);
  assert.equal(calls.at(-1).arguments.action, "promote");
  host.querySelector('button[data-review="preview"]').click(); await settle();
  assert.match(host.innerHTML, /NEW PROJECT SKILL/);
  host.querySelector('button[data-skills-action="dismiss-preview"]').click(); await settle();
  assert.doesNotMatch(host.innerHTML, /NEW PROJECT SKILL/);
  assert.match(host.innerHTML, /1 active · 0 candidates/);
  assert.doesNotMatch(host.innerHTML, /<h3>Review beta<\/h3>/);
  host.querySelector('button[data-skills-action="create"]').click();
  const fill = (name, value) => { host.querySelector(`#skill-form [name="${name}"]`).value = value; };
  fill("title", "A deliberately incomplete draft"); fill("description", ""); fill("content", "Preserve this procedure after an error.");
  const submit = async () => { const form = host.querySelector("#skill-form"); form.listeners.get("submit")({ preventDefault() {}, currentTarget: form }); await settle(); };
  await submit();
  assert.equal(host.querySelector('#skill-form [name="content"]').value, "Preserve this procedure after an error.");
  fill("description", "Explicitly authored through the form.");
  await submit();
  assert.match(host.innerHTML, /2 active · 0 candidates/);
  assert.match(host.innerHTML, /Active project skill saved/);
  assert.equal(calls.at(-1).name, contracts.PRODERO_TOOLS.skillCreate);
  assert.equal(host.querySelector("#skill-form"), null);
  const records = (await call(contracts.PRODERO_TOOLS.skills)).structuredContent.result.skills;
  assert.equal(records.find((skill) => skill.title === "A deliberately incomplete draft").origin, "explicit-user");
  assert.ok(calls.every((request) => request.arguments.projectRoot === root));
});

test('reconnected stdio MCP App reviews a synthetic cache candidate entirely through UI and refreshes active skill and Status', async t => {
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { createProjectSkill, createSkillCandidate, getProjectSkill } = await import('../dist/core/skills.js');
  const { initializeProject } = await import('../dist/core/project.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-ui-reconnect-'));
  await fs.mkdir(path.join(root, '.git')); await initializeProject(root);
  // Explicit synthetic input/provenance; never read the maintainer's Local skills.
  const original = {
    title: 'Verify synthetic cache recovery', description: 'Exercise cache recovery in an isolated synthetic test project.',
    scope: 'project', triggers: ['testing disposable cache recovery'], references: [], relatedKnowledge: [],
    content: '1. Initialize a disposable synthetic project.\n2. Rebuild its derived cache.\n3. Verify the synthetic canonical records are unchanged.',
    sourceSessions: ['sess_synthetic_cache'], derivedFrom: ['sess_synthetic_cache#obs_synthetic_cache'],
    proposedReason: 'Synthetic reconnect and App review fixture.',
  };
  const { skill: candidate } = await createSkillCandidate(root, original, { sessionId: original.sourceSessions[0], derivedFrom: original.derivedFrom[0], proposedReason: original.proposedReason });
  // Force the promoted title beyond the first page: the result must still show the full new skill.
  for (let i = 0; i < 21; i++) await createProjectSkill(root, { title: `Alphabet ${i}`, description: 'Typography fixture', content: 'Inspect typography.' });
  let client;
  const connect = async () => {
    client = new Client({ name: 'ui-reconnect-dogfood', version: '1' }, { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', '--stdio', '--root', root], cwd: path.resolve('.'), stderr: 'pipe' }));
  };
  await connect();
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  const call = (name, args = {}) => client.callTool({ name, arguments: { projectRoot: root, ...args } });
  const preview = await call(contracts.PRODERO_TOOLS.skillPreview, { id: candidate.id });
  assert.equal(preview.structuredContent.approval.appSupportAdvertised, true);
  assert.match(preview.content[0].text, /Do not ask for approval in chat/);
  const tools = (await client.listTools()).tools;
  for (const name of [contracts.PRODERO_TOOLS.skillPreview, contracts.PRODERO_TOOLS.skillReview]) assert.equal(tools.find(t => t.name === name)._meta.ui.resourceUri, contracts.PRODERO_RESOURCE_URI);
  await client.close(); await connect();
  assert.match((await client.readResource({ uri: contracts.PRODERO_RESOURCE_URI })).contents[0].text, /dismiss-preview/);
  const host = new Host(); const calls = []; let app;
  class AppStub {
    constructor() { app = this; }
    connect() {}
    async callServerTool(request) { calls.push(request); return client.callTool(request); }
  }
  const source = await fs.readFile(new URL('../src/ui/main.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const sandbox = vm.createContext({ exports: {}, require: id => id === './card-disclosure.js' ? {mountCardDisclosure:()=>undefined} : id === '@modelcontextprotocol/ext-apps' ? { App: AppStub } : id.includes('contracts') ? contracts : id.includes('context-snapshot') ? snapshots : id.includes('presentation') ? presentation : {}, document: { querySelector: () => host }, FormData: FormDataStub, requestAnimationFrame: cb => cb(), setTimeout });
  vm.runInContext(code, sandbox);
  const settle = async () => {
    for (let i = 0; i < 300 && vm.runInContext('busyAction !== null || statusRequest !== null', sandbox); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(vm.runInContext('busyAction', sandbox), null);
  };
  app.ontoolresult(await call(contracts.PRODERO_TOOLS.statusDetails));
  app.ontoolresult(preview); // Host replays the attached review card after reconnect.
  assert.ok(host.querySelector('button[data-skills-action="approve"]'));
  assert.ok(host.querySelector('button[data-skills-action="edit"]'));
  assert.ok(host.querySelector('button[data-skills-action="dismiss-preview"]'));
  assert.equal((await getProjectSkill(root, candidate.id)).status, 'candidate');
  host.querySelector('button[data-skills-action="edit"]').click();
  host.querySelector('#skill-form [name="title"]').value = 'Test Disposable Cache Recovery';
  const form = host.querySelector('#skill-form'); form.listeners.get('submit')({ preventDefault() {}, currentTarget: form }); await settle();
  assert.equal((await getProjectSkill(root, candidate.id)).status, 'candidate');
  host.querySelector('button[data-skills-action="approve"]').click(); await settle();
  assert.match(host.innerHTML, /Added Project Skill/);
  assert.match(host.innerHTML, /Test Disposable Cache Recovery/);
  assert.ok(host.innerHTML.includes(original.content.split("\n").at(-1)));
  assert.match(host.innerHTML, /22 active · 0 candidates/);
  assert.equal(vm.runInContext('state.project.skillCount', sandbox), 22);
  assert.equal(vm.runInContext('state.project.skillCandidateCount', sandbox), 0);
  assert.equal(host.querySelector('button[data-skills-action="approve"]'), null);
  assert.deepEqual(calls.map(c => c.name), [contracts.PRODERO_TOOLS.skillPreview, contracts.PRODERO_TOOLS.skillReview]);
  // Explicit re-curation is also a review, never an immediate write. Exercise the
  // production form and new schema after reconnect without requiring sampling.
  const beforeRevision = await getProjectSkill(root, candidate.id);
  const recurateButton = () => host.querySelectorAll('button[data-review="recurate"]').find(button => button.dataset.skill === candidate.id);
  recurateButton().click(); await settle();
  assert.equal(calls.at(-1).arguments.recurate, true);
  assert.match(host.innerHTML, /UPDATE PROJECT SKILL/);
  assert.match(host.innerHTML, /Update Skill/);
  assert.equal(host.querySelector('button[data-skills-action="dismiss-preview"]'), null);
  assert.deepEqual(await getProjectSkill(root, candidate.id), beforeRevision);
  host.querySelector('button[data-skills-action="cancel-preview"]').click();
  assert.deepEqual(await getProjectSkill(root, candidate.id), beforeRevision);
  // The skill is beyond the first list page, so reopen its full detail.
  app.ontoolresult(await call(contracts.PRODERO_TOOLS.skills, { id: candidate.id }));
  recurateButton().click(); await settle();
  host.querySelector('button[data-skills-action="edit"]').click();
  host.querySelector('#skill-form [name="description"]').value = 'Verify derived cache recovery in disposable projects.';
  const revisionForm = host.querySelector('#skill-form');
  revisionForm.listeners.get('submit')({ preventDefault() {}, currentTarget: revisionForm }); await settle();
  assert.ok(calls.at(-1).arguments.previousPreview);
  assert.equal(calls.at(-1).arguments.recurate, undefined);
  const approvedDraft = JSON.parse(JSON.stringify(calls.at(-1).arguments.draft));
  assert.match(host.innerHTML, /Your revised draft/);
  assert.deepEqual(await getProjectSkill(root, candidate.id), beforeRevision);
  host.querySelector('button[data-skills-action="approve"]').click(); await settle();
  assert.match(host.innerHTML, /Updated Project Skill/);
  assert.match(host.innerHTML, /22 active · 0 candidates/);
  const afterRevision = await getProjectSkill(root, candidate.id);
  for (const [key, value] of Object.entries(approvedDraft)) assert.deepEqual(afterRevision[key], value);
  assert.deepEqual(afterRevision.derivedFrom, beforeRevision.derivedFrom);
  const prepared = (await call(contracts.PRODERO_TOOLS.prepare, { task: 'Fix cache recovery' })).structuredContent;
  assert.deepEqual(prepared.result.context.skills.map(s => s.id), [candidate.id]);
  assert.ok(prepared.result.context.skills[0].content.includes(original.content));
  await call(contracts.PRODERO_TOOLS.sessionClose, { sessionId: prepared.result.session.id });
  host.querySelector('button[data-skills-action="back"]').click(); await settle();
  assert.match(host.innerHTML, /<strong>22<\/strong><span>active skills<\/span>/);
  assert.doesNotMatch(host.innerHTML, /candidates/);
  assert.equal((await getProjectSkill(root, candidate.id)).promotedTo, candidate.id);
});

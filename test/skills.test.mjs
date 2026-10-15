import { readAgentInstructions } from "./helpers/agent-instructions.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, PRODERO_TOOLS, PRODERO_RESOURCE_URI } from "../dist/server.js";
import { createProjectSkill, createSkillCandidate, getProjectSkill, listProjectSkills, parseSkill, renderSkill, reviewProjectSkill, skillContext, projectSkillsView, previewProjectSkill } from "../dist/core/skills.js";
import { buildIndex, initializeProject, listKnowledge, prepareProject, recordProjectSession, closeProjectSession, resolveProjectContext, syncProject, getProjectStatus } from "../dist/core/project.js";
import { getContext } from "../dist/core/context.js";
import { estimateTokens } from "../dist/core/telemetry.js";

const input = { title: "Verify MCP changes", description: "Validate protocol and embedded interface changes.", scope: "src/server", triggers: ["tool contracts", "MCP UI changes"], content: "1. Build the server.\n2. Build the App.\n\n```sh\nnpm test\n```" };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prodero-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".git"));
  await initializeProject(root);
  return root;
}

test("explicit creation serializes readable independent Markdown files with unique IDs", async (t) => {
  const root = await fixture(t);
  const indexBefore = await fs.readFile(path.join(root, ".prodero/index.md"), "utf8");
  const skills = await Promise.all(Array.from({ length: 12 }, () => createProjectSkill(root, input)));
  assert.equal(new Set(skills.map((s) => s.id)).size, 12);
  assert.equal(new Set(skills.map((s) => s.path)).size, 12);
  assert.equal((await listProjectSkills(root)).length, 12);
  for (const skill of skills) {
    assert.equal(skill.status, "active");
    assert.equal(skill.origin, "explicit-user");
    assert.match(skill.id, /^skill_\d{17}_[a-f0-9]{12}$/);
    const markdown = await fs.readFile(path.join(root, ".prodero", skill.path), "utf8");
    assert.match(markdown, /^---\nkind: project-skill\nversion: 2/);
    assert.match(markdown, /status: active/);
    assert.ok(markdown.includes(input.content));
    assert.deepEqual(parseSkill(markdown, `${skill.id}.md`), skill);
  }
  assert.equal(await fs.readFile(path.join(root, ".prodero/index.md"), "utf8"), indexBefore, "creation changes only its own canonical file");
  assert.deepEqual(await listKnowledge(root), []);
  assert.deepEqual((await fs.readdir(path.join(root, ".prodero/skills"))).filter((name) => name !== ".gitkeep").sort(), skills.map((s) => `${s.id}.md`).sort());
  const special = await createProjectSkill(root, { ...input, title: "true", description: '"Quoted": [description]\nsecond line' });
  assert.deepEqual(parseSkill(renderSkill(special), `${special.id}.md`), special);
  await assert.rejects(createProjectSkill(root, { ...input, title: "  " }));
  await assert.rejects(getProjectSkill(root, "../../config"));
});

test("session candidates retain multiline procedures, reason and provenance without becoming knowledge", async (t) => {
  const root = await fixture(t);
  const prepared = await prepareProject(root, { task: "MCP UI changes" });
  const recorded = await recordProjectSession(root, prepared.session.id, [{
    type: "skill_candidate", ...input, title: 'Review [MCP] "UI"', scopeHint: "module", scopeRef: "src/server", proposedReason: 'Repeated during "UI" work [twice].',
  }]);
  const closed = await closeProjectSession(root, prepared.session.id);
  const next = await prepareProject(root, { task: "MCP UI changes" });
  const synced = closed.synchronization;
  assert.equal(next.automaticSync.sessionsProcessed, 0);
  assert.equal(synced.skillCandidatesCreated, 1);
  assert.equal(synced.knowledgeCreated, 0);
  assert.equal(synced.observationsProcessed, 1);
  assert.ok(synced.skillCandidateTokensAdded > 0);
  assert.equal(synced.canonicalTokensAdded, 0);
  assert.equal(synced.rawKnowledgeTokens, 0);
  assert.equal(synced.rawSkillCandidateTokens, estimateTokens(input.content));
  assert.equal(synced.memoryCompression.kind, "unavailable");
  assert.deepEqual(next.context.skills, []);
  const [candidate] = await listProjectSkills(root);
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.content, input.content);
  assert.equal(candidate.description, input.description);
  assert.deepEqual(candidate.triggers, input.triggers);
  assert.equal(candidate.title, 'Review [MCP] "UI"');
  assert.equal(candidate.proposedReason, 'Repeated during "UI" work [twice].');
  assert.deepEqual(candidate.sourceSessions, [prepared.session.id]);
  assert.deepEqual(candidate.derivedFrom, [`${prepared.session.id}#${recorded.recorded[0].id}`]);
  assert.deepEqual(await listKnowledge(root), []);
  assert.doesNotMatch(await buildIndex(root), /Review \[MCP\]/);
  const checkpoint = JSON.parse(await fs.readFile(path.join(root, ".prodero/checkpoints", `${synced.checkpoint}.json`), "utf8"));
  assert.deepEqual(checkpoint.createdSkills, [candidate.id]);
  assert.deepEqual(checkpoint.createdMemory, []);
  assert.equal((await getProjectStatus(root)).skillCandidateCount, 1);
  assert.equal((await syncProject(root)).skillCandidatesCreated, 0);
});

test("promotion and dismissal preserve provenance and survive replay without automatic reactivation", async (t) => {
  const root = await fixture(t);
  const provenance = { sessionId: "sess_source", derivedFrom: "sess_source#obs_procedure", proposedReason: "Recurring verification." };
  const { skill: candidate } = await createSkillCandidate(root, input, provenance);
  assert.equal(parseSkill(renderSkill(candidate).replace(/\n/g, "\r\n"), `${candidate.id}.md`).status, "candidate", "Git CRLF conversion cannot activate a candidate");
  assert.throws(() => parseSkill(renderSkill(candidate).replace("\n---\n", "\n"), `${candidate.id}.md`), /Invalid project skill frontmatter/);
  const active = await reviewProjectSkill(root, candidate.id, "promote", "Team accepted.", { approved: true, preview: await previewProjectSkill(root, candidate.id) });
  assert.equal(active.status, "active");
  assert.deepEqual(active.derivedFrom, candidate.derivedFrom);
  assert.deepEqual(active.sourceSessions, candidate.sourceSessions);
  assert.equal(active.proposedReason, candidate.proposedReason);
  assert.equal(active.createdAt, candidate.createdAt);
  assert.ok(active.reviewedAt);
  assert.equal(active.reviewReason, "Team accepted.");
  assert.equal((await resolveProjectContext(root, "MCP UI changes")).skills[0].id, active.id);
  const replay = await createSkillCandidate(root, input, provenance);
  assert.equal(replay.created, false);
  assert.equal(replay.skill.status, "active");
  await assert.rejects(reviewProjectSkill(root, active.id, "promote"), /Only candidate/);
  const second = (await createSkillCandidate(root, input, { ...provenance, derivedFrom: "sess_source#obs_rejected" })).skill;
  const dismissed = await reviewProjectSkill(root, second.id, "dismiss", "Too specific.");
  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.content, second.content);
  assert.equal(dismissed.proposedReason, second.proposedReason);
  assert.deepEqual(dismissed.derivedFrom, second.derivedFrom);
  assert.equal((await createSkillCandidate(root, input, { ...provenance, derivedFrom: "sess_source#obs_rejected" })).skill.status, "dismissed");
  await assert.rejects(reviewProjectSkill(root, dismissed.id, "promote"), /Only candidate/);
  assert.deepEqual((await resolveProjectContext(root, "MCP")).skills.map((s) => s.id), [active.id]);
  const status = await getProjectStatus(root);
  assert.equal(status.skillCount, 1);
  assert.equal(status.skillCandidateCount, 0);
  assert.equal(status.skillDismissedCount, 1);
  assert.equal((await projectSkillsView(root, { status: "dismissed" })).skills[0].id, second.id);
  await fs.rm(path.join(root, ".prodero/.cache"), { recursive: true });
  assert.equal((await getProjectSkill(root, second.id)).status, "dismissed");
});

test("title, description, triggers and scope select active skills deterministically without filename ranking", async (t) => {
  const root = await fixture(t);
  const skills = [];
  for (const [field, text] of [["title", "Albatross"], ["description", "Kingfisher"], ["triggers", ["Nightingale"]], ["scope", "src/pelican"]]) {
    skills.push(await createProjectSkill(root, { title: "Procedure", description: "Useful checks", triggers: [], scope: "project", content: "Perform steps. Secretbody", [field]: text }));
  }
  for (const [index, query] of ["albatross", "kingfisher", "nightingale", "pelican"].entries()) {
    const context = await resolveProjectContext(root, query);
    assert.deepEqual(context.skills.map((s) => s.id), [skills[index].id]);
    assert.ok(context.skills[0].signals.length);
    assert.deepEqual((await resolveProjectContext(root, query)).skills, context.skills);
    assert.equal(context.metrics.selectedSkillsTokens, estimateTokens(context.skills[0].content));
    assert.equal(context.metrics.projectKnowledgeTokens, 0);
    assert.equal(context.metrics.contextSelectivity, 0);
    assert.ok(context.metrics.skillSelectivity > 0);
  }
  assert.deepEqual((await resolveProjectContext(root, "Secretbody")).skills, []);
  assert.deepEqual((await resolveProjectContext(root, skills[0].id)).skills, []);
  assert.deepEqual((await resolveProjectContext(root, "")).skills, []);
});

test("skill retrieval bounds item count and tokens, skips oversized matches, accounts independently", async (t) => {
  const root = await fixture(t);
  await createProjectSkill(root, { ...input, title: "MCP huge", content: "Oversized procedure. ".repeat(900) });
  for (let i = 0; i < 7; i++) await createProjectSkill(root, { ...input, title: `MCP procedure ${i}` });
  const context = await getContext(root, "MCP");
  assert.equal(context.skills.length, 4);
  assert.ok(context.metrics.selectedSkillsTokens <= 1500);
  assert.equal(context.selection.omittedSkillsByBudget + context.selection.omittedSkillsByItemLimit, 4);
  assert.ok(!context.skills.some((skill) => skill.title === "MCP huge"));
  const bounded = await getContext(root, "MCP", { contextBudgetTokens: 100 });
  assert.ok(bounded.metrics.contextTokens <= 100);
  assert.ok(bounded.selection.omittedSkillsByBudget > 0);
  assert.equal(bounded.metrics.contextTokens, bounded.metrics.selectedSkillsTokens);
});

test("legacy Markdown skills stay compatible while invalid statuses fail closed", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, ".prodero/skills/old-procedure.md"), "# Legacy verification\n\nRun existing tests.\n");
  const [legacy] = await listProjectSkills(root);
  assert.equal(legacy.status, "active");
  assert.equal(legacy.origin, "legacy");
  assert.equal((await resolveProjectContext(root, "legacy")).skills.length, 1);
  await fs.writeFile(path.join(root, ".prodero/skills/old-metadata.md"), "---\nid: old-metadata\nkind: skill\nstatus: active\nscope: project\n---\n\n# Legacy metadata\n\nRun established checks.\n");
  assert.equal((await getProjectSkill(root, "old-metadata")).origin, "legacy");
  await fs.writeFile(path.join(root, ".prodero/skills/old-candidate.md"), "---\nid: old-candidate\nkind: skill\nstatus: candidate\n---\n\n# Legacy candidate\n\nRun proposed checks.\n");
  assert.equal((await getProjectSkill(root, "old-candidate")).status, "candidate");
  assert.ok(!(await resolveProjectContext(root, "legacy")).skills.some((skill) => skill.id === "old-candidate"));
  const active = await createProjectSkill(root, input);
  assert.throws(() => parseSkill(renderSkill(active).replace("status: active", "status: unknown"), `${active.id}.md`), /Invalid project skill/);
  assert.throws(() => parseSkill(renderSkill(active), "wrong.md"), /Invalid project skill ID/);
});

test("MCP create/list/get/review and Status/Skills App state follow explicit versus inferred intent", async (t) => {
  const root = await fixture(t);
  const server = createServer({projectRoot:root});
  const client = new Client({ name: "project-skills-test", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: { projectRoot: root, ...args } });
    assert.ok(!response.isError, JSON.stringify(response));
    return response.structuredContent;
  };
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find((tool) => tool.name === PRODERO_TOOLS.skills)._meta.ui.resourceUri, PRODERO_RESOURCE_URI);
  assert.match(tools.find((tool) => tool.name === PRODERO_TOOLS.skillCreate).description, /explicitly/);
  assert.match(client.getInstructions(), /Only promote a candidate on explicit user intent/);
  const created = await call(PRODERO_TOOLS.skillCreate, input);
  assert.equal(created.skill.status, "active");
  assert.equal(created.uiState.view, "skills");
  assert.equal(created.result.counts.active, 1);
  const got = await call(PRODERO_TOOLS.skills, { id: created.skill.id });
  assert.equal(got.skill.content, input.content);
  const prepared = await call(PRODERO_TOOLS.prepare, { task: "MCP" });
  await call(PRODERO_TOOLS.sessionRecord, { sessionId: prepared.result.session.id, entries: [
    { type: "skill_candidate", ...input, title: "Candidate A", proposedReason: "Repeated twice." },
    { type: "skill_candidate", ...input, title: "Candidate B" },
  ] });
  await call(PRODERO_TOOLS.sessionClose, { sessionId: prepared.result.session.id, sync: true });
  const listing = await call(PRODERO_TOOLS.skills);
  assert.equal(listing.result.counts.candidate, 2);
  assert.equal(listing.result.counts.active, 1);
  assert.ok(listing.result.skills.every((skill) => !Object.hasOwn(skill, "content") && skill.contentPreview.length <= 500));
  const candidates = listing.result.skills.filter((skill) => skill.status === "candidate");
  const added = await call(PRODERO_TOOLS.skillReview, { id: candidates[0].id, action: "promote", approved: true, preview: (await call(PRODERO_TOOLS.skillPreview, { id: candidates[0].id })).preview });
  assert.equal(added.result.counts.active, 2);
  const rejected = await call(PRODERO_TOOLS.skillReview, { id: candidates[1].id, action: "dismiss", reason: "Not recurring." });
  assert.equal(rejected.result.counts.candidate, 0);
  assert.equal(rejected.result.counts.dismissed, 1);
  assert.equal((await call(PRODERO_TOOLS.skills, { id: candidates[1].id })).skill.reviewReason, "Not recurring.");
  const status = await call(PRODERO_TOOLS.statusDetails);
  assert.equal(status.project.skillCount, 2);
  assert.equal(status.project.skillCandidateCount, 0);
  assert.equal(status.project.knowledgeCount, 0);
  const page = await call(PRODERO_TOOLS.skills, { limit: 1 });
  assert.equal(page.result.skills.length, 1);
  assert.equal(page.result.nextOffset, 1);
  const second = await call(PRODERO_TOOLS.skills, { limit: 1, offset: 1 });
  assert.notEqual(second.result.skills[0].id, page.result.skills[0].id);
  const resource = await client.readResource({ uri: PRODERO_RESOURCE_URI });
  assert.match(resource.contents[0].text, /Active skills/);
  assert.match(resource.contents[0].text, /Candidate skills/);
  assert.match(resource.contents[0].text, /Add Skill/);
  assert.match(resource.contents[0].text, /Dismiss/);
  assert.match(resource.contents[0].text, /Why proposed/);
});

test("Sync replay after a changed session keeps dismissed candidates and normal knowledge separate", async (t) => {
  const root = await fixture(t);
  const { session } = await prepareProject(root);
  const record = await recordProjectSession(root, session.id, [{ type: "skill_candidate", ...input }]);
  await syncProject(root);
  const [candidate] = await listProjectSkills(root);
  await reviewProjectSkill(root, candidate.id, "dismiss", "Rejected by team.");
  const before = await fs.readFile(path.join(root, ".prodero", candidate.path), "utf8");
  await recordProjectSession(root, session.id, [{ type: "decision", title: "Shared Core", content: "MCP and CLI use shared Core operations." }]);
  const synced = await syncProject(root);
  assert.equal(synced.skillCandidatesCreated, 0);
  assert.equal(synced.knowledgeCreated, 1);
  assert.equal(synced.observationsProcessed, 1, "checkpointed skill evidence is not processed again");
  assert.equal(await fs.readFile(path.join(root, ".prodero", candidate.path), "utf8"), before);
  assert.equal((await listProjectSkills(root)).length, 1);
  assert.ok((await listKnowledge(root)).every((item) => !item.derivedFrom.includes(`${session.id}#${record.recorded[0].id}`)));
});

test('agent reads multiple skills without App attachments while explicit Skills view remains available',async t=>{
 const root=await fixture(t);
 const skills=await Promise.all(['Shape','Work','Deliver'].map(title=>createProjectSkill(root,{...input,title})));
 const prepared=await prepareProject(root,{task:'Capture candidate'});
 await recordProjectSession(root,prepared.session.id,[{type:'skill_candidate',...input,title:'Pending procedure',scopeHint:'project'}]);
 await closeProjectSession(root,prepared.session.id);
 const server=createServer({projectRoot:root}),client=new Client({name:'skills-reader',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const instructions=client.getInstructions();
 for(const guidance of [instructions,await readAgentInstructions(root)]){
  assert.match(guidance,/use prodero_skills_read without opening UI/);
  assert.match(guidance,/briefly mention its name in chat only/);
  assert.match(guidance,/Reuse skill procedures already supplied by Prepare/);
 }
 const catalog=(await client.listTools()).tools;
 const reader=catalog.find(t=>t.name===PRODERO_TOOLS.skillsRead);
 assert.equal(reader._meta?.ui?.resourceUri,undefined);
 assert.equal(reader._meta?.['openai/outputTemplate'],undefined);
 assert.equal(reader.annotations.readOnlyHint,true);
 assert.equal(catalog.find(t=>t.name===PRODERO_TOOLS.skills)._meta.ui.resourceUri,PRODERO_RESOURCE_URI);
 assert.equal(catalog.find(t=>t.name===PRODERO_TOOLS.skillPreview)._meta.ui.resourceUri,PRODERO_RESOURCE_URI);
 const listed=await client.callTool({name:PRODERO_TOOLS.skillsRead,arguments:{projectRoot:root}});
 assert.deepEqual(listed.structuredContent.result.skills.map(s=>s.id).sort(),skills.map(s=>s.id).sort());
 for(const skill of skills){
  const result=await client.callTool({name:PRODERO_TOOLS.skillsRead,arguments:{projectRoot:root,id:skill.id}});
  assert.equal(result.structuredContent.skill.content,input.content);
  assert.equal(result.structuredContent.uiState,undefined);
  assert.equal(result.structuredContent.presentation?.card,undefined);
  assert.ok(result.content.some(c=>c.type==='text'&&c.text.includes('Build the server.')));
 }
});

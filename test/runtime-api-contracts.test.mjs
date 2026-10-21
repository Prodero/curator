import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { curationResponse } from './helpers/skill-curator.mjs';
import { createServer } from '../dist/server.js';
import { PRODERO_TOOLS as T } from '../dist/contracts.js';
import { initializeProject } from '../dist/core/project.js';
import { writeKnowledge } from '../dist/core/memory.js';
import { getMemory } from '../dist/core/memory-operations.js';
import { createSkillCandidate, createProjectSkill, getProjectSkill, renderSkill } from '../dist/core/skills.js';
import { readConfig, writeConfig, listCheckpoints } from '../dist/core/storage.js';
import { setProjectSetting, projectSettings } from '../dist/core/settings.js';

const apps = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
const skillInput = { title: 'Verify Harbor queue recovery', description: 'Verify Harbor queue recovery in a disposable fixture.', scope: 'global', triggers: ['queue recovery'], content: '1. Create a disposable Harbor fixture.\n2. Check the queue state.\n\n```md\n## Procedure\nKeep this nested example intact.\n```\n\n3. Preserve the original queue journal.', references: ['test/harbor-fixture.mjs'] };
function item(id, extra = {}) { return { id, scope:'global',scopeRef:null,category:'state',priority:'normal',status:'active',title:`Harbor ${id}`,content:`Harbor ${id} uses a durable amber queue.`,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[],relations:[],...extra }; }
async function fixture(t, capabilities = {}) {
  const root = await fs.mkdtemp('/tmp/prodero-runtime-contracts-');
  await fs.mkdir(path.join(root,'.git')); await initializeProject(root);
  const server = createServer({projectRoot:root});
  const client = new Client({name:'runtime-contract-test',version:'1'}, {capabilities});
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); await fs.rm(root,{recursive:true,force:true}); });
  const call = (name,args={}) => client.callTool({name,arguments:{projectRoot:root,...args}});
  const text = (tool,args={}) => client.callTool({name:T.text,arguments:{tool,arguments:{projectRoot:root,...args}}});
  return {root,client,call,text};
}
async function candidate(root) { return (await createSkillCandidate(root,skillInput,{sessionId:'sess_fixture',derivedFrom:'sess_fixture#obs_queue',proposedReason:'Repeated synthetic queue checks.'})).skill; }
async function modes(root,shared,local) {
  const config = await readConfig(root); config.presentation = {...config.presentation,mode:shared}; await writeConfig(root,config);
  if (local) await setProjectSetting(root,'presentation.mode',local);
}
function ok(result) { assert.ok(!result.isError,JSON.stringify(result)); return result.structuredContent; }
function complete(result) { assert.ok(result.content[0].text.includes(skillInput.content)); assert.equal(result.structuredContent.presentation.text,result.content[0].text); }
async function canonical(root) {
  // Ignore only the self-excluding transaction directory marker; retain every
  // journal, checkpoint, session, preference and canonical record in comparisons.
  const files = {};
  async function walk(dir) { for (const e of await fs.readdir(dir,{withFileTypes:true})) { if(e.name === '.cache') continue; const p=path.join(dir,e.name), relative=path.relative(root,p); if(relative === '.prodero/.transactions/.gitignore') { assert.equal(await fs.readFile(p,'utf8'),'*\n'); continue; } if(e.isDirectory()) await walk(p); else files[relative] = await fs.readFile(p,'utf8'); } }
  await walk(path.join(root,'.prodero')); return files;
}

test('Skill Preview uses effective local text over shared UI, preserves complete exact draft, and gateway review retains consent/stale guards',async t => {
  const {root,client,call,text} = await fixture(t,apps); const skill=await candidate(root); await modes(root,'ui','text');
  const before=await canonical(root), checkpoints=(await listCheckpoints(root)).length;
  const direct=await call(T.skillPreview,{id:skill.id}); const d=ok(direct);
  assert.equal(d.approval.surface,'chat'); assert.equal(d.presentation.resolved,'text'); complete(direct);
  assert.equal(d.projectSettings.presentationSources.mode,'local override');
  const catalog=await client.listTools(); const gateway=catalog.tools.find(x=>x.name===T.text);
  assert.equal(gateway._meta?.ui?.resourceUri,undefined);
  for(const tool of [T.skillPreview,T.skillReview]) assert.ok(gateway.inputSchema.properties.tool.enum.includes(tool));
  const explicit=await call(T.skillPreview,{id:skill.id,presentation:'text'}); complete(explicit); assert.equal(ok(explicit).presentation.scope,'invocation');
  const previewed=await text(T.skillPreview,{id:skill.id}); complete(previewed); const preview=ok(previewed).preview;
  assert.equal(previewed._meta?.ui?.resourceUri,undefined);
  assert.deepEqual(await canonical(root),before); assert.equal((await listCheckpoints(root)).length,checkpoints);
  for (const args of [{},{approved:false,preview},{approved:true}]) assert.equal((await text(T.skillReview,{id:skill.id,action:'promote',...args})).isError,true);
  const tampered=structuredClone(preview); tampered.draft.content+='\n4. Destroy the journal.';
  assert.equal((await text(T.skillReview,{id:skill.id,action:'promote',approved:true,preview:tampered})).isError,true);
  await fs.writeFile(path.join(root,'.prodero',skill.path),renderSkill({...skill,proposedReason:'Changed independent evidence.'}));
  assert.equal((await text(T.skillReview,{id:skill.id,action:'promote',approved:true,preview})).isError,true);
  assert.equal((await getProjectSkill(root,skill.id)).status,'candidate');
  const fresh=ok(await text(T.skillPreview,{id:skill.id})).preview;
  const accepted=ok(await text(T.skillReview,{id:skill.id,action:'promote',approved:true,preview:fresh}));
  assert.equal(accepted.skill.status,'active'); assert.equal(accepted.presentation.resolved,'text');
  assert.equal((await projectSettings(root)).presentation.mode,'text');
});

test('Skill Preview uses local UI over shared text; explicit text gateway overrides once without persisting',async t => {
  const {root,client,call,text}=await fixture(t,apps); const skill=await candidate(root); await modes(root,'text','ui');
  const uiResult=await call(T.skillPreview,{id:skill.id}); const ui=ok(uiResult); assert.ok(uiResult.content[0].text.includes(skillInput.content)); assert.match(uiResult.content[0].text,/Only if this host cannot render/); assert.equal(ui.presentation.resolved,'ui'); assert.equal(ui.approval.surface,'mcp-app'); assert.equal(ui.approval.chatFallback,'only-if-app-cannot-render');
  const catalog=await client.listTools(); assert.ok(catalog.tools.find(x=>x.name===T.skillPreview)._meta.ui.resourceUri);
  const preview=await text(T.skillPreview,{id:skill.id}); complete(preview); assert.equal(ok(preview).approval.surface,'chat'); assert.equal(ok(preview).presentation.scope,'invocation');
  assert.equal((await projectSettings(root)).presentation.mode,'ui'); assert.equal((await getProjectSkill(root,skill.id)).status,'candidate');
});

for (const mode of ['auto','ui']) test(`Skill Preview without advertised Apps respects ${mode} and supplies complete fallback`,async t=>{
  const {root,call,text}=await fixture(t); const skill=await candidate(root); await modes(root,mode);
  const result=await call(T.skillPreview,{id:skill.id}); const data=ok(result);
  assert.equal(data.approval.appSupportAdvertised,false); assert.ok(result.content[0].text.includes(skillInput.content));
  assert.equal(data.approval.surface,'chat');
  assert.equal(data.presentation.resolved,mode==='auto'?'text':'ui');
  assert.match(result.content[0].text,/Show the complete preview in chat/); if(mode==='auto') complete(result);
  const explicit=await text(T.skillPreview,{id:skill.id}); complete(explicit); assert.equal(ok(explicit).approval.surface,'chat');
  assert.equal((await getProjectSkill(root,skill.id)).status,'candidate');
});

test('MCP Remember supports canonical legacy references while retaining supersession and current-target guards',async t=>{
  const {root,call}=await fixture(t);
  for(const id of ['legacy-source','legacy-target','mem_hyphen-target','legacy-historical']) await writeKnowledge(root,item(id,{...(id==='legacy-historical'?{status:'deprecated'}:{})}),false,'local');
  const search=ok(await call(T.memorySearch,{query:'legacy-target'})); assert.ok(search.result.matches.some(x=>x.id==='legacy-target'&&x.layer==='local'));
  const changed=ok(await call(T.remember,{replaceId:'legacy-source',title:'Harbor queue policy',content:'Harbor workers preserve the queue journal before recovery.',relationships:[{type:'depends_on',target:'legacy-target'},{type:'related_to',target:'mem_hyphen-target'}]})).result;
  assert.equal(changed.outcome,'updated'); assert.equal(changed.replacedId,'legacy-source'); assert.match(changed.item.id,/^mem_/); assert.notEqual(changed.item.id,'legacy-source'); assert.deepEqual(changed.item.supersedes,['legacy-source']);
  assert.equal((await getMemory(root,'legacy-source')).status,'superseded'); assert.equal((await getMemory(root,'legacy-source')).content,item('legacy-source').content);
  assert.ok(changed.item.relations.some(x=>x.target==='legacy-target')); assert.ok(changed.item.relations.some(x=>x.target==='mem_hyphen-target'));
  const before=await canonical(root);
  for(const args of [{replaceId:'legacy-source'},{relationships:[{type:'related_to',target:'legacy-historical'}]},{relationships:[{type:'related_to',target:'missing-legacy'}]}]) {
    const result=await call(T.remember,{content:'Harbor worker recovery retains its journal.',...args}); assert.equal(result.isError,true);
  }
  assert.deepEqual(await canonical(root),before);
});

test('MCP Forget preserves Local history and cannot silently retire Versioned; repository maintenance requires exact current revision',async t=>{
  const {root,call}=await fixture(t); await writeKnowledge(root,item('legacy-local'),false,'local'); await writeKnowledge(root,item('legacy-repository'));
  const retired=ok(await call(T.forget,{id:'legacy-local'})).result; assert.equal(retired.forgotten,true); assert.equal((await getMemory(root,'legacy-local')).status,'deprecated');
  assert.equal(ok(await call(T.memorySearch,{query:'legacy-local'})).result.matches.length,0);
  assert.ok(ok(await call(T.memorySearch,{query:'legacy-local',includeHistorical:true})).result.matches.some(x=>x.id==='legacy-local'));
  const detail=ok(await call(T.knowledge,{id:'legacy-repository'})).result.detail;
  const before=await canonical(root);
  assert.equal((await call(T.forget,{id:detail.id})).isError,true);
  for(const args of [{},{mode:'repository-maintenance',approved:false},{mode:'repository-maintenance',revision:'stale'}]) assert.equal((await call(T.knowledgeMutate,{id:detail.id,revision:detail.revision,action:'retire',approved:true,...args})).isError,true);
  assert.deepEqual(await canonical(root),before);
  const accepted=ok(await call(T.knowledgeMutate,{id:detail.id,revision:detail.revision,action:'retire',approved:true,mode:'repository-maintenance'})); assert.equal(accepted.result.detail.status,'deprecated');
  assert.equal((await call(T.knowledgeMutate,{id:detail.id,revision:detail.revision,action:'retire',approved:true,mode:'repository-maintenance'})).isError,true);
});

test('MCP promotion accepts legacy Local selectors but retains exact-preview approval, revisions, and replay protection',async t=>{
  const {root,call}=await fixture(t); await writeKnowledge(root,item('legacy-promotion'),false,'local');
  const before=await canonical(root); const preview=ok(await call(T.promotionPreview,{ids:['legacy-promotion']})).preview;
  assert.deepEqual(preview.actions[0].localIds,['legacy-promotion']); assert.deepEqual(await canonical(root),before);
  for(const args of [{},{approved:false},{approved:true,preview:{...preview,previewId:'modified'}}]) assert.equal((await call(T.promote,{preview,...args})).isError,true);
  await writeKnowledge(root,item('legacy-promotion',{content:'Harbor promotion retains a revised amber queue journal.'}),false,'local');
  const staleBefore=await canonical(root); assert.equal((await call(T.promote,{approved:true,preview})).isError,true); assert.deepEqual(await canonical(root),staleBefore);
  const fresh=ok(await call(T.promotionPreview,{ids:['legacy-promotion']})).preview;
  const accepted=ok(await call(T.promote,{approved:true,preview:fresh})).result; assert.equal(accepted.published,1);
  const checkpoints=(await listCheckpoints(root)).length;
  assert.equal(ok(await call(T.promote,{approved:true,preview:fresh})).result.alreadyApplied,true); assert.equal((await listCheckpoints(root)).length,checkpoints);
});

test('MCP existing-reference schemas reject traversal and malformed IDs without side effects',async t=>{
  const {root,call}=await fixture(t); await writeKnowledge(root,item('legacy-safe'),false,'local'); const before=await canonical(root);
  for(const id of ['../escape','x/y','x\\y','.','','legacy\nunsafe']) {
    for(const [tool,args] of [[T.remember,{replaceId:id,content:'Harbor workers preserve the journal.'}],[T.remember,{relationships:[{type:'related_to',target:id}],content:'Harbor workers preserve the journal.'}],[T.forget,{id}],[T.promotionPreview,{ids:[id]}]]) assert.equal((await call(tool,args)).isError,true,`${tool} ${JSON.stringify(id)}`);
  }
  assert.deepEqual(await canonical(root),before); assert.equal((await getMemory(root,'legacy-safe')).status,'active');
});

for (const disposition of ['update','covered']) test(`Skill text gateway discloses assisted ${disposition} operation and target before exact procedure`,async t=>{
  const {root,client,text}=await fixture(t,{sampling:{}});
  const skill=await candidate(root), target=await createProjectSkill(root,{...skillInput,title:'Verify Harbor queue recovery checks'},'sess_existing');
  const config=await readConfig(root); config.knowledgeEngine={mode:'assisted'}; await writeConfig(root,config);
  let calls=0;
  client.setRequestHandler(CreateMessageRequestSchema,async ({params})=>{
    calls++; const {phase,data}=JSON.parse(params.messages[0].content.text); assert.equal(phase,'curateSkill');
    assert.ok(data.activeSkills.some(x=>x.id===target.id));
    const response=curationResponse(data); response.disposition={action:disposition,targetSkillId:target.id};
    return {role:'assistant',content:{type:'text',text:JSON.stringify(response)},model:'synthetic-contract-double',stopReason:'endTurn'};
  });
  const before=await canonical(root), response=await text(T.skillPreview,{id:skill.id}), data=ok(response), visible=response.content[0].text;
  assert.equal(calls,1); assert.equal(data.preview.mode,'assisted'); assert.equal(data.preview.disposition.action,disposition);
  assert.equal(data.preview.target.id,target.id); assert.equal(data.approval.required,disposition!=='covered');
  assert.ok(visible.includes(`Target: ${target.title} (${target.id})`));
  assert.ok(visible.indexOf('Operation:')<visible.indexOf('## Procedure')); assert.ok(visible.indexOf('Target:')<visible.indexOf('## Procedure'));
  assert.ok(visible.includes(data.preview.draft.content)); assert.equal(data.presentation.text,visible); assert.deepEqual(await canonical(root),before);
  if(disposition==='covered') {
    assert.match(visible,/Already covered; no changes to apply/); assert.match(visible,/Inspect the existing skill or dismiss/); assert.doesNotMatch(visible,/approved=true|using Add Skill|obtain explicit human approval/i);
    assert.equal((await text(T.skillReview,{id:skill.id,action:'promote',approved:true,preview:data.preview})).isError,true);
    assert.equal((await getProjectSkill(root,skill.id)).status,'candidate'); assert.deepEqual(await getProjectSkill(root,target.id),target);
  } else {
    assert.match(visible,/Update existing Project Skill/); assert.match(visible,/approved=true/);
    assert.equal((await text(T.skillReview,{id:skill.id,action:'promote',approved:false,preview:data.preview})).isError,true);
    const result=ok(await text(T.skillReview,{id:skill.id,action:'promote',approved:true,preview:data.preview})); assert.equal(result.skill.id,target.id);
    assert.equal((await getProjectSkill(root,skill.id)).promotedTo,target.id);
  }
  assert.equal(calls,1);
});

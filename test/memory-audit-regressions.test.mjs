import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {emptyProject,record} from './helpers/context-v2-fixture.mjs';
import {fixtureItem,archiveFixture} from './helpers/memory-bundle-fixtures.mjs';
import {writeKnowledge} from '../dist/core/memory.js';
import {loadKnowledgeGraph} from '../dist/core/knowledge-graph.js';
import {readKnowledgeInventory} from '../dist/core/knowledge-provenance.js';
import {previewMemoryLinkRepair,applyMemoryLinkRepair} from '../dist/core/memory-link-repair.js';
import {withSyncLock} from '../dist/core/sync-transaction.js';
import {createProjectSkill,scoreSkill} from '../dist/core/skills.js';
import {getContext} from '../dist/core/context.js';
import {memoryHealth} from '../dist/core/memory-index.js';
import {buildViewModel,renderText} from '../dist/presentation.js';
import {renderProjectStatus} from '../dist/status-presentation.js';
const cachePath=root=>path.join(root,'.prodero/.cache/knowledge-graph.json');
for(const layer of ['local','versioned'])test(`legacy current/archive links survive ${layer} repair and old cache invalidation`,async t=>{
 const root=await emptyProject(t);
 await writeKnowledge(root,fixtureItem('legacy-history',{status:'superseded'}),false,layer);
 await archiveFixture(root,'mem_archive-with-hyphen',{},layer);
 await writeKnowledge(root,fixtureItem('mem_source',{supersedes:['legacy-history'],related:['mem_missing'],relations:[{type:'implements',target:'mem_archive-with-hyphen'}]}),false,layer);
 const before=await readKnowledgeInventory(root);await loadKnowledgeGraph(root);
 const old=JSON.parse(await fs.readFile(cachePath(root),'utf8'));old.version=1;old.brokenReferences.push('mem_source:supersedes:legacy-history');await fs.writeFile(cachePath(root),JSON.stringify(old));
 const graph=await loadKnowledgeGraph(root,undefined,{persistCache:false});assert.equal(graph.diagnostics.cacheState,'stale');assert.deepEqual(graph.brokenReferences,['mem_source:related_to:mem_missing']);
 assert.ok(graph.edges.some(e=>e.type==='supersedes'&&e.to==='legacy-history'));assert.ok(graph.edges.some(e=>e.to==='mem_archive-with-hyphen'));
 assert.equal(JSON.parse(await fs.readFile(cachePath(root),'utf8')).version,1,'read-only rebuild does not rewrite cache');
 await loadKnowledgeGraph(root);assert.equal(JSON.parse(await fs.readFile(cachePath(root),'utf8')).version,2);
 const preview=await previewMemoryLinkRepair(root);assert.equal(preview.count,1);assert.deepEqual(preview.changes[0].links,[{type:'related_to',target:'mem_missing'}]);assert.deepEqual(await readKnowledgeInventory(root),before);
 await withSyncLock(root,()=>applyMemoryLinkRepair(root,preview,true));
 const after=await readKnowledgeInventory(root),source=after.find(r=>r.item.id==='mem_source').item;
 assert.deepEqual(source.supersedes,['legacy-history']);assert.deepEqual(source.relations,[{type:'implements',target:'mem_archive-with-hyphen'}]);assert.deepEqual(source.related,[]);
 for(const item of before.filter(r=>r.item.id!=='mem_source'))assert.deepEqual(after.find(r=>r.item.id===item.item.id),item);
});
test('repair independently rejects poisoned derived diagnostics for existing targets',async t=>{
 const root=await emptyProject(t);await writeKnowledge(root,fixtureItem('legacy-target'),false,'local');await writeKnowledge(root,fixtureItem('mem_source',{related:['legacy-target']}),false,'local');await loadKnowledgeGraph(root);
 const cache=JSON.parse(await fs.readFile(cachePath(root),'utf8'));cache.brokenReferences=['mem_source:related_to:legacy-target'];await fs.writeFile(cachePath(root),JSON.stringify(cache));
 assert.equal((await loadKnowledgeGraph(root)).diagnostics.cacheState,'warm');
 const before=await readKnowledgeInventory(root),preview=await previewMemoryLinkRepair(root);assert.equal(preview.count,0);assert.equal(preview.remaining,0);assert.deepEqual(preview.changes,[]);assert.deepEqual(await readKnowledgeInventory(root),before);
});
const install={title:'Build and globally install the current Acme package',description:'Build the Acme package and install it with npm.',scope:'Package build and local installation',triggers:['Build and install Acme package']};
const dev={title:'Switch Acme development mode',description:'Switch Acme between dev and npm runtime.',scope:'Acme runtime',triggers:['Switch Acme dev to npm','Enable dev mode']};
test('a shared project name alone does not establish install/runtime intent',()=>{
 for(const query of ['Acme','Audit the Acme memory architecture, storage and context','Explain Acme memory retrieval','Audit Acme package','Explain the Acme npm package metadata','Audit Acme package installation architecture'])for(const skill of [install,dev])assert.equal(scoreSkill(query,skill).score,0,query+' / '+skill.title);
 for(const query of ['build Acme','install Acme package',install.title])assert.ok(scoreSkill(query,install).score>0,query);
 for(const query of ['switch Acme dev to npm','enable dev mode','Acme dev ↔ npm','Acme npm -> dev',dev.title])assert.ok(scoreSkill(query,dev).score>0,query);
 const debug={title:'MCP transparency debugging',description:'Inspect exact context snapshots.',scope:'MCP',triggers:['Debug MCP snapshots']};assert.ok(scoreSkill('MCP context transparency debugging',debug).score>0);
});
test('unrelated install skills do not reserve budget; procedural requests and exact titles still select them',async t=>{
 const root=await emptyProject(t);await writeKnowledge(root,record('audit_rule',{kind:'project'},'required',100));
 await writeKnowledge(root,record('audit_memory',{kind:'project'},'relevant',250,'Acme memory architecture storage context retrieval graph.'));
 const skill=await createProjectSkill(root,{...install,content:'Check the verified package before installation. '.repeat(20)});
 const audit=await getContext(root,'Audit Acme memory architecture storage context',{contextBudgetTokens:500});assert.equal(audit.required.length,1);assert.equal(audit.skills.length,0);assert.ok(audit.relevant.some(r=>r.id==='audit_memory'));assert.ok(audit.metrics.contextTokens<=500);
 const selected=await getContext(root,'install Acme package');assert.ok(selected.skills.some(s=>s.id===skill.id));assert.equal(selected.required.length,1);
 assert.ok((await getContext(root,install.title)).skills.some(s=>s.id===skill.id));
 const projection=c=>({required:c.required.map(s=>s.id),relevant:c.relevant.map(s=>s.id),skills:c.skills.map(s=>s.id),allocation:c.allocation,contextTokens:c.metrics.contextTokens});const before=projection(audit);await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true,force:true});assert.deepEqual(projection(await getContext(root,'Audit Acme memory architecture storage context',{contextBudgetTokens:500})),before);
});

test('incomplete provenance remains a compatibility count, with truthful human explanations and no invented sources',()=>{
 const base={status:'active',category:'lesson',priority:'normal',estimatedTokens:10,sourceSessionCount:0,sourceEvidenceCount:0,derivedFromCount:0};
 const records=[{...base,id:'legacy'},{...base,id:'source-file',sourceEvidenceCount:1},{...base,id:'complete',sourceSessionCount:1,derivedFromCount:1}],before=structuredClone(records);
 const health=memoryHealth(records);assert.equal(health.missingProvenanceItems,2);assert.equal(health.status,'attention');assert.deepEqual(records,before);
 const project={name:'Fixture',root:'/fixture',initialized:true,git:true,agentsFile:true,knowledgeCount:3,localKnowledgeCount:3,versionedKnowledgeCount:0,skillCount:0,sessionCount:0,checkpointCount:0,pendingSessionCount:0,conflictCount:0,memoryHealth:health,knowledgeGraph:{brokenReferences:0}};
 const expanded=renderText(buildViewModel({action:'status-details',project}),true,true);
 assert.match(expanded.replace(/\n│ ?/g,' '),/incomplete provenance/);assert.match(expanded,/not proof of lost history/);
 const cli=renderProjectStatus({version:'0.1.0',scope:'project',project,update:{status:'current',current:'0.1.0'}});assert.match(cli,/Provenance: 2 current records with incomplete metadata/);assert.match(cli,/not proof of lost history/);
 assert.deepEqual(memoryHealth(records),health);assert.deepEqual(records,before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initializeProject, prepareProject } from '../dist/core/project.js';
import { writeKnowledge, listKnowledge, parseKnowledge } from '../dist/core/memory.js';
import { loadMemoryCatalog } from '../dist/core/memory-index.js';
import { loadKnowledgeGraph } from '../dist/core/knowledge-graph.js';
import { getMemory, getMemoryLayer } from '../dist/core/memory-operations.js';
import { getKnowledgeProvenance, readKnowledgeInventory } from '../dist/core/knowledge-provenance.js';
import { previewKnowledgeLifecycle as preview, applyKnowledgeLifecycle as apply } from '../dist/core/knowledge-lifecycle.js';
import { listCheckpoints } from '../dist/core/storage.js';

const item=(id,patch={})=>({id,title:'Driving control',content:'Driving control preserves traction.',scope:'module',scopeRef:'driving',category:'state',priority:'normal',status:'active',createdAt:'2025-01-01T00:00:00Z',updatedAt:'2025-01-01T00:00:00Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[],relations:[],...patch});
const create=(id,layer='local',patch={})=>({id,layer,title:'Compact driving control',content:'Driving control preserves traction and safe braking.',scope:'module',scopeRef:'driving',category:'principle',...patch});
const link=(from,to,type='consolidates')=>({from,to,type});
const file=(root,relative)=>path.join(root,'.prodero',relative);
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-lifecycle-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'.git'));await initializeProject(root);await writeKnowledge(root,item('mem_old'),false,'local');return root;}

test('legacy knowledge remains current without migration; existing supersedes resolves both ways',async t=>{
 const root=await fixture(t);assert.equal((await getKnowledgeProvenance(root,'mem_old')).current,true);
 assert.equal(parseKnowledge('# Legacy\n\nExisting state.','legacy.md').status,'active');
 await writeKnowledge(root,item('mem_new',{supersedes:['mem_old']}),false,'local');
 assert.deepEqual((await getKnowledgeProvenance(root,'mem_old')).superseded_by,['mem_new']);
 assert.deepEqual((await getKnowledgeProvenance(root,'mem_new')).supersedes,['mem_old']);
});
test('consolidation archives with stable IDs, contents, scope, category and distinct semantic provenance',async t=>{
 const root=await fixture(t),old=await getMemory(root,'mem_old');
 const p=await preview(root,{operationId:'compact',create:[create('mem_new')],links:[link('mem_new','mem_old')],archive:['mem_old']});
 await apply(root,p);const historical=await getKnowledgeProvenance(root,'mem_old');
 assert.equal(historical.item.status,'consolidated');assert.equal(historical.storage,'archive');assert.equal(historical.current,false);
 for(const k of ['id','content','scope','scopeRef','category','createdAt'])assert.equal(historical.item[k],old[k]);
 assert.deepEqual(historical.superseded_by,[]);assert.deepEqual(historical.consolidated_into,['mem_new']);
 assert.deepEqual((await getKnowledgeProvenance(root,'mem_new')).consolidates,['mem_old']);
 assert.match(historical.path,/^local\/archive\/\d{4}_\d{2}\/mem_old.md$/);assert.ok(!historical.path.includes('2025_01'));
 assert.equal((await getMemory(root,'mem_old')).id,'mem_old');assert.equal(await getMemoryLayer(root,'mem_old'),'local');
 assert.deepEqual((await listKnowledge(root)).map(i=>i.id),['mem_new']);
 assert.deepEqual((await loadMemoryCatalog(root)).summaries.map(i=>i.id),['mem_new']);
 assert.equal((await loadKnowledgeGraph(root)).diagnostics.brokenReferences,0);
 assert.match(await fs.readFile(path.join(root,'.gitignore'),'utf8'),/local\//);
});
test('supersession and consolidation remain distinct across a multi-output plan',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('mem_valid',{category:'constraint'}),false,'local');
 const p=await preview(root,{operationId:'split',create:[create('mem_state','local',{category:'state'}),create('mem_rule','local',{category:'instruction',scope:'global',scopeRef:null})],links:[link('mem_state','mem_old','supersedes'),link('mem_rule','mem_valid')],archive:['mem_old','mem_valid']});
 await apply(root,p);
 assert.equal((await getMemory(root,'mem_old')).status,'superseded');assert.equal((await getMemory(root,'mem_valid')).status,'consolidated');
 assert.deepEqual((await getKnowledgeProvenance(root,'mem_state')).supersedes,['mem_old']);
 assert.deepEqual((await getKnowledgeProvenance(root,'mem_valid')).consolidated_into,['mem_rule']);
 assert.equal((await getMemory(root,'mem_rule')).category,'instruction');
});
test('mixed provenance changes only Local; Versioned archive requires the exact reviewed preview',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('mem_team'),false,'versioned');const original=await fs.readFile(file(root,'memory/mem_team.md'),'utf8');
 const p=await preview(root,{operationId:'mixed',create:[create('mem_new')],links:[link('mem_new','mem_old'),link('mem_new','mem_team')]});await apply(root,p);
 assert.equal(await fs.readFile(file(root,'memory/mem_team.md'),'utf8'),original);
 assert.deepEqual((await getKnowledgeProvenance(root,'mem_team')).consolidated_into,['mem_new']);
 const archive=await preview(root,{operationId:'team-archive',archive:['mem_team']});
 await assert.rejects(apply(root,archive),/approval/);await assert.rejects(apply(root,archive,{approvedVersioned:true,reviewedPlanId:'wrong'}),/approval/);
 assert.equal(await fs.readFile(file(root,'memory/mem_team.md'),'utf8'),original);
 await apply(root,archive,{approvedVersioned:true,reviewedPlanId:archive.planId});
 const archived=await getKnowledgeProvenance(root,'mem_team');assert.match(archived.path,/^archive\//);assert.equal(archived.layer,'versioned');assert.equal(await getMemoryLayer(root,'mem_team'),'versioned');
 assert.equal((await getKnowledgeProvenance(root,'mem_new')).consolidates.length,2);
});
test('Versioned output also requires review and does not automatically publish Local sources',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('mem_team'),false,'versioned');
 const p=await preview(root,{operationId:'versioned',create:[create('mem_new','versioned')],links:[link('mem_new','mem_team','supersedes'),link('mem_new','mem_old')]});
 await assert.rejects(apply(root,p),/approval/);await apply(root,p,{approvedVersioned:true,reviewedPlanId:p.planId});
 assert.equal(await getMemoryLayer(root,'mem_new'),'versioned');assert.equal(await getMemoryLayer(root,'mem_old'),'local');
 assert.deepEqual((await getKnowledgeProvenance(root,'mem_team')).superseded_by,['mem_new']);
});
test('missing, self and mixed-kind cycles are rejected before writes; active archive rejected',async t=>{
 const root=await fixture(t);const original=await fs.readFile(file(root,'local/memory/mem_old.md'),'utf8');
 for(const links of [[link('mem_old','mem_old')],[link('mem_old','mem_missing')],[link('mem_new','mem_old'),link('mem_old','mem_new','supersedes')]])await assert.rejects(preview(root,{operationId:'invalid',create:[create('mem_new')],links}),/Self|Missing|cycle/);
 await assert.rejects(preview(root,{operationId:'invalid',archive:['mem_old']}),/historical/);
 assert.equal(await fs.readFile(file(root,'local/memory/mem_old.md'),'utf8'),original);assert.equal((await listKnowledge(root)).length,1);
});
test('exact repeated apply and duplicate relationships are idempotent; reusing an operation ID is rejected',async t=>{
 const root=await fixture(t);const p=await preview(root,{operationId:'once',create:[create('mem_new')],links:[link('mem_new','mem_old'),link('mem_new','mem_old')],archive:['mem_old','mem_old']});
 const first=await apply(root,p),again=await apply(root,p);assert.equal(again.alreadyApplied,true);assert.equal(first.checkpoint,again.checkpoint);assert.equal((await listCheckpoints(root)).length,1);
 const noop=await preview(root,{operationId:'noop',links:[link('mem_new','mem_old')],archive:['mem_old']});assert.equal(noop.changes.length,0);await apply(root,noop);
 assert.deepEqual((await getKnowledgeProvenance(root,'mem_old')).consolidated_into,['mem_new']);
 const reused=await preview(root,{operationId:'once'});await assert.rejects(apply(root,reused),/already used/);
});
test('stale hashes and modified preview rejected, unchanged records remain byte-identical',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('mem_untouched'),false,'local');const unchanged=await fs.readFile(file(root,'local/memory/mem_untouched.md'),'utf8');
 const proposal={operationId:'stale',create:[create('mem_new')],links:[link('mem_new','mem_old')]};const p=await preview(root,proposal);
 await writeKnowledge(root,item('mem_old',{content:'Driving requirements changed.'}),false,'local');await assert.rejects(apply(root,p),/Stale/);
 const fresh=await preview(root,proposal);await assert.rejects(apply(root,{...fresh,changes:[]}),/modified/);await apply(root,fresh);
 assert.equal(await fs.readFile(file(root,'local/memory/mem_untouched.md'),'utf8'),unchanged);
});
for(const stage of ['new-record','archive','checkpoint'])test(`interruption at ${stage} preserves journal and recovers multi-record mutation on prepare`,async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('mem_second'),false,'local');
 const p=await preview(root,{operationId:`crash-${stage}`,create:[create('mem_new'),create('mem_other')],links:[link('mem_new','mem_old'),link('mem_other','mem_second','supersedes')],archive:['mem_old','mem_second']});
 const rename=fs.rename;let injected=false;
 fs.rename=async(from,to)=>{const target=String(to);if(!injected&&(stage==='new-record'?target.endsWith('/mem_other.md'):stage==='archive'?target.includes('/archive/'):target.includes('/checkpoints/'))){injected=true;throw new Error('Injected lifecycle failure');}return rename(from,to);};
 try{await assert.rejects(apply(root,p),/Injected/);}finally{fs.rename=rename;}
 assert.ok(injected);assert.ok(await fs.readFile(file(root,'.transactions/pending.json'),'utf8'));
 await assert.rejects(listKnowledge(root),/pending recovery/);await assert.rejects(getMemory(root,'mem_old'),/pending recovery/);
 await prepareProject(root,{task:'driving recovery'});
 const inventory=await readKnowledgeInventory(root);assert.equal(inventory.length,4);assert.equal(new Set(inventory.map(r=>r.item.id)).size,4);assert.equal(inventory.filter(r=>r.storage==='archive').length,2);
 assert.deepEqual((await getKnowledgeProvenance(root,'mem_old')).consolidated_into,['mem_new']);assert.deepEqual((await getKnowledgeProvenance(root,'mem_second')).superseded_by,['mem_other']);
 assert.equal((await apply(root,p)).alreadyApplied,true);await assert.rejects(fs.access(file(root,'.transactions/pending.json')),{code:'ENOENT'});
});
test('reverse explicit relation metadata parses and resolves without a competing supersedes representation',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('mem_new'),false,'local');await writeKnowledge(root,item('mem_old',{relations:[{type:'superseded_by',target:'mem_new'}]}),false,'local');
 assert.deepEqual((await getKnowledgeProvenance(root,'mem_new')).supersedes,['mem_old']);
 const p=await preview(root,{operationId:'inverse-cycle',links:[link('mem_new','mem_old','supersedes')]});await apply(root,p);
 assert.deepEqual((await getKnowledgeProvenance(root,'mem_old')).superseded_by,['mem_new']);
});
test('archive layer policy is honored by Git itself',async t=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
 const root=await fixture(t);await exec('git',['init','-q'],{cwd:root});await writeKnowledge(root,item('mem_team',{status:'superseded'}),false,'versioned');
 const p=await preview(root,{operationId:'git-boundary',create:[create('mem_new')],links:[link('mem_new','mem_old')],archive:['mem_old','mem_team']});await apply(root,p,{approvedVersioned:true,reviewedPlanId:p.planId});
 const local=await getKnowledgeProvenance(root,'mem_old'),team=await getKnowledgeProvenance(root,'mem_team');
 await exec('git',['check-ignore','--quiet',`.prodero/${local.path}`],{cwd:root});
 await assert.rejects(exec('git',['check-ignore','--quiet',`.prodero/${team.path}`],{cwd:root}),e=>e.code===1);
 await exec('git',['add',`.prodero/${team.path}`],{cwd:root});assert.match((await exec('git',['ls-files'],{cwd:root})).stdout,/archive\/.*mem_team.md/);
});
test('recovery refuses externally changed sources and retains journal and originals for review',async t=>{
 const root=await fixture(t);const p=await preview(root,{operationId:'changed-source',create:[create('mem_new')],links:[link('mem_new','mem_old')],archive:['mem_old']});
 const rename=fs.rename;fs.rename=async(from,to)=>{if(String(to).includes('/archive/'))throw new Error('Injected archive failure');return rename(from,to);};
 try{await assert.rejects(apply(root,p),/Injected/);}finally{fs.rename=rename;}
 const target=file(root,'local/memory/mem_old.md'),original=await fs.readFile(target,'utf8');await fs.writeFile(target,original+'\nExternal change.\n');
 await assert.rejects(apply(root,p),/changed or missing source/);assert.match(await fs.readFile(target,'utf8'),/External change/);await fs.access(file(root,'.transactions/pending.json'));
 await fs.writeFile(target,original);assert.equal((await apply(root,p)).alreadyApplied,true);
});
test('consolidation preserves existing superseded/deprecated claim state',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('mem_old',{status:'superseded'}),false,'local');await writeKnowledge(root,item('mem_retired',{status:'deprecated'}),false,'local');
 const p=await preview(root,{operationId:'preserve-claim-state',create:[create('mem_new')],links:[link('mem_new','mem_old'),link('mem_new','mem_retired')],archive:['mem_old','mem_retired']});await apply(root,p);
 assert.equal((await getMemory(root,'mem_old')).status,'superseded');assert.equal((await getMemory(root,'mem_retired')).status,'deprecated');
 assert.deepEqual((await getKnowledgeProvenance(root,'mem_old')).consolidated_into,['mem_new']);
});
test('proposal source revision tokens reject stale reasoning before generating a preview',async t=>{
 const root=await fixture(t);const source=await getKnowledgeProvenance(root,'mem_old');
 const proposal={operationId:'expected-revision',expectedRevisions:{mem_old:source.revision},create:[create('mem_new')],links:[link('mem_new','mem_old')]};
 await preview(root,proposal);await writeKnowledge(root,item('mem_old',{content:'Driving controls changed after the proposal source was read.'}),false,'local');
 await assert.rejects(preview(root,proposal),/Stale source revision/);assert.equal((await listKnowledge(root)).length,1);
});

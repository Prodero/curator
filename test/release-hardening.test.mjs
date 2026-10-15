import { PRODERO_SCHEMA_VERSION } from "../dist/core/constants.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeProject, autoMigrateProject, prepareProject, syncProject, rememberProjectKnowledge, getDetailedProjectStatus, resolveProjectContext } from '../dist/core/project.js';
import { parseKnowledge, renderKnowledge, writeKnowledge, listKnowledge } from '../dist/core/memory.js';
import { parseSession, renderSession, createSession, readSession, recordSessionObservations, closeSession } from '../dist/core/sessions.js';
import { createProjectSkill, parseSkill, renderSkill } from '../dist/core/skills.js';
import { readConfig, writeConfig } from '../dist/core/storage.js';
const exec = promisify(execFile);
async function fixture(t, initialize = true) {
  const root = await fs.mkdtemp('/tmp/prodero-hardening-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q', root]);
  if (initialize) await initializeProject(root);
  return root;
}
function knowledge(id = 'mem_fixture', overrides = {}) {
  return { id, scope: 'global', scopeRef: null, category: 'instruction', priority: 'important', status: 'deprecated', title: 'Storage rule', content: 'Preserve canonical data.', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', sourceSessions: [], derivedFrom: [], supersedes: [], related: [], relations: [], ...overrides };
}
async function snapshot(root, excluded = new Set(['.cache', '.transactions', '.backups', '.migrations'])) {
  const result = {};
  async function visit(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!prefix && excluded.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), rel);
      else result[rel] = await fs.readFile(path.join(dir, entry.name), 'utf8');
    }
  }
  await visit(path.join(root, '.prodero'));
  return result;
}

test('M4: LF/CRLF knowledge, sessions and skills preserve metadata and historical state', async t => {
  const root = await fixture(t);
  const item = knowledge(); const text = renderKnowledge(item);
  assert.deepEqual(parseKnowledge(text.replaceAll('\n', '\r\n'), `${item.id}.md`), parseKnowledge(text, `${item.id}.md`));
  assert.equal(parseKnowledge(text.replaceAll('\n', '\r\n'), `${item.id}.md`).status, 'deprecated');
  const session = await createSession(root); await closeSession(root, session.id);
  const sessionText = await fs.readFile(path.join(root, '.prodero/sessions', session.path), 'utf8');
  assert.deepEqual(parseSession(sessionText.replaceAll('\n', '\r\n'), session.path), parseSession(sessionText, session.path));
  const skill = await createProjectSkill(root, {title:'Storage checks', description:'Validate storage.', content:'Run storage checks.'});
  assert.deepEqual(parseSkill(renderSkill(skill).replaceAll('\n', '\r\n'), `${skill.id}.md`), skill);
});

test('M4: damaged canonical metadata fails with a filename instead of active defaults', async t => {
  const root = await fixture(t); const text = renderKnowledge(knowledge());
  for (const malformed of [text.replace('status: deprecated','status: corrupt'), text.replace('scope: global','scope: invented'), text.replace('kind: knowledge','kind: future'), text.replace('id: mem_fixture','id: mem_other'), text.replace('status: deprecated\n',''), text.replace('---\n\n#','\n#'), text.replace('source_sessions: []','source_sessions: [broken'), text.replace('related: []','related: [42]'), text.replace('kind: knowledge','kind: knowledge\nversion: 99')]) {
    assert.throws(() => parseKnowledge(malformed, 'mem_fixture.md'), /mem_fixture\.md/);
  }
  assert.throws(() => parseKnowledge('# stripped metadata\n', 'mem_fixture.md'), /missing/);
  assert.equal(parseKnowledge('# Legacy note\n\nOriginal legacy content.', 'legacy-note.md').status, 'active');
  const session = await createSession(root); const filename = path.join(root,'.prodero/sessions',session.path);
  await fs.writeFile(filename, (await fs.readFile(filename,'utf8')).replace('status: active', 'status: invented'));
  await assert.rejects(getDetailedProjectStatus(root), /Invalid Prodero session/);
});

test('M4: canonical writes and v1 migration reject escaping IDs without changing source', async t => {
  const root = await fixture(t);
  await assert.rejects(writeKnowledge(root, knowledge('../../escaped')), /Invalid canonical ID/);
  const cfg = await readConfig(root); cfg.schemaVersion = 1; await writeConfig(root, cfg);
  const file = path.join(root,'.prodero/memory/legacy.md');
  const content = '---\nid: ../../migration-escape\n---\n\n# Legacy\n';
  await fs.writeFile(file, content);
  await assert.rejects(autoMigrateProject(root), /Invalid canonical ID/);
  assert.equal(await fs.readFile(file,'utf8'), content);
  assert.equal((await readConfig(root)).schemaVersion, 1);
  await assert.rejects(fs.access(path.join(root,'migration-escape.md')), {code:'ENOENT'});
});

test('M4: symlink storage roots, directories and destinations fail before external writes', async t => {
  const outside = await fixture(t, false); await fs.writeFile(path.join(outside,'sentinel'),'unchanged');
  const root = await fixture(t, false); await fs.symlink(outside, path.join(root,'.prodero'));
  await assert.rejects(initializeProject(root), /Symlink/);
  assert.deepEqual((await fs.readdir(outside)).sort(), ['.git','sentinel']);
  for (const directory of ['memory','local','sessions','skills','.cache']) {
    const r = await fixture(t); await fs.rm(path.join(r,'.prodero',directory),{recursive:true}); await fs.symlink(outside,path.join(r,'.prodero',directory));
    await assert.rejects(initializeProject(r), /Symlink/);
  }
  const r = await fixture(t); await fs.symlink(path.join(outside,'sentinel'),path.join(r,'.prodero/memory/mem_fixture.md'));
  await assert.rejects(writeKnowledge(r,knowledge()), /Symlink/);
  assert.equal(await fs.readFile(path.join(outside,'sentinel'),'utf8'),'unchanged');
});

test('M4: invalid config is diagnosed before initialization mutates project files', async t => {
  const root = await fixture(t);
  for (const config of [{schemaVersion:'5'}, {...await readConfig(root), schemaVersion:0}, {...await readConfig(root), context:{max_tokens:'bad'}}]) {
    await fs.writeFile(path.join(root,'.prodero/config.json'), JSON.stringify(config));
    const before = await snapshot(root);
    await assert.rejects(initializeProject(root), /Invalid Prodero config.*config\.json/);
    assert.deepEqual(await snapshot(root), before);
    await fs.writeFile(path.join(root,'.prodero/config.json'), JSON.stringify({schemaVersion:5, initializedWith:'0.1.0',lastUpdatedWith:'0.1.0',projectId:'fixture',createdAt:'2026-09-01T00:00:00Z'}));
  }
});

async function commitFixture(root) {
  await exec('git',['-C',root,'add','.']);
  await exec('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']);
}
for (const mode of ['clone','worktree']) test(`M1: real ${mode} recreates ignored layout with a clean Git lifecycle`, async t => {
  const source=await fixture(t); await writeKnowledge(source,knowledge('mem_team',{status:'active'}));
  await syncProject(source); await commitFixture(source);
  const target=source+'-'+mode; t.after(()=>fs.rm(target,{recursive:true,force:true}));
  if(mode==='clone') await exec('git',['clone','-q',source,target]);
  else await exec('git',['-C',source,'worktree','add','--detach',target,'HEAD']);
  await assert.rejects(fs.access(path.join(target,'.prodero/local')),{code:'ENOENT'});
  for(let i=0;i<2;i++) {
    await getDetailedProjectStatus(target);
    const prepared=await prepareProject(target,{task:'storage checks'});
    await recordSessionObservations(target,prepared.session.id,[{type:'discovery',content:'Cedar records survive clone initialization.'}]);
    await closeSession(target,prepared.session.id); await syncProject(target);
    await rememberProjectKnowledge(target,{kind:'fact',scope:'project',content:'Birch operations use bounded retries.'});
    assert.equal((await exec('git',['-C',target,'status','--porcelain','--untracked-files=all'])).stdout,'');
  }
});

test('M1: CLI Sync reaches v4 migration when ignored local storage does not exist', async t => {
  const root=await fixture(t); const cfg=await readConfig(root);cfg.schemaVersion=4;await writeConfig(root,cfg);
  await fs.rm(path.join(root,'.prodero/local'),{recursive:true});
  await assert.rejects(exec(process.execPath,[path.resolve('dist/cli.js'),'sync',`--root=${root}`]),/MIGRATION_REQUIRED|knowledge update/);
  await exec(process.execPath,[path.resolve('dist/cli.js'),'migrate',`--root=${root}`]);
  const result=await exec(process.execPath,[path.resolve('dist/cli.js'),'sync',`--root=${root}`]);
  assert.equal(JSON.parse(result.stdout).recovery.sessions,0);
  assert.equal((await readConfig(root)).schemaVersion,PRODERO_SCHEMA_VERSION);
});

const { loadMemoryCatalog } = await import('../dist/core/memory-index.js');
const { discoverSessions } = await import('../dist/core/session-index.js');
const { loadKnowledgeGraph } = await import('../dist/core/knowledge-graph.js');
const { MIGRATIONS, migrateProject } = await import('../dist/core/migrations.js');

test('M8: structurally invalid JSON caches rebuild with unchanged canonical bytes', async t => {
  const root=await fixture(t); await rememberProjectKnowledge(root,{content:'Queue processing uses Cedar.',kind:'fact'});
  const before=await snapshot(root);
  const expected=(await loadMemoryCatalog(root)).summaries;
  for(const mutate of [e=>delete e.supersedes,e=>e.tokens=42,e=>e.relations=[{type:'invented'}],e=>e.sourceSessions=null,e=>e.relativePath='../../escape']) {
    const file=path.join(root,'.prodero/.cache/memory-index.json');const data=JSON.parse(await fs.readFile(file,'utf8'));
    mutate(Object.values(data.entries)[0]); await fs.writeFile(file,JSON.stringify(data));
    const catalog=await loadMemoryCatalog(root); assert.equal(catalog.cacheState,'invalid');assert.deepEqual(catalog.summaries,expected);
  }
  for(const mutate of [d=>Object.values(d.checkpoints)[0].processedKeys=42,d=>Object.values(d.sessions)[0].status='invalid',d=>d.sessions=[]]) {
    const file=path.join(root,'.prodero/.cache/session-index.json');const data=JSON.parse(await fs.readFile(file,'utf8'));mutate(data);await fs.writeFile(file,JSON.stringify(data));
    assert.equal((await discoverSessions(root)).cacheState,'invalid');
  }
  const graphBefore=(await loadKnowledgeGraph(root)).edges;const graphFile=path.join(root,'.prodero/.cache/knowledge-graph.json');
  const graph=JSON.parse(await fs.readFile(graphFile,'utf8'));graph.edges=[null];await fs.writeFile(graphFile,JSON.stringify(graph));
  assert.deepEqual((await loadKnowledgeGraph(root)).edges,graphBefore);
  await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true});await getDetailedProjectStatus(root);
  assert.deepEqual(await snapshot(root),before);
});

for(const version of [1,2,3,4]) test(`M8: v${version} migration backups survive cache deletion and repeated upgrade`, async t => {
  const root=await fixture(t);await writeKnowledge(root,knowledge());const cfg=await readConfig(root);cfg.schemaVersion=version;await writeConfig(root,cfg);
  const before=await snapshot(root);const result=await migrateProject(root,cfg);
  assert.match(result.backup,/^\.prodero\/\.backups\//);
  const backupConfig=await fs.readFile(path.join(root,result.backup,'config.json'),'utf8');
  await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true});
  assert.equal(await fs.readFile(path.join(root,result.backup,'config.json'),'utf8'),backupConfig);
  assert.equal(await fs.readFile(path.join(root,'.prodero/memory/mem_fixture.md'),'utf8'),before['memory/mem_fixture.md']);
  assert.equal((await migrateProject(root,await readConfig(root))).migrated,false);
  assert.equal((await readConfig(root)).schemaVersion,PRODERO_SCHEMA_VERSION);
});

test('M8: failed step and failed validation roll back without advancing schema', async t => {
  for(const mode of ['throw','invalid']) {
    const root=await fixture(t);await writeKnowledge(root,knowledge());const cfg=await readConfig(root);cfg.schemaVersion=4;await writeConfig(root,cfg);
    const before=await snapshot(root);const original=MIGRATIONS[4];
    MIGRATIONS[4]={...original,modifiesVersionedKnowledge:true,run:async(stage)=>{
      await fs.writeFile(path.join(stage,'.prodero/memory/mem_fixture.md'),mode==='invalid'?'---\nid: mem_fixture\nstatus: garbage\n---\n':'partial write');
      if(mode==='throw')throw new Error('Injected migration failure');
    }};
    try{await assert.rejects(migrateProject(root,cfg),/Migration rolled back/);}finally{MIGRATIONS[4]=original;}
    assert.equal(cfg.schemaVersion,4);assert.equal((await readConfig(root)).schemaVersion,4);assert.deepEqual(await snapshot(root),before);
    await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true});
    assert.ok((await fs.readdir(path.join(root,'.prodero/.backups'))).some(n=>n.startsWith('schema-4-')));
    assert.equal((await migrateProject(root,cfg)).to,PRODERO_SCHEMA_VERSION);
  }
});

async function childScript(code,args=[]) {return exec(process.execPath,['--input-type=module','-e',code,...args],{cwd:process.cwd()});}
test('M8: process interruption recovers migration from durable backup without cache', async t=>{
  const root=await fixture(t);await writeKnowledge(root,knowledge());const cfg=await readConfig(root);cfg.schemaVersion=4;await writeConfig(root,cfg);
  const before=await snapshot(root);
  await assert.rejects(childScript(`import fs from 'node:fs/promises';import {MIGRATIONS,migrateProject} from './dist/core/migrations.js';import {readConfig} from './dist/core/storage.js';const r=process.argv[1];MIGRATIONS[4]={...MIGRATIONS[4],modifiesVersionedKnowledge:true,run:async(stage)=>{await fs.writeFile(stage+'/.prodero/memory/mem_fixture.md','interrupted');process.exit(23);}};await migrateProject(r,await readConfig(r));`,[root]),e=>e.code===23);
  await fs.access(path.join(root,'.prodero/.transactions/migration.json'));
  await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true});
  const result=await migrateProject(root,await readConfig(root));assert.equal(result.to,PRODERO_SCHEMA_VERSION);
  assert.equal(await fs.readFile(path.join(root,'.prodero/memory/mem_fixture.md'),'utf8'),before['memory/mem_fixture.md']);
  await assert.rejects(fs.access(path.join(root,'.prodero/.transactions/migration.json')),{code:'ENOENT'});
});

test('M8: previous-runtime migration backups move out of cache even at current schema',async t=>{
  const root=await fixture(t);const legacy=path.join(root,'.prodero/.cache/migration-backups/old');await fs.mkdir(legacy,{recursive:true});await fs.writeFile(path.join(legacy,'evidence'),'preserve');
  await migrateProject(root,await readConfig(root));await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true});
  const adopted=(await fs.readdir(path.join(root,'.prodero/.backups'))).find(n=>n.startsWith('legacy-cache-'));
  assert.equal(await fs.readFile(path.join(root,'.prodero/.backups',adopted,'old/evidence'),'utf8'),'preserve');
});

async function syncBatch(t) {
  const root=await fixture(t);
  for(const [id,title,content] of [['mem_merge','Retry policy','Clients use bounded retries.'],['mem_conflict','Cache policy','Caching is enabled.'],['mem_replace','Transport policy','Clients use Cedar.'],['mem_duplicate','Safety policy','Keep canonical state durable.']]) {
    await writeKnowledge(root,knowledge(id,{title,content,status:'active',category:'decision'}),false,'local');
  }
  const session=await createSession(root);
  const decision=(title,content,extra={})=>({type:'decision',title,content,scopeHint:'global',categoryHint:'decision',importanceHint:'important',...extra});
  await recordSessionObservations(root,session.id,[
    decision('Retry policy','Clients use bounded retries. Clients add jitter to retries.'),
    decision('Cache policy','Caching is disabled.'),
    decision('Transport policy','Clients use Birch.',{supersedes:['mem_replace']}),
    decision('Safety policy','Keep canonical state durable.'),
    {type:'skill_candidate',title:'Verify storage',description:'Verify storage writes.',content:'Run storage checks.'},
  ]);
  await closeSession(root,session.id);
  return {root,session};
}
function stableKnowledge(items) { return items.map(({id,title,content,status,sourceSessions,derivedFrom})=>({title,content,status,hasProvenance:sourceSessions.length>0&&derivedFrom.length>0})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))); }
const worker=path.resolve('test/helpers/hardening-worker.mjs');
test('M2: deterministic Sync journal covers every write, checkpoint last, and recovers process crashes without cache',async t=>{
  const baseline=await syncBatch(t);let writeCount;
  const rename=fs.rename;
  fs.rename=async(from,to)=>{if(String(to).endsWith('/.transactions/pending.json'))writeCount=JSON.parse(await fs.readFile(from,'utf8')).writes.length;return rename(from,to);};
  let result;try{result=await syncProject(baseline.root);}finally{fs.rename=rename;}
  assert.equal(result.consolidated,1);assert.equal(result.conflicts,0);assert.equal(result.superseded,1);assert.equal(result.duplicates,1);assert.equal(result.skillCandidatesCreated,1);
  const expected=stableKnowledge(await listKnowledge(baseline.root));assert.ok(writeCount>=6);
  for(let failAt=0;failAt<=writeCount;failAt++) {
    const {root}=await syncBatch(t);
    await assert.rejects(exec(process.execPath,[worker,'sync-crash',root,String(failAt)]),e=>e.code===73);
    const journal=JSON.parse(await fs.readFile(path.join(root,'.prodero/.transactions/pending.json'),'utf8'));
    assert.match(journal.writes.at(-1).path,/^checkpoints\//);
    assert.ok(journal.writes.slice(0,-1).every(x=>!x.path.startsWith('checkpoints/')));
    await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true});
    await syncProject(root);
    assert.deepEqual(stableKnowledge(await listKnowledge(root)),expected,`crash boundary ${failAt}`);
    const before=await snapshot(root);assert.equal((await syncProject(root)).sessions,0);assert.deepEqual(await snapshot(root),before);
    assert.equal((await fs.readdir(path.join(root,'.prodero/checkpoints'))).filter(x=>x.endsWith('.json')).length,1);
    await assert.rejects(fs.access(path.join(root,'.prodero/.transactions/pending.json')),{code:'ENOENT'});
  }
});

test('M2: checkpoint write failure retains recovery journal; failure before journal leaves canonical state unchanged',async t=>{
  for(const mode of ['checkpoint','journal']) {
    const {root}=await syncBatch(t);const before=await snapshot(root);const rename=fs.rename;
    fs.rename=async(from,to)=>{if(mode==='checkpoint'?String(to).includes('/checkpoints/chk_'):String(to).endsWith('/.transactions/pending.json'))throw new Error('Injected write failure');return rename(from,to);};
    try{await assert.rejects(syncProject(root),/Injected write failure/);}finally{fs.rename=rename;}
    if(mode==='journal')assert.deepEqual(await snapshot(root),before);
    else await fs.access(path.join(root,'.prodero/.transactions/pending.json'));
    await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true});await syncProject(root);
    assert.equal((await getDetailedProjectStatus(root)).pendingSessionCount,0);
    assert.equal((await getDetailedProjectStatus(root)).checkpointCount,1);
  }
});

test('M8: concurrent processes cannot run overlapping migration steps',async t=>{
  const root=await fixture(t);const cfg=await readConfig(root);cfg.schemaVersion=4;await writeConfig(root,cfg);
  const results=await Promise.all(Array.from({length:4},()=>exec(process.execPath,[worker,'migrate',root]).then(r=>JSON.parse(r.stdout))));
  assert.ok(results.some(r=>r.ok));assert.ok(results.filter(r=>!r.ok).every(r=>/Sync.*running|lock/i.test(r.error)));
  assert.equal((await readConfig(root)).schemaVersion,PRODERO_SCHEMA_VERSION);
  assert.equal((await fs.readdir(path.join(root,'.prodero/.backups'))).filter(n=>n.startsWith('schema-')).length,1);
});

function observationIds(session) {return Object.values(session.sections).flat().map(x=>/\bid=(obs_[a-zA-Z0-9_]+)/.exec(x)?.[1]).filter(Boolean).sort();}
test('M3: twelve concurrent successful records in one process all persist',async t=>{
  const root=await fixture(t);const session=await createSession(root);
  const results=await Promise.all(Array.from({length:12},(_,i)=>recordSessionObservations(root,session.id,[{type:'discovery',content:`Parallel observation ${i} is independent.`}])));
  const acknowledged=results.flatMap(r=>r.recorded.map(x=>x.id)).sort();
  assert.equal(acknowledged.length,12);assert.deepEqual(observationIds(await readSession(root,session.id)),acknowledged);
});

test('M3: cross-process record/record and record/close preserve every acknowledged ID',async t=>{
  for(const closing of [false,true]) {
    const root=await fixture(t);const session=await createSession(root);
    const jobs=Array.from({length:12},(_,i)=>exec(process.execPath,[worker,closing&&i===5?'close':'record',root,session.id,String(i)]).then(r=>JSON.parse(r.stdout)));
    const results=await Promise.all(jobs);const persisted=await readSession(root,session.id);
    const acknowledged=results.filter(r=>r.ok).flatMap(r=>r.ids).sort();
    assert.deepEqual(observationIds(persisted),acknowledged);
    if(closing) {
      assert.equal(persisted.status,'closed');assert.ok(results.filter(r=>!r.ok).every(r=>/closed/.test(r.error)));
      assert.equal((await closeSession(root,session.id)).alreadyClosed,true);
      const bytes=await fs.readFile(path.join(root,'.prodero/sessions',session.path),'utf8');
      await assert.rejects(recordSessionObservations(root,session.id,[{type:'discovery',content:'Late observation.'}]),/closed/);
      await assert.rejects(closeSession(root,session.id,[{type:'discovery',content:'Repeated final entry.'}]),/closed/);
      assert.equal(await fs.readFile(path.join(root,'.prodero/sessions',session.path),'utf8'),bytes);
    } else {assert.equal(acknowledged.length,12);assert.equal(persisted.status,'active');}
  }
});

test('M3: concurrent MCP records and close obey the same durable mutation boundary',async t=>{
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');const {createServer}=await import('../dist/server.js');
  const root=await fixture(t);const session=await createSession(root);const server=createServer({projectRoot:root});const client=new Client({name:'phase1',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  try {
    const responses=await Promise.all(Array.from({length:12},(_,i)=>client.callTool({name:'prodero_session_record',arguments:{projectRoot:root,sessionId:session.id,entries:[{type:'discovery',content:`MCP observation ${i} is durable.`}]}})));
    assert.ok(responses.every(r=>!r.isError));
    const ids=responses.flatMap(r=>r.structuredContent.result.recorded.map(x=>x.id)).sort();
    const result=await client.callTool({name:'prodero_session_close',arguments:{projectRoot:root,sessionId:session.id}});assert.ok(!result.isError);
    assert.deepEqual(observationIds(await readSession(root,session.id)),ids);assert.equal((await readSession(root,session.id)).status,'closed');
  } finally {await client.close();await server.close();}
});

test('M4: explicitly supported date-ID checkpoint-ready legacy sessions remain readable',()=>{
  const text='---\nid: 2026-09-01-foundation\nkind: session-memory\nstatus: checkpoint-ready\n---\n\n# Foundation\n\n## Decisions\n\n- Preserve legacy evidence.\n';
  for(const value of [text,text.replaceAll('\n','\r\n')]) {
    const result=parseSession(value,'2026-09-01-foundation.md');assert.equal(result.id,'2026-09-01-foundation');assert.equal(result.sections.Decisions.length,1);
  }
  assert.throws(()=>parseSession(text.replace('checkpoint-ready','corrupt'),'2026-09-01-foundation.md'),/Invalid Prodero session/);
});

test('M4/M8: unsafe or invalid later migration input is rejected before earlier files move',async t=>{
  const root=await fixture(t);const cfg=await readConfig(root);cfg.schemaVersion=1;await writeConfig(root,cfg);
  await fs.writeFile(path.join(root,'.prodero/memory/a.md'),renderKnowledge({...knowledge(),id:'renamed-valid'}));
  await fs.writeFile(path.join(root,'.prodero/memory/z.md'),'---\nid: ../../escape\n---\n\n# Bad\n');
  const before=await snapshot(root);await assert.rejects(autoMigrateProject(root),/Invalid canonical ID/);assert.deepEqual(await snapshot(root),before);
});

test('M4: malformed checkpoint and journal data never become silently accepted durable state',async t=>{
  const {commitSyncTransaction,recoverSyncTransaction}=await import('../dist/core/sync-transaction.js');const root=await fixture(t);
  await fs.writeFile(path.join(root,'.prodero/checkpoints/chk_bad.json'),JSON.stringify({id:'chk_bad',createdAt:'2026-09-01T00:00:00Z',sessions:[null]}));
  await assert.rejects(getDetailedProjectStatus(root),/Invalid Prodero checkpoint.*chk_bad/);await fs.rm(path.join(root,'.prodero/checkpoints/chk_bad.json'));
  const writes=[{path:'memory/mem_invalid.md',before:null,after:'---\nid: mem_invalid\nstatus: typo\n---\n'}, {path:'checkpoints/chk_valid.json',before:null,after:JSON.stringify({id:'chk_valid',createdAt:'2026-09-01T00:00:00Z',sessions:[]})}];
  await assert.rejects(commitSyncTransaction(root,writes),/Invalid canonical knowledge/);await assert.rejects(fs.access(path.join(root,'.prodero/memory/mem_invalid.md')),{code:'ENOENT'});
  await fs.mkdir(path.join(root,'.prodero/.transactions'),{recursive:true});
  await fs.writeFile(path.join(root,'.prodero/.transactions/pending.json'),JSON.stringify({version:1,writes}));
  await assert.rejects(recoverSyncTransaction(root),/Invalid canonical knowledge/);await fs.access(path.join(root,'.prodero/.transactions/pending.json'));
});

test('M8/M3: pending migration blocks new acknowledgements, including recovery after interrupted rollback',async t=>{
  const root=await fixture(t);const session=await createSession(root);const cfg=await readConfig(root);cfg.schemaVersion=4;await writeConfig(root,cfg);
  await assert.rejects(childScript(`import {MIGRATIONS,migrateProject} from './dist/core/migrations.js';import {readConfig} from './dist/core/storage.js';const r=process.argv[1];MIGRATIONS[4]={...MIGRATIONS[4],run:async()=>process.exit(23)};await migrateProject(r,await readConfig(r));`,[root]),e=>e.code===23);
  await assert.rejects(recordSessionObservations(root,session.id,[{type:'discovery',content:'Must not be acknowledged before recovery.'}]),/Interrupted migration/);
  // A rollback interrupted after removing config must not make prepare initialize over evidence.
  await fs.rm(path.join(root,'.prodero/config.json'));
  await assert.rejects(prepareProject(root,{task:'recover migration'}),/MIGRATION_REQUIRED/);
  const {planProjectMigration,applyProjectMigration}=await import('../dist/core/migrations.js');
  let plan=await planProjectMigration(root);await applyProjectMigration(root,{approved:true,planId:plan.planId,recover:true});
  plan=await planProjectMigration(root);await applyProjectMigration(root,{approved:true,planId:plan.planId});
  const prepared=await prepareProject(root,{task:'recover migration'});assert.equal(prepared.project.schemaVersion,PRODERO_SCHEMA_VERSION);assert.ok(await readSession(root,session.id));
  assert.equal(observationIds(await readSession(root,session.id)).length,0);
});

test('M8: future schema is rejected and schema write failure preserves prior config and backup',async t=>{
  const root=await fixture(t);const cfg=await readConfig(root);cfg.schemaVersion=99;await fs.writeFile(path.join(root,".prodero/config.json"),JSON.stringify(cfg));const before=await snapshot(root);
  await assert.rejects(migrateProject(root,cfg),/newer/);assert.deepEqual(await snapshot(root),before);
  cfg.schemaVersion=4;await fs.writeFile(path.join(root,".prodero/config.json"),JSON.stringify(cfg));const original=fs.rename;
  fs.rename=async(from,to)=>{if(String(to).endsWith('/.prodero/config.json')&&String(from).includes('.tmp-'))throw new Error('Injected schema commit failure');return original(from,to);};
  try{await assert.rejects(migrateProject(root,cfg),/Migration rolled back/);}finally{fs.rename=original;}
  assert.equal((await readConfig(root)).schemaVersion,4);assert.equal(cfg.schemaVersion,4);
  assert.equal((await migrateProject(root,cfg)).to,PRODERO_SCHEMA_VERSION);
});

test('M4: stable modern IDs cannot downgrade damaged files to legacy active truth',()=>{
  assert.throws(()=>parseSkill('# Missing modern metadata\n\nProcedure.','skill_stripped.md'),/Invalid project skill/);
  assert.throws(()=>parseKnowledge('---\nid: mem_stripped\n---\n\nContent.','renamed.md'),/Invalid canonical knowledge/);
});

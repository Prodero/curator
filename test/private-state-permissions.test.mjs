import {planKnowledgeCuration,simulateKnowledgeCuration} from "../dist/core/knowledge-curation.js";
import {writeKnowledge} from "../dist/core/memory.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fork,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {initializeProject} from '../dist/core/project.js';
import {ensureRuntimeDirectories,ensureDataDirectory,checkedDataPath,writeFileAtomic,writeFileExclusive,readConfig,writeConfig,copyStorageTree} from '../dist/core/storage.js';
import {createSession,recordSessionObservations} from '../dist/core/sessions.js';
import {createSkillCandidate,createProjectSkill} from '../dist/core/skills.js';
import {withSyncLock} from '../dist/core/sync-transaction.js';
import {migrateProject,MIGRATIONS} from '../dist/core/migrations.js';
const posix={skip:process.platform==='win32'};
const mode=async p=>(await fs.stat(p)).mode&0o777;
const file=(root,p)=>path.join(root,'.prodero',p);
async function fixture(t){
 const umask=process.umask(0o022);t.after(()=>process.umask(umask));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-f07-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.git'));await initializeProject(root);return root;
}
async function privateTree(dir){
 assert.equal(await mode(dir),0o700,dir);
 for(const e of await fs.readdir(dir,{withFileTypes:true})){
  const p=path.join(dir,e.name);if(e.isDirectory())await privateTree(p);else assert.equal(await mode(p),0o600,p);
 }
}
const privateStores=['local/memory','local/skills','local/archive/2026_10','local/curation-reviews','local/curation-reasoning','local/telemetry','sessions','checkpoints','.cache','.transactions','.backups','.migrations'];

test('F07: private stores, exclusive creation and atomic replacement use owner-only modes under umask 022',posix,async t=>{
 const root=await fixture(t);
 for(const dir of privateStores){
  await ensureDataDirectory(root,dir);assert.equal(await mode(file(root,dir)),0o700,dir);
  const p=file(root,dir+'/fixture.json');await writeFileExclusive(p,'private');assert.equal(await mode(p),0o600);
  await fs.chmod(p,0o644);await writeFileAtomic(p,'updated');assert.equal(await mode(p),0o600);
  await writeFileAtomic(p,'again');assert.equal(await mode(p),0o600);
 }
 assert.equal(await mode(file(root,'')),0o755);
 for(const p of ['config.json','index.md','memory/shared.md','skills/shared.md']){
  await writeFileAtomic(file(root,p),'shared');assert.equal(await mode(file(root,p)),0o644,p);
 }
 for(const p of ['memory','skills'])assert.equal(await mode(file(root,p)),0o755);
});

test('F07: existing private state tightens on access without traversing unrelated children or following links',posix,async t=>{
 const root=await fixture(t),dir=file(root,'local/memory'),p=path.join(dir,'old.md'),untouched=path.join(dir,'user-data.txt');
 await fs.writeFile(p,'legacy');await fs.writeFile(untouched,'untouched');await fs.chmod(dir,0o755);await fs.chmod(file(root,'local'),0o755);
 await checkedDataPath(root,'local/memory/old.md');assert.equal(await mode(p),0o600);assert.equal(await mode(dir),0o700);assert.equal(await mode(file(root,'local')),0o700);
 assert.equal(await mode(untouched),0o644,'No recursive chmod of unknown children');
 for(const store of ['.backups','.migrations']){
  await fs.mkdir(file(root,store));await fs.writeFile(file(root,store+'/dormant.json'),'old state');
 }
 await ensureRuntimeDirectories(root);
 for(const store of ['.backups','.migrations']){
  assert.equal(await mode(file(root,store)),0o700);assert.equal(await mode(file(root,store+'/dormant.json')),0o644);
 }
 const outside=path.join(root,'user.txt');await fs.writeFile(outside,'user');
 await fs.link(outside,path.join(dir,'linked.md'));await assert.rejects(checkedDataPath(root,'local/memory/linked.md'),/Unsafe private/);
 await fs.symlink(outside,path.join(dir,'symlink.md'));await assert.rejects(checkedDataPath(root,'local/memory/symlink.md'),/Symlink/);
 assert.equal(await mode(outside),0o644);assert.equal(await fs.readFile(outside,'utf8'),'user');
});

test('F07: actual session, candidate skill and lock writers enforce private modes; explicit shared skill stays shared',posix,async t=>{
 const root=await fixture(t),session=await createSession(root);
 await recordSessionObservations(root,session.id,[{type:'decision',content:'Keep private runtime files owner-only.'}]);
 assert.equal(await mode(file(root,'sessions/'+session.id+'.md')),0o600);
 const input={title:'Fixture procedure',description:'Test private candidate storage.',content:'Check the fixture.',scope:'project'};
 const candidate=await createSkillCandidate(root,input,{sessionId:session.id,derivedFrom:session.id+'#obs_fixture'});
 assert.equal(await mode(path.join(root,'.prodero',candidate.skill.path)),0o600);
 const shared=await createProjectSkill(root,input);assert.equal(await mode(file(root,shared.path)),0o644);
 await withSyncLock(root,async()=>{assert.equal(await mode(file(root,'.transactions/lock')),0o700);assert.equal(await mode(file(root,'.transactions/lock/owner')),0o600);});
});

test('F07: migration backups, staging, successful commit and rollback preserve private/shared distinction',posix,async t=>{
 for(const rollback of [false,true]){
  const root=await fixture(t);await createSession(root);await writeKnowledge(root,{id:'mem_shared',scope:'global',scopeRef:null,category:'instruction',priority:'important',status:'active',title:'Preserve data',content:'Preserve existing knowledge.',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[],relations:[]});
  await fs.chmod(file(root,'memory/mem_shared.md'),0o640);
  const cfg=await readConfig(root);cfg.schemaVersion=7;await writeConfig(root,cfg);
  const original=MIGRATIONS[7],run=original.run;
  MIGRATIONS[7]={...original,run:async(stage,config)=>{
   await privateTree(path.dirname(stage)); // Complete transaction staging, including nested shared-looking paths.
   await privateTree(file(root,'.backups'));
   await run(stage,config);if(rollback)throw new Error('permission rollback fixture');
  }};
  try{if(rollback)await assert.rejects(migrateProject(root,cfg),/rolled back/);else await migrateProject(root,cfg);}finally{MIGRATIONS[7]=original;}
  for(const dir of ['local','sessions','checkpoints','.cache','.transactions','.backups','.migrations'])await privateTree(file(root,dir));
  assert.equal(await mode(file(root,'memory/mem_shared.md')),0o640);assert.equal(await mode(file(root,'memory')),0o755);assert.equal(await mode(file(root,'config.json')),0o644);
 }
});

test('F07: real interrupted atomic/migration temporary files are 0600 before rename',posix,async t=>{
 for(const kind of ['atomic','migration']){
  const root=await fixture(t),session=await createSession(root),target=file(root,'sessions/'+session.id+'.md');
  if(kind==='migration'){const cfg=await readConfig(root);cfg.schemaVersion=7;await writeConfig(root,cfg);}
  const child=fork(new URL('./helpers/interrupted-local-write.mjs',import.meta.url),[kind,root,target,'private fixture'],{stdio:['ignore','ignore','pipe','ipc']});
  t.after(()=>child.kill('SIGKILL'));const exit=once(child,'exit');let errors='';child.stderr.on('data',b=>errors+=b);
  const temporary=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Crash boundary timeout '+errors));},15000);child.once('message',m=>{clearTimeout(timer);resolve(m.temporary);});child.once('exit',()=>{clearTimeout(timer);reject(new Error(errors));});});
  assert.equal(await mode(temporary),0o600);child.kill('SIGKILL');await exit;assert.equal(await mode(temporary),0o600);
 }
});

test('F07: explicit private copies (including external simulation state) never inherit readable source modes',posix,async t=>{
 const root=await fixture(t),source=path.join(root,'source'),dest=path.join(root,'simulation');await fs.mkdir(source);await fs.writeFile(path.join(source,'value'),'private copy');
 await copyStorageTree(source,dest,true);await privateTree(dest);assert.equal(await mode(path.join(source,'value')),0o644);
});

test('F07: Windows permission adapter skips POSIX chmod instead of breaking native ACL operation',async()=>{
 await promisify(execFile)(process.execPath,['--input-type=module','-e',`import fs from 'node:fs/promises';import {tightenPrivateMode} from './dist/filesystem/permissions.js';Object.defineProperty(process,'platform',{value:'win32'});fs.lstat=()=>{throw new Error('POSIX operation on Windows')};await tightenPrivateMode('unused');`]);
});


test('F07: actual curation simulation keeps every temporary/derived artifact inside the private cache',posix,async t=>{
 const root=await fixture(t),plan=await planKnowledgeCuration(root),rm=fs.rm;let inspected=false;
 fs.rm=async(target,...args)=>{
  if(path.basename(String(target)).startsWith('prodero-curation-simulation-')){
   assert.equal(path.dirname(String(target)),file(root,'.cache'));
   await privateTree(target);inspected=true;
  }
  return rm(target,...args);
 };
 try{await simulateKnowledgeCuration(root,plan,['Inspect project context']);}finally{fs.rm=rm;}
 assert.equal(inspected,true);
});


test('F07: permission failure aborts a private atomic replacement without replacing content',posix,async t=>{
 const root=await fixture(t),target=file(root,'local/memory/fixture.md');await writeFileAtomic(target,'before');
 await fs.chmod(target,0o644);const open=fs.open;
 fs.open=async(p,...args)=>{const handle=await open(p,...args);if(String(p)===target)handle.chmod=async()=>{throw new Error('permission denied fixture');};return handle;};
 try{await assert.rejects(writeFileAtomic(target,'after'),/permission denied fixture/);}finally{fs.open=open;}
 assert.equal(await fs.readFile(target,'utf8'),'before');assert.deepEqual((await fs.readdir(path.dirname(target))).filter(n=>n.includes('.tmp-')),[]);
});


test('F07/M3: an owned unlinked lock inode is accepted only after confirming the path is absent',posix,async t=>{
 const {tightenPrivateMode}=await import('../dist/filesystem/permissions.js');
 const root=await fixture(t),target=file(root,'.transactions/lock/owner');
 await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,'123',{mode:0o600});
 const handle=await fs.open(target,'r');await fs.unlink(target);
 const unlinked=await handle.stat();await handle.close();
 assert.equal(unlinked.nlink,0);assert.ok(unlinked.isFile());
 const lstat=fs.lstat;
 let calls=0;
 fs.lstat=async(p,...args)=>String(p)===target&&calls++===0?unlinked:lstat(p,...args);
 try{await tightenPrivateMode(target);assert.equal(calls,2);}finally{fs.lstat=lstat;}
 for(const replacement of ['regular','hardlink','symlink']){
  const other=path.join(root,'other');await fs.writeFile(other,'safe synthetic data',{mode:0o644});
  if(replacement==='regular')await fs.writeFile(target,'new owner',{mode:0o600});
  else if(replacement==='hardlink')await fs.link(other,target);
  else await fs.symlink(other,target);
  calls=0;fs.lstat=async(p,...args)=>String(p)===target&&calls++===0?unlinked:lstat(p,...args);
  try{await assert.rejects(tightenPrivateMode(target),/Unsafe private state permissions target/);}finally{fs.lstat=lstat;}
  assert.equal(await mode(other),0o644);await fs.unlink(target);await fs.unlink(other);
 }
 calls=0;fs.lstat=async(p,...args)=>{
  if(String(p)!==target)return lstat(p,...args);
  if(calls++===0)return unlinked;
  throw Object.assign(new Error('synthetic denied'),{code:'EACCES'});
 };
 try{await assert.rejects(tightenPrivateMode(target),{code:'EACCES'});}finally{fs.lstat=lstat;}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile,fork} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {initializeProject,refreshProjectIntegration} from '../dist/core/project.js';
import {createSession} from '../dist/core/sessions.js';
import {ensureDataDirectory,ensureRuntimeDirectories,LOCAL_STATE_IGNORE_RULES} from '../dist/core/storage.js';
const exec=promisify(execFile);
const git=(root,...args)=>exec('git',['-C',root,...args]);
const marker='Private fixture state must never be staged.';
const oldRules='.prodero/.cache/\n.prodero/.transactions/\n.prodero/local/\n.prodero/sessions/*.md\n.prodero/checkpoints/*.json\n';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-f06-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await git(root,'init','-q');await initializeProject(root);return root;}
async function ignored(root,relative){try{await git(root,'check-ignore','--no-index','-q','--',relative);return true;}catch(e){if(e.code===1)return false;throw e;}}
async function put(root,relative,text=marker){const target=path.join(root,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,text);return target;}
async function interrupt(t,root,target,mode='atomic'){
  const child=fork(fileURLToPath(new URL('./helpers/interrupted-local-write.mjs',import.meta.url)),[mode,root,target,marker],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);t.after(()=>child.kill('SIGKILL'));
  const exit=once(child,'exit');
  const temporary=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Timed out waiting for atomic scratch file'));},15000);
    child.once('message',message=>{clearTimeout(timer);resolve(message.temporary);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Writer exited before crash boundary: '+stderr));});
    child.once('error',reject);
  });
  child.kill('SIGKILL');assert.deepEqual(await exit,[null,'SIGKILL']);return temporary;
}

test('F06: directory-wide ignores protect actual killed-writer leftovers and arbitrary runtime artifacts',async t=>{
  const root=await fixture(t);
  const runtime=[
    'sessions/session.md','checkpoints/checkpoint.json','local/memory/note.md','local/skills/draft.md',
    'local/curation-reviews/review.json','local/curation-reasoning/job.json','local/memory-sync.json',
    'local/archive/2026_10/note.md','.cache/context.json','.transactions/pending.json',
    '.backups/snapshot/sessions/session.md','.migrations/receipt.json',
  ];
  for(const relative of runtime){
    const target=await put(root,'.prodero/'+relative,'original');
    const temporary=await interrupt(t,root,target),scratch=path.relative(root,temporary);
    assert.match(temporary,/\.tmp-\d+-[a-f0-9-]{36}$/);assert.equal(await fs.readFile(temporary,'utf8'),marker);
    assert.equal(await fs.readFile(target,'utf8'),'original','Interrupted write must not replace its target');
    assert.equal(await ignored(root,'.prodero/'+relative),true);assert.equal(await ignored(root,scratch),true);
  }
  for(const dir of ['sessions','checkpoints','local','.cache','.transactions','.backups','.migrations']){
    for(const file of ['unexpected.extension','nested/interrupted.snapshot','.gitkeep.tmp-interrupted']){
      const relative=`.prodero/${dir}/${file}`;await put(root,relative);assert.equal(await ignored(root,relative),true,relative);
    }
  }
  const versioned=['.prodero/config.json','.prodero/index.md','.prodero/memory/team.md','.prodero/skills/team.md','.prodero/archive/2026_10/team.md','.prodero/memory/.gitkeep','.prodero/skills/.gitkeep','.prodero/sessions/.gitkeep','.prodero/checkpoints/.gitkeep'];
  for(const relative of versioned){if(!relative.endsWith('config.json'))await put(root,relative,relative.endsWith('.gitkeep')?'':'Shared fixture');assert.equal(await ignored(root,relative),false,relative);}
  const scratch=await interrupt(t,root,path.join(root,'.prodero/memory/team.md'));
  assert.equal(await ignored(root,path.relative(root,scratch)),true,'Atomic scratch stays untracked even beside Versioned state');
  await git(root,'add','.');const staged=(await git(root,'ls-files')).stdout.trim().split('\n');
  assert.deepEqual(staged.filter(f=>f.startsWith('.prodero/')).sort(),versioned.sort());
});

test('F06: existing projects repair old rules before runtime writes; user files and Git index are preserved',async t=>{
  const root=await fixture(t),custom='# User rules\nuser-build/\n'+oldRules;
  await fs.writeFile(path.join(root,'.gitignore'),custom);
  const tracked='.prodero/sessions/already-tracked.txt';await put(root,tracked);
  await git(root,'add','-f',tracked);const before=(await git(root,'ls-files','--stage')).stdout;
  await createSession(root,{agent:'f06-regression'});
  const updated=await fs.readFile(path.join(root,'.gitignore'),'utf8');assert.ok(updated.startsWith(custom));
  for(const rule of LOCAL_STATE_IGNORE_RULES)assert.ok(updated.split('\n').includes(rule));
  assert.equal((await git(root,'ls-files','--stage')).stdout,before);assert.equal(await fs.readFile(path.join(root,tracked),'utf8'),marker);
  await ensureRuntimeDirectories(root);await refreshProjectIntegration(root);assert.equal(await fs.readFile(path.join(root,'.gitignore'),'utf8'),updated,'Ignore installation is idempotent');
  assert.ok((await git(root,'ls-files',tracked)).stdout.includes(tracked),'No automatic untracking');
  // Recreate from no ignore file via a cache/read path, before the first cache artifact.
  await fs.rm(path.join(root,'.gitignore'));await ensureDataDirectory(root,'.cache/new-cache');
  assert.equal(await ignored(root,'.prodero/.cache/new-cache/state.anything'),true);
});

test('F06: interrupted migration copy/rename and recovery trees remain ignored',async t=>{
  const root=await fixture(t),session=await createSession(root,{agent:'private-fixture-agent'});
  const configPath=path.join(root,'.prodero/config.json'),config=JSON.parse(await fs.readFile(configPath,'utf8'));config.schemaVersion=7;await fs.writeFile(configPath,JSON.stringify(config));
  await fs.writeFile(path.join(root,'.gitignore'),oldRules);
  const target=path.join(root,'.prodero/sessions',session.id+'.md'),temporary=await interrupt(t,root,target,'migration');
  assert.match(temporary,/\.tmp-[a-f0-9-]{36}$/);assert.match(await fs.readFile(temporary,'utf8'),/private-fixture-agent/);
  assert.equal(await ignored(root,path.relative(root,temporary)),true);
  const eligible=(await git(root,'ls-files','--others','--exclude-standard')).stdout;
  assert.doesNotMatch(eligible,/\.prodero\/(?:local\/|\.cache\/|\.transactions\/|\.backups\/|\.migrations\/)|\.tmp-/);
  assert.deepEqual(eligible.split('\n').filter(f=>/^\.prodero\/(?:sessions|checkpoints)\//.test(f)).sort(),['.prodero/checkpoints/.gitkeep','.prodero/sessions/.gitkeep']);
});

test('F06: checked-in ignore policy matches generated policy and preserves placeholders',async t=>{
  const root=await fixture(t),rules=await fs.readFile(new URL('../.gitignore',import.meta.url),'utf8');
  for(const rule of LOCAL_STATE_IGNORE_RULES)assert.ok(rules.split('\n').includes(rule),rule);
  await fs.writeFile(path.join(root,'.gitignore'),rules);
  for(const relative of ['sessions/a.md.tmp-123-abc','checkpoints/a.json.tmp-abc','sessions/any/new-format','.backups/.gitignore.tmp-123-abc','.migrations/.gitignore.tmp-123-abc'])assert.equal(await ignored(root,'.prodero/'+relative),true);
  for(const dir of ['sessions','checkpoints','memory','skills'])assert.equal(await ignored(root,`.prodero/${dir}/.gitkeep`),false);
});

test('F06: runtime creation stops if ignore protection cannot be installed',async t=>{
  const root=await fixture(t);
  await fs.rm(path.join(root,'.prodero/sessions'),{recursive:true});
  await fs.rm(path.join(root,'.gitignore'));await fs.mkdir(path.join(root,'.gitignore'));
  await assert.rejects(createSession(root,{agent:'f06-regression'}));
  await assert.rejects(fs.access(path.join(root,'.prodero/sessions')),{code:'ENOENT'});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fork,execFileSync} from 'node:child_process';
import {initializeProject} from '../dist/core/project.js';
import {createSession,readSession} from '../dist/core/sessions.js';
import {withSyncLock} from '../dist/core/sync-transaction.js';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'curator-lock-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  execFileSync('git',['init','-q',root]);await initializeProject(root);await withSyncLock(root,async()=>{});return root;
}
const worker=new URL('./helpers/sync-lock-worker.mjs',import.meta.url);
function actor(t,role,root,...args){
  const child=fork(worker,[role,root,...args],{stdio:['ignore','pipe','pipe','ipc']});
  child.events=[];child.stderrText='';child.stderr.on('data',chunk=>child.stderrText+=chunk);
  child.on('message',message=>child.events.push(message));
  child.exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await child.exited;});
  return child;
}
function event(child,name){
  const prior=child.events.find(item=>item.event===name);if(prior)return Promise.resolve(prior);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(Error(`Barrier ${name} timed out: ${child.stderrText}`)),20_000);
    const message=value=>{if(value.event===name)finish(null,value);else if(value.event==='result'&&!value.ok)finish(Error(value.error));};
    const exit=()=>finish(Error(`Worker exited before ${name}: ${child.stderrText}`));
    function finish(error,value){clearTimeout(timer);child.off('message',message);child.off('exit',exit);error?reject(error):resolve(value);}
    child.on('message',message);child.once('exit',exit);
  });
}
const ids=session=>Object.values(session.sections).flat().map(line=>/\bid=(obs_[a-zA-Z0-9_]+)/.exec(line)?.[1]).filter(Boolean).sort();

test('stale reaper cannot remove a successor lock after its observed owner exits',async t=>{
  const root=await fixture(t),a=actor(t,'holder',root);assert.equal((await event(a,'entered')).overlap,false);
  const b=actor(t,'reaper',root);assert.equal(Number((await event(b,'captured')).owner),a.pid);
  a.send('release');
  // Old code releases while the stale reaper is paused. A correct shared guard
  // blocks that release instead; both schedules must retain mutual exclusion.
  const release=await Promise.race([event(a,'completed').then(()=> 'exited'),event(a,'release-blocked').then(()=> 'blocked')]);
  if(release==='exited')await a.exited;
  const c=actor(t,'successor',root);await event(c,'starting');
  if(release==='exited') {
    assert.equal((await event(c,'entered')).overlap,false);
    b.send('resume');
    const reaper=await event(b,'entered');
    assert.equal(reaper.overlap,false,'stale reaper entered an occupied critical section');
    assert.notEqual(c.exitCode,null,'successor must finish before another writer enters');
  } else {
    b.send('resume');
    const first=await Promise.race([event(b,'entered').then(value=>({child:b,value})),event(c,'entered').then(value=>({child:c,value}))]);
    assert.equal(first.value.overlap,false);
    const second=first.child===b?c:b;
    assert.equal(second.events.some(item=>item.event==='entered'),false);
    first.child.send('release');await first.child.exited;
    assert.equal((await event(second,'entered')).overlap,false);second.send('release');await second.exited;await a.exited;
  }
});

test('dead owner recovery still reclaims a PID-only legacy lock',async t=>{
  const root=await fixture(t),child=actor(t,'holder',root);await event(child,'entered');child.kill('SIGKILL');await child.exited;
  assert.equal(await withSyncLock(root,async()=>true,{waitMs:500}),true);
  await assert.rejects(fs.stat(path.join(root,'.prodero/.transactions/lock')),error=>error.code==='ENOENT');
  await assert.rejects(fs.stat(path.join(root,'.prodero/.transactions/lock-recovery')),error=>error.code==='ENOENT');
});

test('an interrupted transition guard fails closed and remains inspectable',async t=>{
  const root=await fixture(t),a=actor(t,'holder',root);await event(a,'entered');const b=actor(t,'reaper',root);await event(b,'captured');
  b.kill('SIGKILL');a.kill('SIGKILL');await Promise.all([a.exited,b.exited]);
  let ran=false;await assert.rejects(withSyncLock(root,async()=>{ran=true;},{waitMs:20}),/lock-recovery/);assert.equal(ran,false);
  const guard=path.join(root,'.prodero/.transactions/lock-recovery');assert.ok((await fs.stat(guard)).isDirectory());
  // This is the documented manual recovery only after all fixture writers stop.
  await fs.rm(guard,{recursive:true});assert.equal(await withSyncLock(root,async()=>true,{waitMs:500}),true);
});

test('missing, invalid, unsafe or live PID owners remain fail-closed',async t=>{
  for(const owner of [null,'','invalid','0','9007199254740992',String(process.pid)]){
    const root=await fixture(t),lock=path.join(root,'.prodero/.transactions/lock');await fs.mkdir(lock);
    if(owner!==null)await fs.writeFile(path.join(lock,'owner'),owner);
    let ran=false;await assert.rejects(withSyncLock(root,async()=>{ran=true;},{waitMs:20}),/already running/);assert.equal(ran,false);
    assert.equal(await fs.readFile(path.join(lock,'owner'),'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;}),owner);
  }
});

test('an old release preserves a successor directory even with the same PID',async t=>{
  const root=await fixture(t),lock=path.join(root,'.prodero/.transactions/lock');let successor;
  await assert.rejects(withSyncLock(root,async()=>{
    await fs.rename(lock,lock+'-previous');await fs.mkdir(lock);await fs.writeFile(path.join(lock,'owner'),String(process.pid));successor=await fs.stat(lock);
  }),/ownership changed/);
  assert.equal((await fs.stat(lock)).ino,successor.ino);assert.equal(await fs.readFile(path.join(lock,'owner'),'utf8'),String(process.pid));
});

test('failed owner publication never cleans up a replacement lock',async t=>{
  const root=await fixture(t),lock=path.join(root,'.prodero/.transactions/lock'),target=path.join(lock,'owner'),open=fs.open;let injected=false,successor;
  fs.open=async(file,...args)=>{
    if(!injected&&String(file)===target){injected=true;await fs.rename(lock,lock+'-previous');await fs.mkdir(lock);await fs.writeFile(target,String(process.pid));successor=await fs.stat(lock);throw Error('Injected owner publication failure');}
    return open(file,...args);
  };
  try{await assert.rejects(withSyncLock(root,async()=>assert.fail('must not enter')),/ownership changed/);}finally{fs.open=open;}
  assert.equal((await fs.stat(lock)).ino,successor.ino);assert.equal(await fs.readFile(target,'utf8'),String(process.pid));
});

test('failed owner publication cleans up its own partial lock and permits the next writer',async t=>{
  const root=await fixture(t),lock=path.join(root,'.prodero/.transactions/lock'),target=path.join(lock,'owner'),open=fs.open,failure=Error('Injected owner publication failure');let injected=false;
  fs.open=async(file,...args)=>{if(!injected&&String(file)===target){injected=true;throw failure;}return open(file,...args);};
  try{await assert.rejects(withSyncLock(root,async()=>assert.fail('must not enter')),error=>error===failure);}finally{fs.open=open;}
  assert.equal(injected,true);
  for(const name of ['lock','lock-recovery'])await assert.rejects(fs.stat(path.join(root,'.prodero/.transactions',name)),error=>error.code==='ENOENT');
  assert.equal(await withSyncLock(root,async()=>true),true);
});

test('an operation exception releases the lock and preserves the original error',async t=>{
  const root=await fixture(t),failure=Error('Injected operation failure');
  await assert.rejects(withSyncLock(root,async()=>{throw failure;}),error=>error===failure);
  for(const name of ['lock','lock-recovery'])await assert.rejects(fs.stat(path.join(root,'.prodero/.transactions',name)),error=>error.code==='ENOENT');
  assert.equal(await withSyncLock(root,async()=>true),true);
});

test('release waits with a fresh deadline after the acquisition deadline has expired',async t=>{
  const root=await fixture(t),guard=path.join(root,'.prodero/.transactions/lock-recovery'),mkdir=fs.mkdir,now=Date.now;let releasing=false,injected=false,clock=100;
  Date.now=()=>clock;
  fs.mkdir=async(file,...args)=>{
    if(releasing&&!injected&&String(file)===guard){injected=true;throw Object.assign(Error('Injected occupied transition guard'),{code:'EEXIST'});}
    return mkdir(file,...args);
  };
  try{assert.equal(await withSyncLock(root,async()=>{clock=10_000;releasing=true;return 'completed';}), 'completed');}finally{Date.now=now;fs.mkdir=mkdir;}
  assert.equal(injected,true);
  for(const name of ['lock','lock-recovery'])await assert.rejects(fs.stat(path.join(root,'.prodero/.transactions',name)),error=>error.code==='ENOENT');
});

test('release timeout rejects the acknowledgment and preserves lock state for inspection',async t=>{
  const root=await fixture(t),base=path.join(root,'.prodero/.transactions'),marker=path.join(root,'operation-completed'),now=Date.now;let releasing=false,reads=0,acknowledged=false;
  Date.now=()=>releasing?(reads++===0?10_000:16_000):100;
  try{
    await assert.rejects(withSyncLock(root,async()=>{
      await fs.writeFile(marker,'completed');await fs.mkdir(path.join(base,'lock-recovery'));releasing=true;return 'would-be acknowledgment';
    }).then(value=>{acknowledged=true;return value;}),/lock-recovery/);
  }finally{Date.now=now;}
  assert.equal(acknowledged,false);assert.equal(await fs.readFile(marker,'utf8'),'completed');
  assert.equal(await fs.readFile(path.join(base,'lock/owner'),'utf8'),String(process.pid));assert.ok((await fs.stat(path.join(base,'lock-recovery'))).isDirectory());
});

test('lock and transition paths reject symlinks without touching their targets',async t=>{
  for(const name of ['lock','lock-recovery']){
    const root=await fixture(t),outside=path.join(root,'untouched');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'marker'),'original');
    await fs.symlink(outside,path.join(root,'.prodero/.transactions',name));
    await assert.rejects(withSyncLock(root,async()=>assert.fail('must not enter')),/Unsafe|symlink/i);
    assert.equal(await fs.readFile(path.join(outside,'marker'),'utf8'),'original');
  }
});

test('a hardlinked owner is rejected without modifying the external file',async t=>{
  const root=await fixture(t),lock=path.join(root,'.prodero/.transactions/lock'),outside=path.join(root,'untouched');await fs.mkdir(lock);await fs.writeFile(outside,String(process.pid),{mode:0o644});await fs.link(outside,path.join(lock,'owner'));
  await assert.rejects(withSyncLock(root,async()=>assert.fail('must not enter')),/Unsafe|linked/i);
  assert.equal(await fs.readFile(outside,'utf8'),String(process.pid));assert.equal((await fs.stat(outside)).mode&0o777,0o644);
});

test('barrier-started record/record and record/close preserve every acknowledged ID',async t=>{
  for(let round=0;round<3;round++)for(const closing of [false,true]){
    const root=await fixture(t),session=await createSession(root);
    const children=Array.from({length:12},(_,index)=>actor(t,closing&&index===5?'close':'record',root,session.id,String(index)));
    await Promise.all(children.map(child=>event(child,'ready')));for(const child of children)child.send('go');
    const results=await Promise.all(children.map(child=>event(child,'result')));await Promise.all(children.map(child=>child.exited));
    const persisted=await readSession(root,session.id),acknowledged=results.filter(result=>result.ok).flatMap(result=>result.ids).sort();assert.deepEqual(ids(persisted),acknowledged);
    if(closing){assert.equal(persisted.status,'closed');assert.ok(results.filter(result=>!result.ok).every(result=>/closed/.test(result.error)));}
    else {assert.equal(acknowledged.length,12);assert.equal(persisted.status,'active');}
  }
});

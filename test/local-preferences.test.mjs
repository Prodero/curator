import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initializeProject,refreshProjectIntegration} from '../dist/core/project.js';
import {readConfig,writeConfig} from '../dist/core/storage.js';
import {projectSettings,setProjectSetting} from '../dist/core/settings.js';
import {planProjectMigration,migrateProject,MIGRATIONS} from '../dist/core/migrations.js';
import {withSyncLock} from '../dist/core/sync-transaction.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
const exec=promisify(execFile),file=(root,name)=>path.join(root,'.prodero',name);
const prefs=root=>file(root,'local/preferences.json');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-local-prefs-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await exec('git',['init','-q',root]);await initializeProject(root);return root;}
async function put(root,data){await fs.writeFile(prefs(root),typeof data==='string'?data:JSON.stringify(data));}
async function commit(root){await exec('git',['-C',root,'add','.']);await exec('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','synthetic fixture']);}

for(const legacy of [false,true])for(const integration of ['standard','old','missing','absent'])test(`L01/L03: ${legacy?'legacy':'fresh'} / ${integration} ignore rules: theme/mode saves never write shared files and stay Git-clean`,async t=>{
 const root=await fixture(t),config=await readConfig(root);
 config.extensionForTest={keep:true};if(legacy)config.presentation={mode:'ui',theme:'dark-neon',extension:{keep:true}};
 await writeConfig(root,config);
 if(integration==='old')await fs.writeFile(path.join(root,'.gitignore'),'# Custom old rules\ncustom/\n.prodero/.cache/\n.prodero/local/\n');
 if(integration==='missing')await fs.writeFile(path.join(root,'.gitignore'),'# Custom rules without private exclusions\ncustom/\n');
 if(integration==='absent')await fs.rm(path.join(root,'.gitignore'));
 await commit(root);
 const server=createServer({projectRoot:root}),client=new Client({name:'local-preferences-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const set=async arguments_=>{const result=await client.callTool({name:'prodero_config_set',arguments:arguments_});assert.notEqual(result.isError,true,JSON.stringify(result));};
 const original=await fs.readFile(file(root,'config.json'),'utf8'),stat=await fs.stat(file(root,'config.json'));
 const open=fs.open,rename=fs.rename,write=fs.writeFile,calls=[];
 const shared=p=>String(p).startsWith(file(root,'config.json'))||String(p).startsWith(path.join(root,'.gitignore'));
 fs.open=async(p,flags,...args)=>{if(shared(p)&&typeof flags==='string'&&/[wa+]/.test(flags))calls.push(['open',String(p)]);return open(p,flags,...args);};
 fs.rename=async(a,b)=>{if(shared(a)||shared(b))calls.push(['rename',String(b)]);return rename(a,b);};
 fs.writeFile=async(p,...args)=>{if(shared(p))calls.push(['write',String(p)]);return write(p,...args);};
 try{await set({key:'presentation.theme',value:'pink-neon'});await set({key:'presentation.theme',value:'pink-neon'});await set({key:'presentation.mode',value:'text'});await set({key:'presentation.theme',reset:true});}
 finally{fs.open=open;fs.rename=rename;fs.writeFile=write;}
 assert.deepEqual(calls,[]);assert.equal(await fs.readFile(file(root,'config.json'),'utf8'),original);
 assert.equal((await fs.stat(file(root,'config.json'))).ino,stat.ino);assert.equal((await fs.stat(file(root,'config.json'))).mtimeMs,stat.mtimeMs);
 assert.equal((await exec('git',['-C',root,'status','--porcelain'])).stdout,'');
 await exec('git',['-C',root,'check-ignore','-q','.prodero/local/preferences.json']);
 assert.equal((await projectSettings(root)).presentation.theme,legacy?'dark-neon':'prodero');
 if(process.platform!=='win32'){assert.equal((await fs.stat(prefs(root))).mode&0o777,0o600);assert.equal((await fs.stat(file(root,'local'))).mode&0o777,0o700);}
});

test('L01: reads do not create, copy, write or chmod; per-field sources, explicit defaults and reset preserve extensions',async t=>{
 const root=await fixture(t),config=await readConfig(root);config.presentation={mode:'ui',theme:'dark-neon',teamExtension:{keep:true}};await writeConfig(root,config);
 const write=fs.writeFile,mkdir=fs.mkdir,rename=fs.rename,chmod=fs.chmod;
 const unexpected=async()=>{throw new Error('read attempted mutation');};fs.writeFile=unexpected;fs.mkdir=unexpected;fs.rename=unexpected;fs.chmod=unexpected;
 try{const view=await projectSettings(root);assert.deepEqual(view.presentation,{mode:'ui',theme:'dark-neon'});assert.equal(view.settings[0].source,'legacy project default');assert.deepEqual(view.diagnostics,[]);}
 finally{fs.writeFile=write;fs.mkdir=mkdir;fs.rename=rename;fs.chmod=chmod;}
 await assert.rejects(fs.access(prefs(root)),{code:'ENOENT'});
 await put(root,{version:1,extension:{keep:true},presentation:{theme:'system',pluginExtension:{keep:true}}});
 assert.deepEqual((await projectSettings(root)).presentation,{mode:'ui',theme:'system'});
 await setProjectSetting(root,'presentation.mode','auto');let view=await projectSettings(root);assert.equal(view.presentation.mode,'auto');assert.equal(view.settings[0].source,'local override');
 await setProjectSetting(root,'presentation.mode',undefined,{reset:true});view=await projectSettings(root);assert.deepEqual(view.presentation,{mode:'ui',theme:'system'});
 assert.deepEqual(JSON.parse(await fs.readFile(prefs(root),'utf8')),{version:1,extension:{keep:true},presentation:{theme:'system',pluginExtension:{keep:true}}});
 assert.deepEqual((await readConfig(root)).presentation,config.presentation);
});

test('L01/L02: invalid local sibling falls back independently; corrupt/newer/unsafe formats are diagnosed without leaks or overwrite',async t=>{
 const root=await fixture(t),secret='synthetic-private-value';
 for(const raw of ['{'+secret, {version:99,presentation:{theme:'light'},secret}, {version:1,presentation:{mode:'bad-'+secret,theme:'system'}}, {version:1,context:{max_tokens:1},presentation:{theme:'light'}}, {version:1,presentation:{theme:'light',knowledgeEngine:{mode:'assisted'}}}, {version:1,presentation:[]}]){
  await put(root,raw);const before=await fs.readFile(prefs(root),'utf8'),view=await projectSettings(root);
  assert.ok(view.diagnostics.length);assert.ok(!JSON.stringify(view.diagnostics).includes(secret));
  assert.equal(view.presentation.theme,typeof raw==='object'&&raw.presentation?.mode?.startsWith('bad-')?'system':'prodero');
  await assert.rejects(setProjectSetting(root,'presentation.mode','text'),/PRODERO_LOCAL_PREFERENCES_/);
  await assert.rejects(setProjectSetting(root,'presentation.theme',undefined,{reset:true}),/PRODERO_LOCAL_PREFERENCES_/);
  assert.equal(await fs.readFile(prefs(root),'utf8'),before);
 }
 await fs.rm(prefs(root));await setProjectSetting(root,'presentation.mode',undefined,{reset:true});await assert.rejects(fs.access(prefs(root)),{code:'ENOENT'});
});

test('L02: context budget stays canonical, reset is explicit and local preference data cannot become shared policy',async t=>{
 const root=await fixture(t);await put(root,{version:1,extension:{keep:true},presentation:{theme:'light'}});
 const local=await fs.readFile(prefs(root),'utf8');await setProjectSetting(root,'context.max_tokens',8000);
 assert.equal((await readConfig(root)).context.max_tokens,8000);assert.equal(await fs.readFile(prefs(root),'utf8'),local);
 for(const [key,value,options] of [['context.max_tokens',undefined,{reset:true}],['presentation.theme','light',{reset:true}],['presentation.theme',null,{}],['presentation.theme',undefined,{}],['context.max_tokens',null,{}],['../config','text',{}]])await assert.rejects(setProjectSetting(root,key,value,options));
});

test('L02: missing initialization, newer canonical schemas and interrupted migration block all preference writes',async t=>{
 const root=await fixture(t),current=await readConfig(root);await setProjectSetting(root,'presentation.theme','light');const local=await fs.readFile(prefs(root),'utf8');
 for(const key of ['schemaVersion','knowledgeSchemaVersion']){
  await fs.writeFile(file(root,'config.json'),JSON.stringify({...current,[key]:99,presentation:{theme:'dark-neon'}}));
  const view=await projectSettings(root);assert.equal(view.presentation.theme,'light');
  await assert.rejects(setProjectSetting(root,'presentation.mode','text'),/SCHEMA_NEWER/);assert.equal(await fs.readFile(prefs(root),'utf8'),local);
 }
 await fs.writeFile(file(root,'config.json'),JSON.stringify(current));await fs.writeFile(file(root,'.transactions/migration.json'),'{}');
 await assert.rejects(setProjectSetting(root,'presentation.mode','text'),/Interrupted migration/);assert.equal(await fs.readFile(prefs(root),'utf8'),local);
 await fs.rm(file(root,'.transactions/migration.json'));await fs.rm(file(root,'config.json'));
 await assert.rejects(setProjectSetting(root,'presentation.mode','text'),/Initialize/);assert.equal(await fs.readFile(prefs(root),'utf8'),local);
});

test('L02: saving presentation never recovers pending lifecycle knowledge writes',async t=>{
 const root=await fixture(t),before=await fs.readFile(file(root,'config.json'),'utf8');
 const pending=JSON.stringify({version:2,writes:[],moves:[]});await fs.mkdir(file(root,'.transactions'),{recursive:true});await fs.writeFile(file(root,'.transactions/pending.json'),pending);
 await assert.rejects(setProjectSetting(root,'presentation.theme','light'),/Lifecycle transaction pending/);
 assert.equal(await fs.readFile(file(root,'.transactions/pending.json'),'utf8'),pending);assert.equal(await fs.readFile(file(root,'config.json'),'utf8'),before);await assert.rejects(fs.access(prefs(root)),{code:'ENOENT'});
});

test('L02: preference symlinks and hardlinks cannot be read or overwritten; diagnostics do not disclose targets',async t=>{
 const root=await fixture(t),outside=path.join(root,'outside-private');await fs.writeFile(outside,'synthetic-secret-body');
 for(const type of ['symlink','hardlink']){
  await fs[type==='symlink'?'symlink':'link'](outside,prefs(root));const view=await projectSettings(root);assert.ok(view.diagnostics.length);assert.ok(!JSON.stringify(view.diagnostics).includes(outside));
  await assert.rejects(setProjectSetting(root,'presentation.theme','light'));assert.equal(await fs.readFile(outside,'utf8'),'synthetic-secret-body');await fs.unlink(prefs(root));
 }
});

test('L02/L03: conflicting or unsafe nested ignore rules fail without overwriting preferences, shared rules or custom content',async t=>{
 const root=await fixture(t);await setProjectSetting(root,'presentation.theme','dark-neon');
 const before=await fs.readFile(prefs(root),'utf8'),shared=await fs.readFile(path.join(root,'.gitignore'),'utf8');
 for(const directory of ['local','.transactions']){
  const target=file(root,directory+'/.gitignore'),original=await fs.readFile(target,'utf8');
  for(const custom of ['*\n!preferences.json\n# private-custom-body\n',' *\n']){
   await fs.writeFile(target,custom);
   await assert.rejects(setProjectSetting(root,'presentation.theme','light'),error=>/PRODERO_LOCAL_IGNORE_UNAVAILABLE/.test(error.message)&&!error.message.includes('private-custom-body'));
   assert.equal(await fs.readFile(target,'utf8'),custom);assert.equal(await fs.readFile(prefs(root),'utf8'),before);await fs.writeFile(target,original);
  }
  const outside=path.join(root,'ignore-outside');await fs.writeFile(outside,'*\n',{mode:0o644});const outsideStat=await fs.stat(outside);
  for(const type of ['symlink','hardlink']){
   await fs.unlink(target);await fs[type==='symlink'?'symlink':'link'](outside,target);
   await assert.rejects(setProjectSetting(root,'presentation.theme','light'),/PRODERO_LOCAL_IGNORE_UNAVAILABLE/);
   assert.equal(await fs.readFile(outside,'utf8'),'*\n');assert.equal((await fs.stat(outside)).ino,outsideStat.ino);assert.equal((await fs.stat(outside)).mode,outsideStat.mode);assert.equal(await fs.readFile(prefs(root),'utf8'),before);
   await fs.unlink(target);await fs.writeFile(target,original);
  }
  await fs.rm(outside);
 }
 assert.equal(await fs.readFile(path.join(root,'.gitignore'),'utf8'),shared);
});

test('L03: theme/mode saves leave migration plan hash stable and survive re-init and integration refresh',async t=>{
 const root=await fixture(t),config=await readConfig(root);config.schemaVersion=7;await writeConfig(root,config);
 const plan=await planProjectMigration(root);await setProjectSetting(root,'presentation.theme','dark-neon');await setProjectSetting(root,'presentation.mode','text');
 assert.equal((await planProjectMigration(root)).planId,plan.planId);const local=await fs.readFile(prefs(root),'utf8');
 await initializeProject(root);assert.equal(await fs.readFile(prefs(root),'utf8'),local);
 await refreshProjectIntegration(root);assert.equal(await fs.readFile(prefs(root),'utf8'),local);
});

test('L02/L03: shared migration lock serializes saves after staged local replacement without losing either field',async t=>{
 const root=await fixture(t);await setProjectSetting(root,'presentation.theme','dark-neon');const config=await readConfig(root);config.schemaVersion=7;await writeConfig(root,config);
 const original=MIGRATIONS[7];let started,release;const begun=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 MIGRATIONS[7]={...original,run:async(stage,c)=>{started();await gate;await original.run(stage,c);}};
 const migration=migrateProject(root,config);await begun;
 const save=setProjectSetting(root,'presentation.mode','text');
 try{release();await migration;await save;}finally{release();MIGRATIONS[7]=original;await migration.catch(()=>{});}
 assert.deepEqual((await projectSettings(root)).presentation,{mode:'text',theme:'dark-neon'});
});

test('L02: simultaneous saves preserve fields; lock-busy failure is retryable and preserves original local file',async t=>{
 const root=await fixture(t);await Promise.all([setProjectSetting(root,'presentation.mode','text'),setProjectSetting(root,'presentation.theme','dark-neon')]);
 assert.deepEqual((await projectSettings(root)).presentation,{mode:'text',theme:'dark-neon'});const before=await fs.readFile(prefs(root),'utf8');
 await withSyncLock(root,async()=>{await assert.rejects(setProjectSetting(root,'presentation.theme','light'),/Another Sync or storage writer/);});
 assert.equal(await fs.readFile(prefs(root),'utf8'),before);
});

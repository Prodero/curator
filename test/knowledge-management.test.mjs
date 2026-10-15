import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {initializeProject,rememberProjectKnowledge,resolveProjectContext,buildIndex} from '../dist/core/project.js';
import {knowledgeView,mutateKnowledge} from '../dist/core/knowledge-management.js';
import {writeKnowledge} from '../dist/core/memory.js';
import {previewKnowledgePromotion,applyKnowledgePromotion} from '../dist/core/promotion.js';
import {listCheckpoints} from '../dist/core/storage.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {PRODERO_TOOLS as T} from '../dist/contracts.js';
const exec=promisify(execFile);
async function fixture(t){const root=await fs.mkdtemp('/tmp/prodero-knowledge-ui-');t.after(()=>fs.rm(root,{recursive:true,force:true}));await exec('git',['init','-q',root]);await initializeProject(root);return root;}
function item(id,more={}){return {id,scope:'global',scopeRef:null,category:'state',priority:'normal',status:'active',title:'Cedar deployment',content:'Cedar deployment uses the staging queue.',createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[],...more};}
async function commit(root){await exec('git',['-C',root,'add','.']);await exec('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture']);}
async function clean(root){assert.equal((await exec('git',['-C',root,'status','--porcelain'])).stdout,'');}
async function detail(root,id){return (await knowledgeView(root,{},id)).detail;}
function edit(i,extra={}){return {id:i.id,revision:i.revision,action:'edit',approved:true,title:i.title,content:'Cedar deployment uses the production queue.',...extra};}

test('Knowledge catalogue unifies layers, paginates indexed search, filters type/path/history and retains shadowed repository items',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('mem_repository')); const local=await rememberProjectKnowledge(root,{content:'Documents use Cedar examples.',kind:'rule',scope:'path',path:'docs'});
 for(let n=0;n<15;n++)await writeKnowledge(root,item('mem_page_'+n,{title:'Item '+n,content:'Searchable catalogue page '+n}),false,'local');
 const view=await knowledgeView(root);assert.equal(view.total,17);assert.equal(view.matches.length,12);assert.equal(view.nextOffset,12);assert.equal(view.counts.local,16);assert.equal(view.counts.versioned,1);
 assert.equal((await knowledgeView(root,{offset:12})).matches.length,5);
 assert.equal((await knowledgeView(root,{query:'Cedar',layer:'versioned'})).matches.length,1);
 assert.equal((await knowledgeView(root,{category:'instruction',scope:'path',path:'docs/file.md'})).matches[0].id,local.item.id);
 assert.equal((await knowledgeView(root,{scope:'path',path:'src'})).total,0);
 await assert.rejects(knowledgeView(root,{scope:'path'}),/requires/);
 const d=await detail(root,local.item.id);await mutateKnowledge(root,{id:d.id,revision:d.revision,action:'retire',approved:true});
 assert.equal((await knowledgeView(root,{category:'instruction'})).total,0);assert.equal((await knowledgeView(root,{category:'instruction',includeHistorical:true})).total,1);
 await rememberProjectKnowledge(root,{replaceId:'mem_repository',content:'Cedar deployment uses a production queue.'});
 assert.equal((await knowledgeView(root,{layer:'versioned'})).matches[0].shadowed,true);
});

test('Local edits preserve ID, provenance, scope and history, refresh retrieval/graph and remain Git-clean',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('mem_repository'));await buildIndex(root);await commit(root);
 const saved=await rememberProjectKnowledge(root,{title:'Worker fixture',content:'Workers use the staging queue.',kind:'fact'});const before=await detail(root,saved.item.id);
 await mutateKnowledge(root,edit(before,{content:'Workers use the amber transport.'}));
 const after=await detail(root,before.id);assert.equal(after.id,before.id);assert.equal(after.scope,before.scope);assert.deepEqual(after.sourceSessions,before.sourceSessions);assert.notEqual(after.revision,before.revision);
 assert.equal((await listCheckpoints(root)).at(-1).knowledgeBefore[0].content,before.content);
 assert.ok((await resolveProjectContext(root,'amber transport')).relevant.some(i=>i.id===before.id));
 await assert.rejects(mutateKnowledge(root,edit(before)),/changed since/);
 await assert.rejects(mutateKnowledge(root,{id:before.id,revision:before.revision,action:'retire',approved:true}),/changed since/);
 await mutateKnowledge(root,{id:after.id,revision:after.revision,action:'retire',approved:true});
 assert.equal((await knowledgeView(root,{query:'amber'})).total,0);assert.ok(!(await resolveProjectContext(root,'amber')).relevant.some(i=>i.id===after.id));
 await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true,force:true});assert.equal((await knowledgeView(root,{query:'amber',includeHistorical:true})).total,1);await clean(root);
});

test('Repository maintenance requires explicit approval/mode, preserves ID, creates only expected Git diff, supports retire and stale protection',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('legacy-repository'));await buildIndex(root);await commit(root);const before=await detail(root,'legacy-repository');
 await assert.rejects(mutateKnowledge(root,edit(before)),/repository-maintenance/);await assert.rejects(mutateKnowledge(root,edit(before,{mode:'repository-maintenance',approved:false})));await clean(root);
 await mutateKnowledge(root,edit(before,{mode:'repository-maintenance'}));const after=await detail(root,before.id);assert.equal(after.id,before.id);
 assert.deepEqual((await exec('git',['-C',root,'diff','--name-only'])).stdout.trim().split('\n'),['.prodero/memory/legacy-repository.md']);
 await assert.rejects(mutateKnowledge(root,edit(before,{mode:'repository-maintenance'})),/changed since/);
 await mutateKnowledge(root,{id:after.id,revision:after.revision,mode:'repository-maintenance',action:'retire',approved:true});
 const changed=(await exec('git',['-C',root,'diff','--name-only'])).stdout;assert.match(changed,/index.md/);assert.match(changed,/legacy-repository.md/);
 assert.equal((await detail(root,before.id)).status,'deprecated');await assert.rejects(mutateKnowledge(root,edit(await detail(root,before.id),{mode:'repository-maintenance'})),/Historical/);
});

test('Promotion uses existing exact-preview workflow after edits and secret screening protects all management mutations',async t=>{
 const root=await fixture(t);const saved=await rememberProjectKnowledge(root,{content:'Cedar uses the staging queue.',kind:'fact'});const d=await detail(root,saved.item.id);const preview=await previewKnowledgePromotion(root,{ids:[d.id]});
 const snapshot=async()=>JSON.stringify(await fs.readdir(path.join(root,'.prodero/checkpoints')));const before=await snapshot();
 const secret='api_key=synthetic_ui_rejection_123456';
 await assert.rejects(mutateKnowledge(root,edit(d,{title:secret})),/credential/);await assert.rejects(mutateKnowledge(root,edit(d,{content:secret})),/credential/);assert.equal(await snapshot(),before);
 await mutateKnowledge(root,edit(d));await assert.rejects(applyKnowledgePromotion(root,preview,true),/changed after/);
 const fresh=await previewKnowledgePromotion(root,{ids:[d.id]});await applyKnowledgePromotion(root,fresh,true);assert.equal((await knowledgeView(root)).counts.versioned,1);
 async function scan(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await scan(p);else assert.ok(!(await fs.readFile(p,'utf8')).includes(secret));}}await scan(path.join(root,'.prodero'));
});

test('MCP exposes knowledge catalogue/detail text fallback and refuses ordinary Versioned mutations',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('mem_repository'));
 const server=createServer({projectRoot:root}),client=new Client({name:'knowledge-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const call=(name,args={})=>client.callTool({name,arguments:{projectRoot:root,...args}});
 const list=await call(T.knowledge);assert.equal(list.structuredContent.result.total,1);assert.match(list.content[0].text,/Versioned  1/);
 const inspected=await call(T.knowledge,{id:'mem_repository'});assert.match(inspected.content[0].text,/Revision:/);assert.match(inspected.content[0].text,/Git-shareable/);
 const i=inspected.structuredContent.result.detail;const rejected=await call(T.knowledgeMutate,edit(i));assert.equal(rejected.isError,true);
 const changed=await call(T.knowledgeMutate,edit(i,{mode:'repository-maintenance'}));assert.equal(changed.structuredContent.result.detail.id,i.id);
});


test('Local maintenance works for supported legacy canonical identities and preserves graph refresh',async t=>{
 const root=await fixture(t);await writeKnowledge(root,item('legacy-local'),false,'local');await buildIndex(root);await commit(root);
 const before=await detail(root,'legacy-local');const graphBefore=JSON.parse(await fs.readFile(root+'/.prodero/.cache/knowledge-graph.json','utf8')).sourceDigest;
 await mutateKnowledge(root,edit(before));const graphAfter=JSON.parse(await fs.readFile(root+'/.prodero/.cache/knowledge-graph.json','utf8')).sourceDigest;assert.notEqual(graphAfter,graphBefore);
 const current=await detail(root,before.id);await mutateKnowledge(root,{id:current.id,revision:current.revision,action:'retire',approved:true});assert.equal((await detail(root,current.id)).status,'deprecated');await clean(root);
});


test('Catalogue browsing does not turn an empty conversational forget into an arbitrary deletion',async t=>{
 const {forgetMemory,searchMemory}=await import('../dist/core/memory-operations.js');const root=await fixture(t);await writeKnowledge(root,item('mem_only'),false,'local');
 assert.equal((await knowledgeView(root)).total,1);assert.deepEqual(await searchMemory(root,''),[]);await assert.rejects(forgetMemory(root,{}),/No active knowledge/);assert.equal((await detail(root,'mem_only')).status,'active');
});

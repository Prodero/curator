import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareProject,recordProjectSession,closeProjectSession} from '../dist/core/project.js';
import {getMemorySyncOverview} from '../dist/core/memory-sync.js';
import {listKnowledge} from '../dist/core/memory.js';
import {readSession} from '../dist/core/sessions.js';
import {fixture,session,entry} from './helpers/intelligence-fixtures.mjs';
import {fakeProvider} from './helpers/intelligence-provider.mjs';

test('automatic uncertain audit preserves evidence without creating a user moderation blocker',async t=>{
 const root=await fixture(t);
 await session(root,[entry('Rule alpha.'),entry('Rule beta.'),entry('Rule gamma.')]);
 const provider=fakeProvider({audit:({items})=>({status:'uncertain',issues:[{kind:'uncertain',sources:[items[0].id],reason:'Available evidence does not settle this optional improvement.'}],actions:[]})});
 const prepared=await prepareProject(root,{task:'Document cache lifecycle',provider});
 assert.equal(prepared.automaticSync.intelligence.audit.status,'attention');
 assert.equal(prepared.maintenance.unresolvedRetained,true);
 assert.equal(prepared.maintenance.userInputRequired,false);
 assert.equal(prepared.context.policyReadiness.blocking,false);
 assert.ok(!prepared.context.attention.some(a=>a.title==='Knowledge review needed'));
 const current=await listKnowledge(root);
 for(const original of ['Rule alpha.','Rule beta.','Rule gamma.'])assert.ok(current.some(i=>i.content.includes(original)&&i.status==='active'));
 assert.equal(provider.calls.filter(c=>c.phase==='audit').length,1);
});

test('quiet automatic recovery is receipted, leaves active sessions open and is idempotent',async t=>{
 const root=await fixture(t,false),first=await prepareProject(root);
 await recordProjectSession(root,first.session.id,[entry('Cache snapshots remain local.')]);
 const recovered=await prepareProject(root,{task:'Cache snapshots'});
 assert.equal(recovered.maintenance.automatic.sessions,1);
 assert.equal(recovered.maintenance.automatic.created,1);
 assert.ok(recovered.maintenance.automatic.checkpoint);
 assert.equal((await readSession(root,first.session.id)).status,'active');
 await closeProjectSession(root,first.session.id);
 await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true,force:true});
 const again=await prepareProject(root,{task:'Cache snapshots'});
 assert.equal(again.maintenance.automatic.sessions,0);
 assert.equal((await listKnowledge(root)).length,1);
});

test('missing optional usage history is distinct from an overview storage failure',async t=>{
 const root=await fixture(t,false);
 const empty=await getMemorySyncOverview(root);
 assert.equal(empty.diagnostic,undefined);
 const state=path.join(root,'.prodero/local/memory-sync.json');
 const malformed='password=synthetic-parser-fixture';
 await fs.writeFile(state,malformed);
 const failed=await getMemorySyncOverview(root);
 assert.equal(failed.available,false);
 assert.equal(failed.diagnostic.code,'PRODERO_MEMORY_OVERVIEW_UNAVAILABLE');
 assert.match(failed.diagnostic.cause,/PRODERO_INVALID_JSON/);
 assert.ok(!JSON.stringify(failed).includes(malformed));
 assert.equal(await fs.readFile(state,'utf8'),malformed);
});

test('overview keeps recovery failures diagnostic and never repairs a journal on read',async t=>{
 const root=await fixture(t,false),journal=path.join(root,'.prodero/.transactions/pending.json');
 await fs.mkdir(path.dirname(journal),{recursive:true});
 await fs.writeFile(journal,'{}');
 const before=await fs.readFile(journal),result=await getMemorySyncOverview(root);
 assert.equal(result.available,false);
 assert.match(result.diagnostic.cause,/storage writer|recovery journal/);
 assert.deepEqual(await fs.readFile(journal),before);
 await assert.rejects(prepareProject(root,{task:'Continue task'}));
 assert.deepEqual(await fs.readFile(journal),before);
});

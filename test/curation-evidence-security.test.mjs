import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer, PRODERO_TOOLS} from '../dist/server.js';
import {initializeProject} from '../dist/core/project.js';
import {writeKnowledge} from '../dist/core/memory.js';
import {collectCurationEvidence, evidenceFor} from '../dist/core/curation-evidence.js';
import {validateCurationPlan} from '../dist/core/knowledge-curation.js';
import {sha256} from '../dist/core/storage.js';
import {curationApplyBinding} from '../dist/core/curation-review.js';

const credential='synthetic_audit_credential';
const safe='// SERVICE_PASSWORD is supplied by the test harness; CedarAPI uses isolated fixtures.';
const clean=value=>assert.ok(!JSON.stringify(value).includes(credential), 'Credential must not cross the curation boundary');
async function fixture(t, content='Decision:\nCedarAPI tests must obtain SERVICE_PASSWORD from the test harness.') {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-f03-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await initializeProject(root);
  await writeKnowledge(root,{version:3,id:'rule',category:'instruction',contextPolicy:'required',authority:'legacy_inherited',applicability:{kind:'legacy'},scope:'global',scopeRef:null,priority:'normal',status:'active',title:'Test configuration',content,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[]});
  await fs.mkdir(path.join(root,'tests'));
  await fs.writeFile(path.join(root,'tests/ordinary.ts'),safe);
  const server=createServer({projectRoot:root});
  const client=new Client({name:'f03-security-regression',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  t.after(async()=>{await client.close();await server.close();});
  const call=(name,args)=>client.callTool({name,arguments:args});
  return {root,call};
}
async function assertCleanState(dir) {
  for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
    const file=path.join(dir,entry.name);
    if(entry.isDirectory())await assertCleanState(file);
    else if(entry.isFile())clean(await fs.readFile(file,'utf8'));
  }
}

test('F03: recognized credentials are excluded before MCP plan, persisted review and model preparation',async t=>{
  const {root,call}=await fixture(t);
  // Exact audit class, plus a credential outside any selected/truncated excerpt.
  await fs.writeFile(path.join(root,'tests/deploy.sh'),`# SERVICE_PASSWORD password=${credential}`);
  await fs.writeFile(path.join(root,'tests/adjacent.ts'),`${safe}\n${' '.repeat(400)}password=${credential}`);
  await fs.writeFile(path.join(root,'tests/credentials.ts'),safe);
  const inventory=await collectCurationEvidence(root);
  assert.equal(inventory.sensitiveExcluded,3);assert.deepEqual(inventory.files.map(f=>f.path),['AGENTS.md','tests/ordinary.ts']);clean(inventory);
  assert.deepEqual(evidenceFor('SERVICE_PASSWORD',inventory).map(e=>e.excerpt),[safe]);
  // Exported extraction must also reject a caller-constructed unscreened inventory.
  assert.deepEqual(evidenceFor('SERVICE_PASSWORD',{...inventory,files:[{path:'tests/deploy.sh',revision:'ignored',content:`SERVICE_PASSWORD password=${credential}`}]}),[]);
  const planned=await call(PRODERO_TOOLS.curation,{action:'plan'});
  assert.notEqual(planned.isError,true);clean(planned);assert.match(JSON.stringify(planned),/Sensitive evidence excluded/);assert.match(JSON.stringify(planned),/tests\/ordinary.ts/);
  const textPlan=await call('prodero_text',{tool:PRODERO_TOOLS.curation,arguments:{action:'plan'}});
  assert.notEqual(textPlan.isError,true);clean(textPlan);
  const created=await call(PRODERO_TOOLS.curationReview,{action:'create'});
  assert.notEqual(created.isError,true);clean(created);
  const review=created.structuredContent.review;
  assert.deepEqual(review.snapshot.plan.evidenceExclusions,[{reason:'Sensitive evidence excluded',count:3}]);
  for(const action of ['inspect','preview']) {
    const response=await call(PRODERO_TOOLS.curationReview,{action,reviewId:review.snapshot.reviewId});
    assert.notEqual(response.isError,true);clean(response);
  }
  const prepared=await call(PRODERO_TOOLS.curationReasoningPrepare,{prepare:{reviewId:review.snapshot.reviewId,reviewRevisionId:review.snapshot.revision.id,componentId:review.snapshot.revision.dependencies.groups[0].component,requestId:'f03'}});
  assert.notEqual(prepared.isError,true);clean(prepared);
  const job=prepared.structuredContent.result;
  assert.ok(job.task.data.evidence.length);assert.ok(job.task.data.evidence.every(e=>e.excerpt===safe&&e.revision===sha256(safe)));
  const resumed=await call(PRODERO_TOOLS.curationReasoningPrepare,{jobId:job.jobId});
  assert.notEqual(resumed.isError,true);clean(resumed);
  await assertCleanState(path.join(root,'.prodero'));
});

test('F03: checkpoint replay cannot return unsafe historical evidence',async t=>{
  const {root,call}=await fixture(t,'Decision:\nCedarAPI tests must isolate exports.');
  let review=(await call(PRODERO_TOOLS.curationReview,{action:'create'})).structuredContent.review;
  review=(await call(PRODERO_TOOLS.curationReview,{action:'decide',reviewId:review.snapshot.reviewId,planHash:review.snapshot.planHash,decisionRevision:review.state.revision,decisions:{[review.snapshot.units[0].id]:'suggested'}})).structuredContent.review;
  const request={reviewId:review.snapshot.reviewId,planHash:review.snapshot.planHash,decisionRevision:review.state.revision,...curationApplyBinding(review,['rule']),selectedIds:['rule']};
  const applied=await call(PRODERO_TOOLS.curationApply,request);assert.notEqual(applied.isError,true);clean(applied);
  const ordinaryReplay=await call(PRODERO_TOOLS.curationApply,request);assert.notEqual(ordinaryReplay.isError,true);clean(ordinaryReplay);
  const directory=path.join(root,'.prodero/checkpoints');let changed=0;
  for(const name of await fs.readdir(directory)) {
    if(!name.endsWith('.json'))continue;
    const file=path.join(directory,name),before=await fs.readFile(file,'utf8');
    if(before.includes(safe)){await fs.writeFile(file,before.replaceAll(safe,`SERVICE_PASSWORD password=${credential}`));changed++;}
  }
  assert.ok(changed,'Fixture must contain persisted curation evidence');
  const replay=await call(PRODERO_TOOLS.curationApply,request);assert.equal(replay.isError,true);clean(replay);
});

test('F03: unsafe historical review and reasoning jobs fail closed instead of returning cached evidence',async t=>{
  const {root,call}=await fixture(t);
  const created=await call(PRODERO_TOOLS.curationReview,{action:'create'}),review=created.structuredContent.review;
  const prepared=await call(PRODERO_TOOLS.curationReasoningPrepare,{prepare:{reviewId:review.snapshot.reviewId,reviewRevisionId:review.snapshot.revision.id,componentId:review.snapshot.revision.dependencies.groups[0].component,requestId:'historical'}});
  const job=prepared.structuredContent.result;
  // A validly re-sealed plan still fails content validation, independently of integrity checks.
  const plan=structuredClone(review.snapshot.plan);
  plan.proposals[0].evidence.push(`password=${credential}`);
  const {planId,...body}=plan;plan.planId=sha256(JSON.stringify(body));
  assert.throws(()=>validateCurationPlan(plan),/Potential credential/);
  // Simulate legacy on-disk state; it must not be replayed through successful results.
  for(const [file,tool,args] of [
    [path.join(root,'.prodero/local/curation-reasoning',`${job.jobId}.json`),PRODERO_TOOLS.curationReasoningPrepare,{jobId:job.jobId}],
    [path.join(root,'.prodero/local/curation-reviews',`${review.snapshot.reviewId}.json`),PRODERO_TOOLS.curationReview,{action:'inspect',reviewId:review.snapshot.reviewId}],
  ]) {
    const before=await fs.readFile(file,'utf8');assert.ok(before.includes(safe));
    let unsafe=before.replaceAll(safe,`SERVICE_PASSWORD password=${credential}`);
    if(tool===PRODERO_TOOLS.curationReasoningPrepare) {
      // Preserve the persisted job's integrity chain: screening, not a bad hash, must reject it.
      const saved=JSON.parse(unsafe);
      saved.input.bundleHash=sha256(JSON.stringify(saved.input.bundle));
      saved.inputSeal=sha256(JSON.stringify(saved.input));
      let previous=saved.inputSeal;
      saved.events=saved.events.map(({hash,...event})=>{const body={...event,previousHash:previous};previous=sha256(JSON.stringify(body));return {...body,hash:previous};});
      unsafe=JSON.stringify(saved);
    }
    await fs.writeFile(file,unsafe);
    const response=await call(tool,args);assert.equal(response.isError,true);clean(response);
    assert.equal(await fs.readFile(file,'utf8'),unsafe,'Do not silently rewrite sealed historical state');
  }
});

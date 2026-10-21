/** UX diagnostics use only owned temporary fixtures; no real project roots accepted. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createMemoryBundleFixture,fixtureItem,observeFixture} from './memory-bundle-fixtures.mjs';
import {fixtureProposal} from './memory-proposal-fixtures.mjs';
import {runMemorySync,getMemorySyncOverview} from '../../dist/core/memory-sync.js';
import {getDetailedProjectStatus,prepareProject} from '../../dist/core/project.js';
import {writeKnowledge} from '../../dist/core/memory.js';
import {loadMemoryCatalog} from '../../dist/core/memory-index.js';
import {pressureRecord,recordSyncEvidenceLocked} from '../../dist/core/memory-pressure.js';
import {withSyncLock} from '../../dist/core/sync-transaction.js';
import {submitSemanticCuration} from '../../dist/core/curation-semantic-jobs.js';
export const syncPayload=result=>({ok:true,action:'memory-sync',result});
export async function memoryUxFixtures(){
 const fixtures=[],output={};
 const create=async scenario=>{const f=await createMemoryBundleFixture(scenario);fixtures.push(f);return f;};
 const call=(f,w,action,extra={})=>runMemorySync(f.root,{action,workflowId:w.id,revision:w.revision,...extra});
 const open=async f=>({product:'Prodero',action:'open',phase:'ready',hydrationRequired:false,project:{...await getDetailedProjectStatus(f.root),memoryOverview:await getMemorySyncOverview(f.root)}});
 const prepare=async f=>{let w=await runMemorySync(f.root,{action:'start'});w=await call(f,w,'select',{candidateIds:w.jobs.map(j=>j.id)});return call(f,w,'prepare',{candidateId:w.next.candidateId});};
 try{
  const empty=await create('fragmentation');await fs.rm(path.join(empty.root,'.prodero/local/memory-pressure.json'));output.noHistory=await open(empty);
  const two=await create('fragmentation');const ids=['mem_steer_0','mem_steer_1','mem_steer_2','mem_steer_3'];for(const id of ids)await writeKnowledge(two.root,fixtureItem(id,{title:'Steering control',scopeRef:'src/steering'}),false,'local');await observeFixture(two.root,ids,3);await observeFixture(two.root,ids,4);output.twoAreas=await open(two);output.selection=syncPayload(await runMemorySync(two.root,{action:'start'}));
  const local=await create('fragmentation');let w=await prepare(local);output.progress=syncPayload(w);w=await call(local,w,'propose',{candidateId:w.next.candidateId,proposal:fixtureProposal(w.semantic.bundle,'fragmentation')});output.localSuccess=syncPayload(w);output.completed=syncPayload(w);
  const mixed=await create('mixed');w=await prepare(mixed);w=await call(mixed,w,'propose',{candidateId:w.next.candidateId,proposal:fixtureProposal(w.semantic.bundle,'mixed')});output.versionedReview=syncPayload(w);output.interrupted=await open(mixed);output.resumed=syncPayload(await runMemorySync(mixed.root,{action:'inspect',workflowId:w.id}));await fs.appendFile(path.join(mixed.root,'.prodero/memory/mem_driving_00.md'),'\nExternal update.');output.stale=syncPayload(await runMemorySync(mixed.root,{action:'inspect',workflowId:w.id}));
  const protectedFixture=await create('protected');w=await prepare(protectedFixture);const proposal=fixtureProposal(w.semantic.bundle,'protected');proposal.warnings=['Review protected knowledge without changing its applicability.'];output.protected=syncPayload(await call(protectedFixture,w,'propose',{candidateId:w.next.candidateId,proposal}));
  const evolution=await create('evolution');output.evolution=syncPayload(await runMemorySync(evolution.root,{action:'start'}));
  const conflict=await create('fragmentation');await writeKnowledge(conflict.root,fixtureItem(conflict.ids[0],{title:'Fixed driving step',content:'Driving forces always use a fixed 60 Hz time step.'}),false,'local');await writeKnowledge(conflict.root,fixtureItem(conflict.ids[1],{title:'Variable driving step',content:'Driving forces always use the variable render-frame delta; there is no fixed time step.'}),false,'local');const checkpoint='chk_conflict_fixture';await fs.writeFile(path.join(conflict.root,'.prodero/checkpoints',checkpoint+'.json'),JSON.stringify({id:checkpoint,createdAt:'2026-09-01T00:00:00.000Z',sessions:[],createdMemory:[]}));const catalog=await loadMemoryCatalog(conflict.root,{persistCache:false});await withSyncLock(conflict.root,()=>recordSyncEvidenceLocked(conflict.root,{checkpoint,sessionIds:[],sessionIdsDropped:0,changes:[],totals:{created:0,updated:0,merged:0,superseded:0},changesDropped:0,reconciliation:[{source:conflict.ids[0],target:pressureRecord(catalog.summaries.find(s=>s.id===conflict.ids[1])),classification:'potential_conflict'}],classifications:{potential_conflict:1},relationshipsDropped:0}));output.conflict=syncPayload(await runMemorySync(conflict.root,{action:'start'}));
  output.ready={ok:true,action:'prepare',result:await prepareProject(two.root,{task:'Inspect steering fixture context',agent:'browser-fixture'})};
  // A real validated semantic result, with no model request or applied answer.
  const questioned=await create('fragmentation');w=await runMemorySync(questioned.root,{action:'start'});w=await call(questioned,w,'select',{improve:true,share:false});w=await call(questioned,w,'prepare',{candidateId:w.next.candidateId});
  const job=w.curation.job,bundle=job.task.data,sourceIds=bundle.expectedSources.map(s=>s.id);
  const submitted=await submitSemanticCuration(questioned.root,{jobId:job.jobId,inputHash:job.job.input.inputHash,proposal:{version:1,bundleId:bundle.id,sources:bundle.sources.map(s=>({sourceId:s.id,revision:s.revision,disposition:'unresolved',outputKeys:[],coverage:s.clauses.map(c=>({clauseId:c.id,action:'unresolved',grounding:[c.id],exceptions:c.protections.filter(p=>p.kind==='exception').map(p=>p.id),negations:c.protections.filter(p=>p.kind==='negation').map(p=>p.id),modality:c.protections.filter(p=>p.kind==='modality').map(p=>p.id)})),rationale:'A synthetic deployment fact is missing.'})),relations:[],outputs:[],issues:[{kind:'missing_fact',sourceIds,missingFact:'Whether queue v2 is deployed.',why:'The fixture does not establish deployment.',grounding:sourceIds,question:{title:'Queue migration',prompt:'Has queue v2 deployed?',choices:[{id:'yes',label:'Deployed',meaning:'Queue v2 is deployed.'},{id:'no',label:'Not deployed',meaning:'Queue v2 is not deployed.'}],allowFreeText:true},limitations:[]}],answerInterpretations:[],additionalEvidenceRequired:[],rationale:'Keep sources pending clarification.',limitations:[]}});
  if(submitted.status!=='validated')throw new Error('Question fixture validation failed: '+submitted.validation);
  output.question=syncPayload(await runMemorySync(questioned.root,{action:'inspect',workflowId:w.id}));
  return output;
 }finally{await Promise.all(fixtures.map(f=>f.cleanup()));}
}

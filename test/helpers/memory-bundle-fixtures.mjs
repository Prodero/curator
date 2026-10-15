/** Synthetic evidence only; always creates an owned temporary repository. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initializeProject} from '../../dist/core/project.js';
import {writeKnowledge} from '../../dist/core/memory.js';
import {loadMemoryCatalog} from '../../dist/core/memory-index.js';
import {pressureRecord,recordRetrievalEvidence,recordSyncEvidenceLocked} from '../../dist/core/memory-pressure.js';
import {withSyncLock} from '../../dist/core/sync-transaction.js';
import {knowledgeArchivePath} from '../../dist/core/knowledge-provenance.js';
import {renderKnowledge} from '../../dist/core/memory.js';
export const SCENARIOS=['fragmentation','evolution','mixed','protected','provenance'];
export const fixtureItem=(id,patch={})=>({id,title:`Driving evidence ${id}`,content:`Driving evidence for ${id}.\n\nKeep traction measurements reproducible.`,scope:'module',scopeRef:'src/driving',scopeKind:'path',category:'state',priority:'normal',status:'active',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',sourceSessions:['sess_fixture'],derivedFrom:[],supersedes:[],related:[],relations:[],...patch});
export async function observeFixture(root,ids,session=1){const catalog=await loadMemoryCatalog(root,{persistCache:false});const records=ids.map(id=>({...pressureRecord(catalog.summaries.find(r=>r.id===id)),bucket:'contextual',reason:'context-budget',score:20,rankScore:20,signals:[{kind:'scope-token',score:10}]}));const result=await recordRetrievalEvidence(root,`sess_fixture_${session}`,{queryHash:'b'.repeat(64),purpose:'work',budgets:{contextBudgetTokens:80,requiredContextBudgetTokens:20,maxRequiredItems:16,maxContextItems:100},totals:{'context-budget':{records:records.length,tokens:records.reduce((n,r)=>n+r.estimatedTokens,0)}},requiredTruncated:false,requiredOmitted:0,records,detailsDropped:0});if(result!=='recorded')throw new Error('Fixture telemetry failed');}
export async function archiveFixture(root,id,patch={},layer='local'){const item=fixtureItem(id,{status:'superseded',archivedAt:'2026-09-01T00:00:00.000Z',...patch});const relative=knowledgeArchivePath(layer,item.archivedAt,id);await fs.mkdir(path.dirname(path.join(root,'.prodero',relative)),{recursive:true});await fs.writeFile(path.join(root,'.prodero',relative),renderKnowledge(item));return item;}
export async function createMemoryBundleFixture(scenario='fragmentation',{count=4,content}={}){
 if(!SCENARIOS.includes(scenario))throw new Error('Unknown fixture scenario');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-bundle-fixture-'));
 const cleanup=()=>fs.rm(root,{recursive:true,force:true,maxRetries:3});
 try {
  await fs.mkdir(path.join(root,'.git'));await initializeProject(root);
  const ids=Array.from({length:count},(_,i)=>`mem_driving_${String(i).padStart(2,'0')}`);
  const facts = [
   ['Fixed-step driving update','Driving traction is evaluated at a fixed 60 Hz simulation step. Integrate chassis velocity after tire forces are calculated.'],
   ['Slip tracing lesson','Record longitudinal and lateral tire slip separately. Slip traces exposed oscillations that average speed metrics concealed.'],
   ['Brake load transfer','Braking shifts normal load toward the front axle. Tire force limits use the updated per-wheel normal loads.'],
   ['Replay verification lesson','Use the same steering and throttle input trace for regression replays. Compare final pose and wheel-slip histories.'],
  ];
  for(let i=0;i<ids.length;i++){
   const [title,body]=facts[i%facts.length];
   const patch={title,content:content??body,category:i%2?'lesson':'state'};
   if(scenario==='protected'&&i<2)Object.assign(patch,{category:i?'invariant':'decision',priority:'important',content:i?'A tire contact force must oppose the measured direction of slip. This constraint holds for every supported driving mode.':'Deterministic driving replays are a project requirement. Physics algorithm changes require replay parity review.'});
   if(scenario==='provenance'&&i===0)Object.assign(patch,{supersedes:['mem_old_state'],relations:[{type:'consolidates',target:'mem_old_lesson'}]});
   if(scenario==='evolution'&&i===0)Object.assign(patch,{createdAt:'2026-08-01T00:00:00.000Z',supersedes:['mem_previous'],derivedFrom:['sess_fixture#obs_transition']});
   if(scenario==='evolution'&&i===1)Object.assign(patch,{derivedFrom:['sess_fixture#obs_refinement']});
   await writeKnowledge(root,fixtureItem(ids[i],patch),false,scenario==='mixed'&&i<2?'versioned':'local');
  }
  if(scenario==='provenance'){
   await archiveFixture(root,'mem_old_state',{supersedes:['mem_deeper']});
   await archiveFixture(root,'mem_old_lesson',{status:'consolidated'},'versioned');
   await archiveFixture(root,'mem_deeper');await archiveFixture(root,'mem_unrelated');
  }
  if(scenario==='evolution'){
   await writeKnowledge(root,fixtureItem('mem_previous',{title:'Variable-step driving prototype',content:'The driving prototype integrates forces using the variable frame delta.',status:'superseded'}),false,'local');
   const catalog=await loadMemoryCatalog(root,{persistCache:false}),record=id=>pressureRecord(catalog.summaries.find(r=>r.id===id));
   const checkpoint='chk_fixture_01';await fs.writeFile(path.join(root,'.prodero/checkpoints',checkpoint+'.json'),JSON.stringify({id:checkpoint,createdAt:'2026-09-01T00:00:00.000Z',sessions:[],createdMemory:ids.slice(0,2)}));
   await withSyncLock(root,()=>recordSyncEvidenceLocked(root,{checkpoint,sessionIds:['sess_fixture'],sessionIdsDropped:0,changes:ids.slice(0,2).map(id=>({...record(id),actions:['created']})),totals:{created:2,updated:0,merged:0,superseded:1},changesDropped:0,reconciliation:[{source:'sess_fixture#obs_transition',target:record('mem_previous'),classification:'state_transition'},{source:'sess_fixture#obs_refinement',target:record(ids[1]),classification:'refinement'}],classifications:{state_transition:1,refinement:1},relationshipsDropped:0}));
  }
  await observeFixture(root,ids,1);await observeFixture(root,ids,2);
  return {root,ids,scenario,cleanup};
 }catch(error){await cleanup();throw error;}
}

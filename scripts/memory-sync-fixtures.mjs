/** End-to-end diagnostics exclusively in owned temporary repositories. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createMemoryBundleFixture} from '../test/helpers/memory-bundle-fixtures.mjs';
import {fixtureProposal} from '../test/helpers/memory-proposal-fixtures.mjs';
import {runMemorySync} from '../dist/core/memory-sync.js';
import {readKnowledgeInventory} from '../dist/core/knowledge-provenance.js';
if(process.argv.length>2)throw new Error('Fixture diagnostic accepts no paths or arguments');
const exec=promisify(execFile),results=[];
for(const scenario of ['local','mixed','promotion','interrupted']){
 const f=await createMemoryBundleFixture(['mixed','interrupted'].includes(scenario)?'mixed':'fragmentation');
 try{
  let w=await runMemorySync(f.root,{action:'start'});const states=[w.state];
  const act=async(action,extra={})=>{w=await runMemorySync(f.root,{action,workflowId:w.id,revision:w.revision,...extra});states.push(w.state);};
  await act('select',{candidateIds:w.jobs.map(j=>j.id),reviewPromotion:scenario==='promotion'});
  await act('prepare',{candidateId:w.next.candidateId});
  await act('propose',{candidateId:w.next.candidateId,proposal:fixtureProposal(w.semantic.bundle,['mixed','interrupted'].includes(scenario)?'mixed':'fragmentation')});
  const beforeApproval=(await readKnowledgeInventory(f.root)).filter(r=>r.storage==='archive').length;
  if(scenario==='interrupted'){
   // A new process has no in-memory workflow objects or tool connection state.
   const {stdout}=await exec(process.execPath,['--input-type=module','-e',"import {runMemorySync} from './dist/core/memory-sync.js'; console.log(JSON.stringify(await runMemorySync(process.argv[1],{action:'inspect',workflowId:process.argv[2]})));",f.root,w.id],{maxBuffer:4*1024*1024});w=JSON.parse(stdout);states.push('resumed:'+w.state);
  }
  if(w.state==='awaiting_review')await act('approve',{reviewId:w.review.reviewId,approved:true});
  if(w.state==='awaiting_promotion_selection'){
   await act('promotions',{ids:w.promotionCandidates.map(c=>c.id)});
   await act('approve',{reviewId:w.review.reviewId,approved:true});
  }
  results.push({scenario,states,archivesBeforeHumanReview:beforeApproval,summary:w.summary});
 }finally{await f.cleanup();}
}
console.log(JSON.stringify(results,null,2));

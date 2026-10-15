/** Backend diagnostics: NEVER accepts a real repository path. All writes are owned fixtures. */
import fs from 'node:fs/promises';
import {createMemoryBundleFixture,fixtureItem,SCENARIOS} from '../test/helpers/memory-bundle-fixtures.mjs';
import {fixtureProposal} from '../test/helpers/memory-proposal-fixtures.mjs';
import {getMemoryIntelligencePlan} from '../dist/core/memory-intelligence.js';
import {prepareMemoryTransformation,validateMemoryTransformationProposal} from '../dist/core/memory-transformation-proposal.js';
import {previewMemoryTransformation,applyMemoryTransformation} from '../dist/core/memory-transformation.js';
import {writeKnowledge,listKnowledge} from '../dist/core/memory.js';
import {readKnowledgeInventory} from '../dist/core/knowledge-provenance.js';
if(process.argv.length>2)throw new Error('Only owned temporary fixtures are allowed; no arguments accepted');
const results=[];
for(const scenario of [...SCENARIOS,'interrupted']){
 const f=await createMemoryBundleFixture(scenario==='interrupted'?'mixed':scenario);
 try{
  if(scenario==='evolution')await writeKnowledge(f.root,fixtureItem(f.ids[2],{title:'Old driving integrator',content:'The driving integrator still uses variable frame delta.'}),false,'local');
  const c=(await getMemoryIntelligencePlan(f.root)).candidates[0],{bundle}=await prepareMemoryTransformation(f.root,c.id);
  const proposal=fixtureProposal(bundle,scenario==='interrupted'?'mixed':scenario);
  if(scenario==='evolution'){
   proposal.records[0].body='Driving traction uses a fixed 60 Hz step. Calculate tire forces before integrating chassis velocity. The variable frame delta integrator has been replaced.';
   const d=proposal.dispositions.find(d=>d.sourceId===f.ids[2]);d.action='supersede';d.rationale='The current fixed-step source replaces the obsolete variable-delta integrator.';d.coverage='Obsolete variable-delta behavior remains historical evidence.';
  }
  const validated=await validateMemoryTransformationProposal(f.root,proposal),preview=await previewMemoryTransformation(f.root,validated);
  const approval={initiatedByUser:true,reviewedPreviewId:preview.previewId,approvedVersioned:true,approvedSemanticLimitations:true};
  let deniedBeforeReview=false,blockedRead=false;
  if(preview.requiresVersionedReview)try{await applyMemoryTransformation(f.root,preview,{initiatedByUser:true,reviewedPreviewId:preview.previewId});}catch{deniedBeforeReview=true;}
  if(scenario==='interrupted'){
   const rename=fs.rename;let injected=false;
   fs.rename=async(from,to)=>{if(!injected&&String(to).includes('/archive/')){injected=true;throw new Error('Fixture injected failure');}return rename(from,to);};
   try{await applyMemoryTransformation(f.root,preview,approval);throw new Error('Expected failure');}catch(e){if(!/Fixture injected failure/.test(e.message))throw e;}finally{fs.rename=rename;}
   try{await listKnowledge(f.root);}catch(e){if(!/pending recovery/.test(e.message))throw e;blockedRead=true;}
  }
  const result=await applyMemoryTransformation(f.root,preview,approval),inventory=await readKnowledgeInventory(f.root);
  results.push({scenario,created:result.summary.created.map(r=>({category:r.category,layer:r.layer})),consolidated:result.summary.consolidated.length,superseded:result.summary.superseded.length,kept:result.summary.kept.length,unresolved:result.summary.unresolved.length,archives:result.summary.archives.map(r=>({layer:r.layer,to:r.to})),requiresVersionedReview:preview.requiresVersionedReview,requiresSemanticReview:preview.requiresSemanticReview,deniedBeforeReview,blockedRead,recovered:result.alreadyApplied,current:inventory.filter(r=>r.storage==='current'&&['active','disputed'].includes(r.item.status)).length,totalPreserved:inventory.length,tokens:result.summary.estimatedTokens});
 }finally{await f.cleanup();}
}
console.log(JSON.stringify(results,null,2));

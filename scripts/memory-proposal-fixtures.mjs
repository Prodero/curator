/** Owned temporary fixtures only; accepts no project root or input paths. */
import {createMemoryBundleFixture,SCENARIOS} from '../test/helpers/memory-bundle-fixtures.mjs';
import {fixtureProposal} from '../test/helpers/memory-proposal-fixtures.mjs';
import {getMemoryIntelligencePlan} from '../dist/core/memory-intelligence.js';
import {prepareMemoryTransformation,validateMemoryTransformationProposal} from '../dist/core/memory-transformation-proposal.js';
if(process.argv.length>2)throw new Error('Fixture diagnostic accepts no arguments');
const results=[];
for(const scenario of SCENARIOS){const f=await createMemoryBundleFixture(scenario);try{const c=(await getMemoryIntelligencePlan(f.root)).candidates[0];const {bundle}=await prepareMemoryTransformation(f.root,c.id);const validated=await validateMemoryTransformationProposal(f.root,fixtureProposal(bundle,scenario));results.push({scenario,historicalEvidence:bundle.historicalSources.length,...validated.review});}finally{await f.cleanup();}}
console.log(JSON.stringify(results,null,2));

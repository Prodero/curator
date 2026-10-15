// Development diagnostic: never accepts a project root or seeds an existing project.
import {createMemoryBundleFixture,SCENARIOS} from '../test/helpers/memory-bundle-fixtures.mjs';
import {getMemoryIntelligencePlan} from '../dist/core/memory-intelligence.js';
import {buildMemoryTransformationBundle} from '../dist/core/memory-transformation-bundle.js';
if(process.argv.length>2)throw new Error('This diagnostic accepts no arguments and uses temporary repositories only.');
const report=[];
for(const scenario of SCENARIOS){const fixture=await createMemoryBundleFixture(scenario);try{const plan=await getMemoryIntelligencePlan(fixture.root);const bundle=await buildMemoryTransformationBundle(fixture.root,plan.candidates[0].id);report.push({scenario,candidateId:bundle.candidateId,bundleId:bundle.bundleId,status:bundle.status,activeSources:bundle.activeSources.length,historicalSources:bundle.historicalSources.map(r=>({id:r.id,layer:r.layer,storage:r.lifecycle.storage})),layers:bundle.planner.layers,protectedIds:bundle.activeSources.filter(r=>r.protected).map(r=>r.id),signals:bundle.planner.signals,priority:bundle.planner.priority,reconciliation:bundle.planner.reconciliation,size:bundle.size,omissions:bundle.omissions});}finally{await fixture.cleanup();}}
console.log(JSON.stringify(report,null,2));

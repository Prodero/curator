import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProject, closeProjectSession } from '../../dist/core/project.js';
import { getContext } from '../../dist/core/context.js';
import { listKnowledge } from '../../dist/core/memory.js';
import { recordRetrievalEvidence, MEMORY_PRESSURE_LIMITS as L } from '../../dist/core/memory-pressure.js';
import { fixture, entry, pressure } from '../helpers/memory-pressure-fixtures.mjs';

test('compact session histories retain at most 32 sessions and Sync histories retain at most 32 committed events',async t=>{
 const root=await fixture(t,6000);let evidence;await getContext(root,'',{onRetrievalEvidence:e=>evidence=e});
 for(let i=0;i<L.sessions+2;i++)await recordRetrievalEvidence(root,`sess_${String(i).padStart(3,'0')}`,evidence);
 assert.equal((await pressure(root)).sessions.length,L.sessions);
 for(let i=0;i<L.syncs+2;i++){
  const p=await prepareProject(root);await closeProjectSession(root,p.session.id,[entry(`Driving component ${i} uses a separate control path.`,{title:`Component ${i}`,scopeRef:`driving/${i}`})]);
 }
 const s=await pressure(root);assert.equal(s.syncs.length,L.syncs);assert.equal(s.coverage.checkpoints,L.syncs);assert.equal(s.totals.newKnowledge,L.syncs);
 assert.equal(s.coverage.checkpointsWithoutDetails.length,0);assert.equal((await listKnowledge(root)).length,L.syncs+2);
});

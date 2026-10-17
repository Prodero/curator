import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProject, recordProjectSession, closeProjectSession, syncProject, getFastProjectStatus } from '../../dist/core/project.js';
import { writeKnowledge } from '../../dist/core/memory.js';
import { discoverSessions } from '../../dist/core/session-index.js';
import { loadMemoryCatalog } from '../../dist/core/memory-index.js';
import { INTELLIGENCE_LIMITS as L } from '../../dist/core/intelligence.js';
import { estimateTokens } from '../../dist/core/telemetry.js';
import { fakeProvider } from '../helpers/intelligence-provider.mjs';
import { fixture, entry, seed } from '../helpers/intelligence-fixtures.mjs';

test('bounded batches, related discovery and single audit with 10,000 canonical memories exclude historical sessions', async (t) => {
  const root = await fixture(t);
  await Promise.all(Array.from({ length: 10_000 }, (_, i) => writeKnowledge(root, seed(`Historical cache fact ${i}.`, { id: `mem_scale_${i}` }), false, 'local')));
  const historical = await prepareProject(root); await recordProjectSession(root, historical.session.id, [entry('HISTORICAL_PRIVATE_CONTENT')]);
  await closeProjectSession(root, historical.session.id, [], true);
  await loadMemoryCatalog(root); await discoverSessions(root);
  const p = await prepareProject(root);
  await recordProjectSession(root, p.session.id, Array.from({ length: 15 }, (_, i) => entry(`New fact ${i}. ${'Compact local constraint. '.repeat(50)}`)));
  await closeProjectSession(root, p.session.id, [], false);
  const provider = fakeProvider(); const result = await syncProject(root, { provider });
  assert.ok(provider.calls.filter((c) => c.phase === 'distill').length > 1);
  for (const call of provider.calls) {
    assert.doesNotMatch(JSON.stringify(call.input), /HISTORICAL_PRIVATE_CONTENT/);
    const limit = call.phase === 'distill' ? L.distillInputTokens : call.phase === 'reconcile' ? L.reconcileInputTokens : L.auditInputTokens;
    assert.ok(estimateTokens(JSON.stringify(call.input)) <= limit);
    if (call.phase === 'reconcile') assert.ok(call.input.related.length <= L.relatedMemories);
    if (call.phase === 'audit') assert.ok(call.input.items.length <= L.auditItems);
  }
  assert.equal(provider.calls.filter((c) => c.phase === 'audit').length, 1);
  assert.equal(result.diagnostics.sessionBodiesConsolidated, 1);
  const before = provider.calls.length; const fast = await getFastProjectStatus(root);
  assert.equal(Object.hasOwn(fast, 'knowledgeCount'), false); assert.equal(provider.calls.length, before);
});

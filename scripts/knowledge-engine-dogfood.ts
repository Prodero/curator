/** Read-only canonical dogfood when host sampling is unavailable. Never commits mock proposals. */
import fs from 'node:fs/promises';
import { readSession } from '../src/core/sessions.js';
import { planAssistedSync, observationEvidence } from '../src/core/knowledge-engine.js';
import { INTELLIGENCE_LIMITS } from '../src/core/intelligence.js';
import { fakeProvider } from '../test/helpers/intelligence-provider.mjs';

const [root, sessionId, output] = process.argv.slice(2);
if (!root || !sessionId || !output) throw new Error('Usage: node --import tsx scripts/knowledge-engine-dogfood.ts <root> <sessionId> <report.json>');
const session = await readSession(root, sessionId);
const provider = fakeProvider();
const plan = await planAssistedSync(root, [session], provider);
const report = {
  provider: provider.name, realModelInvoked: false, canonicalWritesApplied: 0,
  limitation: 'Mock contract replay on real repository evidence. This is not a successful real-LLM semantic run. The plan is deliberately not committed.',
  sessionId, observations: observationEvidence([session]),
  calls: provider.calls, telemetry: plan.intelligence,
  proposedChanges: plan.reasoning, proposedMemory: plan.writes.map(({ path }) => path),
  provenance: plan.writes.map(({ path, after }) => ({ path, sourceReferences: [...after.matchAll(/sess_[A-Za-z0-9_]+#obs_[A-Za-z0-9_]+/g)].map((match) => match[0]) })),
  budgets: INTELLIGENCE_LIMITS,
};
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, observations: report.observations.length, phases: provider.calls.map((call) => call.phase), telemetry: plan.intelligence, canonicalWritesApplied: 0 }));

// Executable acceptance regressions for audited defects outside the R02 fix.
// TODO bodies deliberately run and fail until their owning checkpoint lands.
// Remove each TODO with the corresponding fix; do not count it as passing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer, PRODERO_TOOLS as T} from '../dist/server.js';
import {runMemorySync} from '../dist/core/memory-sync.js';
import {submitSemanticCuration, curationAnswers} from '../dist/core/curation-semantic-jobs.js';
import {graphicalReviewAction} from '../dist/core/curation-graphical.js';
import {inspectSyncCuration} from '../dist/core/memory-sync-curator.js';
import {buildViewModel} from '../dist/presentation.js';
import {numberedActions} from '../dist/conversation-presentation.js';
import {createMemoryBundleFixture} from './helpers/memory-bundle-fixtures.mjs';
import {knowledgeUi} from './helpers/knowledge-ui.mjs';

const action = (f, w, action, extra = {}) => runMemorySync(f.root, {
  action, workflowId: w.id, revision: w.revision, ...extra,
});
const inspect = (f, w) => runMemorySync(f.root, {action: 'inspect', workflowId: w.id});
const payload = w => ({ok: true, action: 'memory-sync', result: w});
async function fixture(t) {
  const f = await createMemoryBundleFixture('fragmentation');
  t.after(f.cleanup);
  return f;
}
function unresolvedProposal(job) {
  const b = job.task.data, ids = b.expectedSources.map(s => s.id);
  return {
    version: 1, bundleId: b.id,
    sources: b.sources.map(s => ({
      sourceId: s.id, revision: s.revision, disposition: 'unresolved', outputKeys: [],
      coverage: s.clauses.map(c => ({
        clauseId: c.id, action: 'unresolved', grounding: [c.id],
        exceptions: c.protections.filter(p => p.kind === 'exception').map(p => p.id),
        negations: c.protections.filter(p => p.kind === 'negation').map(p => p.id),
        modality: c.protections.filter(p => p.kind === 'modality').map(p => p.id),
      })), rationale: 'A deployment fact is missing.',
    })),
    relations: [], outputs: [],
    issues: [{
      kind: 'missing_fact', sourceIds: ids, missingFact: 'Whether queue v2 is deployed.',
      why: 'The deployment state is not established.', grounding: ids,
      question: {
        title: 'Queue migration', prompt: 'Has the migration to queue v2 completed?',
        choices: [
          {id: 'yes', label: 'Completed', meaning: 'The queue v2 migration is complete.'},
          {id: 'no', label: 'Not completed', meaning: 'The queue v2 migration is not complete.'},
        ], allowFreeText: true,
      }, limitations: [],
    }],
    answerInterpretations: [], additionalEvidenceRequired: [],
    rationale: 'Review current queue knowledge.', limitations: [],
  };
}
const identity = v => ({
  reviewId: v.review.snapshot.reviewId, reviewRevisionId: v.review.snapshot.revision.id,
  planHash: v.review.snapshot.planHash, decisionRevision: v.review.state.revision,
  answerLogHash: v.graphical.answerLogHash,
});
async function questioned(f) {
  let w = await runMemorySync(f.root, {action: 'start'});
  w = await action(f, w, 'select', {improve: true, share: false});
  w = await action(f, w, 'prepare', {candidateId: w.next.candidateId});
  const j = w.curation.job;
  const result = await submitSemanticCuration(f.root, {
    jobId: j.jobId, inputHash: j.job.input.inputHash, proposal: unresolvedProposal(j),
  });
  assert.equal(result.status, 'validated', result.validation);
  w = await inspect(f, w);
  assert.equal(w.state, 'awaiting_clarification');
  return w;
}

test('F3: completed deferred question exposes a deliberately bound Revisit action', async t => {
  const f = await fixture(t);
  let w = await questioned(f);
  const v = w.clarification, q = v.graphical.questions[0];
  await graphicalReviewAction(f.root, {
    ...identity(v), action: 'question_later', questionId: q.question.id,
    questionVersion: q.question.version,
  });
  w = await inspect(f, w);
  assert.equal(w.state, 'completed');
  assert.equal(w.summary.questionsDeferred, 1);
  // Re-analyze currently reuses the deferral. It must not itself undo it.
  w = await runMemorySync(f.root, {action: 'start', restart: true});
  w = await action(f, w, 'select', {improve: true, share: false});
  w = await action(f, w, 'prepare', {candidateId: w.next.candidateId});
  w = await inspect(f, w);
  assert.equal(w.state, 'completed');
  assert.equal(w.summary.questionsDeferred, 1);
  const saved = await inspectSyncCuration(f.root, v.review.snapshot.reviewId);
  assert.ok(saved.graphical.deferredQuestionIds.includes(q.question.id));
  const vm = buildViewModel(payload(w));
  const actions = [...numberedActions(vm), ...numberedActions(vm, true)];
  assert.ok(actions.some(a => a.arguments?.action === 'question_reopen'
    && a.arguments.questionId === q.question.id
    && a.arguments.questionVersion === q.question.version),
  'Completed text must offer deliberate Revisit bound to the saved question, not just Re-analyze');
});

test('F4: a no-App client can persist an exactly bound relayed answer through its emitted tool', async t => {
  const f = await fixture(t), w = await questioned(f), v = w.clarification;
  const server = createServer({projectRoot: f.root});
  const client = new Client({name: 'v02-no-app-answer', version: '1'}, {capabilities: {}});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => {await client.close(); await server.close();});
  const shown = await client.callTool({name: T.text, arguments: {
    tool: T.sync, arguments: {workflowId: w.id}, details: true,
  }});
  assert.match(shown.content.map(c => c.text ?? '').join('\n'), /Has the migration to queue v2 completed/);
  const q = v.graphical.questions[0];
  const bound=shown.structuredContent.presentation.operational.numberedActions.find(a=>a.tool===T.curationQuestion&&a.arguments.choiceId==='yes');
  assert.ok(bound,'The no-App surface must expose a real callable answer tool');
  const result = await client.callTool({name:T.text,arguments:{tool:bound.tool,arguments:bound.arguments}});
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const answers = await curationAnswers(f.root, v.review.snapshot.revision.lineageId);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].choice.id, 'yes');
  assert.equal(answers[0].origin,'agent_relay');
});

test('F5: authoritative refresh keeps the safe original action error visible', async t => {
  const f = await fixture(t), w = await runMemorySync(f.root, {action: 'start'});
  const calls = [], code = 'V02_FIXTURE_LOCK_BUSY';
  const ui = await knowledgeUi(async request => {
    calls.push(request.arguments.request.action);
    if (request.arguments.request.action === 'select') return {
      isError: true, structuredContent: {ok: false, code, message: `${code}: Another writer is busy. Retry when it finishes.`},
    };
    assert.equal(request.arguments.request.action, 'inspect');
    return {structuredContent: payload(w)};
  });
  ui.render({structuredContent: payload(w)});
  await ui.sync('select');
  assert.deepEqual(calls, ['select', 'inspect']);
  assert.match(ui.html, new RegExp(code), 'Safe failure reason must survive authoritative state adoption');
});

test('F6: compact and expanded sharing actions bind the same visible selection', async t => {
  const f = await fixture(t);
  let w = await runMemorySync(f.root, {action: 'start'});
  w = await action(f, w, 'select', {improve: false, share: true});
  const vm = buildViewModel(payload(w));
  const compact = numberedActions(vm).find(a => a.arguments.request?.action === 'promotions');
  const expanded = numberedActions(vm, true).find(a => a.arguments.request?.action === 'promotions');
  assert.equal(compact.arguments.request.ids.length, 4);
  assert.deepEqual(expanded.arguments.request.ids, compact.arguments.request.ids,
    'Expanded review action must bind a valid visible selection, never placeholder ids:[]');
  const reviewed = await runMemorySync(f.root, expanded.arguments.request);
  assert.equal(reviewed.state, 'awaiting_review');
  assert.equal(reviewed.review.kind, 'promotion');
});

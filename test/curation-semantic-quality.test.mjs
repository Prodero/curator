import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {evaluateSemanticCorpus} from '../scripts/evaluate-curation-semantics.mjs';
const corpus=JSON.parse(await fs.readFile(new URL('./fixtures/curation-semantic/quality-corpus.json',import.meta.url),'utf8'));
test('quality reference corpus covers distinct semantic cases without claiming human verification',()=>{
 assert.equal(corpus.cases.length,13);assert.equal(new Set(corpus.cases.map(c=>c.id)).size,13);
 for(const c of corpus.cases){assert.equal(c.sources.length,2);assert.ok(c.expected.rationale);assert.equal(c.labelProvenance.humanReview,'pending');}
 assert.equal(evaluateSemanticCorpus(corpus,{cases:[]}).scored,0);
});
test('offline scorer reports missing and wrong predictions separately from protocol validity',()=>{
 const report=evaluateSemanticCorpus(corpus,{cases:[{id:'exact-duplicate',relation:'duplicate',outcome:'proposed',additionalEvidenceRequired:false},{id:'contradiction',relation:'independent',outcome:'proposed',additionalEvidenceRequired:false}]},{includeUnreviewed:true});
 assert.equal(report.scored,13);assert.equal(report.missing,11);assert.equal(report.allFieldsCorrect,1);assert.equal(report.humanReviewPending,13);
 assert.throws(()=>evaluateSemanticCorpus(corpus,{cases:[{id:'unknown'}]}));
});

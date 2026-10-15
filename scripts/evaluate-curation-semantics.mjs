/** Offline scoring only: no model calls, credentials or canonical writes.
 * Predictions: {cases:[{id,relation,outcome,additionalEvidenceRequired:boolean}]}.
 * Default scores human-reviewed labels only. --include-unreviewed is exploratory. */
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export function evaluateSemanticCorpus(corpus,predictions,{includeUnreviewed=false}={}){
 if(corpus.version!==1||!Array.isArray(predictions.cases))throw new Error('Unsupported quality input');
 const expected=corpus.cases.filter(c=>includeUnreviewed||c.labelProvenance.humanReview==='accepted');
 const known=new Set(corpus.cases.map(c=>c.id)),seen=new Set();
 for(const p of predictions.cases){if(!known.has(p.id)||seen.has(p.id))throw new Error('Unknown or duplicate prediction');seen.add(p.id);}
 const results=expected.map(c=>{const p=predictions.cases.find(p=>p.id===c.id);return {id:c.id,present:!!p,relation:p?.relation===c.expected.relation,outcome:p?.outcome===c.expected.outcome,evidence:p?.additionalEvidenceRequired===c.expected.additionalEvidenceRequired};});
 return {mode:includeUnreviewed?'exploratory-unreviewed':'human-reviewed',scored:results.length,missing:results.filter(r=>!r.present).length,allFieldsCorrect:results.filter(r=>r.relation&&r.outcome&&r.evidence).length,humanReviewPending:corpus.cases.filter(c=>c.labelProvenance.humanReview!=='accepted').length,results};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const file=process.argv[2];if(!file)throw new Error('Usage: node scripts/evaluate-curation-semantics.mjs predictions.json [--include-unreviewed]');
 const corpus=JSON.parse(await fs.readFile(new URL('../test/fixtures/curation-semantic/quality-corpus.json',import.meta.url),'utf8'));
 console.log(JSON.stringify(evaluateSemanticCorpus(corpus,JSON.parse(await fs.readFile(file,'utf8')),{includeUnreviewed:process.argv.includes('--include-unreviewed')}),null,2));
}

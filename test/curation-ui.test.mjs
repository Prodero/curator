import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {lifecycleUi} from './helpers/lifecycle-ui.mjs';
import {createMemoryBundleFixture} from './helpers/memory-bundle-fixtures.mjs';
import {createCurationReview} from '../dist/core/curation-review.js';
import {graphicalReviewPayload} from '../dist/core/curation-graphical.js';

async function snapshot(root){
 const out={};
 async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const target=path.join(dir,e.name);if(e.isDirectory())await walk(target);else out[path.relative(root,target)]=(await fs.readFile(target)).toString('base64');}}
 await walk(root);return out;
}

test('retired cleanup App preserves an actual saved review and all source bytes without exposing moderation handlers',async t=>{
 const f=await createMemoryBundleFixture('fragmentation');t.after(f.cleanup);
 const review=await createCurationReview(f.root),saved=await graphicalReviewPayload(f.root,review);
 const payload={ok:true,action:'curation',root:f.root,...saved},before=await snapshot(f.root),calls=[],messages=[];
 const ui=await lifecycleUi({callServerTool:req=>{calls.push(req);throw Error('Unexpected mutation');},sendMessage:req=>{messages.push(req);throw Error('Unexpected reasoning dispatch');}});
 for(const trusted of [false,true]){
  const html=ui.render({...payload,trustedReviewAvailable:trusted,appReviewAvailable:trusted});
  assert.match(html,/Memory maintenance is handled during work/);
  assert.doesNotMatch(html,/data-curation|data-review|data-memory-sync|<button|<input|<textarea|Current knowledge|Proposed knowledge|Apply/);
 }
 assert.deepEqual(await snapshot(f.root),before);assert.deepEqual(calls,[]);assert.deepEqual(messages,[]);
});

test('legacy cleanup errors remain visible without offering stale retry or apply controls',async()=>{
 const calls=[],ui=await lifecycleUi({callServerTool:req=>{calls.push(req);throw Error('Unexpected retry');}});
 const html=ui.render({ok:false,action:'curation-review-error',code:'RECOVERY_REQUIRED',message:'Saved review could not be read. Restore the exact backup.'});
 assert.match(html,/role="alert"/);assert.match(html,/Saved review could not be read/);assert.match(html,/Restore the exact backup/);
 assert.doesNotMatch(html,/data-curation|data-review|Apply|Approve|<button/);assert.deepEqual(calls,[]);
});

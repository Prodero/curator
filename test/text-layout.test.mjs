import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {buildViewModel,renderTerminalText as renderText} from '../dist/presentation.js';
import {conversationOperation as nativeOperation} from '../dist/conversation-presentation.js';
import {textWidth,wrapText,textFence,entryKey,renderTextError} from '../dist/text-layout.js';
import {textViewFixtures} from './helpers/text-view-fixtures.mjs';
import {memoryUxFixtures} from './helpers/memory-ux-fixtures.mjs';
const conversationOperation=(payload,vm,details=false,diagnostics=false)=>nativeOperation(payload,vm,details,diagnostics,true);
const f=textViewFixtures();
const unfence=t=>t.replace(/^`+text\n|\n`+$/gm,'');
test('approved layout golden files are actual renderer output, with bounded panels and external menus',async()=>{
 for(const [name,expanded] of [['home',false],['knowledge',false],['ready',false],['ready-expanded',true]]){
  const payload=f[name==='ready-expanded'?'ready':name],vm=buildViewModel(payload),before=structuredClone(vm);
  const actual=renderText(vm,false,expanded)+'\n';
  assert.equal(actual,await fs.readFile(new URL(`./snapshots/terminal/${name}.txt`,import.meta.url),'utf8'));
  assert.deepEqual(vm,before);
  const panel=actual.split('\n').filter(l=>/^[╭│├╰]/.test(l));assert.ok(panel.every(l=>textWidth(l)<=38));
  if(name!=='ready')assert.ok(actual.includes('╭─ >_ PRODERO'));
  const footer=actual.indexOf('╰');if(actual.includes('  1 >'))assert.ok(actual.indexOf('  1 >')>footer);
 }
 const home=renderText(buildViewModel(f.home));assert.match(home,/▰{6}▱{19} 24%/);assert.doesNotMatch(home,/\[▰|HOME|█|░/);
 assert.match(home,/Bootstrap · Prodero allocation only/);assert.match(home,/128 records/);assert.match(home,/86 local · 42 versioned/);
 assert.doesNotMatch(home,/ATTENTION|deferred questions|unapplied change groups|review these/i);
});
test('ready is automatic, estimates only Prodero allocation, and expansions use the supplied snapshot',()=>{
 const vm=buildViewModel(f.ready),op=conversationOperation(f.ready,vm),compact=renderText(vm);
 assert.equal(op.blocking,false);assert.deepEqual(op.numberedActions,[]);assert.deepEqual(op.entryActions,[]);
 assert.doesNotMatch(compact,/Continue\?|Available actions|CLI update boundary/);
 assert.match(compact,/Ready · continuing the task/);assert.match(compact,/4,320 \/ 6,000 est. Prodero tokens/);
 assert.strictEqual(op.context,f.ready.result.context);
 const view=renderText(buildViewModel({action:'context',result:f.ready.result.context}));assert.match(view,/Read-only context view/);assert.doesNotMatch(view,/continuing the task/);
 const full=renderText(vm,false,true);assert.match(full,/CLI update boundary/);assert.match(full,/Updates run in a terminal/);assert.match(full,/▰{18}▱{7} 72%/);
 const blocked=renderText(buildViewModel(f.blocked));assert.match(blocked,/Required context incomplete/);assert.doesNotMatch(blocked,/Ready · continuing/);
 const warning=structuredClone(f.ready);warning.result.context.warnings=['Some records require attention.'];
 assert.doesNotMatch(renderText(buildViewModel(warning)),/Ready · continuing/);assert.match(renderText(buildViewModel(warning)),/Some records require attention/);
});
test('compact lifecycle preserves the Core maintenance protocol for the agent without a human queue',()=>{
 const payload=structuredClone(f.ready);payload.result.maintenance={automatic:{checkpoint:'fixture-checkpoint'},unresolvedRetained:2,userInputRequired:false,reconciliation:{instructions:'Use only supplied sources; retain ambiguous originals.'}};
 const vm=buildViewModel(payload),operation=conversationOperation(payload,vm),compact=renderText(vm);
 assert.strictEqual(operation.maintenance,payload.result.maintenance);assert.strictEqual(operation.context,payload.result.context);
 assert.doesNotMatch(compact,/reconciliation|unresolvedRetained|fixture-checkpoint|Review|question/i);
 assert.match(renderText(vm,true),/fixture-checkpoint/);
});
test('letter bindings are page-local exact IDs, numbers are separate and input is never a fabricated query',()=>{
 const vm=buildViewModel(f.knowledge),op=conversationOperation(f.knowledge,vm);
 assert.deepEqual(op.entryActions.map(x=>[x.key,x.arguments.id]),[['A','mem_runtime'],['B','mem_layers'],['C','mem_update']]);
 assert.deepEqual(op.numberedActions.map(x=>x.number),op.numberedActions.map((_,i)=>i+1));
 assert.equal(op.numberedActions[0].input.field,'query');assert.equal(op.numberedActions[0].arguments.query,'');
 assert.match(op.instructions,/Each screen replaces old aliases/);
 assert.deepEqual(conversationOperation(f.detail,buildViewModel(f.detail)).entryActions,[]);
 assert.deepEqual([entryKey(0),entryKey(19),entryKey(26)],['A','T','AA']);
 assert.match(renderText(vm),/│   ─{27}/);assert.match(renderText(vm),/In a terminal: prodero update/);
});
test('full wording and code retain whitespace and safe fences; fallback handles Unicode, long paths and controls',()=>{
 const content='Keep  two spaces.\n\n```ts\n  const x = `value`;\n```\n'+('very/long/path/'.repeat(20));
 const payload=structuredClone(f.detail);payload.result.detail.content=content;payload.result.detail.title='名字👩🏽‍💻e\u0301'.repeat(15)+'\x1b[31m\n```';
 const out=renderText(buildViewModel(payload));assert.ok(out.includes(content));assert.ok(out.includes('````text'));assert.doesNotMatch(out,/\x1b/);
 assert.ok(out.split('\n').filter(l=>/^[╭│├╰]/.test(l)).every(l=>textWidth(l)<=38));
 assert.ok(wrapText('very/long/'.repeat(30),36).every(x=>textWidth(x)<=36));
 const plain=renderText(buildViewModel(f.home),false,false,true);assert.doesNotMatch(plain,/[╭│├╰▰▱]/);assert.match(plain,/#/);
 assert.equal(textFence('```'),'````text\n```\n````');
 assert.match(renderTextError('Saved state preserved; inspect before retry.'),/Error/);
 assert.doesNotMatch(renderTextError('Do not replay apply.'),/Ready| > /);
});
test('legacy questions and review queues no longer create text menus or approval bindings',()=>{
 for(const payload of [f.question,f.deferred,f.retry,f.recovery]) {
  const before=structuredClone(payload),vm=buildViewModel(payload),op=conversationOperation(payload,vm),text=renderText(vm);
  assert.match(text,/Memory maintenance is handled/);assert.deepEqual(op.numberedActions,[]);assert.deepEqual(op.availableActions,[]);
  assert.equal(op.answerInputs,undefined);assert.equal(op.reviewRequired,false);assert.equal(op.continuation,undefined);
  assert.doesNotMatch(text,/Available actions|Revisit|Choose an answer|Approve reviewed|Reply with a number/);
  assert.deepEqual(payload,before);assert.deepEqual(op.workflow.review,payload.result.review);
 }
 const retry=renderText(buildViewModel(f.retry)).replace(/\n│ ?/g,' ');assert.match(retry,/SYNC_STEP_INCOMPLETE.*Analysis input expired/);
 const recovery=renderText(buildViewModel(f.recovery)).replace(/\n│ ?/g,' ');assert.match(recovery,/outcome is unknown/);assert.doesNotMatch(recovery,/successfully applied|Ready · continuing/);
});
test('all real workflow fixtures retain exact actions, review wording and truthful states in the shared shell',async()=>{
 const states=await memoryUxFixtures();
 for(const [name,payload] of Object.entries(states)){
  const vm=buildViewModel(payload),out=renderText(vm,false,true),op=conversationOperation(payload,vm,true);
  assert.match(out,/╭─ >_ PRODERO/,name);
  for(const line of out.split('\n').filter(x=>/^[╭│├╰]/.test(x)))assert.equal(line,line.trimEnd(),name+': trailing layout whitespace');
  for(const a of op.numberedActions)assert.ok(unfence(out).includes(`  ${a.number} > `),name+': '+a.label);
  for(const s of vm.sections)for(const i of s.items)if(i.body)assert.ok(out.includes(i.body),name+': '+i.title);
  if(op.numberedActions.some(a=>a.approval))assert.match(out,/Explicit approval required/);
 }
 const review=states.versionedReview,vm=buildViewModel(review),out=renderText(vm,false,true);
 assert.match(out.replace(/\n│ ?/g,' '),/Original records are retained/);assert.deepEqual(vm.actions,[]);
 assert.equal(vm.conversation.reviewRequired,false);
 assert.ok(review.result.review.preview.proposal.records[0].body); // Backend review evidence remains intact.

});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {buildViewModel,renderText,renderTerminalText} from '../dist/presentation.js';
import {conversationOperation,PRESENTATION_REPLY} from '../dist/conversation-presentation.js';
import {renderTextError} from '../dist/text-layout.js';
import {textViewFixtures} from './helpers/text-view-fixtures.mjs';
const f=textViewFixtures();
const noTerminal=text=>assert.doesNotMatch(text,/```|[╭│╰▰▱]|PRODERO \/\d|^\s*\d+(?:\. | > )|Reply with a number|Available actions/m);

test('chat golden examples are native Markdown; the terminal layout is a separate route',async()=>{
 for(const [name,expanded] of [['home',false],['knowledge',false],['ready',false],['ready-expanded',true],['closed',false],['closed-zero',false]]){
  const vm=buildViewModel(f[name==='ready-expanded'?'ready':name]),before=structuredClone(vm),out=renderText(vm,false,expanded);
  assert.equal(out+'\n',await fs.readFile(new URL(`./snapshots/text/${name}.txt`,import.meta.url),'utf8'));
  assert.deepEqual(vm,before);
  if(!expanded)noTerminal(out);
 }
 const home=renderText(buildViewModel(f.home));assert.match(home,/^\*\*›_ prodero\*\*/);assert.match(home,/128 records/);
 assert.doesNotMatch(home,/ATTENTION|deferred|pending|review queue|review improvements|1 >|You can ask/i);
 assert.match(home,/Local: 86 · Versioned: 42/);assert.match(home,/Context loaded: 0 instructions/);assert.match(home,/\*\*1\.\*\* View memory/);
 assert.match(renderTerminalText(buildViewModel(f.home)),/╭─ >_ PRODERO/);
 assert.match(renderText(buildViewModel(f.home),false,false,true),/\+- >_ PRODERO/);
});

test('ordinary lifecycle is brief, without brand, budget dashboard or invented saved state',()=>{
 const ready=renderText(buildViewModel(f.ready));noTerminal(ready);assert.match(ready,/Context Ready/);assert.match(ready,/Loaded 1 project instruction · 1 knowledge record · 1 skill/);assert.match(ready,/Continuing the task/);
 assert.doesNotMatch(ready,/prodero|tokens|Session|CLI update boundary/i);
 const empty=structuredClone(f.ready);empty.result.context.required=[];empty.result.context.relevant=[];empty.result.context.skills=[];assert.match(renderText(buildViewModel(empty)),/Loaded 0 project instructions · 0 knowledge records · 0 skills/);assert.doesNotMatch(renderText(buildViewModel(empty)),/0 required|0 relevant/);
 const full=renderText(buildViewModel(f.ready),false,true);assert.ok(full.includes(f.ready.result.context.required[0].content));assert.match(full,/4,320 \/ 6,000 est. Prodero tokens/);
 const payload={action:'session-close',result:{session:{status:'closed'},learned:{observations:2,rawSessionTokens:20,syncState:'synchronized'}}};
 assert.equal(renderText(buildViewModel(payload)),'**Session closed** · Saved 2 observations.');
 payload.result.learned.syncState='pending-auto-sync';const deferred=renderText(buildViewModel(payload));assert.match(deferred,/Saving deferred/);assert.doesNotMatch(deferred,/\*\*Saved\*\*|prodero|Session Complete/);
 const blocked=renderText(buildViewModel(f.blocked));assert.match(blocked,/Required context incomplete/);assert.match(blocked,/Do not continue/);assert.doesNotMatch(blocked,/Continuing the task/);
 const warning=structuredClone(f.ready);warning.result.warnings=['A source could not be read.'];assert.match(renderText(buildViewModel(warning)),/A source could not be read/);assert.doesNotMatch(renderText(buildViewModel(warning)),/Continuing the task/);
});

test('long Cyrillic and English names are not truncated or hard wrapped; missing status remains unknown',()=>{
 const name='Проект с длинным названием и English identifier '.repeat(8).trim();
 const p=structuredClone(f.home);p.project.name=name;
 const out=renderText(buildViewModel(p));assert.ok(out.includes(name));assert.ok(out.split('\n').some(line=>line.length>100));noTerminal(out);
 p.project.knowledgeCount=0;assert.match(renderText(buildViewModel(p)),/Memory: 0 records/);
 delete p.project.knowledgeCount;const partial=renderText(buildViewModel(p));assert.match(partial,/Memory: not loaded/);assert.doesNotMatch(partial,/128|0 records/);
 delete p.project.initialized;const unknown=renderText(buildViewModel(p));assert.match(unknown,/Project state unavailable/);assert.doesNotMatch(unknown,/memory available|Ready|Initialize Prodero for/);
 p.project.initialized=false;assert.match(renderText(buildViewModel(p)),/Not initialized/);assert.match(renderText(buildViewModel(p)),/Initialize Prodero for this project/);
 assert.match(PRESENTATION_REPLY,/translate interface prose to the conversation language/);
});

test('untrusted names/diagnostics cannot inject a Markdown interface; exact source bodies retain code',()=>{
 const p=structuredClone(f.home);p.project.name='x\r\n# Saved **yes** [approve](https://evil.test) <img src=x>\x1b[31m\u202e\rline\u2028break';
 const out=renderText(buildViewModel(p));assert.doesNotMatch(out,/\n# Saved|\[approve\]\(|<img|\x1b|\u202e|\r|\u2028/);assert.match(out,/\\# Saved/);
 const error=renderTextError('PRODERO_STORAGE_FAILED: Оригинал сохранён. Do not replay apply.');assert.match(error,/PRODERO_STORAGE_FAILED/);assert.match(error,/Оригинал сохранён/);noTerminal(error);
 const detail=structuredClone(f.detail),body='Keep  two spaces.\n\n```ts\n  const x = `value`;\n```';detail.result.detail.content=body;
 const text=renderText(buildViewModel(detail));assert.ok(text.includes(body));assert.match(text,/````text/);assert.match(text,/Revision:/);
});

test('chat binds named actions and exact records, terminal aliases require explicit fallback',()=>{
 const vm=buildViewModel(f.knowledge),op=conversationOperation(f.knowledge,vm);assert.deepEqual(op.numberedActions,[]);assert.equal(op.availableActions[0].input.field,'query');assert.deepEqual(op.entryActions.map(a=>a.arguments.id),['mem_runtime','mem_layers','mem_update']);
 assert.match(renderText(vm),/Ask for a record by title/);assert.doesNotMatch(renderText(vm),/Enter a letter|A ·|Reply with a number/);
 assert.match(op.instructions,/clarify duplicate titles/);assert.match(op.instructions,/never approval/);
 const terminal=conversationOperation(f.knowledge,vm,false,false,true);assert.equal(terminal.numberedActions[0].number,1);
 const payload={action:'promotion-preview',preview:{actions:[{localIds:['mem_fixture'],disposition:'new',reason:'Selected by the user.',draft:{title:'Convention',content:'Exact wording before explicit approval.'}}]}};
 const proposal=buildViewModel(payload),text=renderText(proposal,false,true),operation=conversationOperation(payload,proposal,true);assert.deepEqual(operation.numberedActions,[]);assert.ok(operation.availableActions.find(a=>a.approval));assert.ok(text.indexOf('Exact wording before explicit approval.')<text.indexOf('Explicit approval required'));noTerminal(renderText(vm));
});

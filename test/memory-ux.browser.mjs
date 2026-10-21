// Optional browser checks: PRODERO_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test test/memory-ux.browser.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {build} from 'esbuild';
import {memoryUxFixtures} from './helpers/memory-ux-fixtures.mjs';
import {updateInstructions} from '../dist/core/update.js';
const {chromium}=await import(process.env.PRODERO_PLAYWRIGHT_MODULE||'playwright');
let browser,server,origin,states;
test.before(async()=>{
 states=await memoryUxFixtures();
 states.denseOpen=structuredClone(states.twoAreas);
 states.denseOpen.project.memoryOverview.areas=Array.from({length:20},(_,i)=>({...states.twoAreas.project.memoryOverview.areas[0],id:'area_'+String(i).padStart(20,'0'),label:'Long knowledge title with implementation details that must not appear on the dashboard '+i}));
 const source=(await fs.readFile('src/ui/main.ts','utf8')).replace('import { App } from "@modelcontextprotocol/ext-apps";',`class App { constructor(){window.__app=this;window.__calls=[];window.__messages=[];} connect(){return Promise.resolve();} getHostContext(){return {};} async callServerTool(r){window.__calls.push(r);if(window.__rpc)return window.__rpc(r);throw Error('No unexpected RPC');} async sendMessage(r){window.__messages.push(r);return {};} }`);
 const bundle=await build({stdin:{contents:source,resolveDir:path.resolve('src/ui'),sourcefile:'main.ts',loader:'ts'},bundle:true,write:false,outdir:'out',format:'esm'});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
 const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><aside id="theme-settings"></aside><div id="app"></div><script type="module">${js}</script></body></html>`;
 server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});
});
test.after(async()=>{await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));});
for(const width of [390,820])test(`memory UX states render one responsive card at ${width}px in project themes`,async t=>{
 const context=await browser.newContext({viewport:{width,height:740},reducedMotion:'reduce'});t.after(()=>context.close());const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const theme of ['dark-neon','light'])for(const name of ['denseOpen','noHistory','twoAreas','selection','progress','localSuccess','versionedReview','protected','conflict','interrupted','stale','question']){
  await page.goto(origin);await page.waitForFunction(()=>window.__app);
  await page.evaluate(({payload,theme})=>window.__app.ontoolresult({structuredContent:{...payload,projectSettings:{root:payload.result?.root??payload.project.root,presentation:{mode:'ui',theme}}}}),{payload:states[name],theme});
  assert.equal(await page.locator('main').count(),1);
  assert.equal(await page.locator('html').getAttribute('data-prodero-theme'),theme);
  assert.equal(await page.locator('details[open]').count(),0,'details stay secondary');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} ${theme} overflows ${width}px`);
  assert.equal(await page.evaluate(()=>window.__calls.length),0,'no follow-up rendering requests');
  if(name==='denseOpen'){
   assert.match(await page.locator('.memory-overview').innerText(),/20 areas identified/);
   assert.doesNotMatch(await page.locator('.memory-overview').innerText(),/Long knowledge title/);
   const button=await page.locator('[data-action="sync"]').boundingBox();assert.ok(button.y+button.height<740,'Curate Memory visible without scrolling');
   assert.equal(await page.locator('.memory-overview .knowledge-warning').count(),0);
   if(theme==='dark-neon')await page.screenshot({path:`/private/tmp/prodero-open-compact-${width}.png`,fullPage:true});
  }
  if(width===820&&theme==='dark-neon'&&['selection','versionedReview','noHistory','localSuccess'].includes(name))await page.screenshot({path:`/private/tmp/prodero-ux-${name}.png`,fullPage:true});
 }
 assert.deepEqual(errors,[]);
});

test('unknown Apply outcome never replays approval and only a saved-state inspect restores actions',async t=>{
 const context=await browser.newContext({viewport:{width:820,height:740}});t.after(()=>context.close());const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>window.__app);
 await page.evaluate(payload=>{window.__saved=payload;window.__rpc=()=>new Promise((_,reject)=>{window.__reject=reject;});window.__app.ontoolresult({structuredContent:payload});},states.versionedReview);
 const approve=page.locator('[data-memory-sync="approve"]');await approve.click();
 await page.waitForFunction(()=>window.__calls.length===1);await approve.dispatchEvent('click');assert.equal(await page.evaluate(()=>window.__calls.length),1,'duplicate approval suppressed while pending');
 const request=await page.evaluate(()=>window.__calls[0]);assert.equal(request.arguments.request.approved,true);assert.equal(request.arguments.request.reviewId,states.versionedReview.result.review.reviewId);assert.equal(request.arguments.request.revision,states.versionedReview.result.revision);
 await page.evaluate(()=>{window.__rpc=()=>Promise.reject(Error('transport unavailable'));window.__reject(Error('apply result lost'));});
 await page.waitForFunction(()=>window.__calls.length===2);await page.waitForFunction(()=>document.querySelector('[data-memory-sync="inspect"]')&&!document.querySelector('[data-memory-sync="inspect"]').disabled);
 assert.equal(await approve.isDisabled(),true);assert.match(await page.locator('main').innerText(),/unknown|unconfirmed/i);
 assert.deepEqual(await page.evaluate(()=>window.__calls.map(c=>c.arguments.request.action)),['approve','inspect']);
 await page.evaluate(()=>{window.__rpc=()=>Promise.resolve({structuredContent:window.__saved});});await page.locator('[data-memory-sync="inspect"]').click();await page.waitForFunction(()=>!document.querySelector('[data-memory-sync="approve"]').disabled);
 assert.deepEqual(await page.evaluate(()=>window.__calls.map(c=>c.arguments.request.action)),['approve','inspect','inspect']);assert.equal(await page.evaluate(()=>window.__messages.length),0);
});

test('question preserves the raw numeric answer draft after a rejected save and never treats it as approval',async t=>{
 const context=await browser.newContext({viewport:{width:390,height:740}});t.after(()=>context.close());const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>window.__app);
 await page.evaluate(payload=>{window.__rpc=()=>Promise.reject(Error('transport unavailable'));window.__app.ontoolresult({structuredContent:payload});},states.question);
 assert.match(await page.locator('main').innerText(),/Has queue v2 deployed/);const answer='2 — only staging is deployed.\nKeep production pending.';await page.locator('#curator-answer').fill(answer);await page.locator('[data-review="answer-free"]').click();
 await page.waitForFunction(()=>window.__calls.length>0);await page.waitForFunction(()=>!document.querySelector('#curator-answer').disabled);
 const request=await page.evaluate(()=>window.__calls[0]);assert.equal(request.arguments.action,'answer');assert.equal(request.arguments.rawText,answer);assert.equal(request.arguments.approved,undefined);assert.ok(request.arguments.questionId);assert.ok(request.arguments.reviewRevisionId);
 assert.equal(await page.locator('#curator-answer').inputValue(),answer);assert.equal(await page.evaluate(()=>window.__messages.length),0);
});

test('healthy Context Ready expands its supplied snapshot locally without an extra Continue step or RPC',async t=>{
 const context=await browser.newContext({viewport:{width:390,height:740}});t.after(()=>context.close());const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>window.__app);
 await page.evaluate(payload=>window.__app.ontoolresult({structuredContent:payload}),states.ready);
 assert.match(await page.locator('main').innerText(),/Context Ready/);assert.equal(await page.getByRole('button',{name:/continue/i}).count(),0);assert.equal(await page.locator('.context-inspector').count(),0);
 await page.locator('[data-action="view-context"]').click();assert.equal(await page.locator('.context-inspector').count(),1);assert.match(await page.locator('.context-inspector').innerText(),new RegExp(states.ready.result.session.id));
 await page.locator('[data-action="close-context"]').click();assert.equal(await page.locator('.context-inspector').count(),0);assert.equal(await page.evaluate(()=>window.__calls.length),0);assert.equal(await page.evaluate(()=>window.__messages.length),0);
});

test('available update indicator requests terminal instructions once without host execution or a false installed result',async t=>{
 const context=await browser.newContext({viewport:{width:820,height:740}});t.after(()=>context.close());const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>window.__app);
 const payload={...states.twoAreas,update:{current:'0.1.0',latest:'0.2.0',available:true,source:'npm',status:'update-available'}};
 await page.evaluate(({payload,instructions})=>{window.__rpc=()=>Promise.resolve({structuredContent:instructions});window.__app.ontoolresult({structuredContent:payload});},{payload,instructions:updateInstructions({id:'npm'})});
 await page.locator('[data-action="update"]').click();await page.waitForFunction(()=>document.querySelector('main').innerText.includes('terminal, run prodero update'));
 const calls=await page.evaluate(()=>window.__calls);assert.equal(calls.length,1);assert.equal(calls[0].name,'prodero_update');assert.equal(calls[0].arguments.projectRoot,payload.project.root);assert.equal(await page.evaluate(()=>window.__messages.length),0);
 assert.match(await page.locator('[data-action="update"]').innerText(),/Update available: 0.2.0/);assert.doesNotMatch(await page.locator('main').innerText(),/Installed successfully|Update request completed|Installing/);
});

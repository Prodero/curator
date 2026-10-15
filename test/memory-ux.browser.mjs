// Optional browser checks: PRODERO_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test test/memory-ux.browser.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {build} from 'esbuild';
import {memoryUxFixtures} from './helpers/memory-ux-fixtures.mjs';
const {chromium}=await import(process.env.PRODERO_PLAYWRIGHT_MODULE||'playwright');
let browser,server,origin,states;
test.before(async()=>{
 states=await memoryUxFixtures();
 states.denseOpen=structuredClone(states.twoAreas);
 states.denseOpen.project.memoryOverview.areas=Array.from({length:20},(_,i)=>({...states.twoAreas.project.memoryOverview.areas[0],id:'area_'+String(i).padStart(20,'0'),label:'Long knowledge title with implementation details that must not appear on the dashboard '+i}));
 const source=(await fs.readFile('src/ui/main.ts','utf8')).replace('import { App } from "@modelcontextprotocol/ext-apps";',`class App { constructor(){window.__app=this;window.__calls=[];window.__messages=[];} connect(){return Promise.resolve();} getHostContext(){return {};} async callServerTool(r){window.__calls.push(r);throw Error('No unexpected RPC');} async sendMessage(r){window.__messages.push(r);return {};} }`);
 const bundle=await build({stdin:{contents:source,resolveDir:path.resolve('src/ui'),sourcefile:'main.ts',loader:'ts'},bundle:true,write:false,outdir:'out',format:'esm'});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
 const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><aside id="theme-settings"></aside><div id="app"></div><script type="module">${js}</script></body></html>`;
 server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true});
});
test.after(async()=>{await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));});
for(const width of [390,820])test(`memory UX states render one responsive card at ${width}px in project themes`,async t=>{
 const context=await browser.newContext({viewport:{width,height:740},reducedMotion:'reduce'});t.after(()=>context.close());const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const theme of ['dark-neon','light'])for(const name of ['denseOpen','noHistory','twoAreas','selection','progress','localSuccess','versionedReview','protected','conflict','interrupted','stale']){
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
   const button=await page.locator('[data-action="sync"]').boundingBox();assert.ok(button.y+button.height<740,'Sync Memory visible without scrolling');
   assert.equal(await page.locator('.memory-overview .knowledge-warning').count(),0);
   if(theme==='dark-neon')await page.screenshot({path:`/private/tmp/prodero-open-compact-${width}.png`,fullPage:true});
  }
  if(width===820&&theme==='dark-neon'&&['selection','versionedReview','noHistory','localSuccess'].includes(name))await page.screenshot({path:`/private/tmp/prodero-ux-${name}.png`,fullPage:true});
 }
 assert.deepEqual(errors,[]);
});

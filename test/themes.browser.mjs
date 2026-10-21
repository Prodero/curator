// Run: PRODERO_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test test/themes.browser.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {projectSettings,setProjectSetting} from '../dist/core/settings.js';
import {initializeProject} from '../dist/core/project.js';
const {chromium} = await import(process.env.PRODERO_PLAYWRIGHT_MODULE || 'playwright');
const exec=promisify(execFile);
const ids=['prodero','dark-neon','pink-neon','blue-neon','purple-neon','light','system'];
const status={product:'Prodero',action:'status-details',phase:'ready',hydrationRequired:false,runtimeVersion:'0.1.0',project:{root:'/tmp/theme-fixture',name:'Theme fixture',initialized:true,git:true,agentsFile:true,schemaVersion:5,canonicalStructure:true,knowledgeCount:8,localKnowledgeCount:3,versionedKnowledgeCount:5,skillCount:2,sessionCount:4,checkpointCount:3,pendingSessionCount:0,conflictCount:0},update:{current:'0.1.0',latest:'0.1.0',available:false,source:'local-checkout',status:'current'}};
const knowledge={uiState:{view:'knowledge'},result:{root:'/tmp/theme-fixture',options:{},counts:{local:1,versioned:1,recommended:0},matches:['local','versioned'].map((layer,i)=>({id:'mem_'+i,layer,title:layer==='local'?'Local deployment notes':'Repository conventions',category:'state',scope:'global',status:'active',contentPreview:'Readable knowledge content with restrained accents.'})),total:2,offset:0,nextOffset:null}};
const learned={action:'session-close',result:{learned:{byType:{decision:1},observations:1,rawSessionTokens:120,syncState:'pending-auto-sync'}}};
const promotion={uiState:{view:'promotion-review'},preview:{summary:{new:1,merge:0,supersede:0,covered:0,conflict:0},actions:[{disposition:'new',draft:{title:'Deployment procedure',content:'Review the production rollout before publishing.'},localIds:['mem_1'],reason:'Explicit review',recommendationSignals:[]}]}};
const skills={uiState:{view:'skills'},result:{counts:{active:0,candidate:0,dismissed:0},skills:[],active:[],candidates:[],dismissed:[],offset:0,nextOffset:null}};
async function snapshot(root){const output={};async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(entry.name==='.git')continue;const p=path.join(dir,entry.name);if(entry.isDirectory())await walk(p);else output[path.relative(root,p)]=await fs.readFile(p,'base64');}}await walk(root);return output;}
let browser,server,origin,root;
test.before(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-themes-'));await exec('git',['init','-q',root]);await initializeProject(root);await exec('git',['-C',root,'add','.']);await exec('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
 const source=(await fs.readFile('src/ui/main.ts','utf8')).replace('import { App } from "@modelcontextprotocol/ext-apps";',`class App { constructor(){window.__app=this;window.__calls=[];} connect(){return Promise.resolve();} getHostContext(){return {};} async callServerTool(request){window.__calls.push(request);const r=await fetch('/config',{method:'POST',body:JSON.stringify(request)});return r.json();} }`);
 const bundle=await build({stdin:{contents:source,resolveDir:path.resolve('src/ui'),sourcefile:'main.ts',loader:'ts'},bundle:true,write:false,outdir:'out',format:'esm'});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
 const html=`<!doctype html><html><head><meta name="color-scheme" content="dark"><style id="styles">${css}</style></head><body><aside id="theme-settings"></aside><div id="app"></div><script type="module">${js}</script></body></html>`;
 server=http.createServer(async(req,res)=>{if(req.url==='/config'){try{let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);assert.equal(request.name,'prodero_config_set');assert.equal(request.arguments.projectRoot,root);const view=await setProjectSetting(root,request.arguments.key,request.arguments.value,{reset:request.arguments.reset});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({content:[],structuredContent:{projectSettings:view}}));}catch(error){res.end(JSON.stringify({isError:true,content:[{type:'text',text:error.message}]}));}return;}res.setHeader('Content-Type','text/html');res.end(html);});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true});
});
test.after(async()=>{await browser?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
async function pageFor(t){const context=await browser.newContext({viewport:{width:820,height:980},colorScheme:'dark',reducedMotion:'reduce'});t.after(()=>context.close());const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>window.__app);await render(page,status);return page;}
async function render(page,payload){await page.evaluate(payload=>window.__app.ontoolresult({structuredContent:payload}),{...payload,projectSettings:await projectSettings(root)});}
async function select(page,id){await page.locator('.theme-picker').evaluate(el=>el.open=true);await page.locator(`input[value="${id}"]`).click();await page.waitForFunction(id=>document.querySelector(`#theme-current`).textContent && document.querySelector(`input[value="${id}"]`).checked && !document.querySelector(`input[value="${id}"]`).disabled,id);}
function luminance(rgb){const channels=rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
test('visual picker applies every palette to status, knowledge, lifecycle, promotion and skills; only local preferences change',async t=>{
 const page=await pageFor(t);const before=await snapshot(root);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const accents=new Set();
 for(const id of ids){
  await select(page,id);
  for(const payload of [status,knowledge,learned,promotion,skills]){
   // Every tool result starts in a fresh app view, like the MCP host does.
   await page.reload();await page.waitForFunction(()=>window.__app);await render(page,payload);
   assert.equal(await page.locator(`input[value="${id}"]`).isChecked(),true);
   assert.equal(await page.locator('html').getAttribute('data-prodero-theme'),id==='system'?'dark-neon':id);
   assert.equal(await page.evaluate(()=>window.__calls.length),0);
   if(id!=='prodero'){
    const colors=await page.locator('.lead, .project-skill p, .context-content, .context-muted').first().evaluate(el=>({text:getComputedStyle(el).color,surface:getComputedStyle(document.querySelector('.shell')).backgroundColor}));
    assert.ok(contrast(colors.text,colors.surface)>=4.5,`${id}: ${JSON.stringify(colors)}`);
   }
  }
  if(id!=='prodero') {
   const colors=await page.evaluate(()=>{
    const root=getComputedStyle(document.documentElement);const roles=['primary','secondary','muted','success','warning','error','info','accent','on-accent','surface'];
    return Object.fromEntries(roles.map(role=>{const el=document.createElement('span');el.style.color=root.getPropertyValue('--palette-'+role);document.body.append(el);const color=getComputedStyle(el).color;el.remove();return [role,color];}));
   });
   for(const role of ['primary','secondary','muted','success','warning','error','info'])assert.ok(contrast(colors[role],colors.surface)>=4.5,id+' '+role);
   assert.ok(contrast(colors.accent,colors['on-accent'])>=4.5,id+' button ink');
  }
  if(id.endsWith('neon'))accents.add(await page.locator('.mark b').evaluate(el=>getComputedStyle(el).backgroundColor));
  await render(page,knowledge);await page.setViewportSize({width:390,height:844});await page.locator('.theme-picker').evaluate(el=>el.open=true);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),id+' overflow');
  if(process.env.PRODERO_THEME_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PRODERO_THEME_SCREENSHOTS,id+'.png'),fullPage:true});
  await page.setViewportSize({width:820,height:980});
 }
 assert.equal(accents.size,4);assert.deepEqual(errors,[]);const canonical=x=>Object.fromEntries(Object.entries(x).filter(([p])=>p!=='.prodero/local/preferences.json'&&p!=='.prodero/local/.gitignore'&&!p.startsWith('.prodero/.transactions/')&&!p.startsWith('.prodero/.cache/')));assert.deepEqual(canonical(await snapshot(root)),canonical(before));assert.equal(await fs.readFile(path.join(root,'.prodero/local/.gitignore'),'utf8'),'*\n');const ignored=(await exec('git',['-C',root,'check-ignore','--','.prodero/local/.gitignore','.prodero/local/preferences.json'])).stdout.trim().split('\n');assert.deepEqual(ignored,['.prodero/local/.gitignore','.prodero/local/preferences.json']);assert.equal((await exec('git',['-C',root,'status','--porcelain'])).stdout,'');
});
test('default screenshot matches original CSS within bounded native-edge raster rounding',async t=>{
 await setProjectSetting(root,'presentation.theme','prodero');const page=await pageFor(t);const original=await fs.readFile('test/fixtures/prodero-default.css','utf8');
 const current=await page.locator('#styles').textContent();
 for(const payload of [status,knowledge,learned,promotion,skills]){
  await page.reload();await page.waitForFunction(()=>window.__app);await render(page,payload);
  // Exclude the new appearance control equally from both backdrop-filter inputs.
  await page.locator('#theme-settings').evaluate(el=>{el.style.height=el.getBoundingClientRect().height+'px';el.style.visibility='hidden';el.style.overflow='hidden';});
  const before=await page.locator('#app').screenshot({animations:'disabled'});
  const top=await page.locator('#theme-settings').evaluate(el=>el.getBoundingClientRect().height);
  await page.locator('#styles').evaluate((el,css)=>el.textContent=css,original+`\n#theme-settings{height:${top}px;visibility:hidden;overflow:hidden}`);
  const legacy=await page.locator('#app').screenshot({animations:'disabled'});if(!before.equals(legacy)){await fs.writeFile('/tmp/prodero-default-new.png',before);await fs.writeFile('/tmp/prodero-default-old.png',legacy);}const difference=await page.evaluate(async({current,legacy})=>{
   async function decode(base64){const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return {width:image.width,height:image.height,data:ctx.getImageData(0,0,image.width,image.height).data};}
   const a=await decode(current),b=await decode(legacy);if(a.width!==b.width||a.height!==b.height)return {sameDimensions:false};let maxDelta=0,changedPixels=0;for(let i=0;i<a.data.length;i+=4){let changed=false;for(let channel=0;channel<4;channel++){const delta=Math.abs(a.data[i+channel]-b.data[i+channel]);maxDelta=Math.max(maxDelta,delta);changed||=delta!==0;}if(changed)changedPixels++;}return {sameDimensions:true,maxDelta,changedPixels};
  },{current:before.toString('base64'),legacy:legacy.toString('base64')});
  // Chromium 156 differs by up to two RGB levels at native rounded control edges when
  // equivalent token-based and literal CSS are repainted. No geometry tolerance.
  assert.ok(difference.sameDimensions&&difference.maxDelta<=2&&difference.changedPixels<=64,'Prodero default appearance changed: '+JSON.stringify({view:payload.uiState??payload.action,...difference}));
  await page.locator('#styles').evaluate((el,css)=>el.textContent=css,current);
 }
});
test('local reset is reachable, preserves the current draft and reveals the built-in fallback without shared writes',async t=>{
 await setProjectSetting(root,'presentation.theme','light');const before=await fs.readFile(path.join(root,'.prodero/config.json'),'utf8');
 const page=await pageFor(t);await render(page,knowledge);await page.locator('input[name="query"]').fill('keep unsaved search');await page.locator('.theme-picker').evaluate(el=>el.open=true);
 await page.locator('#theme-reset').click();await page.waitForFunction(()=>document.documentElement.dataset.proderoTheme==='prodero'&&document.querySelector('#theme-reset').hidden);
 assert.equal(await page.locator('input[name="query"]').inputValue(),'keep unsaved search');assert.equal(await fs.readFile(path.join(root,'.prodero/config.json'),'utf8'),before);assert.equal((await exec('git',['-C',root,'status','--porcelain'])).stdout,'');
 assert.match(await page.locator('#theme-persistence').textContent(),/built-in default/);
});
test('live System changes, host override, legacy/denied browser storage independence and form preservation',async t=>{
 const page=await pageFor(t);await render(page,knowledge);await select(page,'system');await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.proderoTheme==='light');assert.equal(await page.locator('html').getAttribute('data-prodero-theme'),'light');
 await page.evaluate(()=>window.__app.onhostcontextchanged({theme:'dark'}));assert.equal(await page.locator('html').getAttribute('data-prodero-theme'),'dark-neon');
 await page.locator('input[name="query"]').fill('unsaved search');await select(page,'pink-neon');await page.locator('input[value="pink-neon"]').focus();await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.documentElement.dataset.proderoTheme==='blue-neon');assert.equal(await page.locator('input[name="query"]').inputValue(),'unsaved search');
 await page.evaluate(()=>localStorage.setItem('prodero.ui.theme.v1','unknown'));await page.reload();await page.waitForFunction(()=>window.__app);await render(page,knowledge);assert.equal(await page.locator('html').getAttribute('data-prodero-theme'),'blue-neon');
 await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('denied','SecurityError');}}));await page.reload();await page.waitForFunction(()=>window.__app);await render(page,knowledge);assert.equal(await page.locator('html').getAttribute('data-prodero-theme'),'blue-neon');await select(page,'blue-neon');assert.equal(await page.locator('html').getAttribute('data-prodero-theme'),'blue-neon');assert.match(await page.locator('#theme-persistence').textContent(),/this checkout/);
});

test('neon atmospheres have distinct near-black surface hierarchies without active controls',async t=>{
 const page=await pageFor(t), samples={}, captures=[];
 await page.setViewportSize({width:480,height:1040});
 for(const id of ids){
  await page.reload();await page.waitForFunction(()=>window.__app);await render(page,knowledge);await select(page,id);
  await page.locator('.theme-picker').evaluate(el=>el.open=false);
  await page.locator('input[name="query"]').evaluate(el=>el.blur());await page.mouse.move(0,0);
  await page.locator('button').evaluateAll(buttons=>buttons.forEach(b=>b.getAnimations().forEach(a=>a.finish())));
  const input=await page.locator('input[name="query"]').evaluate(el=>getComputedStyle(el).backgroundColor);
  const cardView=structuredClone(knowledge);cardView.result.detail={...knowledge.result.matches[0],title:'Local deployment notes',content:'Readable knowledge content.',status:'active',scope:'global',supersedes:[],related:[],relations:[]};
  await render(page,cardView);
  const sample=await page.evaluate(()=>{
   const styles=selector=>getComputedStyle(document.querySelector(selector));
   const root=styles('html');
   const roles=['primary','secondary','muted','success','warning','error','info','accent','accent-secondary','on-accent','page','surface','elevated','tinted','selected','hover','focus'];
   const tokens=Object.fromEntries(roles.map(role=>{const el=document.createElement('span');el.style.color=root.getPropertyValue('--palette-'+role);document.body.append(el);const color=getComputedStyle(el).color;el.remove();return [role,color];}));
   return {page:styles('.shell').backgroundColor,panel:styles('.panel').backgroundColor,card:styles('.project-skill').backgroundColor,gradient:styles('.shell').backgroundImage,border:styles('.project-skill').borderColor,textShadow:styles('.project-skill .context-content').textShadow,shadow:styles('.project-skill').boxShadow,tokens};
  });
  sample.input=input;
  await render(page,knowledge);
  if(id.endsWith('-neon')){
   samples[id]=sample;
   assert.ok(luminance(sample.page)<.004,id+' near-black foundation');
   assert.equal(sample.panel,sample.tokens.surface);assert.equal(sample.card,sample.tokens.elevated);assert.equal(sample.input,sample.tokens.surface);
   assert.ok(luminance(sample.card)>luminance(sample.panel),id+' elevation');
   assert.equal(sample.textShadow,'none');assert.equal(sample.shadow,'none');assert.notEqual(sample.gradient,'none');
   for(const role of ['primary','secondary','muted','success','warning','error','info'])for(const surface of ['page','surface','elevated','tinted','selected','hover'])assert.ok(contrast(sample.tokens[role],sample.tokens[surface])>=4.5,`${id}: ${role} on ${surface}`);
   assert.ok(contrast(sample.tokens['accent-secondary'],sample.tokens['on-accent'])>=4.5,id+' hover button ink');
   const button=page.locator('button[data-knowledge-action="back"]');
   assert.equal(await button.evaluate(el=>getComputedStyle(el).backgroundColor),sample.tokens.elevated);
   await button.hover();await button.evaluate(el=>el.getAnimations().forEach(a=>a.finish()));
   assert.equal(await button.evaluate(el=>getComputedStyle(el).backgroundColor),sample.tokens.hover);
   await page.locator('input[name="query"]').focus();
   assert.equal(await page.locator('input[name="query"]').evaluate(el=>getComputedStyle(el).outlineColor),sample.tokens.focus);
   await page.locator('input[name="query"]').evaluate(el=>el.blur());await page.mouse.move(0,0);

  }
  if(process.env.PRODERO_THEME_SCREENSHOTS){
   const png=await page.screenshot({fullPage:true,animations:'disabled'});captures.push({id,png:png.toString('base64')});
   await fs.writeFile(path.join(process.env.PRODERO_THEME_SCREENSHOTS,id+'-reading.png'),png);
  }
 }
 for(const role of ['page','panel','card','border','gradient'])assert.equal(new Set(Object.values(samples).map(s=>s[role])).size,4,role+' must differ without active controls');
 assert.ok(Object.entries(samples).filter(([id])=>id!=='dark-neon').every(([,s])=>luminance(samples['dark-neon'].page)<luminance(s.page)));
 // Color direction is visible in surfaces, not merely in accent metadata.
 const rgb=c=>c.match(/[\d.]+/g).slice(0,3).map(Number);
 const pink=rgb(samples['pink-neon'].card),blue=rgb(samples['blue-neon'].card),purple=rgb(samples['purple-neon'].card);
 assert.ok(pink[0]>pink[2]&&pink[2]>pink[1]);assert.ok(blue[2]>blue[1]&&blue[1]>blue[0]);assert.ok(purple[2]>purple[0]&&purple[0]>purple[1]);
 if(captures.length){
  const gallery=await page.context().newPage();
  for(const [file,items] of [['all-themes',captures],['neon-comparison',captures.filter(c=>c.id.endsWith('-neon'))]]){
   await gallery.setViewportSize({width:items.length*480,height:1150});
   await gallery.setContent(`<html><body style="margin:0;background:#07090c;display:flex;font:16px system-ui;color:white">${items.map(c=>`<figure style="margin:0;width:480px;flex:none"><figcaption style="padding:16px">${c.id}</figcaption><img style="display:block;width:480px" src="data:image/png;base64,${c.png}"></figure>`).join('')}</body></html>`);
   await gallery.screenshot({path:path.join(process.env.PRODERO_THEME_SCREENSHOTS,file+'.png'),fullPage:true});
  }
  await gallery.close();
 }
});

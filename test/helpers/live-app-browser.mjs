// Optional acceptance harness: production App code, real Chromium and live stdio MCP.
// Replaces only the host App transport, never backend responses or approval guards.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {parse} from 'smol-toml';
const apps={extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}};
export async function liveBrowserHarness(){
 const sourceRoot=path.resolve('.'),module=process.env.PRODERO_PLAYWRIGHT_MODULE;
 if(!module)throw Error('Set PRODERO_PLAYWRIGHT_MODULE to an existing isolated Playwright/core installation.');
 const {chromium}=await import(module),artifacts=process.env.PRODERO_BROWSER_ARTIFACTS??await fs.mkdtemp(path.join(os.tmpdir(),'curator-browser-evidence-'));
 await fs.mkdir(artifacts,{recursive:true});
 const receipt=JSON.parse(await fs.readFile(path.join(os.homedir(),'.local/state/prodero/host-integrations/codex/receipt.json'),'utf8'));
 const entry=parse(await fs.readFile(path.join(os.homedir(),'.codex/config.toml'),'utf8')).mcp_servers.prodero;
 assert.equal(receipt.runtime.devRoot,sourceRoot);assert.equal(entry.command,receipt.entry.command);assert.equal(JSON.stringify(entry.args),JSON.stringify(receipt.entry.args));assert.equal(entry.env.PATH,receipt.entry.env.PATH);
 const source=(await fs.readFile('src/ui/main.ts','utf8')).replace('import { App } from "@modelcontextprotocol/ext-apps";',`class App {
  constructor(){window.__app=this;window.__calls=[];window.__pending=0;window.__messages=[];}
  connect(){return Promise.resolve();}getHostContext(){return {theme:'dark'};}
  async callServerTool(r){window.__calls.push(r);window.__pending++;try{return await window.__realMcp(r);}finally{window.__pending--;}}
  async sendMessage(r){window.__messages.push(r);return {};}
 }`);
 const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
 const bundle=await build({define:{__PRODERO_VERSION__:JSON.stringify(version)},stdin:{contents:source,resolveDir:path.resolve('src/ui'),sourcefile:'main.ts',loader:'ts'},bundle:true,write:false,outdir:'out',format:'esm'});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
 const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><aside id="theme-settings"></aside><div id="app"></div><script type="module" src="/app.js"></script></body></html>`;
 await fs.writeFile(path.join(artifacts,'test-app.js'),js);
 const server=http.createServer((req,res)=>{const kind=req.url==='/app.js'?'text/javascript':req.url==='/app.css'?'text/css':'text/html';res.setHeader('Content-Type',kind);res.end(req.url==='/app.js'?js:req.url==='/app.css'?css:html);});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});
 const cases=[],screenshots=[],contexts=new Set();
 async function fixture(name,{initialized=true,width=1100}={}){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'curator-open-browser-')),root=path.join(base,'project'),home=path.join(base,'home');await fs.mkdir(root);await fs.mkdir(home);
  const client=new Client({name:'codex-mcp-client',version:'browser-acceptance'},{capabilities:apps});
  const transport=new StdioClientTransport({command:entry.command,args:entry.args,cwd:root,env:{PATH:entry.env.PATH,HOME:home,CODEX_HOME:path.join(home,'.codex'),XDG_STATE_HOME:path.join(home,'.local/state'),TMPDIR:os.tmpdir(),PRODERO_RELEASE_SOURCE:'none'},stderr:'pipe'});
  await client.connect(transport);const calls=[],responses=[];
  const raw=async(name,args={})=>{calls.push({name,args});const response=await client.callTool({name,arguments:args});responses.push({name,response});return response;};
  const call=async(name,args={})=>{const r=await raw(name,args);assert.notEqual(r.isError,true,name+' '+JSON.stringify(r));return r;};
  if(initialized)await call('prodero_initialize');
  const context=await browser.newContext({viewport:{width,height:820},reducedMotion:'reduce'});contexts.add(context);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const f={name,root,home,client,page,calls,errors,failure:null,async settle(){await page.waitForFunction(()=>window.__pending===0);await page.evaluate(()=>new Promise(requestAnimationFrame));},
   raw,call,text:(tool,args={})=>call('prodero_text',{tool,arguments:args}),
   async render(result){await page.evaluate(r=>window.__app.ontoolresult(r),result);await this.settle();},
   async open(){await this.render(await call('prodero_open'));},
   async click(selector){await page.locator(selector).click();await this.settle();},
   async shot(label){const file=path.join(artifacts,name+'-'+label+'.png');await page.screenshot({path:file,fullPage:true});screenshots.push({case:name,label,file});return file;},
   async check(label,fn){try{await fn();cases.push({section:name,check:label,status:'passed'});}catch(e){cases.push({section:name,check:label,status:'failed',error:e.message});await this.shot('failure-'+cases.length);throw e;}},
   async close(){await fs.writeFile(path.join(artifacts,name+'-rpc.json'),JSON.stringify({root,calls,responses},null,2));await context.close();contexts.delete(context);await client.close();assert.deepEqual(errors,[],'Unhandled browser errors');},
  };
  await page.exposeFunction('__realMcp',async request=>{
   if(!/^prodero_/.test(request.name))throw Error('Unexpected non-Curator browser RPC');
   const requested=request.arguments?.projectRoot;if(requested&&path.resolve(requested)!==path.resolve(root)&&path.resolve(requested)!==await fs.realpath(root))throw Error('UI changed the fixture workspace binding');
   if(f.failure?.tool===request.name){const failure=f.failure;f.failure=null;if(failure.throw)throw Error(failure.message);return {isError:true,content:[{type:'text',text:failure.message}],structuredContent:{ok:false,message:failure.message,code:'TEST_TRANSPORT_FAILURE'}};}
   return raw(request.name,request.arguments??{});
  });
  await page.goto(origin);try{await page.waitForFunction(()=>window.__app,{},{timeout:5000});}catch(error){await fs.writeFile(path.join(artifacts,name+'-bootstrap-error.json'),JSON.stringify({errors,error:error.message},null,2));await context.close();contexts.delete(context);await client.close();throw Error('Browser fixture bootstrap: '+errors.join('; ')+' '+error.message);}return f;
 }
 return {fixture,artifacts,cases,screenshots,browserVersion:browser.version(),async close(){for(const c of contexts)await c.close();await browser.close();await new Promise(r=>server.close(r));await fs.writeFile(path.join(artifacts,'browser-results.json'),JSON.stringify({browser:browser.version(),kind:'production App + live configured stdio MCP bridge',nativeCodexRendering:false,cases,screenshots},null,2));}};
}

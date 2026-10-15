import * as applicabilityLabels from '../../dist/core/applicability-label.js';
import * as presentation from "../../dist/presentation.js";
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as contracts from '../../dist/contracts.js';
import * as snapshots from '../../dist/core/context-snapshot.js';
export async function knowledgeUi(callServerTool, sendMessage=()=>({})) {
 let app, html=''; const elements=[];
 const decode=s=>s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
 const host={set innerHTML(text){html=text;elements.length=0;
  for(const m of text.matchAll(/<(button|input|textarea|form|select)\b([^>]*)>/g)){
   const attrs=Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],decode(a[2])]));
   const element={tag:m[1],attrs,checked:/\bchecked\b/.test(m[2]),disabled:/\bdisabled\b/.test(m[2]),listeners:{},value:attrs.value??'',dataset:Object.fromEntries(Object.entries(attrs).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v])),addEventListener(event,fn){this.listeners[event]=fn;}};
   if(m[1]==='textarea')element.value=decode(text.slice(m.index+m[0].length).split('</textarea>')[0]);
   if(m[1]==='select'){const options=text.slice(m.index+m[0].length).split('</select>')[0];element.value=options.match(/<option value="([^"]*)" selected/)?.[1]??'';}
   elements.push(element);
  }
  for(const form of elements.filter(e=>e.tag==='form'))form.fields=elements.filter(e=>e.attrs.name);
 },get innerHTML(){return html;},querySelectorAll(selector){if(selector.includes(','))return [...new Set(selector.split(',').flatMap(part=>this.querySelectorAll(part.trim())))];if(selector.startsWith('#'))return elements.filter(e=>e.attrs.id===selector.slice(1));const attrs=[...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];return elements.filter(e=>(!selector.startsWith('button')||e.tag==='button')&&attrs.every(a=>a[1] in e.attrs&&(a[2]===undefined||e.attrs[a[1]]===a[2])));},querySelector(selector){return this.querySelectorAll(selector)[0]??null;}};
 class App{constructor(){app=this;}connect(){}sendMessage(message){return sendMessage(message);}callServerTool(request){return callServerTool(request);}}
 class FormData{constructor(form){this.fields=form.fields;}get(name){return this.fields.find(f=>f.attrs.name===name)?.value??null;}entries(){return this.fields.map(f=>[f.attrs.name,f.value]).values();}}
 const code=ts.transpileModule(await fs.readFile(new URL('../../src/ui/main.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const context=vm.createContext({exports:{},document:{querySelector:()=>host},FormData,require:id=>id==='./card-disclosure.js'?{mountCardDisclosure:()=>undefined}:id==='@modelcontextprotocol/ext-apps'?{App}:id.includes('applicability-label') ? applicabilityLabels : id.includes('contracts')?contracts:id.includes('context-snapshot')?snapshots:id.includes('presentation')?presentation:{}});vm.runInContext(code,context);
 async function settle(){for(let n=0;n<600&&vm.runInContext('busyAction!==null',context);n++)await new Promise(r=>setTimeout(r,5));if(vm.runInContext('busyAction!==null',context))throw Error('UI did not settle');}
 return {host,check(selector,value=true){const e=host.querySelector(selector);if(!e)throw Error('Missing checkbox '+selector);e.checked=value;e.listeners.change?.();},async review(action){const e=elements.find(e=>e.dataset.review===action);if(!e)throw Error('Missing review action '+action);e.listeners.click({currentTarget:e});await settle();},async sync(action){const e=elements.find(e=>e.dataset.memorySync===action);if(!e)throw Error('Missing Sync Memory action '+action);e.listeners.click({currentTarget:e});await settle();},render:r=>app.ontoolresult(r),get html(){return html;},async click(action,id){const e=elements.find(e=>e.dataset.knowledgeAction===action&&(id===undefined||e.dataset.id===id));if(!e)throw Error('Missing Knowledge button '+action);e.listeners.click?.({currentTarget:e});await settle();},async session(action,id){const e=elements.find(e=>e.dataset.sessionAction===action&&(id===undefined||e.dataset.id===id));if(!e)throw Error('Missing Session button '+action);e.listeners.click?.({currentTarget:e});await settle();},async instruction(action,id){const e=elements.find(e=>e.dataset.instructionAction===action&&(id===undefined||e.dataset.id===id));if(!e)throw Error("Missing instruction button "+action);e.listeners.click({currentTarget:e});await settle();},async promotion(action){const e=elements.find(e=>e.dataset.promotionAction===action);if(!e)throw Error('Missing promotion button');e.listeners.click({currentTarget:e});await settle();},async submit(formId,values){const form=host.querySelector('#'+formId);if(!form)throw Error('Missing form '+formId);for(const [name,value]of Object.entries(values)){const field=form.fields.find(f=>f.attrs.name===name);if(!field)throw Error('Missing field '+name);field.value=value;}form.listeners.submit({preventDefault(){},currentTarget:form});await settle();}};
}

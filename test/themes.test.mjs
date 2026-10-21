import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as definitions from '../dist/settings-definition.js';
const source = await fs.readFile(new URL('../src/ui/themes.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const api = {};
vm.runInNewContext(code, {exports:api, require:()=>definitions, document:{querySelector:()=>null}});
const {createThemeController, THEMES} = api;
function fixture(theme='prodero',project='A') {
 const root={dataset:{}},listeners=new Set(),writes=[];
 const query={matches:false,addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};
 const controller=createThemeController({root,media:query});
 const save=async(root,theme)=>{writes.push({root,theme});};
 controller.setProject(project,theme,save);
 return {controller,root,writes,save,change(dark){query.matches=dark;listeners.forEach(fn=>fn());},listeners};
}
test('all seven themes persist through the project callback without browser storage',async()=>{
 assert.deepEqual(Array.from(THEMES,t=>t.id),['prodero','dark-neon','pink-neon','blue-neon','purple-neon','light','system']);
 const f=fixture();
 for(const {id} of THEMES){await f.controller.select(id);assert.equal(f.controller.selected,id);assert.deepEqual(f.writes.at(-1),{root:'A',theme:id});}
 assert.doesNotMatch(source,/localStorage|THEME_STORAGE_KEY/);
});
test('different projects have isolated themes; pending saves cannot recolor a new project',async()=>{
 const a=fixture('blue-neon'),b=fixture('purple-neon','B');
 await a.controller.select('pink-neon');assert.equal(b.controller.selected,'purple-neon');
 let finish; a.controller.setProject('A','blue-neon',()=>new Promise(resolve=>finish=resolve));
 const pending=a.controller.select('light');a.controller.setProject('B','purple-neon',a.save);finish();await pending;
 assert.equal(a.controller.selected,'purple-neon');assert.equal(a.root.dataset.proderoTheme,'purple-neon');
 a.controller.setProject('C',undefined,a.save);assert.equal(a.controller.selected,'prodero');
});
test('failed project theme save preserves the previous value',async()=>{
 const f=fixture('blue-neon');f.controller.setProject('A','blue-neon',async()=>{throw Error('write failed');});
 await f.controller.select('pink-neon');assert.equal(f.controller.selected,'blue-neon');
});
test('local theme reset reveals supplied fallback; late or failed reset cannot recolor another project',async()=>{
 const f=fixture('light');let calls=0;
 f.controller.setProject('A','light',f.save,{source:'local override',reset:async root=>{assert.equal(root,'A');calls++;return {theme:'dark-neon',source:'legacy project default'};}});
 await f.controller.reset();assert.equal(calls,1);assert.equal(f.controller.selected,'dark-neon');await f.controller.reset();assert.equal(calls,1);
 let finish;f.controller.setProject('A','light',f.save,{source:'local override',reset:()=>new Promise(resolve=>finish=resolve)});
 const pending=f.controller.reset();f.controller.setProject('B','purple-neon',f.save);finish({theme:'dark-neon',source:'legacy project default'});await pending;assert.equal(f.controller.selected,'purple-neon');
 f.controller.setProject('A','light',f.save,{source:'local override',reset:async()=>{throw new Error('repair preference file');}});await f.controller.reset();assert.equal(f.controller.selected,'light');
});
test('host document theme updates cannot overwrite the project palette',()=>{
 const f=fixture('dark-neon');
 for(const theme of ['dark','light']){
  f.root.dataset.theme=theme;
  assert.equal(f.root.dataset.proderoTheme,'dark-neon');
  f.controller.setHostTheme(theme);
  assert.equal(f.root.dataset.theme,theme,'project controller leaves the host attribute alone');
  assert.equal(f.root.dataset.proderoTheme,'dark-neon');
 }
});
test('palette styles depend only on the Prodero theme attribute',async()=>{
 const css=await fs.readFile(new URL('../src/ui/themes.css',import.meta.url),'utf8');
 assert.doesNotMatch(css,/\[data-theme/);
 assert.match(css,/:root\[data-prodero-theme="dark-neon"\]/);
});
test('System follows host appearance while explicit project themes remain independent',async()=>{
 const f=fixture('system');assert.equal(f.root.dataset.proderoTheme,'light');f.change(true);assert.equal(f.root.dataset.proderoTheme,'dark-neon');
 f.controller.setHostTheme('light');assert.equal(f.root.dataset.proderoTheme,'light');
 await f.controller.select('pink-neon');f.change(false);f.controller.setHostTheme('dark');assert.equal(f.root.dataset.proderoTheme,'pink-neon');
 f.controller.dispose();assert.equal(f.listeners.size,0);
});
test('default component stylesheet resolves byte-for-byte to the reviewed baseline',async()=>{
 const css=await fs.readFile(new URL('../src/ui/style.css',import.meta.url),'utf8');
 const themes=await fs.readFile(new URL('../src/ui/themes.css',import.meta.url),'utf8');
 const baseline=await fs.readFile(new URL('fixtures/prodero-default.css',import.meta.url),'utf8');
 const values=new Map([...themes.split('/* Shared variant')[0].matchAll(/(--[\w-]+): ([^;]+);/g)].map(([,k,v])=>[k,v]));
 assert.equal(css.replace(/var\((--[\w-]+)\)/g,(match,key)=>values.get(key)??match),baseline);
 assert.doesNotMatch(css,/#[0-9a-f]{3,8}\b|rgba?\(/i);
 assert.doesNotMatch(source,/callServerTool|updateModelContext|node:fs|\.prodero\//);
});

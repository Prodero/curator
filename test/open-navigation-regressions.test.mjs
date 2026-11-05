import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
import {rememberProjectKnowledge} from '../dist/core/project.js';
import {listKnowledge} from '../dist/core/memory.js';
import {knowledgeUi} from './helpers/knowledge-ui.mjs';
async function fixture(t,{initialized=true}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'curator-navigation-regression-')),server=createServer({projectRoot:root}),client=new Client({name:'navigation-regression',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
 const calls=[],raw=async(name,args={})=>{calls.push({name,args});return client.callTool({name,arguments:args});},call=async(name,args={})=>{const r=await raw(name,args);assert.notEqual(r.isError,true,JSON.stringify(r));return r;};if(initialized)await call('prodero_initialize');return {root,raw,call,calls};
}
async function action(ui,selector){const button=ui.host.querySelector(selector);assert.ok(button,selector);button.listeners.click({currentTarget:button});await ui.settle();}

test('Knowledge detail/back retains its current filtered page instead of silently returning to page one',async t=>{
 const f=await fixture(t);for(let n=0;n<14;n++)await rememberProjectKnowledge(f.root,{title:'Unique '+n,content:'Separate fixture fact '+n+'.',kind:'fact',scope:'path',path:'fixtures/'+n});
 const ui=await knowledgeUi(r=>f.raw(r.name,r.arguments));ui.render(await f.call('prodero_knowledge',{layer:'local'}));await ui.click('next');assert.match(ui.html,/Showing 13–14/);
 const id=ui.host.querySelector('button[data-knowledge-action="view"]').dataset.id;await ui.click('view',id);await ui.click('list');assert.match(ui.html,/Showing 13–14/);assert.equal(f.calls.at(-1).args.offset,12);assert.equal(f.calls.at(-1).args.layer,'local');
});

test('Initialize error stays visible, does not fabricate success and leaves retry available',async t=>{
 const f=await fixture(t,{initialized:false});let fail=true;
 const ui=await knowledgeUi(r=>r.name==='prodero_initialize'&&fail?(fail=false,{isError:true,structuredContent:{ok:false,message:'Initialization refused by fixture storage.'},content:[]}):f.raw(r.name,r.arguments));ui.render(await f.call('prodero_open'));
 await action(ui,'button[data-action="init"]');assert.match(ui.html,/Initialization refused/);assert.doesNotMatch(ui.html,/Prodero initialized\./);assert.ok(ui.host.querySelector('button[data-action="init"]'));
 await action(ui,'button[data-action="init"]');assert.match(ui.html,/Prodero initialized\./);assert.ok(ui.host.querySelector('button[data-action="knowledge"]'));
});

test('successful promotion clears completed selection and retains its confirmed receipt when list refresh fails',async t=>{
 const f=await fixture(t),saved=await rememberProjectKnowledge(f.root,{title:'Harbor fixture',content:'Harbor fixture preserves a bounded source.',kind:'fact'});let committed=false;
 const ui=await knowledgeUi(async r=>{if(committed&&r.name==='prodero_knowledge'){committed=false;throw Error('Fixture refresh unavailable.');}const result=await f.raw(r.name,r.arguments);if(r.name==='prodero_promote'&&!result.isError)committed=true;return result;});
 ui.render(await f.call('prodero_open'));await action(ui,'button[data-action="share"]');ui.check('input[data-share-id="'+saved.item.id+'"]',true);await ui.click('promote-selected');await ui.promotion('publish');
 assert.equal((await listKnowledge(f.root,'versioned')).length,1);assert.match(ui.html,/Wrote 1 Versioned Knowledge item/);assert.match(ui.html,/Showing cached results/);assert.match(ui.html,/List refresh failed: (?:Error: )?Fixture refresh unavailable/);assert.equal(ui.host.querySelector('button[data-promotion-action="publish"]'),null);assert.equal(ui.host.querySelector('button[data-knowledge-action="promote-selected"]'),null);
});

test('first catalogue read error reports unavailable instead of inventing an empty zero-record catalogue',async t=>{
 const f=await fixture(t);await rememberProjectKnowledge(f.root,{title:'Fixture retained record',content:'This record still exists when the first UI read fails.',kind:'fact'});let fail=true;
 const ui=await knowledgeUi(r=>r.name==='prodero_knowledge'&&fail?(fail=false,{isError:true,structuredContent:{ok:false,message:'Fixture read interrupted.'},content:[]}):f.raw(r.name,r.arguments));ui.render(await f.call('prodero_open'));
 await action(ui,'button[data-action="knowledge"]');assert.match(ui.html,/catalogue is unavailable/);assert.doesNotMatch(ui.html,/No knowledge yet|Knowledge: <b>0/);await ui.click('list');assert.ok(ui.host.querySelector('button[data-knowledge-action="view"]'));
});

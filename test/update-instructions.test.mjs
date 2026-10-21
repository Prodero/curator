import test from 'node:test';
import assert from 'node:assert/strict';
import {updateInstructions} from '../dist/core/update.js';
import {buildViewModel,renderText} from '../dist/presentation.js';
import {lifecycleUi} from './helpers/lifecycle-ui.mjs';
const status=()=>({action:'open',product:'Prodero',project:{root:'/tmp/synthetic-update-instructions',name:'Update fixture',initialized:true,git:true,agentsFile:true,knowledgeCount:4,localKnowledgeCount:4,versionedKnowledgeCount:0,skillCount:0,sessionCount:0,pendingSessionCount:0,checkpointCount:0,conflictCount:0},update:{current:'0.1.0',latest:'0.2.0',available:true,source:'npm',status:'update-available'}});

test('instruction text gives the terminal lifecycle and no executable install/approval continuation',()=>{
 const payload=updateInstructions({id:'local-checkout'}),vm=buildViewModel(payload),plain=renderText(vm).replace(/\n│ ?/g,' ');
 assert.match(plain,/Update instructions/);assert.match(plain,/close your MCP hosts/);assert.match(plain,/terminal, run prodero update/);assert.match(plain,/review its plan before approving installation/);assert.match(plain,/restart and reconnect/);assert.match(plain,/migration separately/);
 assert.deepEqual(vm.actions,[]);assert.equal(vm.conversation.continuation,undefined);assert.doesNotMatch(plain,/npm install|staged successfully|Update request completed/);
 const action=buildViewModel(status()).actions.find(a=>a.tool==='prodero_update');assert.equal(action.label,'Show update instructions');assert.equal(action.approval,undefined);assert.deepEqual(action.arguments,{projectRoot:'/tmp/synthetic-update-instructions'});
 const home=renderText(buildViewModel(status())).replace(/\n│ ?/g,' ');assert.match(home,/prodero update in a terminal/);assert.match(home,/close hosts/);
});

test('dashboard update indicator only requests instructions, preserves update availability and never sends host execution',async()=>{
 const calls=[],source={id:'npm'},ui=await lifecycleUi({callServerTool:async request=>{calls.push(request);return {structuredContent:updateInstructions(source)};},sendMessage:()=>{throw new Error('must not execute an update through the host');}});
 ui.render(status());assert.match(ui.html,/>Update available: 0.2.0 · instructions<\/button>/);
 ui.click('update');for(let i=0;i<20&&!ui.html.includes('terminal, run prodero update');i++)await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(calls.length,1);assert.equal(calls[0].name,'prodero_update');assert.equal(calls[0].arguments.projectRoot,status().project.root);
 assert.match(ui.html,/terminal, run prodero update/);assert.match(ui.html,/0.1.0 → 0.2.0/);assert.doesNotMatch(ui.html,/Restart Prodero<\/button>|Update request completed|Installing/);
 assert.ok(ui.renders.some(html=>html.includes('Showing update instructions')));
});

test('a legacy or untrusted update response cannot make the dashboard claim installation or schedule restart',async()=>{
 const ui=await lifecycleUi({callServerTool:async()=>({structuredContent:{message:'Installed successfully',restartRequired:true,update:{available:false,status:'current'}}})});
 ui.render(status());ui.click('update');for(let i=0;i<20&&!ui.html.includes('terminal, run prodero update');i++)await new Promise(resolve=>setTimeout(resolve,0));
 assert.match(ui.html,/terminal, run prodero update/);assert.match(ui.html,/0.1.0 → 0.2.0/);assert.doesNotMatch(ui.html,/Installed successfully|Restart Prodero<\/button>/);
});

for(const state of ['current','unavailable'])test(`${state} has no update-available indicator or instruction action; separate check remains`,async()=>{
 const payload=status();Object.assign(payload.update,{available:false,status:state,latest:state==='current'?'0.1.0':null});
 const ui=await lifecycleUi();ui.render(payload);assert.doesNotMatch(ui.html,/data-action="update"|Update available:.*instructions/);
 const vm=buildViewModel(payload);assert.equal(vm.actions.some(a=>a.tool==='prodero_update'),false);assert.ok(vm.actions.some(a=>a.tool==='prodero_check_update'));assert.doesNotMatch(renderText(vm),/prodero update in a terminal/);
});

import * as applicabilityLabels from '../../dist/core/applicability-label.js';
import * as presentation from "../../dist/presentation.js";
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as contracts from '../../dist/contracts.js';
import * as snapshots from '../../dist/core/context-snapshot.js';

// Run the production UI and its disclosure handlers, without a host connection.
export async function lifecycleUi({ callServerTool, requestAnimationFrame, setTimeout, sendMessage, cardDisclosure } = {}) {
  let app;
  const renders = [];
  let html = '';let answerValue;
  const textarea={get value(){return answerValue??'';},addEventListener(){}};
  const host = {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; renders.push(value); },
    querySelector: selector => selector==='h1'?{textContent:html.match(/<h1>(.*?)<\/h1>/)?.[1]}:selector==='#curator-answer'&&html.includes('id="curator-answer"')?textarea:null,
    querySelectorAll(selector) {
      if(selector==='[data-review]')return [...html.matchAll(/data-review="([^"]+)"/g)].map(([,id])=>({dataset:{review:id},addEventListener:(_,callback)=>buttons.set(`review-${id}`,callback)}));
      if (selector === '[data-curation]') return [...html.matchAll(/data-curation="(\d+)"/g)].map(([,id]) => ({
        dataset: { curation:id }, addEventListener: (_,callback) => buttons.set(`curation-${id}`,callback),
      }));
      return [...this.innerHTML.matchAll(/<button[^>]*data-action="([^"]+)"/g)]
        .filter(([, action]) => selector.includes(`data-action="${action}"`))
        .map(([, action]) => ({ addEventListener: (_, callback) => buttons.set(action, callback) }));
    },
  };
  const buttons = new Map();
  class AppStub {
    constructor() { app = this; }
    connect() {}
    sendMessage(request) { if(sendMessage)return sendMessage(request);throw new Error('Host activation unavailable'); }
    callServerTool(request) { if (callServerTool) return callServerTool(request); throw new Error('Lifecycle rendering must not call MCP'); }
  }
  const source = await fs.readFile(new URL('../../src/ui/main.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const document = { querySelector: () => host };
  vm.runInNewContext(code, {
    exports: {}, document, requestAnimationFrame, setTimeout,
    require: (id) => id === './card-disclosure.js' ? {mountCardDisclosure:()=>cardDisclosure} : id === '@modelcontextprotocol/ext-apps' ? { App: AppStub } : id.includes('applicability-label') ? applicabilityLabels : id.includes('contracts') ? contracts : id.includes('context-snapshot') ? snapshots : id.includes('presentation') ? presentation : {},
  });
  return {
    setAnswer(value){answerValue=value;},
    async key(key, extra={}) { await document.onkeydown?.({key,preventDefault(){},...extra}); return host.innerHTML; },
    get html() { return host.innerHTML; },
    get renders() { return [...renders]; },
    render(payload) { app.ontoolresult({ structuredContent: payload }); return host.innerHTML; },
    async clickAsync(action) { if (!buttons.has(action)) throw new Error(`Missing action: ${action}`); await buttons.get(action)(); return host.innerHTML; },
    click(action) { if (!buttons.has(action)) throw new Error(`Missing action: ${action}`); buttons.get(action)(); return host.innerHTML; },
  };
}

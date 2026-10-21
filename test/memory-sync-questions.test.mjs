import test from 'node:test';
import assert from 'node:assert/strict';
import {runMemorySync as run} from '../dist/core/memory-sync.js';
import {submitSemanticCuration,inspectSemanticCuration,curationAnswers} from '../dist/core/curation-semantic-jobs.js';
import {graphicalReviewAction} from '../dist/core/curation-graphical.js';
import {executeCurationReview} from '../dist/curation-review-adapter.js';
import {createMemoryBundleFixture,fixtureItem,observeFixture} from './helpers/memory-bundle-fixtures.mjs';
import {writeKnowledge,listKnowledge} from '../dist/core/memory.js';
import {listCheckpoints} from '../dist/core/storage.js';
import {knowledgeUi} from './helpers/knowledge-ui.mjs';
import {createServer,PRODERO_TOOLS as T} from '../dist/server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const action=(f,w,action,extra={})=>run(f.root,{action,workflowId:w.id,revision:w.revision,...extra});
const inspect=(f,w)=>run(f.root,{action:'inspect',workflowId:w.id});
async function fixture(t){const f=await createMemoryBundleFixture('fragmentation');t.after(f.cleanup);return f;}
const coverage=(s,disposition,body)=>s.clauses.map(c=>({clauseId:c.id,action:disposition==='proposed'?'preserved':disposition==='unchanged'?'retained':'unresolved',...(disposition==='proposed'?{outputKey:'out_main',start:0,end:body.length}:{}),grounding:[c.id],exceptions:c.protections.filter(p=>p.kind==='exception').map(p=>p.id),negations:c.protections.filter(p=>p.kind==='negation').map(p=>p.id),modality:c.protections.filter(p=>p.kind==='modality').map(p=>p.id)}));
function proposal(job,mode='unchanged'){
 const b=job.task.data,ids=b.expectedSources.map(s=>s.id),body=b.sources.map(s=>s.record.content).join('\n\n');
 const result={version:1,bundleId:b.id,sources:b.sources.map(s=>({sourceId:s.id,revision:s.revision,disposition:mode,outputKeys:mode==='proposed'?['out_main']:[],coverage:coverage(s,mode,body),rationale:'All source facts retained.'})),relations:[],outputs:mode==='proposed'?[{key:'out_main',title:'Queue behavior',body,sourceIds:ids,applicability:b.sources[0].record.applicability,grounding:ids,policyEffects:ids.map(sourceId=>({sourceId,kind:'unchanged'}))}]:[],issues:mode==='unresolved'?[{kind:'missing_fact',sourceIds:ids,missingFact:'Whether queue v2 is deployed.',why:'The deployment state is not established.',grounding:ids,question:{title:'Queue migration',prompt:'Has the migration to queue v2 completed?',choices:[{id:'yes',label:'Completed',meaning:'The queue v2 migration is complete.'},{id:'no',label:'Not completed',meaning:'The queue v2 migration is not complete.'}],allowFreeText:true},limitations:[]}]:[],answerInterpretations:b.answers.map(a=>({answerId:a.id,status:a.choice?'candidate':'ambiguous',fact:a.choice?.meaning??'Missing scope.',sourceIds:a.sourceIds,grounding:[a.id]})),additionalEvidenceRequired:[],rationale:'Review current queue knowledge.',limitations:[]};
 if(mode==='proposed'){
  result.outputs=[];
  for(const category of new Set(b.sources.map(s=>s.record.category))){
   const group=b.sources.filter(s=>s.record.category===category),key=`out_${category}`,body=group.map(s=>s.record.content).join('\n\n');
   result.outputs.push({key,title:`Queue ${category}`,body,sourceIds:group.map(s=>s.id),applicability:group[0].record.applicability,grounding:group.map(s=>s.id),policyEffects:group.map(s=>({sourceId:s.id,kind:'unchanged'}))});
   for(const row of result.sources.filter(s=>group.some(g=>g.id===s.sourceId))){row.outputKeys=[key];row.coverage=coverage(group.find(g=>g.id===row.sourceId),'proposed',body).map(c=>({...c,outputKey:key}));}
  }
 }
 return result;
}
async function prepare(f,w){return action(f,w,'prepare',{candidateId:w.next.candidateId});}
async function submit(f,w,mode){const j=w.curation.job;const result=await submitSemanticCuration(f.root,{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:proposal(j,mode)});assert.equal(result.status,'validated',result.validation);return inspect(f,w);}
const identity=v=>({reviewId:v.review.snapshot.reviewId,reviewRevisionId:v.review.snapshot.revision.id,planHash:v.review.snapshot.planHash,decisionRevision:v.review.state.revision,answerLogHash:v.graphical.answerLogHash});
async function questioned(f){let w=await run(f.root,{action:'start'});w=await action(f,w,'select',{improve:true,share:true});return submit(f,await prepare(f,w),'unresolved');}

test('operation defaults, empty rejection, improve-only and share-only keep one workflow',async t=>{
 for(const [improve,share]of [[true,true],[true,false],[false,true]]){const f=await fixture(t);let w=await run(f.root,{action:'start'});await assert.rejects(action(f,w,'select',{improve:false,share:false}),/Select Improve/);const id=w.id;w=await action(f,w,'select',{improve,share});assert.equal(w.id,id);assert.equal(w.promotionEnabled,share);assert.equal(w.state,improve?'semantic_work':'awaiting_promotion_selection');assert.equal(w.jobs.every(j=>j.selected===improve),true);assert.equal((await listKnowledge(f.root,'versioned')).length,0);}
 const f=await fixture(t);let w=await run(f.root,{action:'start'});w=await action(f,w,'select');assert.equal(w.improveEnabled,true);assert.equal(w.promotionEnabled,true);
});
test('bounded Curator result automatically improves eligible Local memory then enters same-session sharing',async t=>{
 const f=await fixture(t);let w=await run(f.root,{action:'start'});w=await prepare(f,await action(f,w,'select'));assert.ok(w.curation.job);const id=w.id;w=await submit(f,w,'proposed');assert.equal(w.state,'awaiting_promotion_selection');assert.equal(w.id,id);assert.equal(w.summary.archived,4);assert.equal((await listKnowledge(f.root,'versioned')).length,0);assert.equal((await listCheckpoints(f.root)).length,1);
 w=await action(f,w,'promotions',{ids:w.promotionCandidates.map(c=>c.id)});assert.equal(w.state,'awaiting_review');assert.equal(w.review.kind,'promotion');assert.equal(w.next.tool,T.sync);assert.equal(w.next.arguments.workflowId,w.id);assert.equal((await listKnowledge(f.root,'versioned')).length,0);await assert.rejects(action(f,w,'approve',{reviewId:'wrong',approved:true}));w=await action(f,w,'approve',{reviewId:w.review.reviewId,approved:true});assert.equal(w.state,'completed');assert.equal(w.id,id);assert.ok(w.summary.promoted);assert.equal((await inspect(f,w)).summary.promoted,w.summary.promoted);
});
test('real questions reuse Curator answers, reanalysis, and preserve exact answer before continuation',async t=>{
 const f=await fixture(t);let w=await questioned(f);assert.equal(w.state,'awaiting_clarification');assert.equal(w.next.tool,T.sync);assert.equal(w.next.arguments.workflowId,w.id);const v=w.clarification,q=v.graphical.questions[0],before=JSON.stringify(await listKnowledge(f.root));const saved=await graphicalReviewAction(f.root,{...identity(v),action:'answer',questionId:q.question.id,questionVersion:q.question.version,choiceId:'yes',requestId:'sync_answer'});assert.ok(saved.continuationJobId);assert.equal(JSON.stringify(await listKnowledge(f.root)),before);assert.equal((await curationAnswers(f.root,v.review.snapshot.revision.lineageId))[0].choice.id,'yes');
 const j=await inspectSemanticCuration(f.root,saved.continuationJobId),result=await submitSemanticCuration(f.root,{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:proposal(j,'unchanged')});assert.equal(result.status,'validated');w=await inspect(f,w);assert.equal(w.state,'awaiting_promotion_selection');assert.equal(w.clarification,undefined);assert.equal(w.summary.unresolved,0);
});
test('deferral leaves original knowledge and continues independent work then sharing',async t=>{
 const f=await fixture(t),ids=Array.from({length:4},(_,i)=>`mem_billing_${i}`);for(const id of ids)await writeKnowledge(f.root,fixtureItem(id,{scopeRef:'src/billing',title:'Billing state',content:'Billing queues preserve ordering.'}),false,'local');await observeFixture(f.root,ids,3);await observeFixture(f.root,ids,4);
 let w=await questioned(f);const first=w.jobs.find(j=>j.status==='awaiting_clarification'),v=w.clarification,q=v.graphical.questions[0];await graphicalReviewAction(f.root,{...identity(v),action:'question_later',questionId:q.question.id,questionVersion:q.question.version});w=await inspect(f,w);assert.equal(w.state,'semantic_work');assert.equal(w.jobs.find(j=>j.id===first.id).status,'deferred');w=await submit(f,await prepare(f,w),'unchanged');assert.equal(w.state,'awaiting_promotion_selection');assert.equal(w.summary.questionsDeferred,1);assert.ok((await listKnowledge(f.root)).some(i=>i.id===first.sourceIds[0]));const again=await inspect(f,w);assert.equal(again.summary.questionsDeferred,1);
});
test('scoped Sync analysis cannot be applied through protected Curator executor',async t=>{
 const f=await fixture(t);let w=await run(f.root,{action:'start'});w=await prepare(f,await action(f,w,'select'));const j=w.curation.job,result=await submitSemanticCuration(f.root,{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:proposal(j,'proposed')}),r=result.review;await assert.rejects(executeCurationReview(f.root,{reviewId:r.snapshot.reviewId,planHash:r.snapshot.planHash,decisionRevision:r.state.revision,selectedIds:r.snapshot.plan.proposals.map(p=>p.id)}),/read-only/);assert.equal((await listCheckpoints(f.root)).length,0);
});
async function mcp(t,f){const server=createServer({projectRoot:f.root}),client=new Client({name:'sync-questions',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});return (name,args={})=>client.callTool({name,arguments:{projectRoot:f.root,...args}});}
test('entry has two enabled operations, no planner controls and rejects both disabled in UI',async t=>{
 const f=await fixture(t),call=await mcp(t,f),calls=[],ui=await knowledgeUi(req=>{calls.push(req);return call(req.name,req.arguments);});ui.render(await call(T.sync));assert.equal(ui.host.querySelector('#sync-improve-choice').checked,true);assert.equal(ui.host.querySelector('#sync-promotion-choice').checked,true);assert.doesNotMatch(ui.html.split('<details')[0],/Area |fragmentation|context pressure|related memories|data-sync-candidate/);ui.check('#sync-improve-choice',false);ui.check('#sync-promotion-choice',false);assert.equal(ui.host.querySelector('[data-memory-sync="select"]').disabled,true);await ui.sync('select');assert.equal(calls.length,0);ui.check('#sync-promotion-choice',true);await ui.sync('select');assert.equal(calls[0].arguments.request.improve,false);assert.equal(calls[0].arguments.request.share,true);assert.match(ui.html,/Review Local knowledge for sharing/);
});
test('Sync question UI sends existing Curator answer and returns to the same Sync operation',async t=>{
 const f=await fixture(t),w=await questioned(f),call=await mcp(t,f),calls=[],messages=[],ui=await knowledgeUi(req=>{calls.push(req);return call(req.name,req.arguments);},m=>{messages.push(m);return {};});ui.render({structuredContent:{ok:true,action:'memory-sync',result:w}});assert.match(ui.html,/Has the migration to queue v2 completed/);assert.doesNotMatch(ui.html.split('<details')[0],/Review ready changes|View all changes|Current ·/);await ui.review('answer:yes');assert.ok(calls.some(c=>c.name===T.curationReview&&c.arguments.action==='answer'));assert.ok(calls.some(c=>c.name===T.memorySync&&c.arguments.request.action==='inspect'));assert.match(messages[0].content[0].text,new RegExp(w.id));assert.match(ui.html,/Answer saved · awaiting agent analysis/);assert.doesNotMatch(ui.html,/Apply [0-9]/);
});

test('initial and answered pending jobs do not ask fabricated questions; inspection is stable',async t=>{
 const f=await fixture(t);let w=await prepare(f,await action(f,await run(f.root,{action:'start'}),'select',{improve:true,share:false}));w=await inspect(f,w);assert.equal(w.state,'semantic_work');assert.equal(w.clarification,undefined);assert.equal((await inspect(f,w)).revision,w.revision);
});
test('Shared sources and protected Local knowledge never enter automatic transformation writes',async t=>{
 const f=await createMemoryBundleFixture('mixed');t.after(f.cleanup);let w=await run(f.root,{action:'start'});w=await prepare(f,await action(f,w,'select',{improve:true,share:false}));const before=JSON.stringify(await listKnowledge(f.root,'versioned'));w=await submit(f,w,'unchanged');assert.equal(w.state,'completed');assert.equal(JSON.stringify(await listKnowledge(f.root,'versioned')),before);assert.equal(w.summary.versionedArchived,0);
 const protectedFixture=await createMemoryBundleFixture('protected');t.after(protectedFixture.cleanup);let p=await run(protectedFixture.root,{action:'start'});p=await prepare(protectedFixture,await action(protectedFixture,p,'select',{improve:true,share:false}));const originals=await listKnowledge(protectedFixture.root);p=await submit(protectedFixture,p,'proposed');for(const i of originals.filter(i=>['instruction','principle','invariant','constraint','decision'].includes(i.category)))assert.deepEqual((await listKnowledge(protectedFixture.root)).find(k=>k.id===i.id),i);assert.equal(p.state,'completed');
});
test('modern Local commit resumes exactly once after workflow checkpoint failure',async t=>{
 const fs=(await import('node:fs/promises')).default,f=await fixture(t);let w=await prepare(f,await action(f,await run(f.root,{action:'start'}),'select',{improve:true,share:false}));const j=w.curation.job;assert.equal((await submitSemanticCuration(f.root,{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:proposal(j,'proposed')})).status,'validated');
 const rename=fs.rename;fs.rename=async(from,to)=>{if(String(to).endsWith('/local/memory-sync.json')&&(await fs.readFile(from,'utf8')).includes('"state":"completed"'))throw new Error('Injected interruption');return rename(from,to);};try{await assert.rejects(inspect(f,w),/Injected interruption/);}finally{fs.rename=rename;}
 const before=JSON.stringify(await listKnowledge(f.root));w=await inspect(f,w);assert.equal(w.state,'completed');assert.equal(w.summary.archived,4);assert.equal((await listCheckpoints(f.root)).length,1);assert.equal(JSON.stringify(await listKnowledge(f.root)),before);assert.equal((await inspect(f,w)).revision,w.revision);
});
test('external source edit makes Sync stale without applying a prepared result',async t=>{
 const fs=(await import('node:fs/promises')).default,f=await fixture(t);let w=await prepare(f,await action(f,await run(f.root,{action:'start'}),'select'));await fs.appendFile(`${f.root}/.prodero/local/memory/mem_driving_00.md`,'\nNew source fact.');w=await inspect(f,w);assert.equal(w.state,'stale');assert.equal((await listCheckpoints(f.root)).length,0);
});

test('Answer later in Sync UI automatically dispatches independent work without starting a second workflow',async t=>{
 const f=await fixture(t),ids=Array.from({length:4},(_,i)=>`mem_billing_${i}`);for(const id of ids)await writeKnowledge(f.root,fixtureItem(id,{scopeRef:'src/billing',title:'Billing state',content:'Billing queues preserve ordering.'}),false,'local');await observeFixture(f.root,ids,3);await observeFixture(f.root,ids,4);
 const w=await questioned(f),call=await mcp(t,f),messages=[],ui=await knowledgeUi(req=>call(req.name,req.arguments),m=>{messages.push(m);return {};});ui.render({structuredContent:{ok:true,action:'memory-sync',result:w}});await ui.review('question-later');assert.equal(messages.length,1);assert.match(messages[0].content[0].text,new RegExp(w.id));assert.match(ui.html,/Analysis queued/);assert.doesNotMatch(ui.html.split('<details')[0],/Has the migration|Start curation/);const saved=await inspect(f,w);assert.equal(saved.id,w.id);assert.equal(saved.state,'semantic_work');assert.equal(saved.summary.questionsDeferred,1);
});

test('unavailable host continuation leaves a saved answer and a copyable Sync continuation',async t=>{
 const f=await fixture(t),w=await questioned(f),call=await mcp(t,f),ui=await knowledgeUi(req=>call(req.name,req.arguments),()=>{throw new Error('Unavailable');});ui.render({structuredContent:{ok:true,action:'memory-sync',result:w}});await ui.review('answer:yes');assert.match(ui.html,/Automatic continuation is unavailable/);assert.match(ui.html,/Continue prepared Curator reasoning job/);assert.match(ui.html,new RegExp(w.id));assert.equal((await curationAnswers(f.root,w.clarification.review.snapshot.revision.lineageId)).length,1);assert.equal((await listCheckpoints(f.root)).length,0);
});

test('Sync and Curator share project identity across a symlinked workspace path',async t=>{
 const fs=(await import('node:fs/promises')).default,os=await import('node:os'),path=await import('node:path'),f=await fixture(t),parent=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-sync-alias-')),alias=path.join(parent,'project');t.after(()=>fs.rm(parent,{recursive:true,force:true}));await fs.symlink(f.root,alias,'dir');let w=await run(alias,{action:'start'});w=await action(f,w,'select',{improve:true,share:false});w=await prepare(f,w);const j=w.curation.job;assert.equal((await submitSemanticCuration(alias,{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:proposal(j,'unchanged')})).status,'validated');w=await inspect(f,w);assert.equal(w.state,'completed');assert.equal(w.summary.areasFailed,0);
});

test('reasoning tools recover Sync ownership and hand off unresolved facts to its question form',async t=>{
 const f=await fixture(t),call=await mcp(t,f);
 let w=await prepare(f,await action(f,await run(f.root,{action:'start'}),'select'));
 const j=w.curation.job;
 const prepared=(await call(T.curationReasoningPrepare,{jobId:j.jobId})).structuredContent;
 assert.equal(prepared.next.tool,T.memorySync);
 assert.equal(prepared.next.arguments.request.workflowId,w.id);
 const submitted=(await call(T.curationReasoningPropose,{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:proposal(j,'unresolved')})).structuredContent;
 assert.equal(submitted.result.status,'validated');
 assert.equal(submitted.next.arguments.request.workflowId,w.id);
 const inspected=(await call(submitted.next.tool,submitted.next.arguments)).structuredContent.result;
 assert.equal(inspected.next.tool,T.sync);
 const opened=await call(inspected.next.tool,inspected.next.arguments);
 const messages=[],ui=await knowledgeUi(req=>call(req.name,req.arguments),m=>{messages.push(m);return {};});
 ui.render(opened);
 const answer='Во время разработки prod-шаблоны обновлять не нужно: их обновляет production pipeline при деплое.';
 ui.host.querySelector('#curator-answer').value=answer;
 await ui.review('answer-free');
 const resumed=await inspect(f,w),job=await inspectSemanticCuration(f.root,resumed.clarification.graphical.continuationJobId);
 assert.equal(job.task.data.answers.length,1);
 assert.equal(job.task.data.answers[0].rawText,answer);
 assert.match(messages[0].content[0].text,new RegExp(w.id));
 assert.match(messages[0].content[0].text,/next.tool/);
 assert.equal((await listCheckpoints(f.root)).length,0);
 assert.equal((await listKnowledge(f.root,'versioned')).length,0);
});

test('failed answer analysis in Sync offers retry and defer instead of a pending dead end',async t=>{
 const f=await fixture(t),w=await questioned(f),v=w.clarification,q=v.graphical.questions[0];
 const saved=await graphicalReviewAction(f.root,{...identity(v),action:'answer',questionId:q.question.id,questionVersion:q.question.version,choiceId:'yes',requestId:'failure-answer'});
 const job=await inspectSemanticCuration(f.root,saved.continuationJobId),bad=proposal(job);bad.approved=true;
 await submitSemanticCuration(f.root,{jobId:job.jobId,inputHash:job.job.input.inputHash,proposal:bad});
 const failed=await inspect(f,w);assert.equal(failed.state,'awaiting_clarification');assert.equal(failed.clarification.graphical.analysisPending,false);
 const call=await mcp(t,f),ui=await knowledgeUi(req=>call(req.name,req.arguments));ui.render({structuredContent:{ok:true,action:'memory-sync',result:failed}});
 assert.match(ui.html,/Try again/);assert.doesNotMatch(ui.html,/Reviewing your answer/);
 await ui.review('pending-later');
 const next=await inspect(f,w);assert.equal(next.state,'awaiting_promotion_selection');assert.equal(next.summary.questionsDeferred,1);
 assert.equal((await curationAnswers(f.root,v.review.snapshot.revision.lineageId)).length,1);
});

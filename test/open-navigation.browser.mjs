// Explicit optional acceptance: see live-app-browser.mjs. Never targets real memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {liveBrowserHarness} from './helpers/live-app-browser.mjs';
import {writeKnowledge,listKnowledge} from '../dist/core/memory.js';
import {createCurationReview} from '../dist/core/curation-review.js';
import {createProjectSkill,createSkillCandidate} from '../dist/core/skills.js';
import {sha256} from '../dist/core/storage.js';
let h;test.before(async()=>{h=await liveBrowserHarness();});test.after(async()=>{await h?.close();});
const item=(id,title='Harbor '+id)=>({version:3,id,category:'state',contextPolicy:'relevant',authority:'inferred',applicability:{kind:'legacy'},scope:'global',scopeRef:null,priority:'normal',status:'active',title,content:'Isolated Harbor source evidence for '+id+'.',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[]});
const seed=async(root,n=15)=>{for(let i=0;i<n;i++)await writeKnowledge(root,item('mem_local_'+i,'Harbor record '+String(i).padStart(2,'0')),false,'local');};
const button=(kind,action)=>`button[data-${kind}-action="${action}"]`;
const fixture=async(t,name,opts)=>{const f=await h.fixture(name,opts);t.after(()=>f.close());return f;};

test('Open inventory, details, Appearance save/reset/error, responsive empty sections and conditional update',async t=>{
 const f=await fixture(t,'open-settings'),p=f.page;await f.open();
 await f.check('Open/Appearance inventory and no moderation queue',async()=>{
  const actions=await p.locator('button[data-action]').evaluateAll(es=>es.map(e=>e.dataset.action));assert.deepEqual(actions,['knowledge','skills','curate','share']);
  await p.locator('summary').filter({hasText:'Project details'}).click();assert.doesNotMatch(await p.locator('main').innerText(),/deferred questions|unapplied change groups|Check memory improvements/i);await f.shot('open-details');
  await p.locator('.theme-picker > summary').click();await p.locator('input[name="prodero-theme"][value="pink-neon"]').click();await f.settle();assert.equal(await p.locator('html').getAttribute('data-prodero-theme'),'pink-neon');
  await f.click('#theme-reset');assert.equal(await p.locator('html').getAttribute('data-prodero-theme'),'prodero');
  f.failure={tool:'prodero_config_set',message:'TEST_TRANSPORT_FAILURE: theme save interrupted.'};await p.locator('input[name="prodero-theme"][value="light"]').click();await f.settle();assert.equal(await p.locator('html').getAttribute('data-prodero-theme'),'prodero');assert.match(await p.locator('#theme-persistence').innerText(),/interrupted/);await f.shot('theme-error');
 });
 await f.check('empty Knowledge / Curate / sharing / Skills back paths',async()=>{
  await f.click('button[data-action="knowledge"]');assert.match(await p.locator('main').innerText(),/No knowledge matches|No knowledge yet/);await f.click(button('knowledge','back'));
  await f.click('button[data-action="curate"]');assert.match(await p.locator('main').innerText(),/No supported protected-knowledge changes/);await f.click(button('curate','back'));
  await f.click('button[data-action="share"]');assert.equal(await p.locator('input[data-share-id]').count(),0);assert.equal(await p.locator(button('knowledge','promote-selected')).count(),0);await f.click(button('knowledge','back'));
  await f.click('button[data-action="skills"]');assert.match(await p.locator('main').innerText(),/Project Skills/);await f.click(button('skills','back'));
  await p.setViewportSize({width:390,height:780});await f.shot('mobile-open');assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
 });
 await f.check('conditional update is instructions only',async()=>{
  const opened=await f.call('prodero_open');opened.structuredContent.update={...opened.structuredContent.update,available:true,latest:'fixture-only'};await f.render(opened);await f.click('button[data-action="update"]');assert.match(await p.locator('main').innerText(),/terminal|prodero update/);assert.ok(f.calls.some(c=>c.name==='prodero_update'));await f.shot('update-instructions');
 });
});

test('Knowledge real search/filter/pagination/detail return, edit/cancel/stale/reload and retire',async t=>{
 const f=await fixture(t,'knowledge'),p=f.page;await seed(f.root);await writeKnowledge(f.root,item('mem_shared','Shared fixture'),false,'versioned');await f.open();await f.click('button[data-action="knowledge"]');
 let selected;
 await f.check('search, Local filter, next/detail/back retain exact page and selection',async()=>{
  await p.locator('#knowledge-search-form input[name="query"]').fill('Harbor');await p.locator('#knowledge-search-form select[name="layer"]').selectOption('local');await p.locator('#knowledge-search-form').evaluate(e=>e.requestSubmit());await f.settle();
  await f.click(button('knowledge','next'));selected=await p.locator('button[data-knowledge-action="view"]').first().getAttribute('data-id');await f.click(`button[data-knowledge-action="view"][data-id="${selected}"]`);assert.match(await p.locator('.knowledge-detail').innerText(),new RegExp(selected));await f.shot('detail');
  await f.click(button('knowledge','list'));assert.equal(await p.locator('button[data-knowledge-action="view"]').first().getAttribute('data-id'),selected);assert.equal(await p.locator('#knowledge-search-form input[name="query"]').inputValue(),'Harbor');
 });
 await f.check('edit preview/cancel, stale revision keeps draft, reload and exact Apply',async()=>{
  await f.click(`button[data-knowledge-action="view"][data-id="${selected}"]`);await f.click(button('knowledge','edit'));await p.locator('#knowledge-edit-form textarea[name="content"]').fill('User fixture draft is retained.');await p.locator('#knowledge-edit-form').evaluate(e=>e.requestSubmit());await f.settle();await f.click(button('knowledge','cancel-confirm'));assert.equal(await p.locator('#knowledge-edit-form textarea[name="content"]').inputValue(),'User fixture draft is retained.');
  await p.locator('#knowledge-edit-form').evaluate(e=>e.requestSubmit());await f.settle();const current=(await listKnowledge(f.root,'local')).find(i=>i.id===selected);await writeKnowledge(f.root,{...current,content:'External fixture revision wins until reviewed.'},false,'local');await f.click(button('knowledge','confirm'));assert.match(await p.locator('main').innerText(),/changed|revision|reload/i);assert.equal((await listKnowledge(f.root,'local')).find(i=>i.id===selected).content,'External fixture revision wins until reviewed.');await f.shot('stale-edit');
  await f.click(button('knowledge','reload'));await f.click(button('knowledge','edit'));await p.locator('#knowledge-edit-form textarea[name="content"]').fill('Final reviewed fixture change.');await p.locator('#knowledge-edit-form').evaluate(e=>e.requestSubmit());await f.settle();await f.click(button('knowledge','confirm'));assert.equal((await listKnowledge(f.root,'local')).find(i=>i.id===selected).content,'Final reviewed fixture change.');
  await f.click(button('knowledge','retire'));await f.click(button('knowledge','cancel-confirm'));await f.click(button('knowledge','retire'));await f.click(button('knowledge','confirm'));assert.equal((await listKnowledge(f.root,'local')).find(i=>i.id===selected).status,'deprecated');await f.click(button('knowledge','back'));
 });
 await f.check('category/scope/path/history controls preserve their exact filter and empty-state route',async()=>{
  await writeKnowledge(f.root,item('mem_path','Harbor scoped fixture'),false,'local');const scoped=(await listKnowledge(f.root,'local')).find(i=>i.id==='mem_path');await writeKnowledge(f.root,{...scoped,scope:'module',scopeRef:'fixtures/harbor',scopeKind:'path',applicability:{kind:'scoped',paths:['fixtures/harbor']}},false,'local');await f.click('button[data-action="knowledge"]');
  const form=p.locator('#knowledge-search-form');await form.locator('[name="query"]').fill('Harbor');await form.locator('[name="category"]').selectOption('state');await form.locator('[name="scope"]').selectOption('path');await form.locator('[name="path"]').fill('fixtures/harbor');await form.evaluate(e=>e.requestSubmit());await f.settle();assert.equal(await p.locator('button[data-knowledge-action="view"]').count(),1);assert.equal(await p.locator('button[data-knowledge-action="view"]').getAttribute('data-id'),'mem_path');await f.shot('filters');
  await p.locator('#knowledge-search-form [name="query"]').fill('no-matching-zircon');await p.locator('#knowledge-search-form').evaluate(e=>e.requestSubmit());await f.settle();assert.match(await p.locator('main').innerText(),/No knowledge matches/);
  await p.locator('#knowledge-search-form [name="query"]').fill('Harbor');await p.locator('#knowledge-search-form [name="scope"]').selectOption('');await p.locator('#knowledge-search-form [name="path"]').fill('');await p.locator('#knowledge-search-form [name="history"]').selectOption('all');await p.locator('#knowledge-search-form').evaluate(e=>e.requestSubmit());await f.settle();assert.equal(f.calls.filter(c=>c.name==='prodero_knowledge').at(-1).args.includeHistorical,true);await f.click(button('knowledge','back'));
 });
});

test('Local selection survives pages/cancel and stale preview; approved sharing clears selection',async t=>{
 const f=await fixture(t,'sharing'),p=f.page;await seed(f.root);await f.open();await f.click('button[data-action="share"]');let a,b;
 await f.check('exact selection across pages and cancel',async()=>{
  a=await p.locator('input[data-share-id]').first().getAttribute('data-share-id');await p.locator(`input[data-share-id="${a}"]`).check();await f.settle();await f.click(button('knowledge','next'));b=await p.locator('input[data-share-id]').first().getAttribute('data-share-id');await p.locator(`input[data-share-id="${b}"]`).check();await f.settle();await f.click(button('knowledge','promote-selected'));
  const request=f.calls.filter(c=>c.name==='prodero_promotion_preview').at(-1);assert.deepEqual(request.args.ids.sort(),[a,b].sort());assert.equal(request.args.includeAll,undefined);await f.shot('preview');await f.click(button('promotion','cancel'));assert.match(await p.locator(button('knowledge','promote-selected')).innerText(),/2 selected/);
 });
 await f.check('stale proposal rejects without losing sources; new preview Apply confirms and clears selection',async()=>{
  await f.click(button('knowledge','promote-selected'));const old=(await listKnowledge(f.root,'local')).find(i=>i.id===a);await writeKnowledge(f.root,{...old,content:old.content+' New fixture revision.'},false,'local');await f.click(button('promotion','publish'));assert.match(await p.locator('main').innerText(),/changed|stale|review/i);assert.equal((await listKnowledge(f.root,'versioned')).length,0);await f.shot('stale-preview');await f.click(button('promotion','cancel'));
  await f.click(button('knowledge','promote-selected'));await f.click(button('promotion','publish'));assert.equal((await listKnowledge(f.root,'versioned')).length,2);assert.match(await p.locator('main').innerText(),/Wrote 2 Versioned/);assert.equal(await p.locator('input[data-share-id]:checked').count(),0);assert.equal(await p.locator(button('knowledge','promote-selected')).count(),0);await f.shot('applied');await f.click(button('knowledge','back'));
 });
});

test('Curate fresh preview preserves unsupported history and exact approval survives stale recovery',async t=>{
 const f=await fixture(t,'curation'),p=f.page;const rule={...item('mem_rule','Export testing'),category:'instruction',contextPolicy:'required',authority:'legacy_inherited',content:'Decision:\nCedarAPI tests must isolate exports.\n\nImpact:\nNever call real exports.'};await writeKnowledge(f.root,rule);
 const historical=await createCurationReview(f.root),file=path.join(f.root,'.prodero/local/curation-reviews',historical.snapshot.reviewId+'.json'),snapshot=JSON.parse(await fs.readFile(file,'utf8'));snapshot.revision.version=99;const {snapshotHash,...body}=snapshot;snapshot.snapshotHash=sha256(JSON.stringify(body));await fs.writeFile(file,JSON.stringify(snapshot));const bytes=await fs.readFile(file,'utf8');await f.open();
 await f.check('Open with unsupported saved revision, fresh unselected choices and complete preview',async()=>{
  assert.doesNotMatch(await p.locator('main').innerText(),/Review revision is invalid/);await f.click('button[data-action="curate"]');assert.match(await p.locator('main').innerText(),/older reviews.*preserved/);await f.click(button('curate','create'));assert.equal(await p.locator('input[data-curate-unit]:checked').count(),0);assert.equal(await p.locator(button('curate','apply')).count(),0);await p.locator('input[data-curate-unit]:enabled').first().check();await f.settle();await f.click(button('curate','preview'));await f.shot('review');
 });
 await f.check('stale Apply is visible, fresh review requires selection again and Apply confirms',async()=>{
  await writeKnowledge(f.root,{...rule,content:rule.content+'\nPreserve export traces.'});await f.click(button('curate','apply'));assert.match(await p.locator('main').innerText(),/changed|stale/i);assert.doesNotMatch(await p.locator('.message').innerText(),/^Applied/);await f.shot('stale');
  await f.click(button('curate','fresh'));await f.click(button('curate','create'));await p.locator('input[data-curate-unit]:enabled').first().check();await f.settle();await f.click(button('curate','preview'));await f.click(button('curate','apply'));assert.match(await p.locator('.message').innerText(),/Applied \d+ reviewed change/);assert.equal(await fs.readFile(file,'utf8'),bytes);await f.shot('applied');await f.click(button('curate','back'));
  const rejected=await f.raw('prodero_curation_review',{action:'inspect',reviewId:historical.snapshot.reviewId});assert.equal(rejected.isError,true);
 });
});

test('Skills create/cancel/error form preservation and candidate preview/edit/approval/dismiss',async t=>{
 const f=await fixture(t,'skills'),p=f.page;await f.open();await f.click('button[data-action="skills"]');
 await f.check('create/cancel and failed save retain procedure before successful create',async()=>{
  await f.click(button('skills','create'));await p.locator('#skill-form [name="title"]').fill('Harbor user procedure');await f.click(button('skills','cancel'));assert.equal(await p.locator('#skill-form').count(),0);await f.click(button('skills','create'));
  for(const [k,v]of Object.entries({title:'Harbor user procedure',description:'Isolated authoring procedure',content:'Keep this exact authored procedure.',scope:'project'}))await p.locator(`#skill-form [name="${k}"]`).fill(v);
  f.failure={tool:'prodero_skill_create',message:'TEST_TRANSPORT_FAILURE: create failed before save.'};await p.locator('#skill-form').evaluate(e=>e.requestSubmit());await f.settle();assert.equal(await p.locator('#skill-form [name="content"]').inputValue(),'Keep this exact authored procedure.');assert.match(await p.locator('.message').innerText(),/failed before save/);await f.shot('failed-form');await p.locator('#skill-form').evaluate(e=>e.requestSubmit());await f.settle();assert.match(await p.locator('main').innerText(),/Active project skill saved/);
 });
 await f.check('candidate preview/cancel/edit and real Add Skill approval',async()=>{
  const candidate=await createSkillCandidate(f.root,{title:'Harbor proposed procedure',description:'A distinct fixture candidate',content:'Check the Harbor fixture before running export checks.'},{sessionId:'sess_fixture_skill',derivedFrom:'obs_fixture_skill'});await f.click(button('skills','back'));await f.click('button[data-action="skills"]');await f.click(`button[data-skill="${candidate.skill.id}"][data-review="get"]`);await f.click(`button[data-skill="${candidate.skill.id}"][data-review="preview"]`);await f.shot('preview');await f.click(button('skills','cancel-preview'));
  await f.click(`button[data-skill="${candidate.skill.id}"][data-review="preview"]`);await f.click(button('skills','edit'));await p.locator('#skill-form [name="content"]').fill('Check Harbor fixture and preserve the reviewed procedure.');await p.locator('#skill-form').evaluate(e=>e.requestSubmit());await f.settle();await f.click(button('skills','approve'));assert.match(await p.locator('main').innerText(),/Active project skill (added|updated)/);await f.shot('approved');
  const dismissed=await createSkillCandidate(f.root,{title:'Harbor discard procedure',description:'Separate candidate',content:'Inspect a different Harbor fixture.'},{sessionId:'sess_fixture_skill',derivedFrom:'obs_fixture_other'});await f.click(button('skills','back'));await f.click('button[data-action="skills"]');await f.click(`button[data-skill="${dismissed.skill.id}"][data-review="dismiss"]`);assert.match(await p.locator('.message').innerText(),/dismissed/);await f.click(button('skills','back'));
 });
 await f.check('active Curate/cancel and stale candidate approval preserve original procedures',async()=>{
  await f.click('button[data-action="skills"]');const active=await p.locator('button[data-review="recurate"]').first().getAttribute('data-skill');await f.click(`button[data-skill="${active}"][data-review="recurate"]`);assert.equal(await p.locator(button('skills','cancel-preview')).count(),1);await f.shot('active-curate');await f.click(button('skills','cancel-preview'));
  const stale=await createSkillCandidate(f.root,{title:'Harbor stale candidate',description:'Concurrent fixture candidate',content:'Check the Harbor stale fixture in isolation.'},{sessionId:'sess_fixture_skill',derivedFrom:'obs_fixture_stale'});await f.click(button('skills','back'));await f.click('button[data-action="skills"]');await f.click(`button[data-skill="${stale.skill.id}"][data-review="preview"]`);
  await f.call('prodero_skill_review',{id:stale.skill.id,action:'dismiss'});await f.click(button('skills','approve'));assert.match(await p.locator('.message').innerText(),/changed|stale|candidate|dismissed/i);assert.doesNotMatch(await p.locator('.message').innerText(),/Active project skill added/);await f.shot('stale-approval');await f.click(button('skills','cancel-preview'));await f.click(button('skills','back'));
 });
 await f.check('Skills next/first retain selection; conditional covered capability is recorded separately',async()=>{
  const input={title:'Harbor covered procedure',description:'Existing identical procedure',content:'Preserve the identical Harbor procedure.'};const covered=await createSkillCandidate(f.root,input,{sessionId:'sess_fixture_skill',derivedFrom:'obs_fixture_covered'});const created=await createProjectSkill(f.root,input);
  for(let n=0;n<21;n++)await createProjectSkill(f.root,{title:'Paged Harbor '+n,description:'Paging fixture '+n,content:'Inspect independent Harbor page '+n+'.'});
  await f.click('button[data-action="skills"]');const first=await p.locator('button[data-review="get"]').first().getAttribute('data-skill');await f.click(button('skills','next'));assert.notEqual(await p.locator('button[data-review="get"]').first().getAttribute('data-skill'),first);await f.click(button('skills','first'));assert.equal(await p.locator('button[data-review="get"]').first().getAttribute('data-skill'),first);
  for(let page=0;page<4&&!await p.locator(`button[data-skill="${covered.skill.id}"][data-review="preview"]`).count();page++)await f.click(button('skills','next'));await f.click(`button[data-skill="${covered.skill.id}"][data-review="preview"]`);if(await p.locator(button('skills','inspect-existing')).count()){await f.shot('covered');await f.click(button('skills','inspect-existing'));assert.equal(f.calls.filter(c=>c.name==='prodero_skills').at(-1).args.id,created.id);assert.ok((await p.locator('main').innerText()).includes(created.title));h.cases.push({section:'skills',check:'covered-candidate Inspect existing',status:'passed'});}else{h.cases.push({section:'skills',check:'covered-candidate Inspect existing under actual reasoning provider',status:'not-run',reason:'The isolated client has no sampling provider; actual deterministic preview has no covered disposition. No synthetic approval token or model result is injected.'});await f.shot('deterministic-preview');await f.click(button('skills','cancel-preview'));}await f.click(button('skills','back'));
 });
});

test('onboarding Initialize errors are visible and repeat does not fabricate initialization',async t=>{
 const f=await fixture(t,'onboarding',{initialized:false}),p=f.page;await f.open();
 await f.check('failed Initialize remains visible and allows retry',async()=>{f.failure={tool:'prodero_initialize',message:'TEST_TRANSPORT_FAILURE: initialization refused.'};await f.click('button[data-action="init"]');assert.match(await p.locator('main').innerText(),/initialization refused/);await f.shot('init-error');await f.click('button[data-action="init"]');assert.equal(await p.locator('button[data-action="knowledge"]').count(),1);await f.shot('initialized');});
});

test('migration entry reviews and resumes real Open; unsupported future schema has no Apply',async t=>{
 const f=await fixture(t,'migration'),p=f.page,file=path.join(f.root,'.prodero/config.json');let config=JSON.parse(await fs.readFile(file,'utf8'));config.schemaVersion=7;await fs.writeFile(file,JSON.stringify(config));await f.open();
 await f.check('reviewed migration Apply preserves data and resumes Open',async()=>{assert.equal(await p.locator('button[data-action="migration-0"]').count(),1);await f.shot('review');await f.click('button[data-action="migration-0"]');assert.equal(await p.locator('button[data-action="knowledge"]').count(),1);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).schemaVersion,8);await f.shot('resumed');});
 await f.check('future schema cannot be silently migrated',async()=>{config=JSON.parse(await fs.readFile(file,'utf8'));config.schemaVersion=99;await fs.writeFile(file,JSON.stringify(config));await f.open();assert.match(await p.locator('main').innerText(),/newer|Update Curator/i);assert.equal(await p.locator('button[data-action="migration-0"]').count(),0);await f.shot('unsupported');});
});

test('publication receipt remains visible when only post-commit refresh fails',async t=>{
 const f=await fixture(t,'publication-refresh'),p=f.page;await seed(f.root,1);await f.open();await f.click('button[data-action="share"]');await p.locator('input[data-share-id]').check();await f.settle();await f.click(button('knowledge','promote-selected'));
 await f.check('Apply result survives refresh error without offering a second Apply',async()=>{f.failure={tool:'prodero_knowledge',message:'TEST_TRANSPORT_FAILURE: list refresh unavailable.'};await f.click(button('promotion','publish'));assert.equal((await listKnowledge(f.root,'versioned')).length,1);assert.match(await p.locator('main').innerText(),/Wrote 1 Versioned/);assert.match(await p.locator('main').innerText(),/List refresh failed/);assert.match(await p.locator('main').innerText(),/Showing cached results/);assert.equal(await p.locator('input[data-share-id]').count(),0);assert.equal(await p.locator(button('promotion','publish')).count(),0);await f.shot('receipt-error');await f.click(button('knowledge','list'));assert.doesNotMatch(await p.locator('main').innerText(),/Showing cached results/);assert.equal(f.calls.filter(c=>c.name==='prodero_promote').length,1);});
});

test('initial backend storage error is visible without a blank App or fabricated onboarding',async t=>{
 const f=await fixture(t,'initial-error'),p=f.page;await fs.writeFile(path.join(f.root,'.prodero/config.json'),'{invalid fixture config');
 await f.check('real Open error produces an explicit alert',async()=>{const result=await f.raw('prodero_open');assert.equal(result.isError,true);await f.render(result);assert.match(await p.locator('h1').innerText(),/unavailable/);assert.equal(await p.locator('[role="alert"]').count(),1);assert.equal(await p.locator('button[data-action="init"]').count(),0);await f.shot('storage-error');});
});

test('first child read failure cannot masquerade as empty memory or no curation changes',async t=>{
 const f=await fixture(t,'child-read-errors'),p=f.page;await seed(f.root,1);await f.open();
 await f.check('Knowledge/sharing failure shows unavailable, no zero counters or selectable invented data',async()=>{
  for(const action of ['knowledge','share']){f.failure={tool:'prodero_knowledge',message:'TEST_TRANSPORT_FAILURE: initial catalogue read failed.'};await f.click(`button[data-action="${action}"]`);assert.match(await p.locator('main').innerText(),/catalogue is unavailable/);assert.doesNotMatch(await p.locator('main').innerText(),/No knowledge yet|Knowledge: 0/);assert.equal(await p.locator('input[data-share-id]').count(),0);await f.shot(action);await f.click(button('knowledge','list'));assert.equal(await p.locator('button[data-knowledge-action="view"]').count(),1);await f.click(button('knowledge','back'));}
 });
 await f.check('Curate read failure is distinct from a successful empty plan and can retry',async()=>{f.failure={tool:'prodero_curation',message:'TEST_TRANSPORT_FAILURE: initial preview read failed.'};await f.click('button[data-action="curate"]');assert.match(await p.locator('main').innerText(),/preview is unavailable/);assert.doesNotMatch(await p.locator('main').innerText(),/No supported protected-knowledge changes/);await f.shot('curation');await f.click(button('curate','fresh'));assert.match(await p.locator('main').innerText(),/No supported protected-knowledge changes/);await f.click(button('curate','back'));});
});

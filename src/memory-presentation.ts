/** Pure product copy shared by Open, Sync Memory and text clients. Core owns decisions. */
type Data = Record<string, any>;
const count = (n:number,one:string,many=one+'s') => `${n} ${n===1?one:many}`;
const tokens = (n:number) => n>=1000?`${(n/1000).toFixed(2)}K`:String(n);
export const MEMORY_COPY = {
 automatic: 'Prodero remembers automatically. Sessions save useful knowledge into Local Knowledge when they close.',
 purpose: 'Sync Memory keeps that memory useful and shareable.',
 noHistory: 'Not enough usage history yet to evaluate memory optimization.',
 stale: 'Project memory changed since this Sync started. Re-analyze before continuing.',
 shared: 'Versioned Knowledge is Git-shareable project state that your agent can change. Curator does not commit or push; review the repository diff before doing so.',
};
/** Display only: never infer a topic from a knowledge title. Full labels remain in text/details. */
export function memoryAreaLabel(j:Data):string {
 const refs=[...new Set((j.records??[]).map((r:Data)=>r.scopeRef).filter(Boolean))];
 const path=refs.length===1?String(refs[0]):String(j.label??'');
 const reliablePath=/^(?:[\w.@-]+\/)+[\w.@-]+\/?$/.test(path);
 if(reliablePath)return path.length<=48?path:`${path.slice(0,20)}…${path.slice(-27)}`;
 return `Area ${String(j.id??j.candidateId??'').replace(/^area_/,'').slice(0,8)||'overview'}`;
}
export function memoryArea(j:Data) {
 const signals:string[]=j.signals??[], c=j.counts??{};
 const reasons:string[]=[];
 if(signals.includes('context_pressure'))reasons.push(c.budgetOmissionSessions ? `Some relevant knowledge did not fit into ${count(c.budgetOmissionSessions,'recent session')}.` : 'Some relevant knowledge repeatedly did not fit into recent task context.');
 if(signals.includes('fragmentation'))reasons.push('Related memories are spread across several records used together.');
 if(signals.includes('recent_evolution'))reasons.push('Knowledge has evolved through related updates.');
 if(signals.includes('redundancy'))reasons.push('Repeated information may be easier to use together.');
 if(signals.includes('unresolved'))reasons.push('Some related information still needs clarification.');
 const conflict=signals.includes('potential_conflict');
 if(conflict)reasons.push('Prodero found incompatible current knowledge and could not determine which state is correct.');
 const statuses:Record<string,string>={unselected:'',pending:'Waiting',semantic_work:'Improving…',awaiting_review:'Ready for your review',applied:'Processed',skipped:'Skipped',failed:'Could not finish this area'};
 return {id:j.id,title:j.label,displayLabel:memoryAreaLabel(j),body:`${count(j.recordCount,'related memory','related memories')} · ${j.layers?.local??0} Local / ${j.layers?.versioned??0} Shared`,reasons,conflict,status:statuses[j.status]??'',error:j.error?'This area could not be completed. Retry it or continue with other areas.':null};
}
export function memoryOpenPresentation(p:Data) {
 const o=p.memoryOverview, areas=(o?.areas??[]).map(memoryArea), conflicts=areas.filter((a:Data)=>a.conflict).length;
 const hasHistory=o?.available&&o.sessions>0;
 const headline=!o?.available?'Memory overview unavailable':areas.length?`${count(areas.length,'area')} can be improved`:hasHistory?'No improvements suggested by recent usage':'Memory is ready to learn';
 const notes=[MEMORY_COPY.automatic,MEMORY_COPY.purpose];
 if(!o?.available)notes.push('Memory analysis is temporarily unavailable. Try Sync Memory again when current work has finished.');
 else if(!hasHistory)notes.push(MEMORY_COPY.noHistory);
 else if(!areas.length)notes.push('No transformation is suggested by the available recent usage.');
 if(p.knowledgeCount===0)notes.push('No current memories yet. Normal work will build Local Knowledge.');
 if(p.promotionRecommendedCount)notes.push(`${count(p.promotionRecommendedCount,'Local memory','Local memories')} can be reviewed for team sharing.`);
 if(areas.some((a:Data)=>a.reasons.some((r:string)=>r.includes('did not fit'))))notes.push('Some relevant knowledge has not fit into recent task context.');
 if(o?.areasOmitted)notes.push(`${count(o.areasOmitted,'additional area')} can be inspected in a later Sync Memory run.`);
 const workflow=o?.workflow;
 if(workflow)notes.push(workflow.state==='stale'?MEMORY_COPY.stale:'Memory Sync is in progress. Continue when you are ready.');
 const signal=areas.some((a:Data)=>a.reasons.some((r:string)=>r.includes('did not fit')))?'Relevant knowledge has not fit into recent task context.'
  :areas.length?areas[0].reasons.find((r:string)=>!r.includes('incompatible'))??'Related knowledge is ready for review.'
  :!o?.available?'Memory analysis is temporarily unavailable.':!hasHistory?'Not enough usage history yet to evaluate improvements.':'No improvements suggested by recent usage.';
 const total=areas.length+(o?.areasOmitted??0);
 const dashboard={headline:areas.length?'Memory can be improved':headline,areasLabel:total?`${count(total,'area')} identified`:null,signal,
  sharing:typeof p.localKnowledgeCount==='number'?p.localKnowledgeCount?`${count(p.localKnowledgeCount,'Local memory','Local memories')} available for sharing review.`:'No Local memories to share.':null,
  established:p.knowledgeCount>0,workflowNotice:workflow?workflow.state==='stale'?MEMORY_COPY.stale:'Memory Sync is in progress.':null};
 return {headline,notes,areas,conflicts,workflow,dashboard,button:workflow?(workflow.state==='stale'?'Re-analyze memory':'Continue Memory Sync'):'Sync Memory'};
}
export function memorySyncPresentation(w:Data) {
 const areas=(w.jobs??[]).map(memoryArea),s=w.summary??{},p=w.review?.preview;
 const headlines:Record<string,string>={awaiting_selection:'Sync Memory',semantic_work:'Improving memory…',awaiting_clarification:'A question about your project',awaiting_review:w.review?.kind==='promotion'?'Review knowledge for team sharing':p?.requiresVersionedReview?'Review shared-memory changes':'Review memory changes',applying:'Saving changes…',awaiting_promotion_selection:'Review Local knowledge for sharing',completed:'Memory synced',stale:'Re-analyze memory'};
 const notes:string[]=[],warnings:string[]=[],metrics:{label:string,value:string|number}[]=[],sections:{title:string,items:{title:string,body:string,notes:string[]}[]}[]=[];
 const section=(title:string,body:string)=>sections.push({title,items:[{title:'',body,notes:[]}]});
 if(w.state==='awaiting_selection'){
  // Operation choices are the entry surface; planner data is diagnostic.
 }
 if(w.state==='semantic_work')notes.push('Prodero is reviewing related knowledge and making safe Local improvements. You will only be asked about missing project facts.');
 if(w.state==='applying')notes.push('Your approved changes are being saved safely. Continue to check their result.');
 if(w.state==='stale')notes.push(MEMORY_COPY.stale);
 if(w.state==='awaiting_promotion_selection')notes.push('Select Local knowledge to move to Versioned Knowledge.');
 if(w.state!=='stale'&&w.review?.kind==='transformation'){
  const r=p.summary, before=r.consolidated.length+r.superseded.length+r.kept.length+r.unresolved.length,after=r.created.length+r.kept.length+r.unresolved.length;
  metrics.push({label:'Before · current memories',value:before},{label:'After · current memories',value:after},{label:'Estimated tokens · before → after',value:`${tokens(r.estimatedTokens.before)} → ${tokens(r.estimatedTokens.after)}`});
  section(r.label,`${count(r.consolidated.length,'memory','memories')} consolidated; ${count(r.superseded.length,'memory','memories')} replaced by newer project state; ${count(r.kept.length+r.unresolved.length,'previous memory','previous memories')} remain current.\n${count(r.archives.length,'previous memory','previous memories')} will be preserved in history.`);
  for(const category of ['instruction','principle','invariant','constraint','decision']){
   const n=r.protectedSources.filter((x:Data)=>x.category===category&&x.action==='keep').length;
   if(n)notes.push(`${count(n,`project ${category}`)} ${n===1?'was':'were'} preserved unchanged.`);
  }
  if(r.unresolved.length)notes.push(`Prodero could not safely determine how ${count(r.unresolved.length,'memory','memories')} should be handled. It will remain current.`);
  const l=p.limitations;
  notes.push(...(l.warnings??[]),...(l.additionalEvidenceRequired??[]));
  if(l.omittedAsRedundant?.length)section('Information proposed as repetition',l.omittedAsRedundant.flatMap((x:Data)=>x.information).join('\n'));
  if(l.unresolved?.length)section('Information still unresolved',l.unresolved.flatMap((x:Data)=>x.information).join('\n'));
  if(p.requiresVersionedReview){
   notes.push(MEMORY_COPY.shared,'Local and shared changes will be saved together after approval.');
   const v=p.versionedEffects;
   const sharedIds=new Set(r.created.filter((x:Data)=>x.layer==='versioned').map((x:Data)=>x.id));
   const localIds=new Set(r.archives.filter((x:Data)=>x.layer==='local').map((x:Data)=>x.id));
   const sharedLocal=new Set(r.provenance.filter((x:Data)=>sharedIds.has(x.from)&&localIds.has(x.to)).map((x:Data)=>x.to));
   if(sharedLocal.size)notes.push(`${count(sharedLocal.size,'Local memory','Local memories')} will be represented in the new shared knowledge; the originals stay in history.`);
   section('Shared-memory changes',`${count(v.filter((x:Data)=>x.action==='create').length,'new current memory','new current memories')}; ${count(v.filter((x:Data)=>x.action==='consolidate').length,'memory','memories')} consolidated; ${count(v.filter((x:Data)=>x.action==='supersede').length,'memory','memories')} replaced by newer project state.\n${count(r.archives.filter((x:Data)=>x.layer==='versioned').length,'previous shared memory','previous shared memories')} preserved in Versioned archive files.`);
  }
  notes.push('Please review the proposed wording. Prodero checks data integrity but cannot guarantee that every meaning was preserved.');
  sections.push({title:'Proposed current knowledge',items:p.proposal.records.map((x:Data)=>({title:x.title,body:x.body,notes:[`${x.category} · ${x.scope}${x.path?' · '+x.path:''} · ${r.created.find((c:Data)=>c.key===x.key)?.layer==='versioned'?'Shared / Versioned':'Local'}`]}))});
 }
 if(w.state!=='stale'&&w.review?.kind==='link-repair'){
  notes.push(`Remove ${count(p.count,'broken link')} to missing memories. No replacement memory is inferred.`, 'Memory text and valid links stay unchanged. Original records, including removed links, are saved in a checkpoint.');
  if(p.requiresVersionedReview)notes.push(MEMORY_COPY.shared);
  if(p.remaining)notes.push(`${count(p.remaining,'additional broken link')} will remain for a later Sync.`);
  sections.push({title:'Broken links to remove',items:p.changes.map((c:Data)=>({title:c.title,body:c.links.map((l:Data)=>`${l.type} → ${l.target}`).join('\n'),notes:[`${c.layer==='versioned'?'Shared / Versioned':'Local'} · ${c.id}`]}))});
 }
 if(w.state!=='stale'&&w.review?.kind==='promotion'){
  notes.push(MEMORY_COPY.shared,'This operation applies the knowledge shown here to Versioned files; it does not share it through Git.');
  const labels:Record<string,string>={new:'New shared memory',merge:'Update existing shared memory',supersede:'Replace older shared state',covered:'Already represented in shared knowledge',conflict:'Needs review · remains Local'};
  sections.push({title:'Sharing review',items:p.actions.flatMap((a:Data)=>[
   ...(a.before?[{title:`Current · ${a.before.title}`,body:a.before.content,notes:[]}]:[]),
   {title:a.draft?.title??a.before?.title??'Local knowledge',body:a.draft?.content??a.reason,notes:[labels[a.disposition],a.reason]},
  ])});
  if(p.actions.some((a:Data)=>a.disposition==='conflict'))notes.push('Some selected knowledge cannot be shared safely and will remain Local. Review the reasons below.');
 }
 if(w.state==='completed'){
  if(s.areasProcessed&&s.archived)notes.push(`${s.sourcesBefore} previous memories → ${s.currentAfter} current memories.`,`${count(s.archived,'previous memory','previous memories')} preserved in history.`);
  else if(s.areasProcessed)notes.push('Memory reviewed. No previous memories needed to be replaced.');
  else if(w.jobs?.some((j:Data)=>j.selected)||s.areasSkipped||s.areasFailed)notes.push('No memory improvements were applied.');
  else if(w.improveEnabled===false)notes.push('Memory improvement was not selected.');
  else if(w.jobs?.length)notes.push('No memory improvements were selected.');
  else notes.push(w.usage?.available&&w.usage?.sessions?'No transformation was needed based on recent usage.':MEMORY_COPY.noHistory);
  if(s.brokenLinksFixed)notes.push(`${count(s.brokenLinksFixed,'broken link')} fixed.`);
  if(s.brokenLinksRemaining)notes.push(`${count(s.brokenLinksRemaining,'broken link')} remain unchanged.`);
  if(s.promoted)notes.push(`${count(s.promoted,'Local memory','Local memories')} shared with the team.`);
  if(s.areasProcessed)notes.push(`Estimated context for reviewed knowledge: ${tokens(s.estimatedTokens.before)} → ${tokens(s.estimatedTokens.after)} tokens.`);
  if(s.unresolved)notes.push(`${count(s.unresolved,'memory','memories')} still need clarification and remain current.`);
  if(s.areasSkipped)notes.push('Some knowledge was retained because a safe improvement could not be established.');
  if(s.areasFailed)notes.push('Some analysis could not be completed. Saved knowledge is unchanged for those items.');
  if(s.questionsDeferred)notes.push('Deferred questions are saved for later. Independent work continued.');
  if(s.promotionConflicts)notes.push(`${count(s.promotionConflicts,'sharing item')} still need review and remain Local.`);
  notes.push('Previous knowledge remains available through history.');
 }
 if(w.error&&w.state!=='stale')notes.push('This step could not finish. Continue to check saved progress before retrying.');
 if(w.state==='awaiting_promotion_selection'&&w.coverage?.promotionCandidatesOmitted)notes.push(`${count(w.coverage.promotionCandidatesOmitted,'additional Local memory','additional Local memories')} can be reviewed in a later Sync Memory run.`);
 return {headline:headlines[w.state]??'Sync Memory',graphicalHeadline:headlines[w.state]??'Sync Memory',reviewAreaLabel:'Memory changes',notes,warnings,metrics,sections,areas};
}

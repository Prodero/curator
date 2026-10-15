import { assertSafeCurationData } from './curation-evidence.js';
/** Deterministic sealed inputs, never a write capability. Semantic variants must
 * introduce their own validator; they cannot opt into the extractive validator. */
import { materializeSemanticPlan, semanticIssues, type SemanticTypedPlan } from './curation-semantic-contract.js';
import { sha256 } from './storage.js';
import { validateCurationPlan, type CurationPlan } from './knowledge-curation.js';
import type { ReviewState, ReviewUnit } from './curation-review-state.js';

export const revisionHash = (value: unknown) => sha256(JSON.stringify(value));
export type TypedCurationPlan = { kind: 'extractive-v1'; validator: 'extractive-1'; plan: CurationPlan } | SemanticTypedPlan;
export interface DependencyGroup {
  id: string; proposalIds: string[]; readSet: string[]; writeSet: string[];
  requires: string[]; blockedByIssueIds: string[]; sharedOutputs: string[];
  component: string; policyDependencies: string[]; incomplete: string[];
}
export interface DependencyManifest { version: 1; engine: 'structural-1'; groups: DependencyGroup[]; }
export interface ReviewRevision {
  version: 1 | 2; id: string; lineageId: string; parentRevisionId: string | null;
  parentReviewId: string | null; reviewId: string; projectIdentity: string;
  baseline: string; sources: Array<{ id: string; revision: string }>;
  evidence: Array<{ path: string; revision: string }>; typedPlan: TypedCurationPlan;
  groups: ReviewUnit[]; dependencies: DependencyManifest;
  decisionBinding: Pick<ReviewState, 'revision'|'decisions'|'items'|'paused'|'analysis'>;
  analyzedSourceIds: string[];
  answerBindings: Array<{questionId:string; answerEventId:string; basisHash:string}>;
  appliedHistory: string[]; invalidatedDecisions: string[];
}
const sorted = (values: string[]) => [...new Set(values)].sort();
const intersects = (a: string[], b: string[]) => a.some(v => b.includes(v));

/** Only structured catalog relationships and sealed evidence have control effect.
 * Text, explanations and client declarations cannot add/remove dependencies. */
export function deriveDependencies(plan: CurationPlan, units: ReviewUnit[], sources: Array<{id:string;revision:string}> = plan.proposals.map(p=>({id:p.sourceId,revision:p.revision}))) : DependencyManifest {
  const known = new Map(sources.map(s=>[s.id,s.revision]));
  const groups: DependencyGroup[] = units.map(unit => {
    const proposals=unit.proposalIds.map(id=>plan.proposals.find(p=>p.id===id)!);
    const policy=sorted(proposals.flatMap(p=>[...(p.before.relations??[]).map(r=>r.target),...(p.issueBasis??[]).map(r=>r.id),...(p.consolidationSources??[])]));
    const outputs=sorted(proposals.flatMap(p=>p.outputs.map(o=>o.id)));
    const incomplete=policy.filter(id=>!known.has(id)||known.get(id)==='missing').map(id=>`unknown-source:${id}`);
    for(const p of proposals)for(const relation of p.before.relations??[])if(!plan.proposals.some(q=>q.sourceId===relation.target))incomplete.push(`external-policy:${relation.target}`);
    if(plan.evidenceTruncated)incomplete.push('evidence-incomplete');
    return {id:unit.id,proposalIds:[...unit.proposalIds],readSet:sorted([...proposals.map(p=>`knowledge:${p.sourceId}`),...policy.map(id=>`knowledge:${id}`),...proposals.flatMap(p=>(p.investigation?.evidence??[]).map(e=>`evidence:${e.path}`))]),
      writeSet:unit.applicable?sorted([...proposals.map(p=>`knowledge:${p.sourceId}`),...outputs.map(id=>`knowledge:${id}`)]):[],requires:[],blockedByIssueIds:[],sharedOutputs:outputs.filter(id=>units.some(u=>u.id!==unit.id&&u.proposalIds.some(pid=>plan.proposals.find(p=>p.id===pid)?.outputs.some(o=>o.id===id)))),component:'',policyDependencies:policy,incomplete};
  });
  const unresolved=(g:DependencyGroup)=>{const u=units.find(u=>u.id===g.id)!;return u.attention||u.proposalIds.some(id=>plan.proposals.find(p=>p.id===id)!.outputs.some(o=>o.applicability?.kind==='unresolved'));};
  const linked=(a:DependencyGroup,b:DependencyGroup)=>((unresolved(a)||unresolved(b))&&intersects(a.readSet,b.readSet))||intersects(a.writeSet,b.readSet)||intersects(b.writeSet,a.readSet)||intersects(a.writeSet,b.writeSet)||intersects(a.sharedOutputs,b.sharedOutputs)||a.policyDependencies.some(id=>b.proposalIds.includes(id))||b.policyDependencies.some(id=>a.proposalIds.includes(id));
  for(const group of groups){
    const component=new Set([group.id]);let changed=true;
    while(changed){changed=false;for(const a of groups.filter(g=>component.has(g.id)))for(const b of groups)if(!component.has(b.id)&&linked(a,b)){component.add(b.id);changed=true;}}
    const members=groups.filter(g=>component.has(g.id));
    group.component=`component_${revisionHash(sorted([...component])).slice(0,24)}`;
    group.requires=members.filter(g=>g.id!==group.id&&units.find(u=>u.id===g.id)!.applicable).map(g=>g.id).sort();
    group.blockedByIssueIds=members.filter(g=>{const u=units.find(u=>u.id===g.id)!;return u.attention||u.proposalIds.some(id=>plan.proposals.find(p=>p.id===id)!.outputs.some(o=>o.applicability?.kind==='unresolved'));}).map(g=>`issue_${revisionHash(g.proposalIds).slice(0,24)}`).sort();
    group.incomplete=sorted(members.flatMap(g=>g.incomplete));
  }
  return {version:1,engine:'structural-1',groups};
}
export interface SelectionProblem { groupId: string; reason: 'incomplete'|'blocked'|'requires'|'partial_group'; missing: string[]; }
export function selectionProblems(manifest: DependencyManifest, selectedIds: string[]): SelectionProblem[] {
  const selected=manifest.groups.filter(g=>g.proposalIds.some(id=>selectedIds.includes(id))), ids=selected.map(g=>g.id);
  return selected.flatMap(g=>[
    ...(g.proposalIds.some(id=>!selectedIds.includes(id))?[{groupId:g.id,reason:'partial_group' as const,missing:g.proposalIds.filter(id=>!selectedIds.includes(id))}]:[]),
    ...(g.incomplete.length?[{groupId:g.id,reason:'incomplete' as const,missing:g.incomplete}]:[]),
    ...(g.blockedByIssueIds.length?[{groupId:g.id,reason:'blocked' as const,missing:g.blockedByIssueIds}]:[]),
    ...(g.requires.some(id=>!ids.includes(id))?[{groupId:g.id,reason:'requires' as const,missing:g.requires.filter(id=>!ids.includes(id))}]:[]),
  ]);
}
export function sealRevision(body: Omit<ReviewRevision,'id'>): ReviewRevision { return {...body,id:`revision_${revisionHash(body)}`}; }
export function validateRevision(revision: ReviewRevision) {
  assertSafeCurationData(revision);
  if(![1,2].includes(revision.version)||revision.typedPlan.plan.version!==1||revision.dependencies.version!==1||revision.dependencies.engine!=='structural-1')throw new Error('Unsupported curation revision validator');
  const {id,...body}=revision;
  if(id!==`revision_${revisionHash(body)}`)throw new Error('Curation revision integrity failed');
  const typed=revision.typedPlan;
  if(typed.kind==='extractive-v1'&&typed.validator==='extractive-1')validateCurationPlan(typed.plan);
  else if(typed.kind==='semantic-v2'&&typed.validator==='semantic-1'&&revision.version===2){
    validateCurationPlan(typed.basePlan);
    if(!typed.analyses.length||typed.analyses.length>4||revisionHash(materializeSemanticPlan(typed.basePlan,typed.analyses))!==revisionHash(typed.plan))throw new Error('Semantic revision changed');
  }else throw new Error('Unsupported curation revision validator');
  const plan=revision.typedPlan.plan;
  if(new Set(revision.sources.map(s=>s.id)).size!==revision.sources.length||revisionHash(revision.sources.map(s=>[s.id,s.revision]).sort())!==revision.baseline||plan.proposals.some(p=>!revision.sources.some(s=>s.id===p.sourceId&&s.revision===p.revision)))throw new Error('Curation source binding changed');
  const evidence=[...new Map(plan.proposals.flatMap(p=>(p.investigation?.evidence??[]).map(e=>[e.path,{path:e.path,revision:e.revision}] as const))).values()].sort((a,b)=>a.path.localeCompare(b.path));
  if(revisionHash(evidence)!==revisionHash(revision.evidence))throw new Error('Curation evidence binding changed');
  if(typed.kind==='semantic-v2'){
    for(const analysis of typed.analyses){
      if(analysis.bundle.expectedSources.some(source=>!revision.sources.some(s=>s.id===source.id&&s.revision===source.revision)))throw new Error('Semantic catalog binding changed');
      for(const source of analysis.bundle.sources)if(source.editable!==typed.basePlan.proposals.some(p=>p.id===source.id))throw new Error('Semantic source role changed');
      const knownEvidence=new Set(typed.basePlan.proposals.flatMap(p=>(p.investigation?.evidence??[]).map(e=>`evidence_${revisionHash([e.path,e.revision,e.line]).slice(0,24)}@${e.revision}`)));
      if(analysis.bundle.evidence.some(e=>!knownEvidence.has(`${e.id}@${e.revision}`)))throw new Error('Semantic evidence changed');
    }
    const answers=typed.analyses.flatMap(a=>a.bundle.answers.map(answer=>({questionId:answer.questionId,answerEventId:answer.id,basisHash:answer.basisHash})));
    if(revisionHash(revision.answerBindings)!==revisionHash(answers))throw new Error('Semantic answer bindings changed');
  }
  if(typed.kind==='extractive-v1'&&revision.answerBindings.length)throw new Error('Extractive revisions cannot interpret answers');
  if(revision.baseline!==revision.typedPlan.plan.fingerprint||revisionHash(revision.dependencies)!==revisionHash(deriveDependencies(revision.typedPlan.plan,revision.groups,revision.sources)))throw new Error('Curation dependency integrity failed');
}
export const curationSelectionHash = (revisionId: string, decisionRevision: number, selectedIds: string[]) => revisionHash([revisionId,decisionRevision,[...selectedIds].sort()]);

export function deterministicBaseline(revision:ReviewRevision){return revision.typedPlan.kind==='semantic-v2'?revision.typedPlan.basePlan:revision.typedPlan.plan;}
export function revisionIssues(revision?:ReviewRevision){return revision?.typedPlan.kind==='semantic-v2'?semanticIssues(revision.typedPlan.analyses):[];}

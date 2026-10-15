/** Curation-only semantic roles. These are proposals, never authorization. */
import { analyzeKnowledgeText, type AnalyzedPart } from './knowledge-analysis.js';
export type ClauseRole = 'constraint' | 'invariant' | 'convention' | 'procedure' | 'command' | 'lesson' | 'history' | 'rationale' | 'unresolved';
export interface CurationClause extends AnalyzedPart { role: ClauseRole; normative: boolean; segments?:Array<{start:number;end:number}> }
const labels = /^(Decision|Impact|Constraint|Correction|Guard Pattern|Workflow Note|Test-Quality Note|State|Lesson|Principle|Invariant):\s*$/gmi;
const norm = /\b(?:must|should|never|always|required|only|cannot|do not|keep|preserve)\b/i;
function role(label: string, body: string): ClauseRole {
    // Explicit supporting fields do not gain authority from imperative grammar.
    if (/test-quality|lesson|correction/.test(label)) return 'lesson';
    if (/workflow/.test(label)) return 'procedure';
    if (!/\b(?:must|required|only)\b/i.test(body) && (/^(?:Run\b|For .*\b(?:run|coverage),?\b)/i.test(body.trim()) || /^`?\.\/vendor\/bin\//m.test(body))) return 'command';
    if (label === 'state' || /\b(?:currently fails|remains? blocked|planned work owns|temporary workaround)\b/i.test(body) && !/\b(?:must|should|only|unless|never)\b/i.test(body)) return 'history';
    if (label === 'invariant' || /\btransactional invariant\b/i.test(body)) return 'invariant';
    if (norm.test(body)) return /constraint|guard/.test(label) || /\b(?:must not|never|cannot|fail.closed)\b/i.test(body) ? 'constraint' : 'convention';
    if (label === 'impact') return 'rationale';
    return 'unresolved';
}
export function refineCurationClauses(title: string, content: string): CurationClause[] {
    const fields = [...content.matchAll(labels)];
    // Unstructured authored rules stay intact; no speculative policy demotion.
    if (!fields.length) return analyzeKnowledgeText(title, content).map(p => ({...p, role:'unresolved', normative:true}));
    const fieldsWithBounds = fields.map((m,i) => ({start:i===0?0:m.index!,end:fields[i+1]?.index??content.length,label:m[1].toLowerCase(),bodyStart:m.index!+m[0].length}));
    const chunks=fieldsWithBounds.flatMap(c=>{
        // Split only at complete sentence boundaries, then immediately coalesce equal
        // roles. Exact offsets include labels/whitespace, so nothing disappears.
        const breaks=[...content.slice(c.bodyStart,c.end).matchAll(/(?<=[.!?])\s+(?=[A-Z`])/g)].map(m=>c.bodyStart+m.index!+m[0].length);
        const starts=[c.start,...breaks];
        return starts.map((start,i)=>({...c,start,end:starts[i+1]??c.end,bodyStart:i===0?c.bodyStart:start}));
    });
    const parts: CurationClause[] = [];
    for (const c of chunks) {
        const r=role(c.label,content.slice(c.bodyStart,c.end));
        const p=analyzeKnowledgeText(title,content.slice(c.start,c.end))[0];
        const normative=['constraint','invariant','convention'].includes(r);
        const previous=parts.at(-1);
        // Adjacent normative clauses form one coherent constraint; adjacent support of
        // the same lifecycle/role stays together. Never discard the original labels.
        if(previous && (previous.normative && normative || previous.role===r)) {
            previous.end=c.end; previous.content=content.slice(previous.start,c.end).trim();
            previous.evidence.push(`Source field ${c.label}: ${r}`); continue;
        }
        parts.push({...p,start:c.start,end:c.end,content:content.slice(c.start,c.end).trim(),role:r,normative,
            category:r==='history'?'state':r==='lesson'?'lesson':p.category,
            transient:r==='history',evidence:[`Source characters ${c.start}–${c.end}`,`Semantic role: ${r}; ${normative?'source-supported normative clause':'supporting knowledge, not independently mandatory'}`]});
    }
    const grouped:CurationClause[]=[];
    for(const p of parts){
        const prior=grouped.find(g=>(g.normative&&p.normative||g.role===p.role)&&JSON.stringify(g.applicability)===JSON.stringify(p.applicability));
        if(prior){prior.segments??=[{start:prior.start,end:prior.end}];prior.segments.push({start:p.start,end:p.end});prior.content+='\n\n'+p.content;prior.evidence.push(...p.evidence);}
        else grouped.push({...p});
    }
    return grouped.map((p,i)=>({...p,title:grouped.length===1?title:`${title.slice(0,155)} · ${p.role} ${i+1}`}));
}

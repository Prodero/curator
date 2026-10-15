/** Bounded, read-only repository evidence. Never executes project code. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './storage.js';
import { secretPath } from './plugin-files.js';
import { hasSecret, assertNoSecrets } from './secrets.js';

const sensitiveEvidenceReason = 'Sensitive evidence excluded';
// Use the same source policy as importer/plugin reads; screen whole files before slicing.
function sensitiveSource(file:string,content:string):boolean { return secretPath(file)||hasSecret(file)||hasSecret(content); }
// Persisted reviews/jobs predate collection screening. Fail closed before reusing them.
export function assertSafeCurationData(value:unknown):void {
    assertNoSecrets(value);
    function visit(v:unknown):void {
        if(!v||typeof v!=='object')return;
        const record=v as Record<string,unknown>;
        if(typeof record.path==='string'&&typeof record.excerpt==='string'&&sensitiveSource(record.path,record.excerpt))throw new Error(sensitiveEvidenceReason);
        for(const child of Object.values(record))visit(child);
    }
    visit(value);
}
export interface CurationEvidence { path:string; revision:string; line:number; excerpt:string; kind:'implementation'|'test'|'build'; }
export interface EvidenceInventory { root:string; files:Array<{path:string;revision:string;content:string}>; truncated:boolean; sensitiveExcluded:number; }
const ignored=new Set(['.git','.prodero','node_modules','vendor','bower_components']);
export async function collectCurationEvidence(root:string):Promise<EvidenceInventory> {
    const base=await fs.realpath(root),files:EvidenceInventory['files']=[]; let visited=0,truncated=false,sensitiveExcluded=0;
    async function walk(dir:string,depth:number) {
        if(depth>9||visited>=2500){truncated=true;return;}
        let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{return;}
        for(const e of entries.sort((a,b)=>a.name.localeCompare(b.name))){
            if(++visited>2500){truncated=true;return;}
            if(e.isSymbolicLink()||ignored.has(e.name))continue;
            const absolute=path.join(dir,e.name),relative=path.relative(base,absolute).split(path.sep).join('/');
            if(secretPath(relative)||hasSecret(relative)){sensitiveExcluded++;continue;}
            // Hidden tool state is not repository implementation evidence.
            if(e.isDirectory()&&e.name.startsWith('.')&&e.name!=='.github')continue;
            if(e.isDirectory()){await walk(absolute,depth+1);continue;}
            if(!/\.(?:php|js|cjs|mjs|jsx|ts|tsx|sh|md|xml|py|rb|go|rs|java|kt|c|h|cpp|cs|swift|sql|html|css|vue|svelte|json|ya?ml|toml)$/i.test(e.name))continue;
            const st=await fs.lstat(absolute);if(!st.isFile()||st.size>300000)continue;
            // Recheck real containment: referenced symlinks may not escape the project.
            const real=await fs.realpath(absolute);if(!real.startsWith(base+path.sep))continue;
            const content=await fs.readFile(real,'utf8');
            if(sensitiveSource(relative,content)){sensitiveExcluded++;continue;}
            files.push({path:relative,revision:sha256(content),content});
        }
    }
    // One bounded traversal treats repository layouts uniformly.
    await walk(base,0);
    return {root:base,files,truncated,sensitiveExcluded};
}
export function evidenceFor(content:string,inventory:EvidenceInventory):CurationEvidence[] {
    const symbols=new Set((content.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)??[]).filter(s=>s.length>4).map(s=>s.toLowerCase()));
    const results:CurationEvidence[]=[];
    for(const f of inventory.files){
        if(sensitiveSource(f.path,f.content))continue;
        const lines=f.content.split('\n');
        for(let i=0;i<lines.length;i++)if((lines[i].match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)??[]).some(s=>symbols.has(s.toLowerCase()))){
            results.push({path:f.path,revision:f.revision,line:i+1,excerpt:lines[i].trim().slice(0,300),kind:/test/i.test(f.path)?'test':/grunt|deploy/i.test(f.path)?'build':'implementation'});
            if(results.length>=30||results.filter(r=>r.path===f.path).length>=3)break;
        }
        if(results.length>=30)break;
    }
    return results;
}

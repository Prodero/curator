import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeProject } from '../../dist/core/project.js';
import { writeKnowledge } from '../../dist/core/memory.js';
import { getMemoryPressureSnapshot } from '../../dist/core/memory-pressure.js';

async function fixture(t, budget=150) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-pressure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.git'));await initializeProject(root);
 const file=path.join(root,'.prodero/config.json');const config=JSON.parse(await fs.readFile(file));config.context={...config.context,max_tokens:budget,required_max_tokens:50};await fs.writeFile(file,JSON.stringify(config));return root;
}
const item=(id,patch={})=>({id,title:'Driving control',content:'Driving control preserves traction.',scope:'module',scopeRef:'driving',category:'state',priority:'normal',status:'active',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[],relations:[],...patch});
const entry=(content,patch={})=>({type:'state_change',title:'Driving control',content,scopeHint:'module',scopeRef:'driving',...patch});
async function seed(root) {
 await writeKnowledge(root,item('mem_small'),false,'local');
 await writeKnowledge(root,item('mem_large',{content:'Driving control preserves traction. '.repeat(100)}),false,'versioned');
}
const pressure=async root=>(await getMemoryPressureSnapshot(root));


export { fixture, item, entry, seed, pressure };

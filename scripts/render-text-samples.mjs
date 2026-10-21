/** Render synthetic owned fixtures; never inspect a user's project corpus. */
import fs from 'node:fs/promises';
import {buildViewModel,renderText} from '../dist/presentation.js';
import {renderTextError} from '../dist/text-layout.js';
import {textViewFixtures} from '../test/helpers/text-view-fixtures.mjs';
import {memoryUxFixtures} from '../test/helpers/memory-ux-fixtures.mjs';
const golden=process.argv.includes('--golden');
const directory=golden?new URL('../test/snapshots/text/',import.meta.url):new URL('../docs/fixtures/text/',import.meta.url);
await fs.mkdir(directory,{recursive:true});
const f=textViewFixtures();
for(const [name,expanded] of [['home',false],['knowledge',false],['ready',false],['ready-expanded',true]]){
 const payload=f[name==='ready-expanded'?'ready':name];
 await fs.writeFile(new URL(name+'.txt',directory),renderText(buildViewModel(payload),false,expanded)+'\n');
}
if(!golden){
 for(const name of ['question','deferred','retry','recovery','blocked','update'])await fs.writeFile(new URL(name+'.txt',directory),renderText(buildViewModel(f[name]),false,name==='question')+'\n');
 await fs.writeFile(new URL('error.txt',directory),renderTextError('The action outcome is unknown. Inspect saved progress before retrying; do not replay approval.')+'\n');
 await fs.writeFile(new URL('knowledge-detail.txt',directory),renderText(buildViewModel(f.detail))+'\n');
 const states=await memoryUxFixtures();
 for(const [name,payload] of Object.entries(states))await fs.writeFile(new URL('curate-'+name+'.txt',directory),renderText(buildViewModel(payload),false,true)+'\n');
}
console.log(directory.pathname);

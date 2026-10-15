// Test-only crash harness: let the production writer create its real temporary file,
// then pause immediately before rename so the parent can kill this process.
import fs from 'node:fs/promises';
import {writeFileAtomic,readConfig} from '../../dist/core/storage.js';
import {migrateProject} from '../../dist/core/migrations.js';
const [mode,root,target,content]=process.argv.slice(2);
const rename=fs.rename;
fs.rename=async(from,to)=>{
  if(String(to)===target&&String(from).startsWith(target+'.tmp-')){
    setInterval(()=>{},1000); // Keep the crash boundary alive until the parent kills us.
    process.send({temporary:String(from)});
    await new Promise(()=>{});
  }
  return rename(from,to);
};
if(mode==='migration')await migrateProject(root,await readConfig(root));
else await writeFileAtomic(target,content);
throw new Error('Writer unexpectedly passed the injected crash boundary');

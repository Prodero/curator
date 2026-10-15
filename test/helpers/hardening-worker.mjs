import fs from 'node:fs/promises';
import { syncProject } from '../../dist/core/project.js';
import { recordSessionObservations, closeSession } from '../../dist/core/sessions.js';
import { MIGRATIONS, migrateProject } from '../../dist/core/migrations.js';
import { readConfig } from '../../dist/core/storage.js';
const [action, root, ...args] = process.argv.slice(2);
if (action === 'sync-crash') {
  const failAt = Number(args[0]); let written = 0;
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    const result = await rename(from, to);
    if (String(to).endsWith('/.transactions/pending.json') && failAt === 0) process.exit(73);
    if (/\.prodero\/(?:local\/memory|local\/skills|memory|skills|checkpoints)\//.test(String(to)) && ++written === failAt) process.exit(73);
    return result;
  };
  await syncProject(root);
} else if (action === 'record' || action === 'close') {
  try {
    const result = action === 'close' ? await closeSession(root, args[0]) : await recordSessionObservations(root, args[0], [{type:'discovery',content:`Concurrent observation ${args[1]} is durable.`}]);
    console.log(JSON.stringify({ok:true, ids:result.recorded.map(x=>x.id)}));
  } catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); }
} else if (action === 'migrate') {
  const step=MIGRATIONS[4];
  MIGRATIONS[4]={...step,run:async(...values)=>{await new Promise(r=>setTimeout(r,100));await step.run(...values);}};
  try { console.log(JSON.stringify({ok:true,result:await migrateProject(root,await readConfig(root))})); }
  catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); }
}

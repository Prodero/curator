import fs from 'node:fs/promises';
import path from 'node:path';
import {withSyncLock} from '../../dist/core/sync-transaction.js';
import {recordSessionObservations,closeSession} from '../../dist/core/sessions.js';

const [role,root,sessionId,index]=process.argv.slice(2);
const queued=[],waiting=new Map();
process.on('message',message=>{
  if(waiting.has(message)){waiting.get(message)();waiting.delete(message);}
  else queued.push(message);
});
const wait=key=>queued.includes(key)?Promise.resolve(queued.splice(queued.indexOf(key),1)):new Promise(resolve=>waiting.set(key,resolve));
const send=message=>process.send?.(message);
let releasing=false,blocked=false;
// Only the holder's RELEASE is observed. This lets the same regression schedule
// run on the old protocol (release completes) and a protected protocol (blocked).
if(role==='holder') {
  const mkdir=fs.mkdir;
  fs.mkdir=async(target,...args)=>{
    try{return await mkdir(target,...args);}
    catch(error){
      if(releasing&&!blocked&&String(target).endsWith('/.transactions/lock-recovery')&&error.code==='EEXIST'){
        blocked=true;send({event:'release-blocked'});
      }
      throw error;
    }
  };
}
if(role==='reaper') {
  const read=fs.readFile;let captured=false;
  fs.readFile=async(target,...args)=>{
    const value=await read(target,...args);
    if(!captured&&String(target).endsWith('/.transactions/lock/owner')){
      captured=true;send({event:'captured',owner:String(value)});await wait('resume');
    }
    return value;
  };
}
try {
  send({event:'starting'});
  if(role==='record'||role==='close') {
    send({event:'ready'});await wait('go');
    const result=role==='close'?await closeSession(root,sessionId):await recordSessionObservations(root,sessionId,[{type:'discovery',content:`Synthetic parallel record ${index} must remain durable.`}]);
    send({event:'result',ok:true,ids:result.recorded.map(item=>item.id)});
  } else {
    await withSyncLock(root,async()=>{
      const marker=path.join(root,'critical-section');let owned=false;
      try {await fs.writeFile(marker,String(process.pid),{flag:'wx'});owned=true;}
      catch(error){if(error.code!=='EEXIST')throw error;}
      send({event:'entered',pid:process.pid,overlap:!owned});await wait('release');
      if(owned)await fs.unlink(marker);
      releasing=true;
    },{waitMs:20_000});
    send({event:'completed'});
  }
} catch(error){send({event:'result',ok:false,error:error.message});}
process.disconnect();

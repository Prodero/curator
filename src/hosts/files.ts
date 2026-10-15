import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../filesystem/permissions.js";
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class IntegrationError extends Error {
  constructor(public code: string, message: string) { super(`${code}: ${message}`); }
}
export function fail(code: string, message: string): never { throw new IntegrationError(code, message); }

/** Resolve only OS aliases above HOME; never follow links in user configuration. */
export async function safePath(home: string, target: string): Promise<void> {
  const relative = path.relative(home, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('HOST_UNSUPPORTED_PATH', 'Host configuration must be inside the user home. No files changed.');
  let cursor = home;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && cursor !== target) || (stat.isFile() && stat.nlink > 1)) fail('HOST_UNSAFE_PATH', 'Symlink, hard link or invalid configuration path. Review the host settings manually.');
      if (cursor === target && !stat.isDirectory() && !stat.isFile()) fail('HOST_UNSAFE_PATH', 'Unsupported configuration file type.');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
export async function read(home: string, target: string): Promise<string | null> {
  await safePath(home, target);
  try { const s = await fs.stat(target); if (!s.isFile() || s.size > 8_000_000) fail('HOST_UNSUPPORTED_CONFIG', 'Host configuration is not a supported regular text file.'); return await fs.readFile(target, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export async function directory(home: string, target: string) {
  await safePath(home, target); await fs.mkdir(target, {recursive:true,mode:PRIVATE_DIRECTORY_MODE}); await safePath(home,target);
}
async function atomic(home: string, target: string, content: string | null) {
  await safePath(home,target);
  if(content===null){await fs.rm(target,{force:true});return;}
  await directory(home,path.dirname(target));
  const mode=(await fs.stat(target).catch(()=>null))?.mode ?? PRIVATE_FILE_MODE;
  const temporary=target+'.prodero-'+crypto.randomUUID();
  try {await fs.writeFile(temporary,content,{flag:'wx',mode:mode & 0o777});await safePath(home,target);await fs.rename(temporary,target);}
  finally {await fs.rm(temporary,{force:true});}
}
export interface Change {path:string;before:string|null;after:string|null}
/** One per-host lock and private before/after journal. Never roll back over concurrent edits. */
export async function transact(home:string,state:string,changes:Change[]) {
  const writes=changes.filter(c=>c.before!==c.after);if(!writes.length)return;
  await directory(home,state);
  const lock=path.join(state,'lock'),pending=path.join(state,'pending.json');
  await safePath(home,lock);
  try{await fs.mkdir(lock,{mode:PRIVATE_DIRECTORY_MODE});}catch{fail('HOST_BUSY','Another integration operation or interrupted lock exists. Close host processes and inspect the private integration state before retrying.');}
  let journalWritten=false;
  try{
    if(await read(home,pending)!==null)fail('HOST_RECOVERY_REQUIRED','A preserved integration journal requires review before retrying.');
    for(const c of changes)if(await read(home,c.path)!==c.before)fail('HOST_CONCURRENT_CHANGE','Host settings changed during inspection. Retry after closing the host.');
    const journal=JSON.stringify({format:1,changes:writes},null,2)+'\n';
    await atomic(home,pending,journal);journalWritten=true;
    // Backups can contain host credentials; keep them private and never print their contents.
    await fs.writeFile(path.join(state,'backup-'+crypto.randomUUID()+'.json'),journal,{flag:'wx',mode:PRIVATE_FILE_MODE});
    for(const c of writes){if(await read(home,c.path)!==c.before)fail('HOST_CONCURRENT_CHANGE','Host settings changed while applying integration.');await atomic(home,c.path,c.after);}
    for(const c of changes)if(await read(home,c.path)!==c.after)fail('HOST_CONCURRENT_CHANGE','Host settings changed during verification.');
    await fs.rm(pending);
  }catch(e){
    if(journalWritten){
      let restored=true;
      for(const c of [...writes].reverse())try{const now=await read(home,c.path);if(now===c.after)await atomic(home,c.path,c.before);else if(now!==c.before)restored=false;}catch{restored=false;}
      if(restored)await fs.rm(pending,{force:true});
      else fail('HOST_RECOVERY_REQUIRED','Integration interrupted with concurrent changes. Preserve the private pending.json and backups; review before retrying.');
    }
    throw e;
  }finally{await fs.rmdir(lock).catch(()=>{});}
}

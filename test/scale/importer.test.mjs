import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { digestTree } from '../../dist/core/plugin-files.js';
import { fixture } from '../helpers/migrate-ai-studio.mjs';

test('F08: production file-count boundary rejects digest and importer audit instead of a partial result',async t=>{
  const f=await fixture(t);const bulk=path.join(f.root,'.ai-studio/bulk');await fs.mkdir(bulk);
  for(let group=0;group<201;group++){
    const dir=path.join(bulk,String(group));await fs.mkdir(dir);
    await Promise.all(Array.from({length:100},(_,n)=>fs.writeFile(path.join(dir,`${n}.log`),'x')));
  }
  await assert.rejects(digestTree(f.root,'.ai-studio'),/INTEGRITY_LIMIT: file-count/);
  await assert.rejects(f.call('audit'),/INTEGRITY_LIMIT: file-count/);
});

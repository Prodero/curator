// Invented toy-project fixtures; no real project incidents or operational records.
// Disposable manual MCP App acceptance fixture. Never targets an existing project.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initializeProject} from '../dist/core/project.js';
import {writeKnowledge} from '../dist/core/memory.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-app-review-'));
await initializeProject(root);
for(const [id,content] of [
 ['mem_seed','Decision:\nToyGrid tests must use a fixed tile sequence.\n\nImpact:\nNever shuffle the seeded tile bag.'],
 ['mem_fixture','Decision:\nZED palette tests must start with an empty canvas.'],
 ['mem_uncertain','Decision:\nSynthetic ZED runner currently fails because this demo injects a missing palette.'],
]) await writeKnowledge(root,{version:3,id,category:'instruction',contextPolicy:'required',authority:'legacy_inherited',applicability:{kind:'legacy'},scope:'global',scopeRef:null,priority:'normal',status:'active',title:id.replace('mem_',''),content,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[]});
console.log(JSON.stringify({projectRoot:root,openTool:'prodero_curation',arguments:{projectRoot:root,action:'plan'},history:path.join(root,'.prodero/checkpoints')},null,2));

import fs from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync,execFileSync} from 'node:child_process';
const source=fileURLToPath(new URL('..',import.meta.url));
const root=process.env.PRODERO_GATE_OUTPUT ? path.resolve(process.env.PRODERO_GATE_OUTPUT) : await fs.mkdtemp(path.join(os.tmpdir(),'prodero-rc-'));
await fs.mkdir(root,{recursive:true});const checkout=path.join(root,'checkout'),prefix=path.join(root,'install');
console.log(`Release evidence: ${root}`);
const env={...process.env,PRODERO_RELEASE_SOURCE:'none',npm_config_cache:process.env.npm_config_cache||path.join(root,'npm-cache')};
function run(cmd,args,cwd,log){const r=spawnSync(cmd,args,{cwd,env,encoding:'utf8',maxBuffer:64*1024*1024});if(log)writeFileSync(path.join(root,log),(r.stdout||'')+(r.stderr||''));if(r.status!==0)throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stdout||'').slice(-4000)} ${(r.stderr||'').slice(-2000)}`);return r.stdout;}
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:source,encoding:'utf8'}).split('\0').filter(Boolean);
await fs.mkdir(checkout,{recursive:true});
for(const f of new Set(files)){if(/^(node_modules|dist|dist-ui)\//.test(f))throw new Error(`Build output tracked: ${f}`);const stat=await fs.lstat(path.join(source,f)).catch(()=>null);if(!stat)continue;if(!stat.isFile())throw new Error(`Unexpected tracked non-file: ${f}`);await fs.mkdir(path.dirname(path.join(checkout,f)),{recursive:true});await fs.copyFile(path.join(source,f),path.join(checkout,f));}
const tracked=execFileSync('git',['ls-files','-z'],{cwd:source,encoding:'utf8'}).split('\0');assertTree(tracked);
function assertTree(names){for(const f of names)if(/^\.prodero\/(?:local\/|\.cache\/|\.transactions\/|sessions\/[^.].*\.md$|checkpoints\/.*\.json$)/.test(f))throw new Error(`Runtime artifact in public Git tree: ${f}`);}
run('git',['init','--quiet'],checkout);run('git',['add','.'],checkout);run('git',['-c','user.name=RC','-c','user.email=rc@example.invalid','commit','--quiet','-m','Clean RC snapshot'],checkout);
run('npm',['ci','--no-audit','--no-fund'],checkout,'npm-ci.log');console.log('Clean npm ci passed');
run('npm',['run','build'],checkout,'build.log');run('npm',['test'],checkout,'test.log');console.log('Build and full tests passed');
const pack=JSON.parse(run('npm',['pack','--ignore-scripts','--json'],checkout,'pack.json'))[0];const tarball=path.join(root,pack.filename);await fs.rename(path.join(checkout,pack.filename),tarball);
const {hasSecret}=await import(pathToFileURL(path.join(checkout,'dist/core/secrets.js')).href);
for(const f of pack.files){if(/(?:^|\/)(?:\.prodero|node_modules|test|tests|src|fixtures)(?:\/|$)|\.map$|\.ts$/.test(f.path))throw new Error(`Unwanted packed file: ${f.path}`);const content=await fs.readFile(path.join(checkout,f.path),'utf8');if(hasSecret(content))throw new Error(`Credential pattern in artifact: ${f.path}`);if(/\/(?:Users|home)\/[a-zA-Z0-9_-]+\//.test(content))throw new Error(`User-specific path in artifact: ${f.path}`);}
for(const f of pack.files.filter(f=>f.path.endsWith('.md'))){const markdown=await fs.readFile(path.join(checkout,f.path),'utf8');for(const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){const href=match[1].split('#')[0];if(!href||/^(?:https?:|mailto:)/.test(href))continue;const target=path.posix.normalize(path.posix.join(path.posix.dirname(f.path),href));if(!pack.files.some(item=>item.path===target))throw new Error(`Broken packaged doc link: ${f.path} -> ${href}`);}}
for(const f of ['LICENSE','README.md','ARCHITECTURE.md','docs/COMPATIBILITY.md','dist-ui/index.html','plugins/migrate_ai_studio/ui/dist/index.html'])if(!pack.files.some(i=>i.path===f))throw new Error(`Missing package resource: ${f}`);
await fs.mkdir(prefix,{recursive:true});run('npm',['install','--global','--prefix',prefix,'--omit=dev','--ignore-scripts','--no-audit','--no-fund',tarball],prefix,'install.log');
const installed=path.join(prefix,'lib/node_modules/@prodero/cli');for(const dep of ['typescript','tsx','vite']){if(await fs.stat(path.join(installed,'node_modules',dep)).catch(()=>null))throw new Error(`Dev dependency installed: ${dep}`);}
await fs.copyFile(path.join(checkout,'scripts/artifact-smoke.mjs'),path.join(root,'artifact-smoke.mjs'));
// Make it impossible for the smoke runner to use this checkout or its node_modules.
await fs.rename(checkout,path.join(root,'checkout-offline'));
run(process.execPath,[path.join(root,'artifact-smoke.mjs'),prefix,path.join(root,'project'),tarball],root,'artifact-smoke.log');
const summary={ok:true,node:process.version,platform:process.platform,arch:process.arch,tarball,sha256:crypto.createHash('sha256').update(await fs.readFile(tarball)).digest('hex'),files:pack.files.length,unpackedSize:pack.unpackedSize};await fs.writeFile(path.join(root,'result.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));

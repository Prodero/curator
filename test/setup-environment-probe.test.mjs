import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const guide=await fs.readFile(new URL('../setup.md',import.meta.url),'utf8');
const probe=guide.match(/<!-- curator:environment-probe:start -->\s*```sh\n([\s\S]*?)\n```\s*<!-- curator:environment-probe:end -->/)?.[1];
assert.ok(probe,'The shipped guide must contain its executable read-only environment probe');

async function snapshot(root){
  const files={};
  async function visit(dir){
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      const target=path.join(dir,entry.name),key=path.relative(root,target);
      if(entry.isDirectory())await visit(target);
      else if(entry.isSymbolicLink())files[key]={link:await fs.readlink(target)};
      else files[key]={bytes:(await fs.readFile(target)).toString('base64'),mtime:(await fs.stat(target)).mtimeMs};
    }
  }
  await visit(root);return files;
}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'curator-environment-probe-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bin=path.join(root,'bin'),home=path.join(root,'home'),project=path.join(root,'project');
  await fs.mkdir(bin);await fs.mkdir(home);await fs.mkdir(project);
  await fs.writeFile(path.join(home,'.profile'),'# keep shell defaults\n');
  await fs.writeFile(path.join(home,'.npmrc'),'prefix=/unchanged/fixture-prefix\n');
  await fs.writeFile(path.join(project,'.nvmrc'),'24.0.0\n');
  await fs.writeFile(path.join(project,'.tool-versions'),'nodejs 24.0.0\n');
  await fs.writeFile(path.join(project,'package.json'),'{"name":"untouched-project"}\n');
  const binary=async(name,body)=>{
    const target=path.join(bin,name);
    await fs.writeFile(target,'#!/bin/sh\n'+body+'\n',{mode:0o700});return target;
  };
  const version=async(name,value)=>binary(name,`printf '%s\\n' '${value}'`);
  const run=async(extra={})=>{
    const before=await snapshot(root);
    const result=await exec('/bin/sh',['-c',extra.prelude?extra.prelude+'\n'+probe:probe],{cwd:project,env:{HOME:home,PATH:extra.PATH??bin}});
    assert.equal(result.stderr,'');
    assert.deepEqual(await snapshot(root),before,'Inspection must preserve runtimes, config/defaults and project bytes/mtimes');
    return result.stdout;
  };
  return {root,home,project,bin,binary,version,run};
}

test('discovery-only guide probe runs without Node/npm or any external utility',async t=>{
  const f=await fixture(t),text=await f.run();
  assert.match(text,/^uname.state=missing$/m);
  assert.match(text,/^node.state=missing$/m);assert.match(text,/^npm.state=missing$/m);
  assert.match(text,/^prodero.state=missing$/m);assert.match(text,/^brew.state=missing$/m);
  assert.doesNotMatch(text,/\.version=|^os=|^arch=/m);
});

test('installed-looking Node/npm and uname are located without executing version or OS checks',async t=>{
  const f=await fixture(t);await f.version('node','v22.14.0');await f.version('npm','10.9.2');
  await f.binary('uname',`case "$1" in -s) printf 'Darwin\\n';; -m) printf 'arm64\\n';; esac`);
  const text=await f.run();
  assert.ok(text.includes(`uname.path=${path.join(f.bin,'uname')}\n`));
  assert.ok(text.includes(`node.path=${path.join(f.bin,'node')}\n`));
  assert.ok(text.includes(`npm.path=${path.join(f.bin,'npm')}\n`));
  assert.doesNotMatch(text,/v22\.14\.0|10\.9\.2|Darwin|arm64|\.version=|^os=|^arch=/m);
});

test('current PATH candidates and managers are found without executing their installation hooks',async t=>{
  const f=await fixture(t);await f.version('node','v24.0.0');await f.version('npm','11.0.0');
  await f.binary('fnm',`printf 'manager must not execute\\n' >&2\nexit 86`);
  await f.binary('brew',`printf 'package manager must not execute\\n' >&2\nexit 87`);
  const text=await f.run();
  assert.ok(text.includes(`node.path=${path.join(f.bin,'node')}\n`));
  assert.ok(text.includes(`fnm.path=${path.join(f.bin,'fnm')}\n`));
  assert.ok(text.includes(`brew.path=${path.join(f.bin,'brew')}\n`));
  assert.doesNotMatch(text,/\.version=|must not execute/);
});

test('found Node and missing npm are reported without assuming Node version or usability',async t=>{
  const f=await fixture(t);await f.version('node','v22.23.4');
  const text=await f.run();assert.ok(text.includes(`node.path=${path.join(f.bin,'node')}\n`));
  assert.match(text,/^npm.state=missing$/m);assert.doesNotMatch(text,/^node.state=missing$|\.version=/m);
});

test('a failing npm wrapper remains found-but-unverified and is never called',async t=>{
  const f=await fixture(t);await f.version('node','v22.23.4');
  await f.binary('npm',`printf 'synthetic-private-diagnostic\\n' >&2\nexit 1`);
  const text=await f.run();
  assert.ok(text.includes(`npm.path=${path.join(f.bin,'npm')}\n`));
  assert.doesNotMatch(text,/npm.state=missing|npm.state=broken|synthetic-private-diagnostic|\.version=/);
});

test('empty-output npm is only a path candidate, never a claimed working installation',async t=>{
  const f=await fixture(t);await f.version('node','v22.23.4');await f.binary('npm','exit 0');
  const text=await f.run();assert.ok(text.includes(`npm.path=${path.join(f.bin,'npm')}\n`));
  assert.doesNotMatch(text,/npm.state=broken|npm.state=working|\.version=/);
});

test('first-pass PATH selection exposes actual candidate paths, without running either Node candidate',async t=>{
  const f=await fixture(t),other=path.join(f.root,'other-bin');await fs.mkdir(other);
  await f.version('node','v24.0.0');
  await fs.writeFile(path.join(other,'node'),'#!/bin/sh\nprintf "v22.23.4\\n"\n',{mode:0o700});
  await fs.writeFile(path.join(other,'npm'),'#!/bin/sh\nprintf "10.9.2\\n"\n',{mode:0o700});
  const text=await f.run({PATH:f.bin+path.delimiter+other});
  assert.ok(text.includes(`node.path=${path.join(f.bin,'node')}\n`));
  assert.ok(text.includes(`npm.path=${path.join(other,'npm')}\n`));
  assert.doesNotMatch(text,/\.version=|v24\.0\.0|v22\.23\.4/);
});

test('loaded nvm and an existing linked/dev Curator are inspected without changing their setup',async t=>{
  const f=await fixture(t),checkout=path.join(f.root,'existing-checkout');await fs.mkdir(checkout);
  const entry=path.join(checkout,'prodero');
  await fs.writeFile(entry,'#!/bin/sh\nprintf "0.2.1\\n"\n',{mode:0o700});
  await fs.symlink(entry,path.join(f.bin,'prodero'));
  await fs.mkdir(path.join(f.home,'.codex'));
  await fs.writeFile(path.join(f.home,'.codex/config.toml'),'[mcp_servers.prodero]\ncommand="existing"\nargs=["mcp","--dev"]\n');
  const text=await f.run({prelude:'nvm() { printf "nvm must not execute\\n" >&2; return 91; }'});
  assert.match(text,/^nvm.path=nvm$/m);
  assert.ok(text.includes(`prodero.path=${path.join(f.bin,'prodero')}\n`));
  assert.doesNotMatch(text,/\.version=|must not execute/);
});

test('lazy-install PATH shims cannot mutate the environment during first-pass discovery',async t=>{
  const f=await fixture(t),sentinel=path.join(f.root,'unapproved-lazy-install');
  const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  for(const name of ['node','npm','prodero','uname','mise','volta']){
    await f.binary(name,`: > ${shellQuote(sentinel)}\nprintf 'shim was executed\\n' >&2\nexit 95`);
  }
  const text=await f.run();
  for(const name of ['node','npm','prodero','uname','mise','volta'])assert.ok(text.includes(`${name}.path=${path.join(f.bin,name)}\n`));
  assert.equal(await fs.stat(sentinel).catch(()=>null),null,'An unresolved shim must not be invoked, even for --version');
  assert.doesNotMatch(text,/\.version=|shim was executed/);
});

test('a shell function masquerading as Node is reported without execution',async t=>{
  const f=await fixture(t),text=await f.run({prelude:'node() { printf "node function executed\\n" >&2; return 96; }'});
  assert.match(text,/^node.path=node$/m);assert.doesNotMatch(text,/\.version=|node function executed/);
});

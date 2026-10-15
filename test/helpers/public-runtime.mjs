import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const curatorCheckout=fileURLToPath(new URL('../../',import.meta.url));
export async function packageFixture(root,{full=false}={}) {
  await fs.mkdir(path.join(root,'bin'),{recursive:true});
  if(full) {
    for(const file of ['dist','dist-ui','instructions','plugins','prodero.release.json']) await fs.cp(path.join(curatorCheckout,file),path.join(root,file),{recursive:true});
    await fs.symlink(path.join(curatorCheckout,'node_modules'),path.join(root,'node_modules'),'dir');
  } else {
    await fs.mkdir(path.join(root,'dist/hosts'),{recursive:true});
    await fs.writeFile(path.join(root,'dist/cli.js'),'// packaged fixture');
    await fs.writeFile(path.join(root,'dist/hosts/runtime.js'),'// runtime support');
  }
  await fs.copyFile(path.join(curatorCheckout,'bin/prodero'),path.join(root,'bin/prodero'));
  await fs.chmod(path.join(root,'bin/prodero'),0o755);
  const metadata=JSON.parse(await fs.readFile(path.join(curatorCheckout,'package.json'),'utf8'));
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify(metadata));
  return path.join(root,'bin/prodero');
}

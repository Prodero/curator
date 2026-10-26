import fs from 'node:fs/promises';
import path from 'node:path';

/** Keep the last complete MCP resource readable while another process builds. */
export async function publishSingleFileUi(outDir, build, stagingRoot = path.dirname(outDir)) {
  await fs.mkdir(outDir, {recursive:true});
  // Stage outside the served/copied resource tree, on the same filesystem.
  // Each builder owns only its directory; publishing never removes outDir.
  const staging = await fs.mkdtemp(path.join(stagingRoot, '.ui-build-'));
  try {
    await build(staging);
    const entries = await fs.readdir(staging, {withFileTypes:true});
    if (entries.length !== 1 || entries[0].name !== 'index.html' || !entries[0].isFile()) {
      throw new Error('MCP UI build must produce only a regular index.html file.');
    }
    await fs.rename(path.join(staging, 'index.html'), path.join(outDir, 'index.html'));
  } finally {
    await fs.rm(staging, {recursive:true, force:true});
  }
}

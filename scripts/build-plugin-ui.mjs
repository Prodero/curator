import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { publishSingleFileUi } from './publish-ui.mjs';
const root = path.resolve('plugins');
for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT')
    return []; throw error; })) {
    if (!entry.isDirectory())
        continue;
    const ui = path.join(root, entry.name, 'ui');
    if (!(await fs.stat(path.join(ui, 'index.html')).catch(() => null))?.isFile())
        continue;
    await publishSingleFileUi(path.join(ui, 'dist'), outDir =>
        build({ configFile: false, root: ui, plugins: [viteSingleFile()], build: { outDir, emptyOutDir: true } }), path.dirname(root));
}

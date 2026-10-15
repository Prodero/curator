import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
const root = path.resolve('plugins');
for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT')
    return []; throw error; })) {
    if (!entry.isDirectory())
        continue;
    const ui = path.join(root, entry.name, 'ui');
    if (!(await fs.stat(path.join(ui, 'index.html')).catch(() => null))?.isFile())
        continue;
    await build({ configFile: false, root: ui, plugins: [viteSingleFile()], build: { outDir: path.join(ui, 'dist'), emptyOutDir: true } });
}

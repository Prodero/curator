import {build} from 'vite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publishSingleFileUi} from './publish-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await publishSingleFileUi(path.join(root, 'dist-ui'), outDir =>
  build({configFile:path.join(root, 'vite.config.ts'), build:{outDir}}));

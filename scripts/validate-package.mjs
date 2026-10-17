import fs from 'node:fs/promises';
import path from 'node:path';

export async function validatePackage(checkout, pack, hasSecret) {
for(const f of pack.files){if(/(?:^|\/)(?:\.prodero|node_modules|test|tests|src|fixtures)(?:\/|$)|\.map$|\.ts$/.test(f.path))throw new Error(`Unwanted packed file: ${f.path}`);const content=await fs.readFile(path.join(checkout,f.path),'utf8');if(hasSecret(content))throw new Error(`Credential pattern in artifact: ${f.path}`);if(/\/(?:Users|home)\/[a-zA-Z0-9_-]+\//.test(content))throw new Error(`User-specific path in artifact: ${f.path}`);}
for(const f of pack.files.filter(f=>f.path.endsWith('.md'))){const markdown=await fs.readFile(path.join(checkout,f.path),'utf8');for(const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){const href=match[1].split('#')[0];if(!href||/^(?:https?:|mailto:)/.test(href))continue;const target=path.posix.normalize(path.posix.join(path.posix.dirname(f.path),href));if(!pack.files.some(item=>item.path===target))throw new Error(`Broken packaged doc link: ${f.path} -> ${href}`);}}
for(const f of ['LICENSE','README.md','ARCHITECTURE.md','docs/COMPATIBILITY.md','dist-ui/index.html','plugins/migrate_ai_studio/ui/dist/index.html'])if(!pack.files.some(i=>i.path===f))throw new Error(`Missing package resource: ${f}`);
}

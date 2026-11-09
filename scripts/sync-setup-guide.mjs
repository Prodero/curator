import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = new URL('../setup.md', import.meta.url);
export const publishedDocs = 'https://unpkg.com/@prodero/curator@latest/';

export function renderHostedGuide(markdown) {
  return markdown.replace(/(\[[^\]]*\]\()(?=docs\/)([^)]+)(\))/g,
    (_, start, href, end) => `${start}${publishedDocs}${href}${end}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args[0] === '--check';
  if (check) args.shift();
  if (args.length !== 1 || args[0].startsWith('-')) {
    throw new Error('Usage: node scripts/sync-setup-guide.mjs [--check] PATH/TO/WEBSITE/public/curator/setup.md');
  }
  const destination = path.resolve(args[0]);
  if (destination === fileURLToPath(source)) throw new Error('Cannot overwrite the canonical setup.md');
  const info = await fs.lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info && !info.isFile()) throw new Error('Destination must be a regular file, not a symlink or directory');
  const expected = renderHostedGuide(await fs.readFile(source, 'utf8'));
  const existing = info ? await fs.readFile(destination, 'utf8') : null;
  if (check) {
    if (existing !== expected) throw new Error('Hosted setup guide is missing or out of sync; run the sync command');
    console.log('Hosted setup guide matches the canonical guide');
  } else if (existing !== expected) {
    await fs.writeFile(destination, expected);
    console.log('Updated hosted setup guide');
  } else {
    console.log('Hosted setup guide is already synchronized');
  }
}

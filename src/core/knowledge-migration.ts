import fs from 'node:fs/promises';
import path from 'node:path';
import { checkedDataPath, exists, writeFileAtomic } from './storage.js';
import { parseFrontmatter, frontmatter } from './format.js';
import { parseKnowledge, renderKnowledge } from './memory.js';

/** Current and historical canonical stores, in deterministic order. Checkpoint
 * preimages remain historical evidence and are not rewritten as current records. */
export async function knowledgeFiles(root: string): Promise<string[]> {
  const directories = ['memory', 'local/memory'];
  for (const archive of ['archive', 'local/archive']) {
    const directory = await checkedDataPath(root, archive);
    if (await exists(directory)) for (const month of (await fs.readdir(directory)).sort()) {
      if (/^\d{4}_\d{2}$/.test(month)) directories.push(`${archive}/${month}`);
    }
  }
  const files: string[] = [];
  for (const directory of directories) {
    const target = await checkedDataPath(root, directory);
    if (await exists(target)) for (const name of (await fs.readdir(target)).sort()) {
      if (name.endsWith('.md') && !name.startsWith('.')) files.push(`${directory}/${name}`);
    }
  }
  return files;
}

/** Mechanical compatibility conversion only: no lexical rules, scope inference,
 * model calls, status filtering or authority promotion. */
export async function migrateKnowledgeV1ToV2(root: string): Promise<void> {
  for (const relative of await knowledgeFiles(root)) {
    const target = await checkedDataPath(root, relative), filename = path.basename(relative);
    const before = await fs.readFile(target, 'utf8');
    const old = parseKnowledge(before, filename);
    if (old.version === 2) continue;
    const {metadata, body} = parseFrontmatter(before, filename);
    let after: string;
    if (metadata.kind === 'knowledge') {
      // Preserve bodies, provenance and unrelated metadata byte-for-byte. The old
      // enforcement field was never canonical; remove that ignored draft alias.
      const eol = before.startsWith('---\r\n') ? '\r\n' : '\n';
      const end = before.indexOf(`${eol}---${eol}`, 3 + eol.length);
      const header = before.slice(0, end).replace(/^enforcement:.*(?:\r?\n|$)/m, '');
      after = header.replace(/^---\r?\n/, `---${eol}version: 2${eol}context_policy: ${old.contextPolicy}${eol}authority: legacy_inherited${eol}`) + before.slice(end);
    } else {
      // Legacy unstructured Markdown acquires explicit structural metadata while
      // keeping precisely the same effective title/content/defaults.
      const canonical = parseFrontmatter(renderKnowledge({...old,version:2}), filename).metadata;
      const {enforcement: _ignored, ...preserved} = metadata;
      after = frontmatter({...preserved, ...canonical}, body);
    }
    const next = parseKnowledge(after, filename, 2);
    if (JSON.stringify({...old, version:2}) !== JSON.stringify(next)) throw new Error(`Knowledge policy migration changed effective knowledge: ${relative}`);
    await writeFileAtomic(target, after);
  }
}

export async function validateKnowledgeV2(root: string): Promise<void> {
  for (const relative of await knowledgeFiles(root)) {
    parseKnowledge(await fs.readFile(await checkedDataPath(root, relative), 'utf8'), path.basename(relative), 2);
  }
}

/** Preserve exact old selector semantics; never infer scope from prose. */
export async function migrateKnowledgeV2ToV3(root:string):Promise<void> {
 for(const relative of await knowledgeFiles(root)) {
  const target=await checkedDataPath(root,relative),filename=path.basename(relative),before=await fs.readFile(target,'utf8');
  const old=parseKnowledge(before,filename,2);
  const eol=before.startsWith('---\r\n')?'\r\n':'\n';
  const after=before.replace(/^version: 2\r?$/m,`version: 3${eol}applicability: {"kind":"legacy"}`);
  const next=parseKnowledge(after,filename,3);const {applicability,...rest}=next;
  if(JSON.stringify({...old,version:3})!==JSON.stringify(rest))throw new Error(`Applicability migration changed canonical knowledge: ${relative}`);
  await writeFileAtomic(target,after);
 }
}
export async function validateKnowledgeV3(root:string):Promise<void> {
 for(const relative of await knowledgeFiles(root))parseKnowledge(await fs.readFile(await checkedDataPath(root,relative),'utf8'),path.basename(relative),3);
}

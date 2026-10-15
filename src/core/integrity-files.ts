import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { checkedPath, safeRelative, secretPath } from './plugin-files.js';

export interface IntegrityLimits { files: number; bytes: number; depth: number; entries: number; timeoutMs: number }
export const INTEGRITY_LIMITS: Readonly<IntegrityLimits> = Object.freeze({ files: 20_000, bytes: 100_000_000, depth: 32, entries: 40_000, timeoutMs: 30_000 });
export interface IntegrityOptions { exclude?: string[]; limits?: Partial<IntegrityLimits>; signal?: AbortSignal }
const skipped = new Set(['.git', 'node_modules', '.cache', '.transactions', 'dist', 'dist-ui']);
const privateStores = /(^|\/)\.prodero\/(?:local|sessions|checkpoints|\.cache|\.transactions|\.backups|\.migrations)(?:\/|$)/;
const canonicalStores = ['config.json', 'index.md', 'memory', 'skills', 'local/memory', 'local/skills', 'local/archive', 'archive', 'sessions', 'checkpoints'];

export async function integritySnapshot(root: string, relative: string, options: IntegrityOptions = {}, canonical = false) {
  const limits = { ...INTEGRITY_LIMITS, ...options.limits };
  for (const key of Object.keys(INTEGRITY_LIMITS) as (keyof typeof limits)[]) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > INTEGRITY_LIMITS[key]) throw new Error('Invalid integrity limit; limits may only be lowered');
  }
  const exclusions = new Set((options.exclude ?? []).map(safeRelative));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(cancel, limits.timeoutMs);
  const started = performance.now();
  const check = () => { if (controller.signal.aborted || performance.now() - started >= limits.timeoutMs) throw new Error('INTEGRITY_CANCELLED: digest cancelled or time budget exceeded; no complete digest produced'); };
  const fail = (kind: string) => { throw new Error(`INTEGRITY_LIMIT: ${kind} budget exceeded; narrow the import tree or remove out-of-scope artifacts and retry. No complete digest produced.`); };
  let entries = 0, bytes = 0, directories = 0, files = 0;
  const digest = crypto.createHash('sha256').update(`curator-integrity-v2:${canonical ? 'canonical' : 'external'}\0`);
  const hashes: Record<string, string> = Object.create(null);
  const changed = () => new Error('Source tree changed while creating digest; retry audit');
  const stable = (a: import('node:fs').BigIntStats, b: import('node:fs').BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  async function git(args: string[], input = ''): Promise<{code: number | null; output: string; errorText: string}> {
    check();
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', root, ...args], { stdio: ['pipe', 'pipe', 'pipe'], signal: controller.signal });
      let output = '', errorText = '', error = false;
      child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 8_000_000) { error = true; child.kill(); } });
      child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(0, 4096); });
      child.stdin.on('error', () => {});
      child.on('error', () => reject(new Error('INTEGRITY_GIT: Git ignore inspection unavailable or cancelled; no complete digest produced')));
      child.on('close', code => error ? reject(new Error('INTEGRITY_LIMIT: Git ignore output budget exceeded')) : resolve({code, output, errorText}));
      child.stdin.end(input);
    });
  }
  let gitRepository = false;
  async function ignored(names: string[]): Promise<Set<string>> {
    if (!gitRepository || !names.length) return new Set();
    if (Buffer.byteLength(names.join('\0')) > 4_000_000) fail('Git path-input');
    const result = await git(['check-ignore', '--no-index', '-z', '--stdin'], names.join('\0') + '\0');
    if (result.code !== 0 && result.code !== 1) throw new Error('INTEGRITY_GIT: Git ignore inspection failed; no complete digest produced');
    return new Set(result.output.split('\0').filter(Boolean));
  }
  function excluded(rel: string, within: string) {
    if (secretPath(rel)) return true;
    if (canonical) {
      if (rel.split('/').some(part => part.includes('.tmp-'))) return true;
      if (rel === ".prodero") return false;
      const name = rel.slice('.prodero/'.length);
      return !canonicalStores.some(store => name === store || name.startsWith(store + '/') || store.startsWith(name + '/'));
    }
    if (privateStores.test(rel) || rel.split('/').some(p => skipped.has(p))) return true;
    if (relative === '.' && rel.split('/')[0] === '.prodero') return true;
    return [...exclusions].some(p => within === p || within.startsWith(p + '/'));
  }
  async function hashFile(target: string, rel: string, stat: import('node:fs').BigIntStats) {
    if (++files > limits.files) fail('file-count');
    if (stat.size > BigInt(limits.bytes - bytes)) fail('total-byte');
    check();
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({bigint:true});
      if (!before.isFile() || !stable(stat, before)) throw changed();
      const value = crypto.createHash('sha256'); let read = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, signal: controller.signal })) {
        check(); read += (chunk as Buffer).length;
        if (read > limits.bytes - bytes) fail('total-byte');
        value.update(chunk as Buffer);
      }
      const after = await handle.stat({bigint:true});
      const current = await fs.lstat(target, {bigint:true});
      if (!stable(before, after) || !stable(after, current) || BigInt(read) !== before.size) throw changed();
      bytes += read;
      hashes[rel] = value.digest('hex');
      return {hash: hashes[rel], bytes: read};
    } finally { await handle.close(); }
  }
  async function visit(target: string, rel: string, within: string, depth: number) {
    check();
    if (excluded(rel, within)) return;

    const before = await fs.lstat(target, {bigint:true});
    if (before.isSymbolicLink()) throw new Error('Symlink in source tree rejected');
    if (depth > limits.depth) fail('traversal-depth');
    if (before.isDirectory()) {
      if (within) { directories++; digest.update(`D\0${within}\0`); }
      const names: string[] = [];
      for await (const entry of await fs.opendir(target)) {
        check(); if (++entries > limits.entries) fail('entry-count');
        const nextRel = rel === '.' ? entry.name : `${rel}/${entry.name}`;
        const nextWithin = within ? `${within}/${entry.name}` : entry.name;
        if (!excluded(nextRel, nextWithin)) names.push(entry.name);
      }
      // Batch Git checks and prune ignored directories before traversing them.
      const paths = names.map(n => rel === '.' ? n : `${rel}/${n}`);
      const ignores = await ignored(paths);
      for (const name of names.sort()) {
        const nextRel = rel === '.' ? name : `${rel}/${name}`;
        if (!ignores.has(nextRel)) await visit(path.join(target,name), nextRel, within ? `${within}/${name}` : name, depth + 1);
      }
      if (!stable(before, await fs.lstat(target, {bigint:true}))) throw changed();
    } else if (before.isFile()) {
      const value = await hashFile(target, rel, before);
      digest.update(`F\0${within}\0${value.bytes}\0${value.hash}\0`);
    } else throw new Error('Special source file rejected');
  }
  try {
    check();
    const base = await checkedPath(root, relative);
    if (!canonical) {
      const result = await git(['rev-parse', '--is-inside-work-tree']);
      if (result.code !== 0 && !(result.code === 128 && /not a git repository/i.test(result.errorText))) throw new Error('INTEGRITY_GIT: Unable to determine Git ignore scope');
      gitRepository = result.code === 0 && result.output.trim() === 'true';
    }
    const stat = await fs.lstat(base).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && !stat.isDirectory()) throw new Error('Source is not a directory');
    if (stat && !(await ignored([relative])).has(relative)) await visit(base, relative, '', 0);
    check();
    return { hashes: Object.fromEntries(Object.entries(hashes)), digest: {version: 2 as const, algorithm: 'sha256-tree-v2' as const, sha256: digest.digest('hex'), files, directories, bytes} };
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}

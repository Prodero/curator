import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeProject, prepareProject, recordProjectSession, closeProjectSession } from '../../dist/core/project.js';

async function fixture(t, assisted = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-engine-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git')); await initializeProject(root);
  const file = path.join(root, '.prodero/config.json');
  const config = JSON.parse(await fs.readFile(file)); config.knowledgeEngine = { mode: assisted ? 'assisted' : 'deterministic' };
  await fs.writeFile(file, JSON.stringify(config)); return root;
}
async function session(root, entries) {
  const p = await prepareProject(root);
  await recordProjectSession(root, p.session.id, entries);
  // This fixture exercises explicit manual assisted Sync, so leave evidence pending.
  await closeProjectSession(root, p.session.id, [], false);
  return p.session.id;
}
const entry = (content, extra = {}) => ({ type: 'decision', title: 'Cache lifecycle', content, scopeHint: 'module', scopeRef: 'cache', ...extra });
const seed = (content, overrides = {}) => ({ id: 'mem_existing', scope: 'module', scopeRef: 'cache', category: 'decision', priority: 'important', status: 'active', title: 'Cache lifecycle', content, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', sourceSessions: ['sess_old'], derivedFrom: ['sess_old#obs_1'], supersedes: [], related: [], ...overrides });
const checkpoint = async (root, result) => JSON.parse(await fs.readFile(path.join(root, '.prodero/checkpoints', `${result.checkpoint}.json`)));


export { fixture, session, entry, seed, checkpoint };

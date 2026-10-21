import fs from 'node:fs/promises';
import {modeSchema, themeSchema} from '../settings-definition.js';
import {assertSafePath, projectDataPath, ensureSelfIgnoredPrivateDirectory, writeFileAtomic} from './storage.js';
import {ownsSyncLock} from './sync-transaction.js';

export const LOCAL_PREFERENCES_VERSION = 1;
const relativePath = 'local/preferences.json';
type Presentation = {mode?: ReturnType<typeof modeSchema.parse>; theme?: ReturnType<typeof themeSchema.parse>};
type Document = Record<string, unknown> & {version: 1; presentation?: Record<string, unknown>};
export interface PreferenceDiagnostic {code: string; cause: string; recovery: string}
interface Preferences {presentation: Presentation; document?: Document; diagnostics: PreferenceDiagnostic[]}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Extensions may round-trip, but a local file cannot masquerade as shared project policy.
const sharedKeys = new Set(['context', 'knowledgeEngine', 'schemaVersion', 'knowledgeSchemaVersion', 'initializedWith', 'lastUpdatedWith', 'projectId', 'createdAt', 'contextPolicy', 'authority', '__proto__', 'constructor', 'prototype']);
const forbidden = (key: string) => sharedKeys.has(key.split('.')[0]);
const diagnostic = (code: string, cause: string): PreferenceDiagnostic => ({code, cause,
 recovery: 'Preserve .prodero/local/preferences.json; repair it explicitly or use a compatible Curator before saving preferences.'});

/** Read-only: no creation, legacy copy, permission changes, recovery or cleanup. */
export async function readLocalPreferences(root: string): Promise<Preferences> {
 const fallback: Preferences = {presentation: {}, diagnostics: []};
 let raw: unknown;
 try {
  const target = projectDataPath(root, relativePath);
  await assertSafePath(target);
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe preference file');
  raw = JSON.parse(await fs.readFile(target, 'utf8'));
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
  return {...fallback, diagnostics: [diagnostic('PRODERO_LOCAL_PREFERENCES_UNAVAILABLE', 'Local preferences could not be safely read. Legacy project defaults are used.')]};
 }
 if (!object(raw) || raw.version !== LOCAL_PREFERENCES_VERSION) {
  const newer = object(raw) && Number.isInteger(raw.version) && Number(raw.version) > LOCAL_PREFERENCES_VERSION;
  return {...fallback, diagnostics: [diagnostic(newer ? 'PRODERO_LOCAL_PREFERENCES_NEWER' : 'PRODERO_LOCAL_PREFERENCES_INVALID',
   newer ? 'Local preferences require a newer Curator. Legacy project defaults are used.' : 'Local preferences have an invalid format. Legacy project defaults are used.')]};
 }
 if (Object.keys(raw).some(forbidden) || (raw.presentation !== undefined && (!object(raw.presentation) || Object.keys(raw.presentation).some(forbidden)))) {
  return {...fallback, diagnostics: [diagnostic('PRODERO_LOCAL_PREFERENCES_INVALID', 'Local preferences must contain presentation overrides only; shared policy or identity overrides are not supported.')]};
 }
 const presentation: Presentation = {}, diagnostics: PreferenceDiagnostic[] = [];
 for (const [key, schema] of [['mode', modeSchema], ['theme', themeSchema]] as const) {
  const value = (raw.presentation as Record<string, unknown> | undefined)?.[key];
  if (value === undefined) continue;
  const parsed = schema.safeParse(value);
  if (parsed.success) Object.assign(presentation, {[key]: parsed.data});
  else diagnostics.push(diagnostic('PRODERO_LOCAL_PREFERENCES_INVALID', `Local presentation.${key} is invalid; its legacy project default is used.`));
 }
 // Valid sibling fields can resolve, but writes never overwrite a damaged document.
 return {presentation, diagnostics, ...(diagnostics.length ? {} : {document: raw as Document})};
}

/** Caller owns the shared Sync/migration lock and has checked canonical write gates. */
export async function saveLocalPreference(root: string, key: 'mode' | 'theme', value: unknown, reset: boolean): Promise<void> {
 if (!ownsSyncLock(root)) throw new Error('Local preferences require the shared project writer lock.');
 if (key !== 'mode' && key !== 'theme') throw new Error('Only presentation mode and theme may be saved as local preferences.');
 if (reset && value !== undefined) throw new Error('Reset requires no value.');
 const parsed = reset ? undefined : (key === 'mode' ? modeSchema : themeSchema).parse(value);
 const current = await readLocalPreferences(root);
 if (current.diagnostics.length) {
  const issue = current.diagnostics[0];
  throw new Error(`${issue.code}: ${issue.cause} ${issue.recovery}`);
 }
 if (reset && current.document?.presentation?.[key] === undefined) return;
 const document: Document = current.document ?? {version: LOCAL_PREFERENCES_VERSION};
 const presentation = {...document.presentation};
 if (reset) delete presentation[key];
 else presentation[key] = parsed;
 await ensureSelfIgnoredPrivateDirectory(root, 'local');
 await writeFileAtomic(projectDataPath(root, relativePath), `${JSON.stringify({...document, presentation}, null, 2)}\n`);
}

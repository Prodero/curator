import { SETTINGS, settingKeySchema } from '../settings-definition.js';
import fs from 'node:fs/promises';
import { presentationConfigSchema } from '../settings-definition.js';
import { readConfig, writeConfig, projectDataPath, assertSafePath, exists } from './storage.js';
import { withSyncLock } from './sync-transaction.js';
import type { ProderoConfig } from './types.js';

export function effectiveSettings(config:ProderoConfig|null) {
 const values={'presentation.mode':config?.presentation?.mode,'presentation.theme':config?.presentation?.theme,'context.max_tokens':config?.context?.max_tokens ?? config?.context?.budgetTokens};
 return SETTINGS.map(def=>{
  const value=values[def.key] ?? def.defaultValue;
  const option='options' in def ? def.options.find(o=>o.id===value):undefined;
  return {key:def.key,group:def.group,label:def.label,description:option && 'description' in option ? option.description:def.description,type:def.type,value,
   displayValue:option?.label ?? (typeof value==='number'?`${value.toLocaleString('en-US')} ${'unit' in def ? def.unit:''}`.trim():String(value)),
   source:values[def.key]===undefined?'default' as const:'project override' as const,
   defaultValue:def.defaultValue,...('options' in def ? {options:def.options}:{}),...('min' in def ? {min:def.min,max:def.max}:{})};
 });
}
export async function projectSettings(root:string) {
 let config:ProderoConfig|null;
 try {config=await readConfig(root);} catch(error) {
  // Presentation preferences are metadata, never a permission to read/write newer knowledge.
  const marker=projectDataPath(root,'.transactions/migration.json');await assertSafePath(marker);
  if(!String(error).includes('SCHEMA_NEWER') && !await exists(marker))throw error;
  const file=projectDataPath(root,'config.json');await assertSafePath(file);
  let raw;try{raw=JSON.parse(await fs.readFile(file,'utf8'));}catch{raw={};}
  const presentation=presentationConfigSchema.safeParse(raw?.presentation);
  config={presentation:presentation.success?presentation.data:undefined} as ProderoConfig;
 }
 const settings=effectiveSettings(config);
 return {root,initialized:config!==null,settings,presentation:{mode:config?.presentation?.mode ?? SETTINGS[0].defaultValue,theme:config?.presentation?.theme ?? SETTINGS[1].defaultValue}};
}
export function renderSettings(view:Awaited<ReturnType<typeof projectSettings>>) {
 const lines=['Prodero · Project Settings'];
 for(const group of [...new Set(view.settings.map(s=>s.group))]) {
  lines.push(group);
  for(const s of view.settings.filter(s=>s.group===group)) lines.push(`${s.label}: ${s.displayValue} (${s.source})`,s.description);
 }
 if(!view.initialized) lines.push('Project is not initialized. Defaults are shown; initialize Prodero before saving settings.');
 return lines.join('\n\n');
}
export async function setProjectSetting(root:string,key:unknown,value:unknown) {
 const name=settingKeySchema.parse(key),def=SETTINGS.find(s=>s.key===name)!;
 const parsed=def.validation.parse(value);
 if(!await readConfig(root)) throw new Error('Initialize Prodero before changing project settings.');
 return withSyncLock(root,async()=>{
  const config=(await readConfig(root))!;
  switch(name) {
   case 'presentation.mode':config.presentation={...config.presentation,mode:parsed as NonNullable<ProderoConfig['presentation']>['mode']};break;
   case 'presentation.theme':config.presentation={...config.presentation,theme:parsed as NonNullable<ProderoConfig['presentation']>['theme']};break;
   case 'context.max_tokens':config.context={...config.context,max_tokens:parsed as number};break;
  }
  await writeConfig(root,config);
  return projectSettings(root);
 },{waitMs:5000});
}

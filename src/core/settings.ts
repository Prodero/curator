import { SETTINGS, settingKeySchema } from '../settings-definition.js';
import fs from 'node:fs/promises';
import { presentationConfigSchema } from '../settings-definition.js';
import { readConfig, writeConfig, projectDataPath, assertSafePath, exists, assertSupportedSchema, assertSupportedKnowledgeSchema } from './storage.js';
import { withSyncLock } from './sync-transaction.js';
import type { ProderoConfig } from './types.js';
import {readLocalPreferences, saveLocalPreference} from './local-preferences.js';
async function supportedConfig(root:string) {
 const config=await readConfig(root);
 if(config){assertSupportedSchema(config.schemaVersion);assertSupportedKnowledgeSchema(config.knowledgeSchemaVersion);}
 return config;
}

export function effectiveSettings(config:ProderoConfig|null, local:Awaited<ReturnType<typeof readLocalPreferences>>['presentation']={}) {
 const legacy={'presentation.mode':config?.presentation?.mode,'presentation.theme':config?.presentation?.theme,'context.max_tokens':config?.context?.max_tokens ?? config?.context?.budgetTokens};
 const overrides={'presentation.mode':local.mode,'presentation.theme':local.theme,'context.max_tokens':undefined};
 const values={...legacy,'presentation.mode':local.mode ?? legacy['presentation.mode'],'presentation.theme':local.theme ?? legacy['presentation.theme']};
 return SETTINGS.map(def=>{
  const value=values[def.key] ?? def.defaultValue;
  const option='options' in def ? def.options.find(o=>o.id===value):undefined;
  return {key:def.key,group:def.group,label:def.label,description:option && 'description' in option ? option.description:def.description,type:def.type,value,
   displayValue:option?.label ?? (typeof value==='number'?`${value.toLocaleString('en-US')} ${'unit' in def ? def.unit:''}`.trim():String(value)),
   source:overrides[def.key]!==undefined?'local override' as const:legacy[def.key]===undefined?'default' as const:def.group==='Presentation'?'legacy project default' as const:'project override' as const,
   defaultValue:def.defaultValue,...('options' in def ? {options:def.options}:{}),...('min' in def ? {min:def.min,max:def.max}:{})};
 });
}
export async function projectSettings(root:string) {
 let config:ProderoConfig|null;
 try {config=await supportedConfig(root);} catch(error) {
  // Presentation preferences are metadata, never a permission to read/write newer knowledge.
  const marker=projectDataPath(root,'.transactions/migration.json');await assertSafePath(marker);
  if(!String(error).includes('SCHEMA_NEWER') && !await exists(marker))throw error;
  const file=projectDataPath(root,'config.json');await assertSafePath(file);
  let raw;try{raw=JSON.parse(await fs.readFile(file,'utf8'));}catch{raw={};}
  const presentation=presentationConfigSchema.safeParse(raw?.presentation);
  config={presentation:presentation.success?presentation.data:undefined} as ProderoConfig;
 }
 const local=await readLocalPreferences(root),settings=effectiveSettings(config,local.presentation);
 return {root,initialized:config!==null,settings,presentation:{mode:local.presentation.mode ?? config?.presentation?.mode ?? SETTINGS[0].defaultValue,theme:local.presentation.theme ?? config?.presentation?.theme ?? SETTINGS[1].defaultValue},
  presentationSources:{mode:settings[0].source,theme:settings[1].source},diagnostics:local.diagnostics};
}
export function renderSettings(view:Awaited<ReturnType<typeof projectSettings>>) {
 const lines=['Prodero · Project Settings'];
 for(const group of [...new Set(view.settings.map(s=>s.group))]) {
  lines.push(group);
  for(const s of view.settings.filter(s=>s.group===group)) lines.push(`${s.label}: ${s.displayValue} (${s.source})`,s.description);
 }
 lines.push('Display mode and theme are saved on this checkout. Context budget is shared project configuration.');
 for(const diagnostic of view.diagnostics)lines.push(`${diagnostic.code}: ${diagnostic.cause}`,diagnostic.recovery);
 if(!view.initialized) lines.push('Project is not initialized. Defaults are shown; initialize Prodero before saving settings.');
 return lines.join('\n\n');
}
export async function setProjectSetting(root:string,key:unknown,value:unknown,options:{reset?:boolean}={}) {
 const name=settingKeySchema.parse(key),def=SETTINGS.find(s=>s.key===name)!;
 const reset=options.reset===true;
 if(reset && (value!==undefined || name==='context.max_tokens'))throw new Error('Reset requires a presentation key and no value.');
 const parsed=reset?undefined:def.validation.parse(value);
 if(!await supportedConfig(root)) throw new Error('Initialize Prodero before changing project settings.');
 return withSyncLock(root,async()=>{
  const config=await supportedConfig(root);
  if(!config)throw new Error('Initialize Prodero before changing project settings.');
  switch(name) {
   case 'presentation.mode':case 'presentation.theme':
    await saveLocalPreference(root,name==='presentation.mode'?'mode':'theme',parsed,reset);
    return projectSettings(root);
   case 'context.max_tokens':config.context={...config.context,max_tokens:parsed as number};break;
  }
  await writeConfig(root,config);
  return projectSettings(root);
 },{waitMs:5000,...(name==='context.max_tokens'?{}:{recoverLifecycle:false,maintainIntegration:false})});
}

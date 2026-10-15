import { publicEntry, verifyPublicEntry } from './public-entry.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {PRODERO_VERSION} from '../core/constants.js';
import {adapters,executable,block,replaceBlock,LAUNCHER,GLOBAL_START,GLOBAL_END,MCP_START,MCP_END,type HostAdapter,type Entry} from './adapters.js';
import {IntegrationError,fail,read,transact,type Change} from './files.js';

const legacyReceiptSchema=z.object({format:z.literal(1),host:z.enum(['codex','claude']),config:z.string(),launcherPath:z.string(),entry:z.object({command:z.string(),args:z.array(z.string()),type:z.string().optional(),env:z.record(z.string()).optional()}).strict(),launcher:z.string(),mcpBlock:z.string().nullable(),originalConfig:z.string().nullable(),originalLauncher:z.string().nullable(),installedConfig:z.string(),installedLauncher:z.string()}).strict();
const runtimeEntrySchema=legacyReceiptSchema.shape.entry;
export const receiptSchema=z.union([
 legacyReceiptSchema,
 legacyReceiptSchema.extend({format:z.literal(2),runtime:z.object({mode:z.enum(['package','dev']),packageEntry:runtimeEntrySchema,devRoot:z.string().nullable(),devEntry:runtimeEntrySchema.nullable()}).strict()}).strict(),
]);
export type Receipt=z.infer<typeof receiptSchema>;
export interface MachineOptions {home?:string;env?:NodeJS.ProcessEnv;entryPoint?:string}
export interface HostStatus {id:string;name:string;support:string;detected:boolean;mcpConfigured:boolean|null;launcherInstalled:boolean|null;state:string;message:string;runtimeMode?:'package'|'dev'}
const stable=(v:unknown):string=>JSON.stringify(v,(_k,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
const errorStatus=(base:HostStatus,e:unknown):HostStatus=>({...base,mcpConfigured:null,launcherInstalled:null,state:e instanceof IntegrationError?e.code==='HOST_CONFLICT'?'conflicted':e.code==='HOST_RECOVERY_REQUIRED'?'recovery-required':'unsupported-configuration':'unsupported-configuration',message:e instanceof IntegrationError?e.message:'HOST_CONFIGURATION_ERROR: Cannot safely read or update host settings. Check file access and restore valid configuration; no configuration contents are shown.'});
export function environment(options:MachineOptions){
 const env=options.env??process.env,home=options.home??env.HOME??os.homedir();
 if(!path.isAbsolute(home)||(env.XDG_STATE_HOME&&!path.isAbsolute(env.XDG_STATE_HOME)))fail('HOST_UNSUPPORTED_PATH','HOME and integration state overrides must be absolute paths. No files changed.');
 return {env,home:path.resolve(home),state:path.join(env.XDG_STATE_HOME||path.join(home,'.local/state'),'prodero/host-integrations'),entryPoint:options.entryPoint??fileURLToPath(new URL('../cli.js',import.meta.url))};
}
export function expectedEntry(host:HostAdapter,entryPoint:string,env:NodeJS.ProcessEnv=process.env):Entry {return publicEntry(host.id,entryPoint,env);}
export async function inspect(host:HostAdapter,options:ReturnType<typeof environment>,remove=false,adoptDev=false){
 const {home,env,state,entryPoint}=options,dir=path.join(state,host.id),receiptPath=path.join(dir,'receipt.json');
 const detected=await host.detect();
 const base:HostStatus={id:host.id,name:host.name,support:host.support,detected,mcpConfigured:false,launcherInstalled:false,state:'not-detected',message:'Agent not detected.'};
 let receipt:Receipt|undefined;
 const saved=await read(home,receiptPath);
 if(saved!==null){const parsed=receiptSchema.safeParse(JSON.parse(saved));if(!parsed.success)fail('HOST_UNSUPPORTED_CONFIG','Invalid integration receipt. Restore the private receipt or review integration manually.');receipt=parsed.data;if(receipt.host!==host.id||receipt.config!==host.config||!host.launchers.includes(receipt.launcherPath))fail('HOST_CONFLICT','Host configuration location changed. Review the original managed integration before reinstalling.');}
 if(await read(home,path.join(dir,'pending.json'))!==null)fail('HOST_RECOVERY_REQUIRED','Preserved private integration journal requires manual recovery before another write.');
 if(await fs.lstat(path.join(dir,'lock')).catch(()=>null))fail('HOST_RECOVERY_REQUIRED','An integration lock exists. Close other installers; inspect private state if an operation was interrupted.');
 const launcherPath=receipt?.launcherPath??host.launcher;
 if(!remove&&receipt&&launcherPath!==host.launcher)fail('HOST_CONFLICT','A global instruction override now shadows the installed launcher. Uninstall first, then reinstall for the active global file.');
 const config=await read(home,host.config),launcher=await read(home,launcherPath);
 // Do not install a second block hidden in Codex's inactive global instruction file.
 // Removal can still clean up the receipt-owned file without touching the other one.
 if(!remove)for(const other of host.launchers.filter(p=>p!==launcherPath)){
  if(block(await read(home,other)??'',GLOBAL_START,GLOBAL_END))fail('HOST_CONFLICT','Another global instruction file contains a Prodero launcher. Reconcile the existing launcher before installing.');
 }
 const text=config??(host.id==='claude'?'{}\n':'');host.inspectConfig(text);
 if(receipt?.originalConfig!==null&&receipt?.originalConfig!==undefined)host.inspectConfig(receipt.originalConfig);
 const current=host.entry(text),owned=block(launcher??'',GLOBAL_START,GLOBAL_END),mcp=host.id==='codex'?block(text,MCP_START,MCP_END):null;
 base.mcpConfigured=current!==undefined;base.launcherInstalled=Boolean(owned);
 const alternate=host.alternateEntry?.(text) as {enabled?:unknown;command?:unknown;args?:unknown;url?:unknown}|undefined;
 if(!remove&&alternate!==undefined&&(host.id==='claude'||alternate?.enabled!==false||(adoptDev&&!receipt&&current===undefined&&!mcp))){
  const valid=alternate&&typeof alternate==='object'&&((typeof alternate.command==='string'&&alternate.command.trim()&&(alternate.args===undefined||(Array.isArray(alternate.args)&&alternate.args.every(a=>typeof a==='string'))))||(typeof alternate.url==='string'&&/^https?:\/\//.test(alternate.url)));
  if(!valid)fail('HOST_UNSUPPORTED_CONFIG',`Invalid prodero-dev connection in ${host.config}. Review its command or URL before installing.`);
  if(current!==undefined||receipt||mcp)fail('HOST_CONFLICT',`Both prodero-dev and a prodero installation are present in ${host.config}. Disable one connection before continuing.`);
  base.mcpConfigured=true;
  base.state=owned?'externally-configured':'external-incomplete';
  base.message=owned?`Already configured through prodero-dev (managed manually). Settings: ${host.config}. No second server will be installed.`:`prodero-dev is configured in ${host.config}, but the global launcher is missing in ${launcherPath}. Review this manual setup before installing; no second server will be added.`;
  return {base,receipt,receiptPath,saved,dir,config,text,launcher,launcherPath,desired:expectedEntry(host,entryPoint,env)};
 }
 if(!receipt&&(current!==undefined||owned||mcp))fail('HOST_CONFLICT',`Existing Prodero configuration has no ownership receipt. Review ${current!==undefined||mcp?host.config:launcherPath}; back up and reconcile only the Prodero entry/block before installing.`);
 if(receipt){
  if(current!==undefined&&stable(current)!==stable(receipt.entry))fail('HOST_CONFLICT','The managed Prodero MCP entry was modified. Preserve your changes and review before reinstalling/uninstalling.');
  if(owned&&owned.text!==receipt.launcher)fail('HOST_CONFLICT','The managed launcher was modified. Preserve your changes and review its block before reinstalling/uninstalling.');
  if(host.id==='codex'&&((mcp&&mcp.text!==receipt.mcpBlock)||(current!==undefined&&!mcp)))fail('HOST_CONFLICT','The managed Codex MCP block was modified or lost its boundaries.');
 }
 if(receipt?.format===2){
  const runtime=receipt.runtime;
  if((runtime.mode==='dev'&&(!runtime.devRoot||!path.isAbsolute(runtime.devRoot)||!runtime.devEntry))||stable(receipt.entry)!==stable(runtime.mode==='dev'?runtime.devEntry:runtime.packageEntry))fail('HOST_UNSUPPORTED_CONFIG','Runtime receipt is inconsistent. Restore the private receipt before switching.');
 }
 base.runtimeMode=receipt?.format===2?receipt.runtime.mode:receipt?'package':undefined;
 const desired=receipt?.format===2&&receipt.runtime.mode==='dev'?{...expectedEntry(host,entryPoint,env),args:receipt.runtime.devEntry!.args[0]==='mcp'?receipt.runtime.devEntry!.args:['mcp','--dev']}:expectedEntry(host,entryPoint,env);
 base.state=receipt?(current!==undefined&&owned&&stable(current)===stable(desired)&&owned.text===LAUNCHER?'installed':'outdated'):detected?'not-configured':'not-detected';
 base.message=base.state==='installed'?'MCP configured; launcher installed. Restart the host after package updates.':base.state==='outdated'?'Managed integration is missing or outdated. Run prodero install to update it.':detected?'Agent detected; Prodero not configured.':'Agent not detected.';
 return {base,receipt,receiptPath,saved,dir,config,text,launcher,launcherPath,desired};
}
export async function machineIntegrations(action:'status'|'install'|'uninstall',selection:string|undefined,options:MachineOptions={}){
 if(selection&&!['all','codex','claude','cursor'].includes(selection))fail('HOST_UNKNOWN','Unknown host. Choose codex or claude, or use --all.');
 const ctx=environment(options);
 if(action==='install'&&!options.entryPoint&&await fs.stat(path.resolve(path.dirname(ctx.entryPoint),'../src/cli.ts')).catch(()=>null))fail('HOST_UNPACKAGED_RUNTIME','Install @prodero/cli from npm or a release tarball before configuring hosts. Development checkout launchers are not registered.');
 const hosts=await adapters(ctx.home,ctx.env,selection);const results:HostStatus[]=[];
 for(const host of hosts){if(selection&&selection!=='all'&&selection!==host.id)continue;
  let base:HostStatus={id:host.id,name:host.name,support:host.support,detected:await host.detect(),mcpConfigured:false,launcherInstalled:false,state:'not-configured',message:''};
  try{
   const view=await inspect(host,ctx,action==='uninstall');base=view.base;
   if(action==='status'||(action==='install'&&(base.state==='externally-configured'||base.state==='external-incomplete'||(!base.detected&&!view.receipt)))){results.push(base);continue;}
   const {receipt,receiptPath,saved,dir,config,text,launcher,launcherPath,desired}=view;
   if(action==='uninstall'&&!receipt){results.push({...base,message:'No managed integration to remove. Existing project knowledge remains intact.'});continue;}
   let nextConfig:string|null,nextLauncher:string|null,nextReceipt:string|null;
   if(action==='install'){
    // All parsing and ownership checks happen before the first write.
    await verifyPublicEntry(desired);
    nextConfig=host.edit(text,desired);nextLauncher=replaceBlock(launcher??'',GLOBAL_START,GLOBAL_END,LAUNCHER);
    const next:Receipt={...(receipt?.format===2?{format:2 as const,runtime:{...receipt.runtime,packageEntry:expectedEntry(host,ctx.entryPoint,ctx.env),...(receipt.runtime.mode==='dev'?{devEntry:desired}:{})}}:{format:1 as const}),host:host.id,config:host.config,launcherPath,entry:desired,launcher:LAUNCHER,mcpBlock:host.id==='codex'?block(nextConfig,MCP_START,MCP_END)!.text:null,originalConfig:receipt?receipt.originalConfig:config,originalLauncher:receipt?receipt.originalLauncher:launcher,installedConfig:nextConfig,installedLauncher:nextLauncher};
    // An unchanged installation must not rewrite JSON formatting or the ownership receipt.
    if(base.state==='installed'){results.push(base);continue;}
    nextReceipt=JSON.stringify(next,null,2)+'\n';
   }else{
    nextConfig=config===receipt!.installedConfig?receipt!.originalConfig:config===null?null:host.edit(text,undefined);
    nextLauncher=launcher===receipt!.installedLauncher?receipt!.originalLauncher:launcher===null?null:replaceBlock(launcher,GLOBAL_START,GLOBAL_END,undefined);
    nextReceipt=null;
   }
   const changes:Change[]=[{path:host.config,before:config,after:nextConfig},{path:launcherPath,before:launcher,after:nextLauncher},{path:receiptPath,before:saved,after:nextReceipt}];
   await transact(ctx.home,dir,changes);
   results.push({...base,mcpConfigured:action==='install',launcherInstalled:action==='install',state:action==='install'?'installed':'not-configured',message:action==='install'?'Managed MCP and minimal launcher installed. Restart the host; open a repository and type prodero.':'Managed MCP and launcher removed. Existing project knowledge and project instructions remain intact.'});
  }catch(e){results.push(errorStatus(base,e));}
 }
 if(!selection||selection==='all'||selection==='cursor')results.push({id:'cursor',name:'Cursor',support:'unimplemented',detected:await executable('cursor',ctx.env)||Boolean(await fs.lstat(path.join(ctx.home,'.cursor')).catch(()=>null)),mcpConfigured:false,launcherInstalled:false,state:'unsupported',message:'Detection only; Cursor configuration is not modified.'});
 const failed=results.some(r=>['conflicted','unsupported-configuration','recovery-required','external-incomplete'].includes(r.state))||(action==='install'&&selection!==undefined&&selection!=='all'&&results.every(r=>!r.detected||r.support==='unimplemented'));
 return {ok:!failed,version:PRODERO_VERSION,scope:'machine',action,hosts:results,...(action==='uninstall'?{message:'Existing project knowledge and project instructions remain intact.'}:{})};
}

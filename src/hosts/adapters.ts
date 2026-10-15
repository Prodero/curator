import { PRESENTATION_LAUNCHER } from "../presentation.js";
import fs from 'node:fs/promises';
import path from 'node:path';
import {parse as parseToml} from 'smol-toml';
import {parseTree,modify,applyEdits,type Node as JsonNode} from 'jsonc-parser';
import {fail} from './files.js';
export type Entry = {command:string;args:string[];type?:string;env?:Record<string,string>};
export interface HostAdapter {
 id:'codex'|'claude';name:string;support:'supported'|'experimental';
 config:string;launchers:string[];launcher:string;
 detect():Promise<boolean>;
 inspectConfig(text:string):unknown;
 entry(text:string):unknown;
 alternateEntry?(text:string):unknown;
 removeAlternate(text:string):string;
 edit(text:string,value:Entry|undefined):string;
}
export const MCP_START='# prodero:mcp-start',MCP_END='# prodero:mcp-end';
export const GLOBAL_START='<!-- prodero:global-start -->',GLOBAL_END='<!-- prodero:global-end -->';
export const LAUNCHER=`${GLOBAL_START}\n## Prodero launcher\n\n${PRESENTATION_LAUNCHER} The connected server resolves the current workspace from the host. Omit \`projectRoot\` normally; use it only to select among host-authorized roots. New projects initialize through Prodero MCP without shell setup.\n${GLOBAL_END}`;
export function block(text:string,start:string,end:string):{text:string;start:number;end:number}|null{
 const a=text.indexOf(start),b=text.indexOf(end);
 if(a<0&&b<0)return null;
 if(a<0||b<a||text.indexOf(start,a+start.length)>=0||text.indexOf(end,b+end.length)>=0)fail('HOST_CONFLICT','Managed boundaries are missing, duplicated or ambiguous. Review them manually.');
 return {text:text.slice(a,b+end.length),start:a,end:b+end.length};
}
export function replaceBlock(text:string,start:string,end:string,value:string|undefined){
 const found=block(text,start,end);
 if(found)return text.slice(0,found.start)+(value??'')+text.slice(found.end);
 return value===undefined?text:text+(text&&!text.endsWith('\n')?'\n':'')+(text?'\n':'')+value+'\n';
}
export function strictJson(text:string):Record<string,unknown>{
 if(!text.trim())fail('HOST_INVALID_CONFIG','Empty JSON host configuration. Restore valid JSON before retrying.');
 const errors:unknown[]=[];const tree=parseTree(text,errors as never[],{allowTrailingComma:false,disallowComments:true});
 const check=(node:JsonNode)=>{if(node.type==='object'){const keys=node.children?.map(c=>c.children![0].value)??[];if(new Set(keys).size!==keys.length)fail('HOST_INVALID_CONFIG','Duplicate keys in host JSON. Resolve ambiguity before retrying.');}node.children?.forEach(check);};
 if(errors.length||!tree||tree.type!=='object')fail('HOST_INVALID_CONFIG','Malformed JSON host configuration. Restore valid JSON before retrying.');check(tree!);
 return JSON.parse(text);
}
function toml(text:string):Record<string,any>{try{return parseToml(text);}catch{fail('HOST_INVALID_CONFIG','Malformed or ambiguous Codex TOML. Restore valid configuration before retrying.');}}
function map(value:unknown){if(value!==undefined&&(!value||typeof value!=='object'||Array.isArray(value)))fail('HOST_UNSUPPORTED_CONFIG','MCP settings must be an object/table. No files changed.');return value as Record<string,unknown>|undefined;}
export async function adapters(home:string,env:NodeJS.ProcessEnv,selection?:string):Promise<HostAdapter[]>{
 // Relative overrides would make machine installation depend on the current project.
 for(const key of (selection==='codex'?['CODEX_HOME']:selection==='claude'?['CLAUDE_CONFIG_DIR']:['CODEX_HOME','CLAUDE_CONFIG_DIR']))if(env[key]&&!path.isAbsolute(env[key]!))fail('HOST_UNSUPPORTED_PATH','Host configuration overrides must be absolute paths inside the user home. No files changed.');
 const codex=env.CODEX_HOME?path.resolve(env.CODEX_HOME):path.join(home,'.codex');
 const claude=env.CLAUDE_CONFIG_DIR?path.resolve(env.CLAUDE_CONFIG_DIR):path.join(home,'.claude');
 const launchers=[path.join(codex,'AGENTS.md'),path.join(codex,'AGENTS.override.md')];
 const override=selection==='claude'?null:await fs.lstat(launchers[1]).catch(()=>null);
 const result:HostAdapter[]=[{id:'codex',name:'Codex',support:'supported',config:path.join(codex,'config.toml'),launchers,launcher:override&&override.size>0?launchers[1]:launchers[0],
 async detect(){return await executable('codex',env)||Boolean(await fs.lstat(this.config).catch(()=>null));},
 inspectConfig:toml,entry(text){return map(toml(text).mcp_servers)?.prodero;},
 alternateEntry(text){return map(toml(text).mcp_servers)?.['prodero-dev'];},
 removeAlternate:removeCodexDev,
 edit(text,value){
  const stanza=value?`${MCP_START}\n[mcp_servers.prodero]\ncommand = ${JSON.stringify(value.command)}\nargs = ${JSON.stringify(value.args)}\n${value.env ? `env = { ${Object.entries(value.env).map(([k,v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(", ")} }\n` : ""}${MCP_END}`:undefined;
  const next=replaceBlock(text,MCP_START,MCP_END,stanza);toml(next);return next;
 }},
 {id:'claude',name:'Claude Code',support:'experimental',config:env.CLAUDE_CONFIG_DIR?path.join(claude,'.claude.json'):path.join(home,'.claude.json'),launchers:[path.join(claude,'CLAUDE.md')],launcher:path.join(claude,'CLAUDE.md'),
 async detect(){return await executable('claude',env)||Boolean(await fs.lstat(this.config).catch(()=>null));},
 inspectConfig:strictJson,entry(text){return map(strictJson(text).mcpServers)?.prodero;},
 alternateEntry(text){return map(strictJson(text).mcpServers)?.['prodero-dev'];},
 removeAlternate(text){return applyEdits(text,modify(text,['mcpServers','prodero-dev'],undefined,{formattingOptions:{insertSpaces:true,tabSize:2,eol:'\n'}}));},
 edit(text,value){const next=applyEdits(text,modify(text,['mcpServers','prodero'],value,{formattingOptions:{insertSpaces:true,tabSize:2,eol:'\n'}}));strictJson(next);return next;}
 }];
 return selection&&selection!=='all'?result.filter(host=>host.id===selection):result;
}
export async function executable(name:string,env:NodeJS.ProcessEnv):Promise<boolean>{
 for(const dir of (env.PATH??'').split(path.delimiter).filter(d=>path.isAbsolute(d))){try{const p=path.join(dir,name);await fs.access(p,fs.constants.X_OK);if((await fs.stat(p)).isFile())return true;}catch{}}
 return false;
}

/** Migrate an unambiguous dev table and optional adjacent env table; preserve unrelated bytes. */
function removeCodexDev(text:string):string {
 const before=toml(text);
 const headers=[...text.matchAll(/^\s*\[mcp_servers\.prodero-dev\][ \t]*(?:#[^\r\n]*)?\r?$/gm)];
 if(headers.length!==1)fail('HOST_UNSUPPORTED_CONFIG','Migration requires one standalone [mcp_servers.prodero-dev] table. Review other TOML forms manually.');
 const start=headers[0].index!,bodyStart=start+headers[0][0].length;
 const rest=text.slice(bodyStart);
 let next=/^\s*\[/m.exec(rest),end=next?bodyStart+next.index:text.length;
 // Native Codex configurations commonly serialize env as a separate child table.
 // Remove only this exact adjacent child; the semantic check below rejects any
 // remaining descendants or other structure we cannot preserve unambiguously.
 const envHeader=/^\s*\[mcp_servers\.prodero-dev\.env\][ \t]*(?:#[^\r\n]*)?\r?$/m.exec(text.slice(end));
 if(envHeader?.index===0){
  const afterEnv=end+envHeader[0].length;
  next=/^\s*\[/m.exec(text.slice(afterEnv));
  end=next?afterEnv+next.index:text.length;
 }
 const result=text.slice(0,start)+text.slice(end);
 delete before.mcp_servers['prodero-dev'];
 const after=toml(result);
 // Empty parent maps can disappear when their last child table is removed.
 if(before.mcp_servers&&Object.keys(before.mcp_servers).length===0)delete before.mcp_servers;
 if(after.mcp_servers&&Object.keys(after.mcp_servers).length===0)delete after.mcp_servers;
 const stable=(v:unknown):string=>JSON.stringify(v,(_k,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
 if(stable(before)!==stable(after))fail('HOST_UNSUPPORTED_CONFIG','Cannot remove the dev table without changing other TOML settings. Review the registration manually.');
 return result;
}

import {createInterface} from 'node:readline/promises';
import {runNpmUpdate,NpmUpdateError,type UpdateDependencies} from './core/npm-update.js';
const help=`Usage: prodero update [exact-version] [--yes]

Finish work and close Codex and Claude before updating. The terminal waits for
npm and verifies the installed CLI; reopen your applications and reconnect afterward.
Only an ordinary same-user global npm installation with Node 22.14–22.x/npm 10.9.x
is supported. Install scripts are disabled; project and host settings are untouched.

Without a version, an interactive terminal checks the latest public release.
Non-interactive use requires an exact stable version and --yes, confirming that
work has ended and applications are closed. Equal versions are a no-op; downgrades
are refused. No sudo, automatic application closing or package rollback is used.`;
/** Closing stdin or Ctrl-C at the maintenance prompt is a refusal. */
export function terminalConfirmation(question:string,input:NodeJS.ReadableStream=process.stdin,output:NodeJS.WritableStream=process.stdout):Promise<boolean>{
 const terminal=createInterface({input,output});
 return new Promise(resolve=>{let done=false;const finish=(answer:boolean)=>{if(done)return;done=true;terminal.close();resolve(answer);};terminal.once('close',()=>finish(false));terminal.once('SIGINT',()=>finish(false));terminal.question(question).then(answer=>finish(/^y(?:es)?$/i.test(answer.trim())),()=>finish(false));});
}
export async function updateCommand(args:string[],dependencies:UpdateDependencies={}):Promise<number>{
 if(args.length===1&&['--help','-h'].includes(args[0])){(dependencies.write??console.log)(help);return 0;}
 let yes=false,targetVersion:string|undefined;
 for(const arg of args){if(arg==='--yes'){if(yes)throw new NpmUpdateError('NPM_UPDATE_ARGUMENT','Specify --yes only once.');yes=true;}else if(arg.startsWith('-')||targetVersion!==undefined)throw new NpmUpdateError('NPM_UPDATE_ARGUMENT','Use prodero update [exact-version] [--yes].');else targetVersion=arg;}
 const write=dependencies.write??console.log;
 const confirm=dependencies.confirm??terminalConfirmation;
 try{const result=await runNpmUpdate({targetVersion,yes},{...dependencies,write,confirm,interactive:dependencies.interactive??Boolean(process.stdin.isTTY&&process.stdout.isTTY)});write(result.message);return result.exitCode;}
 catch(error){if(error instanceof NpmUpdateError){write(`${error.code}: ${error.message}`);return error.exitCode;}write('NPM_UPDATE_FAILED: Cannot complete or verify this update. Inspect this npm installation before retrying.');return 1;}
}

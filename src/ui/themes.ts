import { THEMES, type Theme } from '../settings-definition.js';
export { THEMES };
export type { Theme };
export function validTheme(value:unknown):Theme { return THEMES.some(t=>t.id===value)?value as Theme:'prodero'; }
type Scheme='light'|'dark';
/** Appearance is hydrated from effective checkout settings. Browser storage is never consulted. */
export function createThemeController(environment:{
 root:Pick<HTMLElement,'dataset'>;
 media?:Pick<MediaQueryList,'matches'|'addEventListener'|'removeEventListener'>;
 changed?:(theme:Theme,status:string,source:string)=>void;
}) {
 let selected:Theme='prodero',hostScheme:Scheme|undefined,project:string|undefined,generation=0;
 let persist:((root:string,theme:Theme)=>Promise<void>)|undefined;
 let resetPreference:((root:string)=>Promise<{theme:unknown;source:string}>)|undefined,source='default';
 const persisted=()=>source==='local override'?'Saved on this checkout.':source==='legacy project default'?'Using the legacy project default.':'Using the built-in default.';
 let status='Open a project to choose its theme.';
 const apply=()=>{
  const scheme=hostScheme ?? (environment.media ? environment.media.matches?'dark':'light':undefined);
  // The host/SDK owns data-theme (light/dark); keep project palettes separate.
  environment.root.dataset.proderoTheme=selected==='system'?(scheme==='light'?'light':scheme==='dark'?'dark-neon':'prodero'):selected;
  environment.changed?.(selected,status,source);
 };
 environment.media?.addEventListener?.('change',apply);apply();
 return {
  get selected(){return selected;},get project(){return project;},
  setProject(root:string,theme:unknown,save:(root:string,theme:Theme)=>Promise<void>,options?:{source?:string;notice?:string;reset?:(root:string)=>Promise<{theme:unknown;source:string}>}){
   generation++;project=root;persist=save;resetPreference=options?.reset;source=options?.source??'default';selected=validTheme(theme);status=persisted()+' System follows host appearance when available.'+(options?.notice?' '+options.notice:'');apply();
  },
  async select(value:unknown){
   if(!project || !persist)return;
   const chosen=validTheme(value),root=project,request=++generation;
   status='Saving checkout theme…';apply();
   try{await persist(root,chosen);if(request!==generation||root!==project)return;selected=chosen;source='local override';status=persisted();apply();}
   catch(error){if(request===generation&&root===project){status=error instanceof Error?error.message:'Could not save checkout theme.';apply();}}
  },
  async reset(){
   if(!project||!resetPreference||source!=='local override')return;
   const root=project,request=++generation;
   status='Resetting checkout theme…';apply();
   try{const result=await resetPreference(root);if(request!==generation||root!==project)return;selected=validTheme(result.theme);source=result.source;status=persisted();apply();}
   catch(error){if(request===generation&&root===project){status=error instanceof Error?error.message:'Could not reset checkout theme.';apply();}}
  },
  setHostTheme(value:unknown){if(value==='light'||value==='dark'){hostScheme=value;apply();}},
  dispose(){generation++;environment.media?.removeEventListener?.('change',apply);},
 };
}
function mountThemePicker(){
 const container=document.querySelector<HTMLElement>('#theme-settings');if(!container)return;
 container.innerHTML=`<details class="theme-picker"><summary>Appearance <span id="theme-current"></span></summary><fieldset><legend>Theme on this checkout</legend><div class="theme-options">${THEMES.map(t=>`<label style="--swatch:${t.swatch};--swatch-base:${t.base}"><input disabled type="radio" name="prodero-theme" value="${t.id}"><span class="theme-swatch" aria-hidden="true"></span><span>${t.label}</span></label>`).join('')}</div><p id="theme-persistence"></p><button type="button" id="theme-reset" hidden>Use project/default setting</button></fieldset></details>`;
 let media:MediaQueryList|undefined;try{media=window.matchMedia?.('(prefers-color-scheme: dark)');}catch{}
 const controller=createThemeController({root:document.documentElement,media,changed(selected,status,source){
  container.querySelector('#theme-current')!.textContent=THEMES.find(t=>t.id===selected)!.label;
  const busy=status.startsWith('Saving')||status.startsWith('Resetting');
  container.querySelectorAll<HTMLInputElement>('input').forEach(i=>{i.checked=i.value===selected;i.disabled=status.startsWith('Open a project')||busy;});
  const reset=container.querySelector<HTMLButtonElement>('#theme-reset')!;reset.hidden=source!=='local override';reset.disabled=busy;
  container.querySelector('#theme-persistence')!.textContent=status;
 }});
 container.addEventListener('change',event=>{const input=event.target;if(input instanceof HTMLInputElement && input.name==='prodero-theme')void controller.select(input.value);});
 container.querySelector('#theme-reset')!.addEventListener('click',()=>void controller.reset());
 return controller;
}
export const themeController=mountThemePicker();

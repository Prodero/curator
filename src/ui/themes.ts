import { THEMES, type Theme } from '../settings-definition.js';
export { THEMES };
export type { Theme };
export function validTheme(value:unknown):Theme { return THEMES.some(t=>t.id===value)?value as Theme:'prodero'; }
type Scheme='light'|'dark';
/** Appearance is hydrated from canonical project config. Browser storage is never consulted. */
export function createThemeController(environment:{
 root:Pick<HTMLElement,'dataset'>;
 media?:Pick<MediaQueryList,'matches'|'addEventListener'|'removeEventListener'>;
 changed?:(theme:Theme,status:string)=>void;
}) {
 let selected:Theme='prodero',hostScheme:Scheme|undefined,project:string|undefined,generation=0;
 let persist:((root:string,theme:Theme)=>Promise<void>)|undefined;
 let status='Open a project to choose its theme.';
 const apply=()=>{
  const scheme=hostScheme ?? (environment.media ? environment.media.matches?'dark':'light':undefined);
  // The host/SDK owns data-theme (light/dark); keep project palettes separate.
  environment.root.dataset.proderoTheme=selected==='system'?(scheme==='light'?'light':scheme==='dark'?'dark-neon':'prodero'):selected;
  environment.changed?.(selected,status);
 };
 environment.media?.addEventListener?.('change',apply);apply();
 return {
  get selected(){return selected;},get project(){return project;},
  setProject(root:string,theme:unknown,save:(root:string,theme:Theme)=>Promise<void>){
   generation++;project=root;persist=save;selected=validTheme(theme);status='Saved for this project. System follows host appearance when available.';apply();
  },
  async select(value:unknown){
   if(!project || !persist)return;
   const chosen=validTheme(value),root=project,request=++generation;
   status='Saving project theme…';apply();
   try{await persist(root,chosen);if(request!==generation||root!==project)return;selected=chosen;status='Saved for this project.';apply();}
   catch(error){if(request===generation&&root===project){status=error instanceof Error?error.message:'Could not save project theme.';apply();}}
  },
  setHostTheme(value:unknown){if(value==='light'||value==='dark'){hostScheme=value;apply();}},
  dispose(){generation++;environment.media?.removeEventListener?.('change',apply);},
 };
}
function mountThemePicker(){
 const container=document.querySelector<HTMLElement>('#theme-settings');if(!container)return;
 container.innerHTML=`<details class="theme-picker"><summary>Appearance <span id="theme-current"></span></summary><fieldset><legend>Project theme</legend><div class="theme-options">${THEMES.map(t=>`<label style="--swatch:${t.swatch};--swatch-base:${t.base}"><input disabled type="radio" name="prodero-theme" value="${t.id}"><span class="theme-swatch" aria-hidden="true"></span><span>${t.label}</span></label>`).join('')}</div><p id="theme-persistence"></p></fieldset></details>`;
 let media:MediaQueryList|undefined;try{media=window.matchMedia?.('(prefers-color-scheme: dark)');}catch{}
 const controller=createThemeController({root:document.documentElement,media,changed(selected,status){
  container.querySelector('#theme-current')!.textContent=THEMES.find(t=>t.id===selected)!.label;
  container.querySelectorAll<HTMLInputElement>('input').forEach(i=>{i.checked=i.value===selected;i.disabled=status.startsWith('Open a project')||status.startsWith('Saving');});
  container.querySelector('#theme-persistence')!.textContent=status;
 }});
 container.addEventListener('change',event=>{const input=event.target;if(input instanceof HTMLInputElement && input.name==='prodero-theme')void controller.select(input.value);});
 return controller;
}
export const themeController=mountThemePicker();

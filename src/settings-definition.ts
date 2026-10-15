import { z } from 'zod';
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from './core/telemetry.js';

export const THEMES = [
  { id: 'prodero', label: 'Current / Prodero', swatch: '#c6ff76', base: '#0b0d0c' },
  { id: 'dark-neon', label: 'Dark Neon', swatch: '#b6efff', base: '#020304' },
  { id: 'pink-neon', label: 'Pink Neon', swatch: '#ff63c5', base: '#090307' },
  { id: 'blue-neon', label: 'Blue Neon', swatch: '#55c9ff', base: '#020710' },
  { id: 'purple-neon', label: 'Purple Neon', swatch: '#b98aff', base: '#07030e' },
  { id: 'light', label: 'Light', swatch: '#3e6516', base: '#f7f9fc' },
  { id: 'system', label: 'System', swatch: '#a0adbd', base: '#f7f9fc' },
] as const;
export type Theme = typeof THEMES[number]["id"];
export const modeSchema=z.enum(['auto','ui','text']);
export const themeSchema=z.enum(['prodero','dark-neon','pink-neon','blue-neon','purple-neon','light','system']);
export const presentationConfigSchema=z.object({mode:modeSchema.optional(),theme:themeSchema.optional()}).passthrough();
export const SETTINGS = [
 {key:'presentation.mode',group:'Presentation',label:'Display mode',description:'Choose automatic display, interactive UI, or text for this project.',type:'enum',defaultValue:'auto',options:[{id:'auto',label:'Automatic',description:'Use MCP Apps when advertised, otherwise readable text.'},{id:'ui',label:'UI',description:'Prefer the interactive Prodero application for this project.'},{id:'text',label:'Text',description:'Use readable text for this project.'}],validation:modeSchema},
 {key:'presentation.theme',group:'Presentation',label:'Theme',description:'Visual theme used by Prodero for this project.',type:'enum',defaultValue:'prodero',options:THEMES,validation:themeSchema},
 {key:'context.max_tokens',group:'Context',label:'Task context budget',description:'Maximum Prodero context budget prepared for a task.',type:'integer',defaultValue:DEFAULT_CONTEXT_BUDGET_TOKENS,unit:'tokens',min:1,max:1000000,validation:z.number().int().min(1).max(1000000)},
] as const;
export const settingKeySchema=z.enum(['presentation.mode','presentation.theme','context.max_tokens']);
export const SETTINGS_ROUTING='For requests to show Prodero settings, project settings, or Prodero config, call prodero_config_get and show its friendly settings view. For project preference changes use prodero_config_set: text-only/text mode → presentation.mode=text; switch back to UI → presentation.mode=ui; automatic presentation → presentation.mode=auto; blue/purple neon → presentation.theme=blue-neon/purple-neon; context budget 8000 → context.max_tokens=8000. These are canonical project settings, never knowledge entries. Resolve the current project on each call. Read effective settings when choosing the text gateway; do not rely on a previous project or conversational preference.';

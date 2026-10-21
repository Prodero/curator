import { projectSettings } from "./core/settings.js";
import { z } from "zod";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { registerAppTool, getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { buildViewModel, renderText, PRESENTATION_REPLY, LIFECYCLE_PRESENTATION_REPLY, type PresentationMode } from "./presentation.js";
import { createPresentationCards } from './presentation-cards.js';
import { conversationOperation } from './conversation-presentation.js';
import { PRODERO_TOOLS } from './contracts.js';

export const PRESENTED_TOOLS = ["prodero_initialize","prodero_context","prodero_curation","prodero_curation_question","prodero_migrate","prodero_open","prodero_status","prodero_status_details","prodero_prepare","prodero_session_close","prodero_knowledge","prodero_knowledge_mutate","prodero_instruction_review","prodero_instruction_optimize","prodero_session_review","prodero_session_review_mutate","prodero_promotion_preview","prodero_promote","prodero_sync","prodero_memory_sync","prodero_skill_preview","prodero_skill_review"] as const;
const modeSchema=z.enum(["auto","ui","text"]).optional().describe("Optional invocation override; defaults to effective presentation.mode on this checkout (local preference, legacy project default, then built-in default). Auto uses advertised MCP Apps capability; UI prefers App; text supplies a compact conversational summary with details on request. Use prodero_text to guarantee no App attachment.");
export function resolvePresentation(mode:PresentationMode,capabilities:Parameters<typeof getUiCapability>[0]):"ui"|"text" {
  return mode === "auto" ? (getUiCapability(capabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ? "ui":"text") : mode;
}

/** Shared validated callbacks; project defaults are read afresh for each invocation. */
export function presentationTools(server:McpServer,resolveRoot:(explicit?:string)=>Promise<string>) {
  const cards = createPresentationCards();
  const groupSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/).optional().describe('Reuse one opaque presentationGroup for this conversation across UI calls so older cards collapse. Never reuse it in another conversation. Omit when unknown; lifecycle cards then group only by their exact session.');
  type Extra = Parameters<ToolCallback<z.ZodRawShape>>[1];
  const handlers=new Map<string,(args:Record<string,unknown>,extra:Extra)=>Promise<CallToolResult>>();
  type PresentationContext = { requested:PresentationMode; resolved:"ui"|"text" };
  type PresentedCallback<Shape extends z.ZodRawShape> = (input:Parameters<ToolCallback<Shape>>[0],extra:Extra,presentation?:PresentationContext)=>CallToolResult|Promise<CallToolResult>;
  function register<Shape extends z.ZodRawShape>(target:McpServer,name:string,config:{title?:string;description?:string;inputSchema:Shape;annotations?:ToolAnnotations;_meta?:Record<string,unknown>},handler:PresentedCallback<Shape>) {
    const hasUi = Boolean((config._meta?.ui as {resourceUri?:string} | undefined)?.resourceUri);
    if(!(PRESENTED_TOOLS as readonly string[]).includes(name)) return registerAppTool<z.ZodRawShape, z.ZodRawShape>(target,name,{...config,_meta:config._meta ?? {},...(hasUi ? {inputSchema:{...config.inputSchema,presentationGroup:groupSchema}} : {})},async(input,extra)=>{
      const {presentationGroup, ...args} = input;
      const result=await handler(args as Parameters<ToolCallback<Shape>>[0],extra);
      if(result.isError || !result.structuredContent)return result;
      const settings=await projectSettings(await resolveRoot(args.projectRoot as string|undefined));
      const resolved = resolvePresentation(settings.presentation.mode,server.server.getClientCapabilities());
      const group = groupSchema.parse(presentationGroup);
      const card = hasUi && resolved === 'ui' && group ? cards.issue(settings.root, `conversation:${group}`) : undefined;
      return {...result,structuredContent:{...result.structuredContent,projectSettings:{root:settings.root,presentation:settings.presentation,presentationSources:settings.presentationSources,diagnostics:settings.diagnostics},presentation:{requested:settings.presentation.mode,resolved,scope:"project",...(card ? {card} : {})}}};
    });
    const schema=z.object(config.inputSchema);
    const run=async (input:Record<string,unknown>,extra:Extra):Promise<CallToolResult> => {
      if(name===PRODERO_TOOLS.curationQuestion)z.object({...config.inputSchema,presentation:modeSchema,presentationGroup:groupSchema,details:z.boolean().optional(),diagnostics:z.boolean().optional(),plain:z.boolean().optional()}).strict().parse(input);
      const root=await resolveRoot(input.projectRoot as string | undefined);
      const settings=await projectSettings(root);
      const details=z.boolean().optional().parse(input.details);
      const diagnostics=z.boolean().optional().parse(input.diagnostics);
      const plain=z.boolean().optional().parse(input.plain);
      const requested=modeSchema.parse(input.presentation) ?? settings.presentation.mode;
      const presentationGroup = groupSchema.parse(input.presentationGroup);
      const resolved=resolvePresentation(requested,server.server.getClientCapabilities());
      // Parse using the original schema and strip presentation before invoking Core.
      const args=schema.parse({...input,projectRoot:root});
      const result=await handler(args as Parameters<ToolCallback<Shape>>[0],extra,{requested,resolved});
      if(result.isError || !result.structuredContent) return result;
      const payload=result.structuredContent;
      const viewModel=buildViewModel(payload);
      const sessionId = ['prepare','session-close'].includes(String(payload.action)) ? (payload.result as any)?.session?.id : undefined;
      const group = presentationGroup ? `conversation:${presentationGroup}` : sessionId ? `session:${sessionId}` : undefined;
      const card = resolved === 'ui' && hasUi && group ? cards.issue(root, group) : undefined;
      const operational = conversationOperation(payload, viewModel, details || diagnostics, diagnostics);
      // Skill preview already supplies its complete exact Markdown and approval guidance.
      // A generic compact projection must not discard that reviewed procedure.
      const skillCompanion = ['skill-preview','skill-review'].includes(String(payload.action)) ? result.content.find(c=>c.type==='text') : undefined;
      const humanText = skillCompanion?.type === 'text' ? skillCompanion.text : renderText(viewModel,diagnostics,details || diagnostics,plain);
      // A capable connection can still have a surface where its App is invisible.
      // Keep the existing compact lifecycle fallback; no extra Core call or card.
      const lifecycle = ['prepare','session-close'].includes(String(payload.action));
      const fallback = lifecycle ? ` ${LIFECYCLE_PRESENTATION_REPLY}\n\n${humanText}` : '';
      // UI already carries these full Core snapshots in result; retain only the
      // exact relay/action bindings alongside the fallback, avoiding duplication.
      const {context:_context,session:_session,automaticSync:_sync,...fallbackOperational}=operational;
      return {...result,content:resolved === "text" ? [{type:"text",text:humanText}, {type:"text",text:JSON.stringify({proderoOperation:operational}),annotations:{audience:["assistant"]}}] : [...result.content, {type:"text",text:PRESENTATION_REPLY+fallback+(viewModel.knowledgeTable?`\n\n${humanText}\n\n${JSON.stringify({knowledgeRows:operational.knowledgeRows,numberedActions:operational.numberedActions})}`:""),annotations:{audience:["assistant"]}}],
        structuredContent:{...payload,projectSettings:{root:settings.root,presentation:settings.presentation,presentationSources:settings.presentationSources,diagnostics:settings.diagnostics},presentation:{requested,resolved,scope:input.presentation === undefined ? "project":"invocation",actions:resolved === "text" ? operational.availableActions : viewModel.actions,...(resolved === "text" || lifecycle ? {text:humanText,operational:resolved === "text" ? operational : fallbackOperational} : {}),...(card ? {card} : {})}}};
    };
    handlers.set(name,(args,extra)=>run({...args,presentation:"text"},extra));
    if(name===PRODERO_TOOLS.curationQuestion)return target.registerTool(name,{...config,inputSchema:z.object({...config.inputSchema,presentation:modeSchema,presentationGroup:groupSchema,details:z.boolean().optional(),diagnostics:z.boolean().optional(),plain:z.boolean().optional()}).strict()},run);
    return registerAppTool<z.ZodRawShape, z.ZodRawShape>(target,name,{...config,_meta:config._meta ?? {},inputSchema:{...config.inputSchema,presentation:modeSchema,presentationGroup:groupSchema,details:z.boolean().optional().describe("Show full details and proposed wording instead of the compact summary."),plain:z.boolean().optional().describe("Use ASCII frame and meter glyphs when Unicode rendering is unsuitable."),diagnostics:z.boolean().optional().describe("Include technical diagnostics, allocation evidence and exact workflow data. Implies details.")}},run);
  }
  function registerGateway() {
    // Register after the server installs its diagnostic boundary. Registering a
    // tool during factory creation would initialize the SDK handlers too early.
    registerAppTool(server, PRODERO_TOOLS.uiCardState, {
      title: 'Prodero card display state',
      description: 'App-only ephemeral card coordination. No project reads or knowledge changes.',
      inputSchema: { cardId: z.string().uuid(), activate: z.boolean().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] } },
    }, async ({cardId, activate}) => ({content: [], structuredContent: cards.inspect(cardId, activate)}));
    server.registerTool("prodero_text",{
      title:"Prodero Text Presentation",
      description:PRESENTATION_REPLY + " Open Prodero as compact conversational text (details:true for full inspection), or present a covered lifecycle/knowledge tool without an MCP App attachment. Uses the original tool schema, Core operation and approval rules. Pass its normal arguments unchanged. Mutating operations require the same explicit human review. No preference is persisted. Relay presentation.text exactly as supplied, preserving code fences, entry letters and the external Pulse menu. Healthy Prepare continues automatically; details use its returned context snapshot, never repeat retrieval. Operational data are for the agent; use exact continuations for follow-up replies. Show full proposed wording before approval.",
      inputSchema:{tool:z.enum(PRESENTED_TOOLS).default("prodero_open"),arguments:z.record(z.unknown()).default({})},
      // Conservatively describe the entire gateway; never mark a mixed operation tool read-only.
      annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false},
    },async ({tool,arguments:args},extra)=>handlers.get(tool)!(args,extra));
  }
  return {register,registerGateway};
}

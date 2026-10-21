import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderTextError } from './text-layout.js';
import { publicDiagnostic } from "./core/diagnostics.js";

// Preserve only known protocol states, with fixed public prose. Never forward
// arbitrary plugin error payloads or client-supplied diagnostics.
const reviewMessages: Record<string,string> = {
  semantic_invalid:'Semantic reasoning input or saved state is invalid.',
  semantic_limit:'Semantic reasoning reached its bounded limit. Saved state was preserved.',
  semantic_stale:'Semantic reasoning input is obsolete. Inspect the current review.',
  dependency_blocked:'Selected changes require unresolved information or additional reviewed groups.',
  unsupported_review_schema:'This review uses a newer format. Update Prodero.',
  review_retention_full:'Saved review decisions reached the retention limit. No decisions were deleted.',
  review_paused:'Resume this review before applying changes.',
  stale_review:'Knowledge changed since this review.',
  invalid_review:'Review is unavailable. Analyze knowledge again.',
  invalid_selection:'Apply must match valid saved review decisions and complete groups.',
  project_mismatch:'Review belongs to another project.',
  review_changed:'Your review changed in another window. Reload your decisions.',
  review_too_large:'Review is too large. Reduce the review scope first.',
  recovery_required:'Finish the pending transaction before starting a new review.',
  review_unavailable:'This connection does not advertise MCP Apps support. Knowledge review is preview-only.',
};
/** Wrap the public request registration API, including SDK validation before tool handlers. */
export function installDiagnosticBoundary(server: McpServer): void {
  const register = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => register(schema, async (request, extra) => {
    try {
      const result = await handler(request, extra);
      if (result && typeof result === "object" && "isError" in result && result.isError) {
        const raw = result as { content?: Array<{ type: string; text?: string }>; structuredContent?: { error?: unknown; action?: unknown; code?: unknown; details?: unknown } };
        const state=raw.structuredContent;
        if(state?.action==='curation-review-error'&&typeof state.code==='string'&&Object.hasOwn(reviewMessages,state.code)){
          const message=reviewMessages[state.code];
          return {isError:true,content:[{type:'text',text:renderTextError(message)}],structuredContent:{ok:false,action:'curation-review-error',code:state.code,error:message,message,...(state.code==='dependency_blocked'?{details:safeDependencyDetails(state.details)}:{})}};
        }
        const message = raw.structuredContent?.error ?? raw.content?.find(item => item.type === "text")?.text;
        const safe = publicDiagnostic(message);
        // Drop arbitrary plugin error payloads too: they may contain rejected input.
        return { isError: true, content: [{ type: "text", text: renderTextError(safe) }], structuredContent: { ok: false, error: safe, message: safe, ...(safe.startsWith("POLICY_REVIEW_REQUIRED:")?{policyTransition:{decision:"review_required",blocking:true,preserved:true}}:{}) } };
      }
      return result;
    } catch (error) {
      if(error && typeof error==='object' && 'code' in error && typeof error.code==='string' && Object.hasOwn(reviewMessages,error.code)){
        const message=reviewMessages[error.code];
        return {isError:true,content:[{type:'text',text:renderTextError(message)}],structuredContent:{ok:false,action:'curation-review-error',code:error.code,error:message,message}};
      }
      throw new Error(publicDiagnostic(error));
    }
  });
}

function safeDependencyDetails(value:unknown) {
  const problems=(value as {problems?:unknown[]})?.problems;
  return {problems:Array.isArray(problems)?problems.slice(0,1000).flatMap((raw:any)=>typeof raw?.groupId==='string'&&/^item_[a-f0-9]{24}$/.test(raw.groupId)&&['incomplete','blocked','requires','partial_group'].includes(raw.reason)?[{groupId:raw.groupId,reason:raw.reason,missing:Array.isArray(raw.missing)?raw.missing.filter((v:unknown)=>typeof v==='string'&&/^(?:item|issue)_[a-f0-9]{24}$/.test(v)):[]}]:[]):[]};
}

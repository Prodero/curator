import { hasSecret } from "./secrets.js";

/** Public diagnostics never include parser source excerpts or rejected schema values. */
export function publicDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Operation failed";
  if (message.startsWith("PRODERO_") && !hasSecret(message)) return message;
  if (error instanceof SyntaxError || /Unexpected token|Unexpected end of JSON|not valid JSON|JSON at position/.test(message)) {
    return "PRODERO_INVALID_JSON: Invalid JSON input or stored data. Inspect the selected input/configuration or preserved transaction journal; restore valid data before retrying.";
  }
  if (/Input validation error|Output validation error|"code":\s*"(?:invalid_|too_|unrecognized_)/.test(message)) {
    return "PRODERO_INVALID_ARGUMENT: Tool arguments or metadata do not match the schema. Check the tool's field types and allowed values before retrying.";
  }
  if (hasSecret(message)) return "PRODERO_UNSAFE_DIAGNOSTIC: Rejected input contains a potential credential. Remove secrets and retry; the rejected value is omitted.";
  return message;
}

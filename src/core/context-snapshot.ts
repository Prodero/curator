import type { ContextResult } from "./types.js";

/** Associate the exact resolver result with its prepared session without copying canonical bodies. */
export function associatePreparedContext(context: ContextResult, sessionId: string): ContextResult {
  context.snapshot = { version: 1, sessionId, task: context.query };
  return context;
}

/** UI-safe, I/O-free lookup. Missing old/disposable state never triggers context resolution. */
export function preparedContextSnapshot(context: ContextResult | null | undefined): ContextResult | null {
  if (!context || context.snapshot?.version !== 1 || !context.snapshot.sessionId) return null;
  return context;
}

/** Temporary, opt-in wire observation. No tool/resource payloads are recorded. */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { PRODERO_RESOURCE_URI, PRODERO_TOOLS } from "./contracts.js";

const publicKeys = new Set(["experimental", "extensions", "io.modelcontextprotocol/ui", "mimeTypes", "roots", "listChanged", "sampling", "context", "tools", "elicitation", "form", "url", "tasks", "requests", "call", "createMessage", "create", "list", "cancel", "subscribe", "name", "version", "title", "platform", "userAgent", "clientInfo", "hostInfo", "clientId", "sessionId", "progressToken", "io.modelcontextprotocol/related-task", "taskId", "openai/userAgent", "openai/userLocation", "openai/locale", "openai/widgetSessionId", "ui", "protocolVersion"]);
const publicNames = new Set(["codex", "codex-mcp-client", "Codex", "claude-desktop", "Claude", "Cursor", "cursor", "claude-code"]);
let processFingerprintSalt: Buffer | undefined;
const versions = new Set(["2024-10-07", "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-01-26"]);

export function installPresentationTrace(server: McpServer): void {
  if (process.env.PRODERO_DEBUG_PRESENTATION !== "1") return;
  const connect = server.connect.bind(server);
  // Hashes permit equality checks within this process without storing unknown values.
  const salt = processFingerprintSalt ??= randomBytes(32);
  const fingerprint = (value: unknown) => createHmac("sha256", salt).update(JSON.stringify(value) ?? "undefined").digest("hex").slice(0, 24);
  function safe(value: unknown, key = "", depth = 0): unknown {
    if (depth > 6) return { redacted: true, fingerprint: fingerprint(value) };
    if (value === undefined) return null;
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if ((key === "mimeTypes" && value === RESOURCE_MIME_TYPE) || (key === "platform" && ["desktop", "mobile", "web"].includes(value)) || (key === "name" && publicNames.has(value)) || (key === "version" && /^\d+\.\d+\.\d+$/.test(value)) || (key === "protocolVersion" && versions.has(value))) return value;
      return { type: "string", fingerprint: fingerprint(value) };
    }
    if (typeof value === "number") return { type: "number", fingerprint: fingerprint(value) };
    if (Array.isArray(value)) return { items: value.slice(0, 32).map(item => safe(item, key, depth + 1)), truncated: value.length > 32, ...(value.length > 32 ? { fingerprint: fingerprint(value) } : {}) };
    if (typeof value === "object") return { ...Object.fromEntries(Object.entries(value).slice(0, 64).map(([k, v]) => [publicKeys.has(k) ? k : `key#${fingerprint(k)}`, safe(v, k, depth + 1)])), ...(Object.keys(value).length > 64 ? { traceTruncatedKeys: true, fingerprint: fingerprint(value) } : {}) };
    return { redacted: true };
  }
  server.connect = async (transport) => {
    const connection = randomUUID();
    let fd: number | undefined;
    let disabled = false;
    let sequence = 0;
    const destination = process.env.PRODERO_DEBUG_PRESENTATION_FILE;
    try {
      if (destination) {
        if (!path.isAbsolute(destination)) throw new Error("absolute path required");
        fd = openSync(destination, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("private regular file required");
      }
    } catch {
      if (fd !== undefined) closeSync(fd);
      fd = undefined;
      disabled = true;
      process.stderr.write("[prodero:presentation] Trace disabled: destination must be an owned private regular file at an absolute path.\n");
    }
    const emit = (event: string, details: Record<string, unknown> = {}) => {
      if (disabled || sequence >= 10000) return;
      try {
        let line = JSON.stringify({ trace: "prodero-presentation-v1", time: new Date().toISOString(), pid: process.pid, connection, sequence: ++sequence, event, ...details }) + "\n";
        if (line.length > 32768) line = JSON.stringify({ trace: "prodero-presentation-v1", time: new Date().toISOString(), pid: process.pid, connection, sequence, event, truncated: true }) + "\n";
        if (fd !== undefined) writeSync(fd, line);
        else process.stderr.write(line);
      } catch { disabled = true; } // Diagnostics never change a protocol result.
    };
    const snapshot = () => {
      const capabilities = server.server.getClientCapabilities();
      const ui = getUiCapability(capabilities);
      return { transportSession: safe(transport.sessionId), clientInfo: safe(server.server.getClientVersion()), capabilities: safe(capabilities), uiExtensionPresent: ui !== undefined, declaredMimeTypes: safe(ui?.mimeTypes, "mimeTypes"), supportsMcpAppHtml: Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(RESOURCE_MIME_TYPE) };
    };
    const pending = new Map<string | number, { event: string; call: number }>();
    let call = 0;
    function incoming(message: JSONRPCMessage) {
      if (!("method" in message)) return;
      const params = message.params as Record<string, unknown> | undefined;
      let event: string | undefined;
      if (message.method === "initialize") event = "initialize.request";
      else if (message.method === "tools/call" && params?.name === PRODERO_TOOLS.open) event = "open.request";
      else if (message.method === "tools/call" && params?.name === PRODERO_TOOLS.plugins) event = "control.request";
      else if (["tools/list", "resources/list", "resources/templates/list", "prompts/list", "ping"].includes(message.method)) event = "discovery.request";
      else if (message.method === "tools/call") { emit("other-tool.observed"); return; }
      else if (message.method === "resources/read" && params?.uri === PRODERO_RESOURCE_URI) event = "status-resource.read";
      else if (message.method === "notifications/initialized") { emit("mcp.initialized", snapshot()); return; }
      else if (message.method.startsWith("ui/")) { emit("ui.message.observed", { method: ["ui/initialize", "ui/notifications/initialized", "ui/notifications/size-changed", "ui/notifications/host-context-changed"].includes(message.method) ? message.method : safe(message.method), meta: safe(params?._meta) }); return; }
      if (!event) return;
      const number = ++call;
      if ("id" in message) { if (pending.size >= 256) pending.delete(pending.keys().next().value!); pending.set(message.id, { event, call: number }); }
      emit(event, { call: number, ...(event === "discovery.request" ? { method: message.method } : { meta: safe(params?._meta) }), ...(event === "initialize.request" ? { requestedProtocolVersion: safe(params?.protocolVersion, "protocolVersion"), clientInfo: safe(params?.clientInfo), capabilities: safe(params?.capabilities) } : snapshot()) });
    }
    function outgoing(message: JSONRPCMessage) {
      if (!("id" in message) || message.id === undefined || "method" in message) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      const result = "result" in message ? message.result : undefined;
      emit(request.event.replace(/request$|read$/, "response"), { call: request.call, outcome: "error" in message || result?.isError === true ? "error" : "ok", ...(request.event === "initialize.request" ? { negotiatedProtocolVersion: safe(result?.protocolVersion, "protocolVersion"), ...snapshot() } : {}) });
    }
    // Observe the public transport boundary, including the SDK-owned initialize handler.
    const wrapped: Transport = {
      onmessage: transport.onmessage,
      onerror: transport.onerror,
      onclose: transport.onclose,
      get sessionId() { return transport.sessionId; },
      setProtocolVersion: transport.setProtocolVersion?.bind(transport),
      async start() {
        transport.onmessage = (message, extra) => { try { incoming(message); } catch { /* fail open */ } wrapped.onmessage?.(message, extra); };
        transport.onerror = error => { emit("transport.error"); wrapped.onerror?.(error); };
        transport.onclose = () => { emit("connection.closed"); if (fd !== undefined) { try { closeSync(fd); } catch {} fd = undefined; } disabled = true; wrapped.onclose?.(); };
        await transport.start();
      },
      async send(message, options) { try { outgoing(message); } catch { /* fail open */ } await transport.send(message, options); },
      close: () => transport.close(),
    };
    emit("connection.started", { handshakeObservation: "passive-server-wire-only; app-host handshake normally does not reach server", fingerprintScope: "process", controlTool: PRODERO_TOOLS.plugins });
    try { await connect(wrapped); }
    catch (error) { if (fd !== undefined) { try { closeSync(fd); } catch {} } throw error; }
  };
}

import { publicDiagnostic } from "../core/diagnostics.js";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import { PRODERO_TOOL_NAMES } from "../contracts.js";
import type { PluginContext, PluginDefinition } from "./api.js";
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const relativeFile = z.string().min(1).max(240).refine(value => !path.isAbsolute(value) && !value.includes("\\") && value.split("/").every(p => p && p !== "." && p !== ".."), "Unsafe plugin resource path");
export const pluginManifestSchema = z.object({
    manifest_version: z.literal(1), api_version: z.literal(1), id: identifier,
    name: z.string().min(1).max(100), version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1).max(1000), capabilities: z.array(identifier).max(16),
    entrypoint: relativeFile.refine(p => p.endsWith(".cjs"), "v1 entrypoints use CommonJS .cjs"),
    ui: z.object({ resource: relativeFile, action: identifier }).strict().optional(),
}).strict();
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export const DEFAULT_PLUGIN_ROOT = path.resolve(import.meta.dirname, "../../plugins");
export const pluginToolName = (id: string) => `prodero_plugin_${id}`;
export const pluginActionToolName = (id: string, action: string) => `${pluginToolName(id)}_${action}`;
export const pluginResourceUri = (id: string, version: string) => `ui://prodero/plugins/${id}-${version}.html`;
export function pluginFile(root: string, relative: string): string {
    relativeFile.parse(relative);
    let cursor = root;
    for (const part of relative.split("/")) {
        cursor = path.join(cursor, part);
        if (fs.lstatSync(cursor).isSymbolicLink())
            throw new Error("Symlink in plugin resource path");
    }
    if (!fs.statSync(cursor).isFile())
        throw new Error("Plugin resource is not a file");
    return cursor;
}
/** Disposable registry; discovering installations never reads or writes project state. */
export class PluginRegistry {
    readonly diagnostics: {
        plugin: string;
        phase: string;
        message: string;
    }[] = [];
    private readonly plugins = new Map<string, {
        manifest: PluginManifest;
        directory: string;
        definition: PluginDefinition;
        html?: string;
    }>();
    constructor(root = DEFAULT_PLUGIN_ROOT) {
        if (!fs.existsSync(root))
            return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        }
        catch {
            this.diagnostics.push({ plugin: "registry", phase: "discovery", message: "Cannot read plugin directory" });
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!entry.isDirectory() || entry.name.startsWith("."))
                continue;
            let phase = "manifest";
            try {
                const directory = path.join(root, entry.name);
                const manifest = pluginManifestSchema.parse(JSON.parse(fs.readFileSync(pluginFile(directory, "plugin.json"), "utf8")));
                if (manifest.ui && (PRODERO_TOOL_NAMES as readonly string[]).includes(pluginToolName(manifest.id)))
                    throw new Error("Plugin UI tool name conflicts with a Core tool");
                if (this.plugins.has(manifest.id))
                    throw new Error("Duplicate plugin ID");
                phase = "entrypoint";
                const definition = createRequire(import.meta.url)(pluginFile(directory, manifest.entrypoint)) as PluginDefinition;
                if (!definition?.actions || typeof definition.actions !== "object" || !Object.keys(definition.actions).length)
                    throw new Error("Missing plugin actions");
                for (const [name, action] of Object.entries(definition.actions)) {
                    identifier.parse(name);
                    if (!action || typeof action.title !== "string" || typeof action.description !== "string" || typeof action.readOnly !== "boolean" || typeof action.run !== "function")
                        throw new Error("Invalid action contract");
                }
                phase = "ui";
                if (manifest.ui && !definition.actions[manifest.ui.action])
                    throw new Error("Unknown UI initial action");
                const html = manifest.ui ? fs.readFileSync(pluginFile(directory, manifest.ui.resource), "utf8") : undefined;
                this.plugins.set(manifest.id, { manifest, directory, definition, html });
            }
            catch (error) {
                this.diagnostics.push({ plugin: publicDiagnostic(entry.name), phase, message: error instanceof Error && error.name === "ZodError" ? "Invalid or incompatible manifest/action contract" : error instanceof Error && /^(Duplicate|Missing|Invalid|Unknown|Symlink|Plugin)/.test(error.message) ? publicDiagnostic(error) : `Plugin ${phase} could not be loaded` });
            }
        }
    }
    list() { return [...this.plugins.values()].map(({ manifest, definition }) => ({ ...manifest, actions: Object.entries(definition.actions).map(([id, action]) => ({ id, title: action.title, description: action.description, readOnly: action.readOnly, ...(manifest.ui ? { toolName: pluginActionToolName(manifest.id, id) } : {}) })), ...(manifest.ui ? { toolName: pluginToolName(manifest.id), resourceUri: pluginResourceUri(manifest.id, manifest.version) } : {}) })); }
    has(id: string) { return this.plugins.has(id); }
    get(id: string) { return this.list().find(p => p.id === id); }
    resource(id: string) { return this.plugins.get(id)?.html; }
    directory(id: string) { const plugin = this.plugins.get(id); if (!plugin)
        throw new Error(`Plugin unavailable: ${id}`); return plugin.directory; }
    async dispatch(id: string, action: string, context: PluginContext, input: unknown) {
        const plugin = this.plugins.get(id);
        const handler = plugin && Object.hasOwn(plugin.definition.actions, action) ? plugin.definition.actions[action] : undefined;
        if (!handler)
            throw new Error(`Plugin action unavailable: ${id}/${action}`);
        const boundedContext = handler.readOnly ? { ...context, state: { ...context.state, apply: async () => { throw new Error("Read-only plugin action cannot apply state"); } } } : context;
        try {
            return await handler.run(boundedContext, input);
        }
        catch (error) {
            // Preserve validated boundary errors; never echo arbitrary plugin/source data in diagnostics.
            this.diagnostics.push({ plugin: id, phase: action, message: "Plugin action failed" });
            if (this.diagnostics.length > 100)
                this.diagnostics.shift();
            throw new Error(`Plugin ${id}/${action} failed: ${error instanceof Error && error.name === "ZodError" ? "invalid structured input or output" : error instanceof Error ? error.message.replace(/[\r\n]/g, " ").slice(0, 300) : "unknown error"}`);
        }
    }
}

import { assertNoSecrets, hasSecret } from "../core/secrets.js";
import { analyzeKnowledgeText } from "../core/knowledge-analysis.js";
import fs from "node:fs/promises";
import { applyImport, readImportState, verifyImport, validateImportItems } from "../core/imports.js";
import { digestTree, readSource, scanFiles, snapshotFiles } from "../core/plugin-files.js";
import { pluginFile, type PluginRegistry } from "./registry.js";
import type { PluginContext } from "./api.js";
export function createPluginContext(registry: PluginRegistry, id: string, root: string, llm?: PluginContext["llm"]): PluginContext {
    const plugin = registry.get(id);
    if (!plugin)
        throw new Error(`Plugin unavailable: ${id}`);
    return Object.freeze({
        projectRoot: root, plugin: Object.freeze({ id, version: plugin.version }),
        files: Object.freeze({ scan: (relative: string, limit?: number) => scanFiles(root, relative, limit), read: (relative: string) => readSource(root, relative), snapshot: (relative: string) => snapshotFiles(root, relative), digest: (relative: string, options?: { exclude?: string[] }) => digestTree(root, relative, options) }),
        screening: Object.freeze({ assertSafe: assertNoSecrets, hasSecret }),
        assets: Object.freeze({ read: (relative: string) => fs.readFile(pluginFile(registry.directory(id), relative), "utf8") }),
        state: Object.freeze({ analyze: analyzeKnowledgeText, read: () => readImportState(root), validate: (items: Parameters<PluginContext["state"]["validate"]>[0]) => validateImportItems(root, items), apply: (batch: Parameters<PluginContext["state"]["apply"]>[0]) => applyImport(root, plugin, batch), verify: (receipt: Parameters<PluginContext["state"]["verify"]>[0]) => verifyImport(root, receipt) }),
        ...(llm ? { llm } : {}),
    });
}

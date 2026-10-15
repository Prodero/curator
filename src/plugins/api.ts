import type { z } from "zod";
import type { importBatchSchema, importItemSchema, ImportReceipt, ImportState } from "../core/imports.js";
import type { TreeDigest } from "../core/plugin-files.js";
/** Public v1 boundary. Plugins propose; Core validates all durable mutations.
 * Local installation plugins are trusted code, not a security sandbox. */
export interface PluginContext {
    readonly projectRoot: string;
    readonly plugin: {
        id: string;
        version: string;
    };
    readonly files: {
        scan(relative: string, limit?: number): Promise<{
            files: {
                path: string;
                bytes: number;
            }[];
            truncated: boolean;
            exists: boolean;
        }>;
        read(relative: string): Promise<{
            path: string;
            content: string;
            sha256: string;
        }>;
        snapshot(relative: string): Promise<Record<string, string>>;
        digest(relative: string, options?: { exclude?: string[] }): Promise<TreeDigest>;
    };
    /** Shared Core credential policy for complete packets, including metadata. */
    readonly screening: { assertSafe(value: unknown): void; hasSecret(value: string): boolean };
    readonly assets: {
        read(relative: string): Promise<string>;
    };
    readonly state: {
        read(): Promise<ImportState>;
        analyze(title:string, content:string): import("../core/knowledge-analysis.js").AnalyzedPart[];
        validate(items: z.input<typeof importItemSchema>[]): Promise<void>;
        apply(batch: z.input<typeof importBatchSchema>): Promise<ImportReceipt>;
        verify(receipt: ImportReceipt): Promise<{
            valid: boolean;
            issues: string[];
        }>;
    };
    readonly llm?: {
        json(instructions: string, input: unknown, schema: Record<string, unknown>): Promise<unknown>;
    };
}
export interface PluginAction {
    title: string;
    description: string;
    readOnly: boolean;
    run(context: PluginContext, input: unknown): Promise<unknown>;
}
export interface PluginDefinition {
    actions: Record<string, PluginAction>;
}

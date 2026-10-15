import {applicabilitySchema,withApplicability,sameApplicability,applicabilityKey,inferApplicability} from "./applicability.js";
import { assertCompatibleProject } from "./storage.js";
import fs from "node:fs/promises";
import { sortableId } from "./ids.js";
import { z } from "zod";
import { listKnowledge, renderKnowledge } from "./memory.js";
import { listProjectSkills, renderSkill, skillInputSchema, type ProjectSkill } from "./skills.js";
import { readConfig, sha256, listCheckpoints } from "./storage.js";
import { checkedPath, hasSecret, readSource, safeRelative, snapshotImportState } from "./plugin-files.js";
import { commitSyncTransaction, recoverSyncTransaction, withSyncLock, type PlannedWrite } from "./sync-transaction.js";
import { buildIndex } from "./index.js";
import { estimateTokens, knowledgeText, MAX_CANONICAL_ITEM_TOKENS } from "./telemetry.js";
import type { KnowledgeItem } from "./types.js";
import { assertEnglishProse } from "./language.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
export const importEvidenceSchema = z.object({ path: text.max(400), sha256: hash, startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict();
export const importItemSchema = z.object({
    applicability:applicabilitySchema.optional(),scopeKind:z.enum(["path","topic"]).optional(),
    key: text.max(100), destination: z.enum(["project_instruction", "knowledge", "skill"]),
    title: text.max(200).regex(/^[^\r\n]+$/), content: text.max(8000),
    scope: z.enum(["global", "module", "task"]), scopeRef: text.max(300).nullable(),
    category: z.enum(["principle", "invariant", "decision", "constraint", "lesson", "state", "instruction"]),
    evidence: z.array(importEvidenceSchema).min(1).max(12), reason: text.max(1000),
    persistEvidence: z.boolean().optional(),
    skill: skillInputSchema.strict().nullable(), activateSkill: z.boolean(),
}).strict();
export const importBatchSchema = z.object({
    version: z.literal(1), planId: hash, approvedPlanId: hash,
    stateFingerprint: hash, items: z.array(importItemSchema).max(100),
}).strict();
export type ImportState = {
    knowledge: KnowledgeItem[];
    skills: ProjectSkill[];
    fingerprint: string;
    files: Record<string, string>;
    importedKeys:string[];
    importedSources:z.infer<typeof importEvidenceSchema>[];
};
export interface ImportReceipt {
    version: 1;
    plugin: string;
    pluginVersion: string;
    planId: string;
    batchHash: string;
    checkpoint: string;
    created: {
        key: string;
        path: string;
        sha256: string;
        destination: string;
        source?:z.infer<typeof importEvidenceSchema>[];
    }[];
    duplicates: {
        key: string;
        path: string;
        sha256: string;
        destination: string;
        source?:z.infer<typeof importEvidenceSchema>[];
    }[];
    before: Record<string, string>;
}
export async function readImportState(root: string): Promise<ImportState> {
    if (!(await readConfig(root)))
        throw new Error("Initialize Prodero before importing knowledge");
    const files = await snapshotImportState(root);
    return { knowledge: await listKnowledge(root), skills: await listProjectSkills(root), fingerprint: sha256(JSON.stringify(files)), files, importedSources:(await listCheckpoints(root)).flatMap(c=>c.importReceipt?[...c.importReceipt.created,...c.importReceipt.duplicates].flatMap(i=>i.source??[]):[]), importedKeys:(await listCheckpoints(root)).flatMap(c=>c.importReceipt?[...c.importReceipt.created,...c.importReceipt.duplicates].map(i=>i.key):[]) };
}
const normalized = (content: string) => content.trim().replace(/\s+/g, " ").toLowerCase();
/** Read-only preflight is shared by proposal review and the durable apply boundary. */
export async function validateImportItems(root: string, raw: unknown): Promise<void> {
    await assertCompatibleProject(root);
    const items = z.array(importItemSchema).max(100).parse(raw);
    if (new Set(items.map(i => i.key)).size !== items.length)
        throw new Error("Duplicate import item key");
    if (hasSecret(JSON.stringify(items)))
        throw new Error("Potential secret in import proposal");
    // Validate every proposal and evidence before taking the writer lock or touching durable state.
    for (const item of items) {
        assertEnglishProse([item.title, item.content, item.reason, item.skill?.title, item.skill?.description, item.skill?.scope, ...(item.skill?.triggers ?? []), item.skill?.content], "Imported Prodero knowledge");
        if (item.destination !== "skill" && estimateTokens(knowledgeText(item)) > MAX_CANONICAL_ITEM_TOKENS)
            throw new Error("Knowledge exceeds canonical token budget");
        if ((item.scope === "global") !== (item.scopeRef === null))
            throw new Error("Invalid scope boundary");
        if (item.destination === "project_instruction" && item.category !== "instruction")
            throw new Error("Project rules require instruction category");
        if (item.destination === "skill" ? !item.skill : item.skill !== null || item.activateSkill)
            throw new Error("Invalid skill destination");
        if (item.skill && (item.title !== item.skill.title || item.content !== item.skill.content || item.skill.relatedKnowledge.length))
            throw new Error("Skill proposal must match its reviewed content and use evidence references");
        if (item.skill && estimateTokens(renderSkill({ ...item.skill, id: "validation", status: "candidate", origin: "legacy", createdAt: "", updatedAt: "", sourceSessions: [], derivedFrom: [], proposedReason: item.reason, reviewedAt: null, reviewReason: null, path: "skills/validation.md" })) > 1500)
            throw new Error("Skill exceeds context budget; distill the procedure");
        for (const reference of item.skill?.references ?? [])
            safeRelative(reference);
        for (const evidence of item.evidence) {
            safeRelative(evidence.path);
            const source = await readSource(root, evidence.path);
            if (source.sha256 !== evidence.sha256 || evidence.endLine < evidence.startLine || evidence.endLine > source.content.split("\n").length)
                throw new Error("Source evidence changed or line range invalid");
        }
    }
}
/** No plugin-supplied write paths, overwrites or model execution. Exact approved input only. */
export async function applyImport(root: string, plugin: {
    id: string;
    version: string;
}, raw: unknown): Promise<ImportReceipt> {
    const batch = importBatchSchema.parse(raw);
    if (batch.approvedPlanId !== batch.planId)
        throw new Error("Exact plan approval required");
    await validateImportItems(root, batch.items);
    const batchHash = sha256(JSON.stringify(batch));
    return withSyncLock(root, async () => {
        await recoverSyncTransaction(root);
        const checkpoints = await listCheckpoints(root);
        const previousImport = checkpoints.find(c => c.importReceipt?.plugin === plugin.id && c.importReceipt?.planId === batch.planId);
        if (previousImport?.importReceipt) {
            const receipt = previousImport.importReceipt;
            if (receipt.batchHash !== batchHash) throw new Error("Applied plan differs from requested batch");
            await checkedPath(root, ".prodero/index.md");
            await buildIndex(root);
            return receipt;
        }
        // Reuse Core's chronological ID contract; the receipt is the stable replay key.
        const checkpoint = sortableId("chk");
        const state = await readImportState(root);
        if (state.fingerprint !== batch.stateFingerprint)
            throw new Error("Prodero state changed since audit; create a fresh reviewed plan");
        const writes: PlannedWrite[] = [];
        const now = new Date().toISOString();
        const receipt: ImportReceipt = { version: 1, plugin: plugin.id, pluginVersion: plugin.version, planId: batch.planId, batchHash, checkpoint, created: [], duplicates: [], before: state.files };
        const knowledge = [...state.knowledge], skills = [...state.skills];
        for (const item of batch.items) {
            const applicability=item.applicability??(item.scopeRef?{kind:"scoped" as const,...(item.scopeKind==="path"||/[/.]/.test(item.scopeRef)?{paths:[item.scopeRef]}:{subsystems:[item.scopeRef]})}:inferApplicability(item.content));
            const signature = item.destination === "skill" ? `skill:${item.skill!.scope}:${normalized(item.content)}` : `${item.destination}:${applicabilityKey({...item,applicability})}:${item.category}:${normalized(item.content)}`;
            const id = `${item.destination === "skill" ? "skill" : "mem"}_import_${sha256(signature).slice(0, 32)}`;
            const provenance = item.persistEvidence !== false ? item.evidence.map(e => `${e.path}#L${e.startLine}-L${e.endLine}@${e.sha256}`) : [];
            const derivedFrom = [...provenance, `plugin:${plugin.id}@${plugin.version}/plan:${batch.planId}`];
            let target: string, after: string;
            if (item.destination === "skill") {
                const prior = skills.find(s => s.status !== "superseded" && normalized(s.content) === normalized(item.content) && s.scope === item.skill!.scope);
                if (prior) {
                    const p = `.prodero/${prior.path}`;
                    receipt.duplicates.push({ key: item.key, path: p, sha256: sha256(await fs.readFile(await checkedPath(root, p), "utf8").catch(() => writes.find(w => `.prodero/${w.path}` === p)!.after)), destination: item.destination,source:item.evidence });
                    continue;
                }
                const skill: ProjectSkill = { ...item.skill!, id, status: item.activateSkill ? "active" : "candidate", origin: "legacy", createdAt: now, updatedAt: now, sourceSessions: [], derivedFrom, proposedReason: item.reason, reviewedAt: item.activateSkill ? now : null, reviewReason: item.activateSkill ? `Approved plan ${batch.planId}` : null, path: `skills/${id}.md` };
                after = renderSkill(skill);
                if (estimateTokens(after) > 1500)
                    throw new Error("Skill with provenance exceeds context budget");
                target = skill.path;
                skills.push(skill);
            }
            else {
                const prior = knowledge.find(k => k.status === "active" && sameApplicability(k,{...item,applicability}) && k.category === item.category && normalized(k.content) === normalized(item.content));
                if (prior) {
                    const p = `.prodero/memory/${prior.id}.md`;
                    receipt.duplicates.push({ key: item.key, path: p, sha256: state.files[p] ?? sha256(writes.find(w => `.prodero/${w.path}` === p)!.after), destination: item.destination,source:item.evidence });
                    continue;
                }
                const knowledgeItem: KnowledgeItem = withApplicability({ version:3, contextPolicy:"relevant", authority:"imported", id, scope: item.scope, scopeRef: item.scopeRef, category: item.category, priority: "normal", status: "active", title: item.title, content: item.content, createdAt: now, updatedAt: now, sourceSessions: [], derivedFrom, supersedes: [], related: [], evidence: provenance.map(ref => ({ kind: "source_file" as const, ref })) },applicability);
                if (estimateTokens(knowledgeText(knowledgeItem)) > MAX_CANONICAL_ITEM_TOKENS)
                    throw new Error("Knowledge exceeds canonical token budget");
                after = renderKnowledge(knowledgeItem);
                target = `memory/${id}.md`;
                knowledge.push(knowledgeItem);
            }
            writes.push({ path: target, before: null, after });
            receipt.created.push({ key: item.key, path: `.prodero/${target}`, sha256: sha256(after), destination: item.destination,source:item.evidence });
        }
        await checkedPath(root, ".prodero/index.md");
        const record = { id: checkpoint, createdAt: now, previousCheckpoint: checkpoints.at(-1)?.id ?? null, sessions: [], consolidation: "not-performed", createdMemory: receipt.created.filter(i => i.destination !== "skill").map(i => i.path.split("/").at(-1)!.slice(0, -3)), createdSkills: receipt.created.filter(i => i.destination === "skill").map(i => i.path.split("/").at(-1)!.slice(0, -3)), updatedMemory: [], supersededMemory: [], duplicateMemory: [], conflicts: [], summary: { sessions: 0, candidates: batch.items.length, created: receipt.created.length, consolidated: 0, duplicates: receipt.duplicates.length, superseded: 0, conflicts: 0 }, importReceipt: receipt };
        try {
            await commitSyncTransaction(root, [...writes, { path: `checkpoints/${checkpoint}.json`, before: null, after: JSON.stringify(record, null, 2) + "\n" }]);
            await buildIndex(root);
        }
        catch {
            throw new Error("Import interrupted and may be partially applied. Core retains its recovery journal/checkpoint; retry this exact approved plan after resolving the filesystem or concurrent-write error.");
        }
        return receipt;
    });
}
export async function verifyImport(root: string, receipt: ImportReceipt) {
    await assertCompatibleProject(root);
    const issues: string[] = [];
    if (!/^chk_[0-9]{17}_[a-f0-9]{12}$/.test(receipt.checkpoint))
        throw new Error("Invalid receipt checkpoint");
    const record = JSON.parse(await fs.readFile(await checkedPath(root, `.prodero/checkpoints/${receipt.checkpoint}.json`), "utf8"));
    if (JSON.stringify(record.importReceipt) !== JSON.stringify(receipt))
        throw new Error("Receipt does not match durable checkpoint");
    const state = await readImportState(root);
    for (const item of [...receipt.created, ...receipt.duplicates])
        if (state.files[item.path] !== item.sha256)
            issues.push(`Imported item missing or changed: ${item.key}`);
    const allowed = new Set([...receipt.created.map(i => i.path), `.prodero/checkpoints/${receipt.checkpoint}.json`, ".prodero/index.md"]);
    for (const p of new Set([...Object.keys(receipt.before), ...Object.keys(state.files)]))
        if (!allowed.has(p) && receipt.before[p] !== state.files[p])
            issues.push(`Other canonical state changed: ${p}`);
    if (new Set(receipt.created.map(i => i.path)).size !== receipt.created.length)
        issues.push("Duplicate created destination");
    return { valid: issues.length === 0, issues };
}

import { assertCompatibleProject } from "./storage.js";
import { hasSecret } from "./secrets.js";
export { hasSecret } from "./secrets.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
const skipped = new Set([".git", "node_modules", ".cache", ".transactions", "dist", "dist-ui"]);
export function safeRelative(value: string) {
    if (!value || path.isAbsolute(value) || value.includes("\\") || /[\x00-\x1f]/.test(value) || value.split("/").some(p => !p || p === ".." || p === "."))
        throw new Error("Unsafe relative path");
    return value;
}
export async function checkedPath(root: string, relative: string) {
    await assertCompatibleProject(root);
    if (relative !== ".")
        safeRelative(relative);
    let cursor = await fs.realpath(root);
    for (const part of relative === "." ? [] : relative.split("/")) {
        cursor = path.join(cursor, part);
        try {
            if ((await fs.lstat(cursor)).isSymbolicLink())
                throw new Error("Symlink source/destination rejected");
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
        }
    }
    return cursor;
}
/** Conservative source exclusions: credential stores/config may expose more than one secret. */
export function secretPath(value: string) {
    const normalized = value.replace(/\\/g, '/');
    // Exclude these private configuration trees, including caches and nonstandard key names.
    if (/(^|\/)(?:\.ssh|\.aws|\.azure)(?:\/|$)/i.test(normalized) || /(^|\/)(?:\.config\/gcloud|AppData\/Roaming\/gcloud)(?:\/|$)/i.test(normalized)) return true;
    if (/(^|\/)gcloud\/(?:credentials\.db|access_tokens\.db|legacy_credentials(?:\/|$)|configurations(?:\/|$))/i.test(normalized)) return true;
    if (/(^|\/)(?:ssh_config|sshd_config)(?:$|\.d(?:\/|$))/i.test(normalized)) return true;
    if (/(^|\/)(?:\.kube\/config|\.docker\/config\.json)(?:\.[^/]*)?$/i.test(normalized)) return true;
    const name = normalized.split('/').at(-1) ?? '';
    if (/^(?:\.env(?:\..*)?|\.npmrc(?:\..*)?|\.git-credentials(?:\..*)?|\.netrc|_netrc|\.pypirc|\.boto|credentials(?:\..*)?|application_default_credentials\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|ssh_host_.*_key)$/i.test(name)) return true;
    if (/\.(?:pem|key|p12|pfx|ppk)$/i.test(name)) return true;
    // Credential-specific data filenames; do not blacklist ordinary auth modules or docs.
    return /^(?:(?:[^/]+[-_.])?service[-_]?account(?:[-_]?(?:key|credentials))?(?:[-_.](?:prod|production|dev|development|staging|test))?|(?:[^/]+[-_.])?credentials|client[_-]?secret(?:[_-].*)?)\.(?:json|ya?ml|toml|ini)$/i.test(name);
}
export async function scanFiles(root: string, relative: string, limit = 2000) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20000)
        throw new Error("Invalid file count limit");
    const base = await checkedPath(root, relative);
    const files: {
        path: string;
        bytes: number;
    }[] = [];
    let truncated = false, count = 0;
    try {
        if (!(await fs.stat(base)).isDirectory())
            throw new Error("Source is not a directory");
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { files, truncated, exists: false };
        throw error;
    }
    async function visit(dir: string, prefix: string) {
        for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if ((relative === "." && (skipped.has(entry.name) || entry.name === ".prodero")) || (relative === ".prodero" && [".cache", ".transactions"].includes(entry.name)))
                continue;
            if (++count > limit) {
                truncated = true;
                return;
            }
            if (entry.isSymbolicLink())
                throw new Error("Symlink in source tree rejected");
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory())
                await visit(path.join(dir, entry.name), rel);
            else if (entry.isFile())
                files.push({ path: rel, bytes: (await fs.stat(path.join(dir, entry.name))).size });
            else
                throw new Error("Special source file rejected");
            if (truncated)
                return;
        }
    }
    await visit(base, relative === "." ? "" : relative);
    return { files, truncated, exists: true };
}
export async function readSource(root: string, relative: string) {
    if (secretPath(relative))
        throw new Error("Secret-bearing file type excluded");
    const target = await checkedPath(root, relative);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 128000)
        throw new Error("Source file exceeds text budget");
    const raw = await fs.readFile(target);
    if (raw.includes(0))
        throw new Error("Binary source excluded");
    const content = raw.toString("utf8");
    if (hasSecret(content))
        throw new Error("Potential secret-bearing source excluded");
    return { path: relative, content, sha256: crypto.createHash("sha256").update(raw).digest("hex") };
}
/** External integrity scope: bounded, path-screened, Git-ignore aware; no source text retained. */
export async function snapshotFiles(root: string, relative: string, options: import("./integrity-files.js").IntegrityOptions = {}) {
    return (await (await import("./integrity-files.js")).integritySnapshot(root, relative, options)).hashes;
}

/** Core-only exception: canonical Local records/checkpoints participate in import conflict/replay checks. */
export async function snapshotImportState(root: string) {
    return (await (await import("./integrity-files.js")).integritySnapshot(root, ".prodero", {}, true)).hashes;
}
export interface TreeDigest { version: 2; algorithm: "sha256-tree-v2"; sha256: string; files: number; directories: number; bytes: number }
export async function digestTree(root: string, relative: string, options: import("./integrity-files.js").IntegrityOptions = {}): Promise<TreeDigest> {
    return (await (await import("./integrity-files.js")).integritySnapshot(root, relative, options)).digest;
}

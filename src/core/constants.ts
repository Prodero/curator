import { readFileSync } from "node:fs";

const packageIdentity = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string };
const releaseIdentity = JSON.parse(readFileSync(new URL("../../prodero.release.json", import.meta.url), "utf8")) as { formatVersion: number; schemaVersion: number; knowledgeSchemaVersion: number };

if (releaseIdentity.formatVersion !== 1 || !Number.isInteger(releaseIdentity.schemaVersion) || releaseIdentity.schemaVersion < 1 || !Number.isInteger(releaseIdentity.knowledgeSchemaVersion) || releaseIdentity.knowledgeSchemaVersion < 1) throw new Error("Invalid prodero.release.json");

export const PRODERO_VERSION = packageIdentity.version;
export const PRODERO_SCHEMA_VERSION = releaseIdentity.schemaVersion;
export const PRODERO_KNOWLEDGE_SCHEMA_VERSION = releaseIdentity.knowledgeSchemaVersion;
export const PRODERO_PACKAGE_NAME = packageIdentity.name;
export const PRODERO_DIRECTORY = ".prodero";

export const MANAGED_START = "<!-- prodero:start -->";
export const MANAGED_END = "<!-- prodero:end -->";

export const PROJECT_DIRECTORIES = [
  "memory",
  "sessions",
  "skills",
  "checkpoints",
  "local/memory",
  ".cache",
] as const;

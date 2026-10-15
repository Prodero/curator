import { publicDiagnostic } from "./diagnostics.js";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PRODERO_SCHEMA_VERSION, PRODERO_VERSION } from "./constants.js";
import { writeFileAtomic } from "./storage.js";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const versionSchema = z.string().regex(semverPattern, "Expected a valid semantic version");
export const releaseMetadataSchema = z.object({
  version: versionSchema,
  schemaVersion: z.number().int().positive(),
  releaseId: z.string().regex(/^[A-Za-z0-9._-]+$/).max(200),
  publishedAt: z.string().datetime().optional(),
  notes: z.string().max(4_000).optional(),
  artifact: z.object({ locator: z.string().trim().min(1), integrity: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
}).strict();

export type ReleaseMetadata = z.infer<typeof releaseMetadataSchema>;
export interface StagedRelease { restartRequired: true; detail?: string }
export interface ReleaseSource {
  readonly id: string;
  readonly installedReleaseId?: string;
  latest(signal?: AbortSignal): Promise<unknown | null>;
  stage(release: ReleaseMetadata, signal?: AbortSignal): Promise<StagedRelease>;
}
export const MANUAL_UPDATE_COMMAND = "npm install --global @prodero/cli@latest";
export interface UpdateCheck {
  manualUpdateCommand?: string; developmentOnly?: boolean;
  current: string; latest: string | null; available: boolean; source: string;
  status: "current" | "update-available" | "unavailable" | "invalid";
  installedSchemaVersion: number; availableSchemaVersion: number | null; error?: string;
}
export interface UpdateResult {
  ok: boolean; status: "manual-update" | "current" | "restart-required" | "failed" | "interrupted" | "unavailable" | "invalid";
  installedVersion: string; availableVersion: string | null; source: string; restartRequired: boolean; message: string;
}
export class ReleaseSourceUnavailableError extends Error {}

type ParsedVersion = { core: [number, number, number]; prerelease: string[] };
function parseVersion(value: string): ParsedVersion {
  const match = semverPattern.exec(value);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") ?? [] };
}

/** Compare strict SemVer values. Build metadata does not affect precedence. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const av = a.prerelease[index], bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av), bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) > Number(bv) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}

export class UnconfiguredReleaseSource implements ReleaseSource {
  readonly id = "unconfigured";
  async latest(): Promise<null> { return null; }
  async stage(): Promise<StagedRelease> { throw new Error("No Prodero release source is configured."); }
}

const LOCAL_RELEASE_FILES = ["package.json", "package-lock.json", "prodero.release.json", "tsconfig.json", "vite.config.ts", "src", "scripts", "bin", "plugins"];
const MAX_LOCAL_RELEASE_FILES = 5_000;
const MAX_LOCAL_RELEASE_BYTES = 64 * 1024 * 1024;

function localCheckoutDigest(root: string): string {
  const digest = crypto.createHash("sha256");
  let files = 0, bytes = 0;
  const visit = (relative: string) => {
    const absolute = path.join(root, relative);
    let stat;
    try { stat = lstatSync(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Local release source contains a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(path.join(relative, name));
      return;
    }
    if (!stat.isFile()) return;
    files += 1; bytes += stat.size;
    if (files > MAX_LOCAL_RELEASE_FILES || bytes > MAX_LOCAL_RELEASE_BYTES) throw new Error("Local release source exceeds the bounded release snapshot.");
    digest.update(`F\0${relative.split(path.sep).join("/")}\0${stat.size}\0`); digest.update(readFileSync(absolute)); digest.update("\0");
  };
  for (const relative of LOCAL_RELEASE_FILES) visit(relative);
  return digest.digest("hex");
}

async function runLocalBuild(root: string, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-8_000); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const abort = () => child.kill("SIGTERM"); signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("exit", (code, terminationSignal) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new InterruptedUpdateError("Local release build was interrupted."));
      else if (code === 0) resolve();
      else reject(new Error(`Local release build failed with ${terminationSignal ? `signal ${terminationSignal}` : `exit code ${code ?? "unknown"}`}.${output.trim() ? `\n${output.trim()}` : ""}`));
    });
  });
}

/** One-click adapter for an MCP runtime launched from a development checkout. */
export class LocalCheckoutReleaseSource implements ReleaseSource {
  readonly id = "local-checkout";
  readonly installedReleaseId: string;
  constructor(readonly root: string) { this.installedReleaseId = `local-${localCheckoutDigest(root)}`; }
  async latest(): Promise<ReleaseMetadata> {
    const identity = JSON.parse(await fs.readFile(path.join(this.root, "package.json"), "utf8")) as { version?: unknown };
    const releaseIdentity = z.object({ formatVersion: z.literal(1), schemaVersion: z.number().int().positive() }).strict().parse(JSON.parse(await fs.readFile(path.join(this.root, "prodero.release.json"), "utf8")));
    const version = versionSchema.parse(identity.version);
    const hash = localCheckoutDigest(this.root);
    return { version, schemaVersion: releaseIdentity.schemaVersion, releaseId: `local-${hash}`, artifact: { locator: ".", integrity: `sha256:${hash}` } };
  }
  async stage(release: ReleaseMetadata, signal?: AbortSignal): Promise<StagedRelease> {
    const before = await this.latest();
    if (before.releaseId !== release.releaseId || before.artifact.integrity !== release.artifact.integrity) throw new InterruptedUpdateError("Local release source changed after update review; check again.");
    await runLocalBuild(this.root, signal);
    const after = await this.latest();
    if (after.releaseId !== release.releaseId || after.artifact.integrity !== release.artifact.integrity) throw new InterruptedUpdateError("Local release source changed while it was being built; no activation was recorded.");
    return { restartRequired: true, detail: `Local checkout ${this.root} built and verified successfully.` };
  }
}

const localManifestSchema = z.object({
  formatVersion: z.literal(1), release: z.unknown().nullable(),
  simulation: z.object({ outcome: z.enum(["success", "failed", "interrupted"]), message: z.string().optional() }).strict().optional(),
}).strict();
class InterruptedUpdateError extends Error {}

/** Deterministic source used for local development and contract tests. */
export class LocalManifestReleaseSource implements ReleaseSource {
  readonly id = "local-manifest";
  constructor(readonly manifestPath: string, readonly stateDirectory = path.join(path.dirname(manifestPath), ".prodero-update-state")) {}
  private async manifest() { return localManifestSchema.parse(JSON.parse(await fs.readFile(this.manifestPath, "utf8"))); }
  async latest(): Promise<unknown | null> { return (await this.manifest()).release; }
  async stage(release: ReleaseMetadata, signal?: AbortSignal): Promise<StagedRelease> {
    signal?.throwIfAborted();
    const manifest = await this.manifest();
    const simulation = manifest.simulation?.outcome ?? "success";
    if (simulation === "failed") throw new Error(manifest.simulation?.message ?? "Local release installation failed.");
    if (simulation === "interrupted") throw new InterruptedUpdateError(manifest.simulation?.message ?? "Local release installation was interrupted.");
    const manifestDirectory = path.dirname(this.manifestPath);
    const artifactPath = path.resolve(manifestDirectory, release.artifact.locator);
    if (path.isAbsolute(release.artifact.locator) || (artifactPath !== manifestDirectory && !artifactPath.startsWith(`${manifestDirectory}${path.sep}`))) throw new Error("Release artifact must stay inside the local manifest directory.");
    const artifact = await fs.readFile(artifactPath);
    const integrity = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
    if (integrity !== release.artifact.integrity) throw new Error("Release artifact integrity verification failed.");
    await fs.mkdir(this.stateDirectory, { recursive: true });
    const stagedPath = path.join(this.stateDirectory, `${release.releaseId}.artifact`);
    const temporary = `${stagedPath}.partial-${process.pid}`;
    try {
      await fs.writeFile(temporary, artifact, { flag: "wx" });
      signal?.throwIfAborted();
      await fs.rename(temporary, stagedPath);
      await writeFileAtomic(path.join(this.stateDirectory, "pending.json"), `${JSON.stringify({ formatVersion: 1, release, stagedPath, stagedAt: new Date().toISOString() }, null, 2)}\n`);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return { restartRequired: true, detail: `Release ${release.version} was verified and staged at ${stagedPath}.` };
  }
}

/** npm is read-only here: package installation always belongs to the user's package manager. */
export class NpmReleaseSource implements ReleaseSource {
  readonly id = "npm";
  constructor(private readonly request: typeof fetch = fetch) {}
  async latest(signal?: AbortSignal): Promise<unknown | null> {
    try {
      const response = await this.request("https://registry.npmjs.org/@prodero%2fcli/latest", { signal, redirect: "error" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Registry unavailable");
      return await response.json();
    } catch { throw new ReleaseSourceUnavailableError("Cannot reach the public npm release source. Installed knowledge is unaffected."); }
  }
  async stage(): Promise<StagedRelease> { throw new Error(`Use ${MANUAL_UPDATE_COMMAND}`); }
}

export function configuredReleaseSource(environment: NodeJS.ProcessEnv = process.env): ReleaseSource {
  if (environment.PRODERO_RELEASE_SOURCE === "none") return new UnconfiguredReleaseSource();
  if (environment.PRODERO_DEV_UPDATE === "1") {
    const manifest = environment.PRODERO_RELEASE_MANIFEST?.trim();
    if (manifest) return new LocalManifestReleaseSource(path.resolve(manifest), environment.PRODERO_UPDATE_STATE_DIR?.trim());
    const checkout = environment.PRODERO_LOCAL_RELEASE_CHECKOUT?.trim();
    if (checkout) return new LocalCheckoutReleaseSource(path.resolve(checkout));
    return new UnconfiguredReleaseSource();
  }
  return new NpmReleaseSource();
}

function updateAvailable(source: ReleaseSource, release: ReleaseMetadata, installedVersion: string): boolean {
  const precedence = compareVersions(release.version, installedVersion);
  return precedence > 0 || (precedence === 0 && Boolean(source.installedReleaseId) && source.installedReleaseId !== release.releaseId);
}

async function checkReleaseUpdate(source: ReleaseSource = configuredReleaseSource(), installedVersion = PRODERO_VERSION): Promise<UpdateCheck> {
  let raw: unknown | null;
  try {
    versionSchema.parse(installedVersion);
    raw = await source.latest(AbortSignal.timeout(2_500));
  } catch (error) {
    const status = error instanceof ReleaseSourceUnavailableError || (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) ? "unavailable" : "invalid";
    return { current: installedVersion, latest: null, available: false, source: source.id, status, installedSchemaVersion: PRODERO_SCHEMA_VERSION, availableSchemaVersion: null, error: publicDiagnostic(error) };
  }
  if (raw === null) return { current: installedVersion, latest: null, available: false, source: source.id, status: "unavailable", installedSchemaVersion: PRODERO_SCHEMA_VERSION, availableSchemaVersion: null };
  try {
    const release = releaseMetadataSchema.parse(raw);
    if (release.schemaVersion < PRODERO_SCHEMA_VERSION) throw new Error(`Release schema v${release.schemaVersion} is older than installed schema v${PRODERO_SCHEMA_VERSION}.`);
    const available = updateAvailable(source, release, installedVersion);
    return { current: installedVersion, latest: release.version, available, source: source.id, status: available ? "update-available" : "current", installedSchemaVersion: PRODERO_SCHEMA_VERSION, availableSchemaVersion: release.schemaVersion };
  } catch (error) {
    return { current: installedVersion, latest: null, available: false, source: source.id, status: "invalid", installedSchemaVersion: PRODERO_SCHEMA_VERSION, availableSchemaVersion: null, error: publicDiagnostic(error) };
  }
}

export async function checkForUpdate(source: ReleaseSource = configuredReleaseSource(), installedVersion = PRODERO_VERSION): Promise<UpdateCheck> {
  if (!(source instanceof NpmReleaseSource)) {
    const result = await checkReleaseUpdate(source, installedVersion);
    return { ...result, manualUpdateCommand: MANUAL_UPDATE_COMMAND, developmentOnly: source.id !== "unconfigured",
      ...(result.status === "unavailable" && !result.error ? { error: "No production release source is configured or no release is available." } : {}) };
  }
  const base = { current: installedVersion, latest: null, available: false, source: source.id, installedSchemaVersion: PRODERO_SCHEMA_VERSION, availableSchemaVersion: null, manualUpdateCommand: MANUAL_UPDATE_COMMAND, developmentOnly: false };
  try {
    const raw = await source.latest(AbortSignal.timeout(2_500));
    if (raw === null) return { ...base, status: "unavailable", error: "No public npm release is available yet." };
    const { version } = z.object({ version: versionSchema }).parse(raw);
    const available = compareVersions(version, installedVersion) > 0;
    return { ...base, latest: version, available, status: available ? "update-available" : "current" };
  } catch (error) {
    return { ...base, status: error instanceof ReleaseSourceUnavailableError ? "unavailable" : "invalid", error: error instanceof ReleaseSourceUnavailableError ? error.message : "Invalid version metadata from the npm release source." };
  }
}

export async function installLatest(source: ReleaseSource = configuredReleaseSource(), installedVersion = PRODERO_VERSION): Promise<UpdateResult> {
  if (source instanceof NpmReleaseSource || source instanceof UnconfiguredReleaseSource) {
    const check = await checkForUpdate(source, installedVersion);
    return { ok: true, status: "manual-update", installedVersion, availableVersion: check.latest, source: source.id, restartRequired: false,
      message: `${check.error ? `${check.error} ` : ""}Run: ${MANUAL_UPDATE_COMMAND}. Then restart your MCP host. This tool has not installed or changed anything. Project knowledge remains in the project .prodero directory.` };
  }
  let raw: unknown | null;
  try { raw = await source.latest(AbortSignal.timeout(2_500)); }
  catch (error) {
    if (error instanceof ReleaseSourceUnavailableError || (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))) return unavailable(source, installedVersion, error);
    return failure("invalid", source, installedVersion, null, error);
  }
  if (raw === null) return { ok: false, status: "unavailable", installedVersion, availableVersion: null, source: source.id, restartRequired: false, message: "No Prodero release source is configured or no release is available." };
  let release: ReleaseMetadata;
  try {
    release = releaseMetadataSchema.parse(raw);
    compareVersions(release.version, installedVersion);
    if (release.schemaVersion < PRODERO_SCHEMA_VERSION) throw new Error(`Release schema v${release.schemaVersion} is older than installed schema v${PRODERO_SCHEMA_VERSION}.`);
  }
  catch (error) { return failure("invalid", source, installedVersion, null, error); }
  if (!updateAvailable(source, release, installedVersion)) return { ok: true, status: "current", installedVersion, availableVersion: release.version, source: source.id, restartRequired: false, message: `Prodero ${installedVersion} is already current.` };
  try {
    const staged = await source.stage(release, AbortSignal.timeout(30_000));
    return { ok: true, status: "restart-required", installedVersion, availableVersion: release.version, source: source.id, restartRequired: staged.restartRequired, message: `${staged.detail ?? `Prodero ${release.version} was staged.`} Development-only staging. Restart the Prodero MCP runtime after a checkout rebuild; manifest simulation has no production activation consumer.` };
  } catch (error) {
    const interrupted = error instanceof InterruptedUpdateError || (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name));
    return failure(interrupted ? "interrupted" : "failed", source, installedVersion, release.version, error);
  }
}

function unavailable(source: ReleaseSource, installedVersion: string, error: unknown): UpdateResult {
  const detail = publicDiagnostic(error);
  return { ok: false, status: "unavailable", installedVersion, availableVersion: null, source: source.id, restartRequired: false, message: `Prodero release source is unavailable: ${detail}` };
}

function failure(status: "failed" | "interrupted" | "invalid", source: ReleaseSource, installedVersion: string, availableVersion: string | null, error: unknown): UpdateResult {
  const detail = publicDiagnostic(error);
  return { ok: false, status, installedVersion, availableVersion, source: source.id, restartRequired: false, message: `Prodero update ${status}: ${detail}` };
}

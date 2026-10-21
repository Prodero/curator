/** CLI-only presentation. Status readers retain ownership of all facts. */
import type {ProjectStatus} from './core/types.js';
import type {UpdateCheck} from './core/update.js';
import type {ProjectMigrationPlan} from './core/migrations.js';
import type {machineIntegrations} from './hosts/manager.js';
import {publicDiagnostic} from './core/diagnostics.js';
import {PRODERO_VERSION} from './core/constants.js';
import {MEMORY_COPY} from './memory-presentation.js';
export type StatusScope='machine'|'project';
export interface ProjectStatusResult {version:string;scope:'project';project:ProjectStatus;update:UpdateCheck}
export interface StatusFailure {ok:false;version:string;scope:StatusScope;error:{code:string;message:string;recovery:string};migration?:ProjectMigrationPlan}
const plain=(value:string)=>value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim();
export function statusFailure(error:unknown,scope:StatusScope,migration?:ProjectMigrationPlan):StatusFailure {
 const message=plain(publicDiagnostic(error)),code=/^(PRODERO_[A-Z0-9_]+):/.exec(message)?.[1]??'PRODERO_STATUS_FAILED';
 return {ok:false,version:PRODERO_VERSION,scope,error:{code,message,recovery:migration?plain(publicDiagnostic(migration.recovery??(migration.state==='runtime-too-old'?'Update Curator before reading this project.':'Run prodero migrate status with this project root to review the required update.'))):'Check the command arguments, selected root, and preserved configuration before retrying.'},...(migration?{migration:{...migration,...(migration.diagnostic?{diagnostic:plain(publicDiagnostic(migration.diagnostic))}:{}),...(migration.recovery?{recovery:plain(publicDiagnostic(migration.recovery))}:{})}}:{})};
}
export function renderStatusFailure(result:StatusFailure):string {
 return [`Prodero ${result.version} · ${result.scope} status unavailable`,`${result.error.code}: ${result.error.message}`,result.error.recovery,...(result.migration?[`Project update: ${result.migration.state}`]:[])].join('\n');
}
const yes=(value:boolean|null)=>value===null?'unknown':value?'yes':'no';
export function renderMachineStatus(result:Awaited<ReturnType<typeof machineIntegrations>>):string {
 return [`Prodero ${result.version}`,`Machine integrations${result.ok?'':' · attention required'}`,...result.hosts.flatMap(h=>[`${h.name}: ${h.state.replaceAll('-',' ')}`,`  Detected: ${yes(h.detected)} · MCP configured: ${yes(h.mcpConfigured)} · Launcher installed: ${yes(h.launcherInstalled)}${h.runtimeMode?` · Runtime: ${h.runtimeMode}`:''}`,`  ${plain(publicDiagnostic(h.message))}`])].join('\n');
}
export function renderProjectStatus(result:ProjectStatusResult):string {
 const p=result.project,u=result.update;
 return [`Prodero ${result.version}`,`Project: ${plain(p.name)} (${plain(p.root)})`,`Initialized: ${yes(p.initialized)} · Git repository: ${yes(p.git)} · Project instructions: ${yes(p.agentsFile)}`,...(p.initialized?[`Project schema: ${p.schemaVersion}`,`Knowledge: ${p.knowledgeCount} current · ${p.localKnowledgeCount} Local · ${p.versionedKnowledgeCount} Versioned`,`Sessions: ${p.sessionCount} total · ${p.activeSessionCount} active · ${p.pendingSessionCount} pending`,`Skills: ${p.skillCount} active · ${p.skillCandidateCount} candidates`,`Checkpoints: ${p.checkpointCount} · Last sync: ${p.lastSyncAt??'never'}`,`Needs attention: ${p.conflictCount} conflicts · ${p.knowledgeGraph.brokenReferences} broken references · ${p.promotionRecommendedCount} sharing suggestions`].concat(p.memoryHealth?.missingProvenanceItems ? [`Provenance: ${p.memoryHealth.missingProvenanceItems} current records with incomplete metadata. ${MEMORY_COPY.incompleteProvenance}`] : []):['Project is not initialized. Run prodero init with --root set to this directory.']),u.status==='current'?`Update: current (${u.current})`:u.status==='update-available'?`Update available: ${u.current} → ${u.latest}`:`Update check ${u.status}: ${plain(publicDiagnostic(u.error??'No release information is available.'))}`,...(u.status==='update-available'&&u.manualUpdateCommand?[u.manualUpdateCommand]:[])].join('\n');
}

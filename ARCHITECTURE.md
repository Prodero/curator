# Prodero Architecture

## Primary experience

Users interact with Prodero primarily through their coding agent.

```text
User
  ↓ natural language or App action
Coding Agent
  ↓ MCP
Prodero MCP Server
  ↓
Prodero Core
  ↓
.prodero/
```

MCP is both the agent-native API and the primary UI boundary. The MCP App is an inline project-intelligence surface, not a separate web dashboard.

## One Core, multiple adapters

```text
                  Prodero Core
                       │
          ┌────────────┼────────────┐
          │            │            │
         MCP          CLI         Tests
          │
      primary UX
```

`src/core/` owns project behavior. `src/server.ts` and `src/cli.ts` translate transport inputs and outputs only. UI actions call names from `src/contracts.ts`; MCP handlers invoke Core functions directly and never shell out to CLI commands.

Context budgeting remains centralized in `src/core/context.ts`. It selects applicable Required first, then strongly matching Skills, Relevant knowledge and any remaining matching Skills. The configurable total budget and internal safety caps bound delivery. The main item limit never counts required instructions. Required-budget overflow is explicit in warnings, Attention, and the prepared-context snapshot rather than being hidden as ordinary saturation. Current snake-case configuration keys coexist with legacy camel-case keys at the project adapter boundary.

The CLI remains a bootstrap, development/debugging, CI/automation, and graceful-degradation adapter.

## MCP discovery and App lifecycle

`prodero_open` is associated with `ui://prodero/status.html`. It awaits the existing
Core detailed status and bounded Bootstrap Context without starting a session.
Agent lifecycle tools (`prodero_prepare` and `prodero_session_close`) use
`ui://prodero/lifecycle.html`. Both resources serve the same single-file bundle;
`action` and `uiState` choose the final view.

The presentation boundary is:

```text
resolve the selected root and presentation settings
  → await Core state (config/init, caches/indexes, counts, context as applicable)
  → buildViewModel
  → return one completed tool result
  → App toolresult handler renders once
```

`completeStatus` in `src/server.ts` delegates to `getDetailedProjectStatus`; it is
shared by open and the explicit detailed-status endpoint. No second collector was
introduced. The presentation adapter pins the resolved root for its handler and
builds the ViewModel only after that handler completes. UI and text open consume
identical completed state (`phase: ready`, `hydrationRequired: false`). A failed
required state read is an error, not a successful partial snapshot or onboarding.

`prodero_status` remains a tiny, side-effect-free identity/status query with no App
resource. It does not enumerate knowledge/sessions, migrate, rebuild caches, or use
the network, in either UI preference or text mode. Its legacy `phase: initial`
means summary-only, not a promise of later hydration: `hydrationRequired` is false
and the text ViewModel explicitly says detailed statistics were not requested.
`prodero_status_details` remains an explicit data-only endpoint. User navigation
back to Status awaits this endpoint before adopting and rendering its full result.

The App does not render project content at startup, infer uninitialized from null
state, hydrate automatically, or check releases in the background. Release status
starts as `not-checked` and is an optional user action. The prior paint-scheduled
hydration path and text-only fallback collector have been removed. User actions
can still update their existing App; initial tool delivery makes no follow-up RPC.

Prepare already awaited Sync, the shared Context Engine and complete project
statistics before returning Context Ready/Attention. That sequencing is retained;
removing the App's pre-toolresult render also fixes the false initial screen for
prepare. The Context Engine remains independent of session lifecycle.

Initialization and sync actions call the same MCP tools available to agents without Apps. Their structured results include fresh status so the existing UI refreshes in place after each mutation.

For source-local development, `scripts/mcp-dev.ts` builds the App with stdout suppressed, then starts the TypeScript MCP server over stdio. Suppression is a protocol requirement: stdout belongs exclusively to MCP messages.

## Progressive context and fallback order

```text
MCP tools/resources
    ↓ if unavailable
Prodero CLI
    ↓ final fallback
.prodero/index.md and linked files
```

Agents begin with the compact index, apply required global knowledge, and load only task-relevant knowledge and skills. They do not recursively load `.prodero/`.

## Memory lifecycle

```text
prepare → context + explicit agent-held session ID
    ↓
session_record (batched) → sessions/<sortable-unique-id>.md
    ↓
session_close → deterministic learning; next prepare → pending recovery
    ↓
local/memory/mem_<sortable-unique-id>.md
    ↓ deterministic router + lexical resolver
index.md / compact task context
    ↓
next agent session
```

`src/core/sessions.ts` validates state transitions and atomically serializes structured MCP observations into readable Markdown. Each observation gets a stable `obs_...` ID; canonical provenance is `source session + observation ID`. Different agents use different session files, with no mutable registry. Recording into a closed session fails; repeated close without new entries is idempotent.

`consolidation.ts` converts structured observations into candidates behind a deterministic consolidator boundary. `memory.ts` owns atomic canonical records. `index.ts` generates a concise derived router, while `context.ts` returns required global knowledge and a bounded keyword-matched contextual set.

Deterministic Sync compares ordered, whitespace-normalized content within the same scope/category boundary for exact duplicates. Retrieval bag-of-words keys are never equality keys. Only an identical complete-sentence prefix with compatible protected constraints may be extended without intelligence; lexical overlap alone remains separate. Repeated complete sentences are removed without dropping provenance. Explicit `supersedes` metadata is required for replacement; incompatible decision-like records sharing an explicit title/topic become `disputed`. No source session or historical memory is deleted.

Each checkpoint is immutable and references its prior checkpoint, exact processed session snapshots, created/updated/superseded/duplicate/conflict memory IDs, and a summary. Synchronization state is therefore derived without a mutable global cursor.

## Incremental complexity invariant

> Sync cost should primarily scale with new or changed unsynchronized knowledge, not total project history.

`session-index.ts` maintains an ignored, rebuildable cache of checkpoint-derived processed hashes and session filesystem stamps. Checkpoints remain authoritative. On a warm path, unchanged synchronized session bodies are not reread; only new/changed pending bodies are parsed and passed to consolidation. A missing or invalid cache is rebuilt locally from checkpoints and Markdown without changing correctness.

`memory-index.ts` stores ignored, rebuildable canonical summaries and token signals. For every new candidate it selects at most 24 potentially related items using scope, `scope_ref`, category, explicit relationships, normalized title/content, and token overlap. Only those bodies are loaded for deeper consolidation. This same boundary can later contain an LLM consolidator without placing all canonical memory into one model context.

`ensureDerivedStateRoot()` centralizes creation of `.prodero/.cache/` without creating or changing canonical knowledge. Memory and session indexes detect missing, incompatible, or invalid derived JSON, remove only that disposable file, rebuild from canonical state, and atomically replace it from a same-directory temporary file. Individual indexes remain lazy. Cache payloads contain relative filenames and content-derived metadata, never absolute worktree paths. Consequently every Git worktree owns its own ignored derived state, and missing cache is a normal cold-start condition for status, context, prepare, and Sync.

## Local and Versioned Knowledge

Knowledge has one Markdown schema and two storage/sharing layers. v0.1 trust model: Local Knowledge is Git-ignored working state, not a security boundary against the connected agent. Versioned Knowledge is Git-shareable project state; the agent may create, promote and maintain it. Review/preview/approval steps are workflow safeguards, not authenticated human authorization; approved=true does not prove human consent. Curator does not commit or push. Users must review repository changes before committing or pushing. `.prodero/local/memory/` is the default target for session consolidation and conversational remember; the whole local area, session files, checkpoints, transactions, and derived caches are ignored by Git. `.prodero/memory/` is Versioned Knowledge and changes only through explicit imports, low-level repository maintenance, or an approved promotion review.

`MemoryCatalog` indexes both roots with a derived `layer` and relative path, rejects duplicate stable IDs across layers, and presents one bounded search/graph/context space. The derived `.prodero/index.md` contains Versioned Knowledge routes, a pointer to ignored `local/index.md`, and active skill titles/paths from both layers. It can therefore disclose Local skill metadata. This repository ignores the root index; runtime initialization does not install that exclusion universally. Inspect generated routers before sharing them and keep private ones ignored. Active local supersession metadata shadows an older versioned item during retrieval without mutating the shared file.

Promotion is a preview-then-apply workflow (not a Git commit or human-authorization boundary). Recommendations combine recurrence, age, importance, category, relationships, and divergence from current Versioned Knowledge. Preview compares bounded local candidates against current versioned items, optionally reusing the provider-neutral reconciliation interface for semantic judgment, and emits new/merge/supersede/covered/conflict dispositions plus exact source revisions. Core validates the complete preview hash and every revision after the workflow approval flag is supplied, then applies local lifecycle updates and versioned writes in the existing journaled transaction with the checkpoint last. Pulls or concurrent edits therefore invalidate stale reviews instead of overwriting team knowledge.

Set `PRODERO_DEBUG_TIMINGS=1` during local MCP development to emit fast response, detailed status, index/cache, telemetry, and update-check timings to stderr. These diagnostics never enter the normal UI and are development observations, not performance guarantees.

Filesystem/stat/checkpoint discovery, status counts, pending detection, index routing, and token estimates are deterministic local operations and make no LLM/API call. Context Selection v2 retains the 6,000 estimated-token resolver budget and treats 2,000 tokens as a Required reserve, using the model-neutral `ceil(UTF-8 bytes / 4)` strategy. Applicable Required can borrow total capacity, with independent safety ceilings of 16,000 tokens / 128 records. Relevant uses a soft target of 8, deterministic marginal-value continuation and a 128-record safety ceiling. Strongly matching Skills receive capacity before Relevant, retaining 4 / 1,500 limits. Undelivered Required produces blocking `required-incomplete`; Open/Bootstrap and the derived router retain their compact limits. See [Context Selection v2](docs/CONTEXT-SELECTION-V2.md). Counts are explicitly estimated; these are Prodero-supplied task-context limits, never the model context window.

`memory-index.ts` caches per-item token, freshness, and provenance-count signals alongside lexical metadata. Context totals and selectivity sum cached summaries; only bounded selected bodies are loaded. Required globals are deterministically priority-ranked under separate item and token bounds, and omissions retain exact reason/count/token diagnostics. Ordinary Relevant omissions are nonblocking; incomplete Required delivery blocks readiness; only bounded metadata for omitted required items is disclosed. Query retrieval uses deterministic lexical scoring and greedy scope/category diversity. Non-critical active `state` records older than 180 days are retained but demoted and surfaced when selected. Detailed memory health counts stale, disputed, historical, missing-provenance, and oversized items; fast status still touches none of the corpus.

Sync telemetry is derived from the same pending candidates already in consolidation. `rawSessionTokens` counts durable observation content in the current batch. `canonicalTokensAdded` counts newly created canonical title + content and newly appended consolidation text, excluding duplicates and unrelated existing knowledge. Compression is `1 - canonical/raw` only when canonical is smaller; larger output is an explicit expansion and zero raw input is unavailable. The result also aliases lifecycle-friendly counts (`sessionsProcessed`, `observationsProcessed`, `knowledgeCreated`, `knowledgeConsolidated`, `knowledgeSuperseded`) while preserving the existing bounded result fields.

Prodero-owned metrics and host usage are separate contracts. `ProderoContextMetrics` contains local project/context estimates. Optional `AgentUsageTelemetry` and `AgentUsageAdapter` are an extension boundary for supported future hosts/providers; `agentUsage` is `null` by default, is never inferred, and does not enter canonical memory.

`prodero_open` is the startup entry exposed to conversational launchers because MCP hosts do not provide a universal chat-start hook. It reads the existing unified memory catalog, derives `kind: instruction` and `enforcement: required` for compatible instruction records, returns only applicable active or disputed instructions under fixed item/token bounds, and reports deterministic conflicts rather than choosing between them. These instructions become model-visible tool results after the call; they are not system-level instructions. `prodero_prepare` remains the independent work-lifecycle entry: it recovers pending observations (excluding an explicitly reused active session), resolves required instructions and task context even when open was skipped, and creates or explicitly reuses the agent-held active session ID. The ID is invisible to the human and never stored in shared server state. Sync Memory is a separate user-initiated improve/share workflow. CLI `sync` starts or resumes it and may recover pending observations; `sync-sessions` performs only closed-session recovery.

The shared Context Engine is `src/core/context.ts::prepareContext`, which resolves
configuration and delegates to the existing `getContext` retrieval/ranking/budgeting
pipeline. Session lifecycle depends on it; the engine imports no session lifecycle.
`prodero_recall` (CLI `recall`) returns its `ContextResult` without initialization,
migration, synchronization, session creation or any cache writes. Prepare uses the
same engine after its normal automatic Sync and then associates a work session.
Purpose is an explicit ranking policy, not another retrieval implementation.
See [context selection and compatibility](docs/CONTEXT-SELECTION-V2.md).

The prepared `ContextResult` is also the MCP App's transparency snapshot. Core attaches the prepared session ID to that same object; it does not copy canonical bodies or persist an authoritative snapshot. Selected knowledge carries per-item token estimates and the exact lexical, title, scope, priority, diversity, and stale signals that contributed to its deterministic rank. Omitted candidates carry bounded summary metadata only, never eagerly loaded bodies. `View context` is a local UI state toggle over the received tool result, so opening it performs no tool call and cannot drift from what the agent received. Missing snapshot identity renders a graceful unavailable state without resolver fallback.

Canonical knowledge remains flat under `memory/`; scope, category, priority, and status belong in metadata. The schema is intentionally small:

- scope: `global`, `module`, `task`;
- category: `principle`, `invariant`, `decision`, `constraint`, `lesson`, `state`, `instruction`;
- priority: `critical`, `important`, `normal`, `contextual`;
- status: `active`, `superseded`, `deprecated`, `consolidated`, `duplicate`, `disputed`.

The deterministic implementation is conservative and remains the default. The optional experimental Knowledge Engine below adds a provider-neutral reasoning boundary through the existing MCP lifecycle.

Runtime distribution uses npm. The read-only npm release adapter reports installed/latest versions, availability and an exact manual command; an unavailable registry is never treated as current. `prodero_update` returns instructions and does not modify packages or project integration. Development checkout/manifest staging adapters require explicit development opt-in and are not production self-update.

Package upgrades leave project `.prodero` storage in place. Required schema migrations use an ordered registry with durable recovery backups outside disposable cache, canonical validation and transaction-aware writes. State advances only after successful completion. Managed integration changes are restricted to initialization, explicit maintenance or required migrations; ordinary Local activity stays Git-clean. Prodero never commits repository changes.

## Dogfooding and safe experiments

The public repository starts with project configuration and empty Versioned store placeholders. Development knowledge and skills remain Local, Git-ignored and absent from the public tree. Runtime state and all `.prodero` data are excluded from the npm artifact.

Development scripts and fixtures are excluded from the package. The clean release gate rebuilds tests, packs public resources and validates an isolated production-only installation. See docs/RELEASING.md.

## Scanner boundary

Scanning remains a future Core capability shared by MCP and CLI. The current UI may show a disabled roadmap action, but no scan tool or fabricated scan result exists.

## Local-first guarantees

Cloud services, accounts, hosted databases, remote MCP, and the App UI are optional. Without the runtime, `AGENTS.md` and the repository's Markdown and structured files remain accessible through ordinary tools and Git.


## Optional Knowledge Engine (experimental)

> LLM reasons; Prodero Core validates and applies.
>
> Intelligence processing is bounded by changed knowledge, not total project history.
>
> Prodero remains usable in deterministic fallback mode.

```text
Knowledge ingestion:
new unsynchronized session observations → DISTILL → evidence-grounded candidate proposals

Knowledge integration:
candidate → local bounded related-memory discovery → RECONCILE
          → whole-plan validation → staged canonical overlay

Knowledge integrity:
affected overlay + bounded neighbors → one AUDIT → validated corrections / Attention
                                    → atomic writes + checkpoint
```

The audit sees safely applied changes in an in-memory overlay. Disk changes are deliberately delayed until all reconciliation and audit proposals pass validation. A later invalid action therefore cannot leave earlier actions partially applied. Candidates are not canonical truth.

### Provider and supported development path

`src/core/intelligence.ts` defines `IntelligenceProvider` with `distill`, `reconcile`, and `audit`, each accepting a bounded typed input and an abort signal, returning an unknown structured result that Core validates. Providers receive no filesystem/root handle. The only transport adapter is `src/providers/mcp-sampling.ts`: standard MCP `sampling/createMessage`, enabled only when the client advertises `sampling` in negotiated capabilities. It uses basic text sampling, `includeContext: none`, no tools, a bounded output and timeout; the host controls model choice and permissions. JSON is parsed strictly, never extracted from prose or code fences. Sampling does not guarantee JSON output, so unsupported/malformed results safely leave sessions pending.

This mechanism is specified by [MCP sampling (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling) and documented by [VS Code's MCP guide](https://code.visualstudio.com/api/extension-guides/ai/mcp). The installed SDK uses this supported protocol path. It is not a promise that every coding host supports sampling. [Codex's MCP documentation](https://developers.openai.com/codex/mcp) does not establish portable sampling support; check `prodero_status_details.knowledgeEngine.samplingAvailable` on the actual freshly connected runtime. Current development validates the transport with an SDK sampling client whose model responses are deterministic test doubles; this is not evidence of successful real-model semantic behavior.

Configuration remains optional in `.prodero/config.json`:

```json
"knowledgeEngine": { "mode": "assisted" }
```

Omission or `mode: deterministic` retains local deterministic behavior. In assisted mode without a negotiated provider, Sync uses conservative deterministic fallback and records `fallbackReason`. No API key is required and no vendor SDK is installed. A provider rejection, timeout, malformed result, unsupported claim or invalid plan does **not** silently fall back: no semantic plan/checkpoint is committed and sessions remain pending for retry. The unchanged lifecycle is `prepare → automatic Sync → context → record → close → next prepare`; Sync Memory remains a separate improve/share workflow, while `sync-sessions` is the low-level closed-session recovery command. Fast Status never calls a provider, reads journals, enumerates corpora or adds hydration work. Capability/mode diagnostics live in Status details and Sync telemetry.

### Phase contracts and safety limits

DISTILL accepts only new observation evidence: source `session#observation` identity, session ID, content, original title/category/scope/priority, candidate kind and explicit supersession hints. Prior checkpoint observation hashes exclude previously processed observations even when an open session later changes. Older checkpoints remain readable; they lack observation hashes, so legacy changed sessions can conservatively reprocess old evidence. Unchanged historical session bodies never enter model inputs.

The strict result is `{candidates: [...]}`. Each candidate has a batch-local ID, `kind` (`knowledge`, `skill_candidate`, `instruction_candidate`), canonical fields, `sources`, exact evidence excerpts and `supersedes`. All source IDs must belong to the input batch. Every input observation must be represented, even when several sources collapse into one candidate. The provider can compact repeated wording or omit non-durable sentences, but cannot silently drop an entire observation's provenance.

This first implementation intentionally limits factual bodies to **extractive complete sentences** from source content. Titles may be composed; factual-body paraphrasing is not enabled. Reconciliation MERGE must preserve all distinct complete source sentences; NO_CHANGE requires extractive coverage, in addition to polarity/direction safeguards. This sacrifices some semantic compression for deterministic grounding. Exact excerpts and constraint guards prevent unsupported factual sentences; they are not a general proof of semantic entailment or an exhaustive contradiction detector in every language. Core also rejects changes in protected negation, direction/order, numeric versions, enablement, permission, timing and modality. The permanent regression tests include caching negation and reversed frontend/backend dependencies.

RECONCILE accepts one candidate and only the bounded related canonical bodies chosen by the existing lexical catalog. Its result is `{actions: [action]}` with exactly one action. Actions use `action`, `sources`, nullable `canonical`, a concise `reason`, and an optional backward-compatible `classification`:

- CREATE creates an active candidate with Core-generated identity.
- MERGE integrates two compatible active sources and unions provenance; audit merges retain the other record as historical `consolidated` knowledge.
- SUPERSEDE requires explicit source supersession hints or grounded complete-replacement proofs (an already recorded supersession edge during audit); old content remains with historical status.
- CONFLICT preserves incompatible evidence as linked disputed records.
- NO_CHANGE adds provenance only; audit duplicates retain the other historical record.
- LINK keeps distinct knowledge and relates it.
- UNCERTAIN preserves unresolved evidence as active related knowledge; only an explicit `potential_conflict` classification makes it disputed. It never forces compression.

Core validates exact schemas, source membership, target IDs within supplied context, state transitions, scope/category and priority authority, evidence excerpts, protected constraints, complete-source retention in merges, and the 2,000 estimated-token canonical body/title limit. Disk IDs are generated by Core, never from provider paths. Canonical symlinks/path traversal are rejected. All underlying session observations remain intact. Optional typed evidence references support future file/test/commit/documentation/user-instruction evidence; only session-observation references are populated now. No scanner is introduced.

Skill candidates retain their existing stable observation-derived IDs, candidate status and review lifecycle. Intelligence cannot activate them or turn them into knowledge. Inferred global instruction proposals are retained in checkpoint `instructionCandidates`, with their original session evidence, excluded from required context; there is no automatic promotion; the existing instruction-review tool provides the review workflow. Normal non-candidate observations retain the existing product's explicit scope/priority authority.

### Bounded affected-area audit

`AuditInput` is also the future explicit Memory Area Audit extension point, with no scheduler or whole-project sweep. The affected area starts with staged created/changed/historical/conflicted items, then explicit relationships and catalog-selected neighbors. A deterministic policy triggers **one** audit when nontrivial reconciliation merged, superseded, linked, conflicted or was uncertain, or at least three records were touched. Exact duplicates and trivial no-change batches skip it.

Audit returns `status: clean | changes_proposed | uncertain`, typed issues (`contradiction`, `duplicate`, `obsolete`, `unsafe_merge`, `fragmentation`, `constraint_loss`, `uncertain`), and corrective actions. Corrections use the same mutation validator and can only reference supplied area IDs; CREATE and historical reactivation are prohibited. Unresolved issues become disputed records. Truncated review is reported as Attention, never whole-project coherence. There is no recursive audit or hidden retry loop. Coherent means only the bounded reviewed area.

Centralized hard limits in `INTELLIGENCE_LIMITS`:

| Boundary | Maximum |
|---|---:|
| Distill input JSON | 4,000 estimated tokens |
| Observations / candidates per batch | 12 / 12 |
| Related memories per reconciliation | 12 |
| Reconcile input JSON | 8,000 estimated tokens |
| Audit area | 16 items |
| Audit input JSON including changes/evidence | 12,000 estimated tokens |
| Output per call | 32,000 UTF-8 bytes |
| Sampling generation limit | 4,000 host output tokens |
| Provider timeout | 45 seconds |

Input JSON budgets cover content/metadata; the adapter adds a small fixed protocol prompt/schema. Oversized single observations stay pending instead of being cut mid-constraint. Oversized pending sets are batched; memory candidates and audit input are trimmed before provider invocation. A cold local index may scan bodies to rebuild, but those historical bodies are never all transmitted. Computation/model cost scales with changed evidence, not full history.

### Application, recovery and explainability

Every Sync holds a per-worktree process lock in `.prodero/.transactions/`. Assisted plans contain before hashes and validated after-images. A durable `pending.json` write-ahead journal survives deletion of disposable `.cache/`; atomic file replacement applies the validated plan and writes its immutable checkpoint **last**. Subsequent Sync/prepare recovers a partially applied journal before doing new reasoning. A diverged before-image stops recovery with an explicit error instead of overwriting concurrent user edits. Stale process locks are reclaimed only when the owner no longer exists. A lock without owner metadata requires inspection. This is recoverable multi-file application, not a filesystem-wide atomic snapshot: readers can see intermediate files during interrupted application until Sync recovers. Journals/locks are local runtime state, self-ignored for Git and not shared between worktrees.

Checkpoint records retain concise phase/action/source/target/reason metadata, original canonical before-images for affected existing records, processed observation hashes, review candidates and phase telemetry. No hidden chain-of-thought or full model transcript is persisted. Existing source sessions, provenance, checkpoint chain and indexes remain authoritative; caches remain rebuildable.

Telemetry records phase calls, sessions/observations/candidates, input/output estimates, candidate comparisons, action counts, bounded audit size/truncation/issues/corrections and result. Actual provider usage is optional and separate; basic MCP sampling exposes no standardized billing usage, so it is left absent. Session Learned retains product labels and adds only a compact audit result/Attention; it is not an LLM trace viewer.


### Knowledge reconciliation categories

`src/core/reconciliation.ts` owns classification normalization, bounded semantic reconciliation and presentation signals. Session review, assisted Sync and assisted publication previews call the same `reconcileCandidate` path. UI displays the returned severity and review flag; it does not detect conflicts.

Reconciliation actions optionally carry `classification`: `state_transition` (an update), `refinement`, `duplicate`, `supporting`, or `potential_conflict`. `unresolved` means evidence needs semantic interpretation, and `independent` means distinct related knowledge. These last two are informational fallback categories, not conflicts. Classification is retained in the existing checkpoint reasoning records; no knowledge schema migration is required.

Meaning and storage action are separate. A newer implementation or intentionally adapted test can establish `state_transition` even when old tests passed. Full replacement still requires existing grounded supersession proofs. Partial updates can use LINK and preserve complementary older claims. Refinement can MERGE subject to existing extractive safeguards, or LINK when a safe merge is unavailable. Duplicate/supporting evidence uses NO_CHANGE only when existing content covers it. Only incompatible claims about the same state without evidence establishing the current claim are `potential_conflict` and disputed.

Old provider actions without classification remain supported: SUPERSEDE maps to state_transition, MERGE to refinement, NO_CHANGE to supporting (exact equality uses duplicate), CONFLICT to potential_conflict, UNCERTAIN to unresolved, and CREATE/LINK to independent. Existing stored disputed records and their history remain readable; they are not silently reinterpreted or automatically cleared.

In deterministic mode or without a sampling provider, explicit supersedes IDs, exact equality and complete source-sentence containment supply limited classifications. Other differences remain unresolved and both records stay active. Titles, token overlap, polarity, numbers and storage timestamps alone never establish a conflict. Users can enable the existing assisted engine for semantic classification; optional review falls back to neutral deterministic signals on provider failure, while Sync retains its fail-without-commit behavior.

Only potential_conflict uses warning styling. State transitions say “Knowledge evolution detected — newer evidence updates earlier project state.” Refinements say “Knowledge refined — newer evidence adds detail to earlier knowledge.” Unresolved evidence says “Related evidence will be reconciled during consolidation.” Instruction/skill proposals and invalid observations retain their existing review workflow without being classified as knowledge conflicts.

## Migration Foundation

Project structure and canonical knowledge have independent versions under `.prodero/config.json`. The existing Core migration engine owns ordered planning, approval-bound execution, staging, backup integrity, shared locking, rollback and diagnostic history. Open, Prepare, MCP/text and CLI consume that engine. See [Migration Foundation](docs/MIGRATIONS.md) for version transitions and lifecycle boundaries.

# App-first knowledge review

> v0.1 contract: Local/Versioned describe Git storage and sharing, not a security boundary against the connected agent. Review and approval are workflow safeguards, not authenticated human consent. The agent may create, promote and maintain Versioned files. Curator does not commit or push; users review repository changes before doing so. See [Privacy](PRIVACY.md).

The review workflow separates analysis, dispositions, clarification and execution state.
See [Review lifecycle](#review-lifecycle) for the current journal,
projection, deferral and legacy compatibility contract. The protected Apply
protocol below remains authoritative.

## Architecture and protocol

The graphical workflow is Analyze → Review knowledge → Current / Suggested /
Decide later → review summary → Apply changes → result. Only the final Apply
handler invokes `prodero_curation_apply`. Rendering, navigation, refresh, analysis,
simulation and staged decisions do not apply knowledge changes.

`reviewCuration` is no longer a startup requirement. Previously its trusted
embedding callback authenticated review and supplied the exact-batch grant; normal
MCP startup did not supply it. Now the server adapter validates saved review
state before granting the existing invocation-local `withTrustedKnowledgeBatch`.
Core retains the same policy gate and exact-record authorization, without MCP or
host-specific dependencies.

1. `prodero_curation` exposes plan, simulate and defer, including in text mode.
2. App-only `prodero_curation_review` exposes create, inspect, decide and preview, plus analysis, answers, deferral/reopening and retry actions.
   Creation seals the server's current plan; the UI displays that saved plan.
3. Decisions are `current | suggested | deferred`, keyed by server-defined review
   items. Absence means not reviewed, never implicit acceptance. Linked merge
   proposals form one review item. Unsafe/conflicting items cannot be Suggested.
4. Each staging request supplies the expected decision revision. Conflicting
   edits return `review_changed` and require reloading the saved decisions.
5. The final App-only `prodero_curation_apply` request contains `reviewId`,
   `planHash`, `decisionRevision`, `selectedIds`, and optionally `projectRoot`.
   Replacement records, output text and approval booleans are not accepted.
6. The adapter derives selection from the saved decisions and immutable plan,
   compares it exactly with the request, checks dependency closure, and executes
   only those entries through Core.

Both App-only tools declare `_meta.ui.visibility: ["app"]` and are deliberately
outside the `prodero_text` gateway. Their handlers also require the standard MCP
Apps MIME capability on the connection; non-App clients fail closed even if they
ignore visibility metadata. Capability negotiation is not proof of user intent. The old `action:"apply"`, including with
`approved:true`, fails validation. The external callback has been removed; an old
runtime embedding must migrate to the App flow. Unrelated Sync Memory routes and
authorization remain unchanged.

## Review lifecycle

`.prodero/local/curation-reviews/<reviewId>.json` holds the immutable snapshot:
project path and canonical real path, plan hash, engine version, complete catalog
fingerprint, source revisions/preimages, exact outputs, evidence revisions,
dependency groups, creation time and integrity hash. The paired `.state.json`
now holds the version-2 decision journal: snapshot/project binding, a legacy-compatible baseline and append-only revisioned user events. Version-1 state remains readable.
Writes are atomic and staging uses the common writer lock. No lock is held during
human review. Reopening resumes the newest valid review matching the current plan;
MCP restart does not discard it.

Snapshots expire for Apply after seven days and are bounded to 32 per project,
with an 8 MiB per-file limit. Decision-bearing snapshot/journal pairs remain pinned
and inspectable past expiry. Creation prunes only abandoned decision-free pairs;
if saved decisions fill the capacity, creation fails visibly without deleting them.
Journals additionally cap events at 2,048. Cleanup is opportunistic.
Checkpoint receipts have independent existing history retention and are not
removed with reviews. Pending transactions prevent creating a new review rather
than making analysis recover a partially applied mutation.

## Validation, transactions and replay

Apply acquires the existing writer lock, recovers unfinished transactions, then
checks for a completed receipt **before** stale validation. Operation identity is
a hash of review ID and the sorted exact selection; order does not affect it.
The completed receipt is bound to project identity and plan hash. An identical
retry returns its checkpoint, even after review expiry/removal or a lost response.
It does not execute a second mutation or fail because the successful operation
made its own source plan stale.

For a new operation the server validates snapshot integrity, project, engine,
plan hash, decision revision, exact selection and complete dependency groups.
It replans the full relevant catalog/evidence under the lock and compares plan
hash and catalog fingerprint. Core also checks selected source/evidence revisions
and transaction preimage hashes. Any stale plan applies nothing and returns
`stale_review`; changing the selection on an already applied review requires a
fresh review. Cooperative project writers share this lock. Arbitrary external
filesystem edits are not a serialized writer and remain subject to the existing
transaction conflict/recovery contract.

The existing exact-mode transaction writes outputs/retirements and checkpoint,
with checkpoint completion last, then rebuilds the index. Recovery rolls forward;
there is no new Undo implementation. History includes review and operation IDs,
plan/engine, exact selection, staged decisions, preimages and complete proposed
outputs. Results identify applied, unselected and unresolved proposals, checkpoint
ID/location and whether the response is a replay.

## Human review

All surfaces consume a shared server projection, including persisted deferrals.
The default entry focuses on decisions needing attention; Review all includes
all knowledge. Cards compare current/suggested text, policy, applicability and
scope. Clicking a card stages its choice and advances; Previous and per-item
summary links allow corrections. Left/Right select Current/Suggested, L defers,
and Backspace returns. Keyboard navigation has no Apply shortcut.

Straightforward suggestions can be selected together through an explicit action;
existing Current/Later choices are preserved. Nothing is preselected because it
is high-confidence. Unresolved recommendations remain unavailable for application.
The summary distinguishes current attention, deferred issues, deferred changes,
unchanged records and included proposals and can preview context
impact for the staged selection. Technical identifiers and results are in Details.
Stale review displays “Knowledge changed since this review” with a fresh-review
action. Successful completion shows counts and history availability.

## Workflow safeguards and host compatibility

The first-party App and a compliant MCP Apps host provide the intended review workflow, not authenticated human authorization.
The host must hide App-only tools from the model and route App tool calls. An App
can invoke tools through `App.callServerTool`; a server receives a normal tool
request, not a cryptographic attestation of a physical click. Visibility metadata
is **not** authentication against a malicious raw MCP client, modified App, or
host that exposes all tools to its model. No `approved` boolean or client-provided
proposal can substitute for the validated server snapshot and Core grant.

This uses the standard [MCP Apps interaction model](https://modelcontextprotocol.io/extensions/apps/overview)
and [tool visibility metadata](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).
Codex and Claude use the same adapter where the host supports these capabilities;
there is no host-name branching. Actual visibility enforcement, App permissions,
reload behavior and rendering must be verified for each host/version. A host
without Apps uses preview-only text. This phase implements no MCP elicitation.
No trusted-host authorization or elicitation system is required for the accepted v0.1 contract. Existing App-only curation and preview-only text routing remain workflow restrictions; other agent-callable Versioned writers remain available.

## Verification and host acceptance

Automated tests cover snapshot persistence/retention, selection and merge groups,
unresolved rejection, source/evidence/dependency/catalog staleness, identity and
payload rejection, non-App connection rejection, writer serialization, recovery before validation, replay after
lost response and snapshot removal, alternate selections, legacy/text rejection,
and App-only metadata. Production UI handlers run against the actual server over
an MCP in-memory transport: rendering, cards, backtracking, bulk decisions,
preview/reload, keyboard, final Apply, completion and stale recovery are exercised.
These tests do not establish host-side filtering or visual appearance.

For host acceptance, after `npm run build` in the repository, use
`node scripts/curation-review-fixture.mjs` to create a
throwaway project, open its Curator App, and verify:

1. Review renders; opening/reopening, refresh and preview preserve knowledge bytes.
2. Current/Suggested/Later stage only decisions; only Apply sends
   `prodero_curation_apply` and creates a curation checkpoint.
3. Details' checkpoint matches the reviewed outputs and source preimages.
4. Repeating the same captured Apply request through the App bridge returns the
   same checkpoint with `replayed:true` (including after a lost response).
5. Edit a fixture source after review; Apply returns `stale_review`, changes
   nothing else and offers Review updated changes.
6. Inspect the host's model-facing catalog: neither App-only tool is exposed;
   model-visible curation and text paths cannot apply.

Do not substitute a raw SDK client for the host checks in steps 1, 2 and 6.

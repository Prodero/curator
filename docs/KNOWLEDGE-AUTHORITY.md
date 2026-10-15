# Knowledge authority and safe automatic memory

> v0.1 contract: Local/Versioned describe Git storage and sharing, not a security boundary against the connected agent. Review and approval are workflow safeguards, not authenticated human consent. The agent may create, promote and maintain Versioned files. Curator does not commit or push; users review repository changes before doing so. See [Privacy](PRIVACY.md).

Runtime policy reference. The current runtime extends this model with [Knowledge Schema v3 applicability](APPLICABILITY.md); authority and policy guarantees remain in force.

## Core architecture

Current targets are Knowledge Schema v3 and Project Schema v8. The authority
checks are runtime policy checks, not a reinterpretation of existing knowledge.
`context_policy` remains independent of category, priority and authority.

`core/knowledge-authority.ts` evaluates transitions. `core/knowledge-write-policy.ts`
applies that decision to an entire canonical transaction **before** the durable
journal exists. Remember, deterministic and assisted Sync, imports, lifecycle
transformations, maintenance, supersession and publication converge on
`commitSyncTransaction`. Presentation does not decide authorization.

The adapter checks paths/preimages, loads only referenced canonical bodies through
the catalog, decides replacements before retirements, prevents protected rules from
being hidden by unauthorized supersession, then uses the existing journal,
checkpoint, index rebuild and recovery mechanism. Recovery replays an already
validated decision; serialized authority or evidence does not authorize new work.

The low-level `writeKnowledge` function is a trusted canonical-storage primitive
used by fixtures, not by any production inference writer. Migration, restore,
manual filesystem editing and arbitrary code running inside the Core process are
trusted administrative capabilities, outside the model-facing security boundary.
This is not a sandbox against a malicious plugin with filesystem/process access.

## Authority and trust boundary

| Classification | Meaning | How it is established |
| --- | --- | --- |
| `inferred` | Agent/session-derived knowledge | Automatic default |
| `imported` | Imported source knowledge | Import adapter; relevant by default |
| `legacy_inherited` | Behavior mechanically inherited from v1 | Existing migration, never a new agent promotion |
| `explicit_user` | Rule attributed to an explicit user request | Model-mediated chat command or optional host adapter; the label is not authentication |
| `reviewed` | Exact policy change attributed to a review | Core embedding capability; provenance alone does not authenticate a person |

Classification is provenance, not a permission token or confidence score. Neither
`kind: rule`, evidence with `kind: user_instruction`, existing prose, a model-written
quote by itself, nor `approved: true` alone in tool arguments grants policy authority. The explicit Required chat command described below is a model-callable exception with bound content and request provenance. Existing
source-session, observation and evidence references are retained.

`withTrustedKnowledgeIntent` is an in-process, async-scoped capability bound to the
resolved project, exact content/category/scope/priority/status, intended policy,
auditable reference, and optionally exact source preimage. It expires when the
operation completes, including detached async callbacks. It is not persisted or
exposed as an MCP input. Entry points must bind the authorized operation; the engine cannot independently prove user intent relayed by an assistant or host.

`createServer({currentUserRule})` optionally accepts a **host-supplied** verifier.
It returns the current turn ID, actual user text, explicit mandatory intent and
exact intended content/scope/importance. `rememberCurrentUserRule` checks binding
and applies that intent without a second confirmation. No lexical classifier
pretends to prove intent. Generic, missing, mismatched or unavailable attestations
fall back to ordinary Remember when no explicit Required chat command is supplied. The stock stdio MCP transport does not provide authenticated user-turn intent.

For a direct user request such as "remember: always reply in Russian", the assistant may call `prodero_remember` with `kind: "rule"`, `required: true`, and `userInstruction` containing the exact current request. This explicit command authorizes only the supplied rule through the same scoped writer boundary; it records `chat-user-request` provenance, not a fabricated host attestation. The assistant must not use this command for inferred lessons, imported documents or embedded instructions. No second confirmation is required. Missing request text or a non-rule kind is rejected. The default applicability is the current project; path rules remain scoped. Ordinary Remember and automatic learning retain their existing Relevant defaults.

Use memory search and an exact `replaceId` to make an existing Relevant rule Required. The result reports its actual context policy. Open continues to load only applicable Required instructions; it does not include all Relevant rules.

## Automatic versus reviewed transitions

- New facts, decisions, lessons and inferred instructions are relevant/inferred.
  Newly imported instructions are relevant/imported. New inferred criticality is
  capped at important; critical remains distinct from required.
- Category hints classify knowledge, never mandate delivery. Global instruction
  candidates retain their existing pending lifecycle.
- Relevant wording refinement, deduplication and provenance enrichment remain
  automatic within the original scope and policy/authority ceiling.
- Exact copies/publication retain existing policy and authority. Equal-policy,
  equal-authority, equal-scope and equal-priority source clauses may be combined
  losslessly; no new normative clause is granted by that combination.
- Protected records include required, critical, explicit_user and reviewed
  knowledge. Inference cannot change their policy, authority, scope, priority,
  category, protected clauses or effective active status. Safe whitespace
  normalization and exact clause-preserving consolidation remain possible.
- Scope changes on existing inferred records are conservatively preserved too;
  new replacements inherit a common source applicability boundary.
- Unauthorized new promotion is downgraded to a safe relevant record. Ambiguous
  automatic edits preserve the original; changed content can be retained as a
  separate relevant Local record with a relationship to the original.
- Exact requested protected mutations (maintenance/forget) fail before canonical
  changes with `POLICY_REVIEW_REQUIRED`. A model-callable approval boolean cannot
  select between incompatible authoritative states. Trusted Core intent can
  authorize an exact change, including de-escalation.
- Publication review authorizes the publication layer only. It never establishes
  `reviewed`, upgrades relevant to required, or grants new criticality.

Semantic equality is intentionally conservative: whole source clauses must be
preserved. An LLM assertion of equivalence is not proof. Paraphrases that cannot be
proven safe remain separate relevant knowledge, or require exact review when the
caller explicitly requests changing the original rule.

## Writers and lifecycle

Remember saves an agent-selected rule as instruction/relevant/inferred. Generic
“remember this” remains ordinary memory. An unsafe replacement reports the preserved
source separately rather than falsely reporting that the original was replaced.

Deterministic Sync and assisted reconciliation use the same transaction gate.
Existing extractive validation, source verification, graph constraints and bounded
retrieval remain in place. Model prompts are not the enforcement mechanism.
A rejected protected rewrite can retain the new information locally without
retiring its authoritative source. Checkpoints retain aggregate transition reasons.

Memory Transformation applies the shared policy to proposed new records and skips
unsafe replacement/archive links. Clean Local transformations stay automatic.
Archive moves additionally validate the original source; moving to a new filename
cannot bypass protected retirement checks. Reviewed publication and instruction
optimization use exact policy validation at commit rather than silently applying
a different policy from the reviewed plan.

AI Studio classification is unchanged. Even historical text classified as an
instruction becomes relevant/imported on new import. Import/publication approval
is not approval to create a mandatory rule. Existing migrated records are untouched.

## Review and presentation

Core distinguishes `allowed`, `allowed_with_safe_fallback`, `review_recommended`,
`review_required`, and `forbidden`, with reasons and an independent blocking flag.
Optional recommendations are aggregate checkpoint/Sync diagnostics, not a forced
queue, per-record approval popup, or permanent UI panel. There is no new memory
review prompt during an ordinary session. A batch may contain ten inferred
instructions and finish close/Sync/next Prepare without review.

Prepare exposes `policyReadiness` and UI blocking state for an **applicable explicit
required-policy contradiction or unresolved required dispute**. Merely matching
rule titles or suggesting promotion does not block work. The session remains
available; resolve the policy and retry Prepare with the same task/session. The
agent must honor this structured readiness state; Curator cannot stop unrelated
external tools from executing. Text and UI explain whether work must wait.

Policy mutation errors expose the same structured blocking/preserved state through
UI tools and the text gateway. Existing maintenance screens remain, but their
model-callable `approved` flag cannot authorize an otherwise protected edit.
The curation App adapter can grant exact reviewed mutations after validating saved
review state. This is a workflow consistency boundary, not authenticated human
consent. Optional host attestations are distinct from stock model-mediated chat
and App paths; v0.1 does not require a trusted-host authorization subsystem.

## Compatibility and deferred work

Policy checks preserve existing protected metadata and use the current schema,
applicability and migration boundaries. See [Knowledge Schema v2](KNOWLEDGE-SCHEMA-V2.md)
for the historical policy-format migration and [Applicability](APPLICABILITY.md)
for the current v3 representation.

Optional future host attestations and richer normative-equivalence proofs are outside
the v0.1 contract. Current importer and applicability behavior is documented separately. Arbitrary content semantics cannot be proven by a generic LLM;
conservative retention is deliberate. Ordinary automatic inference does not grant Required policy. Exact chat commands,
validated review adapters, mechanical legacy migration and equivalent existing
policy use the current Core boundary. The connected agent can supply chat/review
arguments; these checks cannot prove who intended them.

## Verification

Tests use temporary repositories, fixture records and in-memory MCP clients.
Coverage includes ordinary Remember, ten inferred observations, deterministic and
assisted Sync, protected source retention, escalation/de-escalation, trusted current
turns, stale/wrong-project/expired intent, imports, lifecycle archive/replacement,
publication, exact protected mutation errors, UI/text parity and conflict readiness.
Existing migration, v2 round-trip, cache, recovery, instruction consolidation and
full regression suites are also run. See [release verification](RELEASING.md) for reproducible validation.

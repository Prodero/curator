# Context Selection v2

Context Selection v2 changes runtime allocation only. Knowledge Schema remains v3. Applicability, authority, canonical writers, migration and curation authorization are unchanged. Open/Bootstrap keeps its existing compact allocation.

## One resource ledger

Prepare uses `ContextAllocation` as its single capacity ledger. Existing applicability and ranking identify candidates before allocation. Delivery is whole-record and deterministic; no model calls occur in selection.

Order:

1. Applicable Required, using existing criticality/relevance ordering.
2. Strong matching active Skills (existing skill score at least 14).
3. Relevant, using existing lexical/applicability/graph ranking and scope/category diversity.
4. Remaining matching Skills if capacity permits.

Required takes precedence over Skills. A skill with strong domain evidence gets capacity before optional knowledge. Four skills and 1,500 skill tokens remain safety limits. The score 14 threshold uses accumulated domain evidence in the existing scoring model (for example, title plus scope, or multiple trigger matches), rather than introducing new skill semantics. Skills omitted by total/token/item constraints are diagnosed individually.

## Required reserve and safety

The default total remains 6,000 estimated tokens. The existing 2,000 Required setting is a reserve, not a ceiling. Required may borrow all unused total capacity; an unused reserve is released to Skills/Relevant. With default total, Required is bounded by 6,000; independent hard ceilings of 16,000 tokens and 128 records protect projects configured with much larger totals. Hard ceilings are runtime safeguards, not new required user configuration.

No record is split. An oversized record can be omitted while later fitting Required records are delivered, but the result is explicitly incomplete. No required record is reclassified as Relevant to evade a ceiling.

`policyReadiness` precedence remains conflict (`review-required`), unknown applicability (`context-needed`), then delivery failure (`required-incomplete`), then `ready`. All first three states block safe continuation. Allocation completeness and omission diagnostics remain available even when another readiness state takes precedence. Incomplete delivery is not ordinary optimization; inspect omissions and retry after providing an appropriate task boundary or explicitly changing total capacity. The allocator never changes policy or scope itself.

## Relevant marginal continuation

Existing `context.max_items` (default 8) is the initial soft retrieval target. It remains a bounded graph-seed target too. Eligible records are ranked with existing signals; beyond that target a candidate must satisfy all of:

- diversity-adjusted score at least 12 and at least 30% of the best candidate's base score;
- at least three previously unsupplied non-query, non-numeric terms;
- novel terms at least 20% of its non-query content vocabulary;
- whole-record token capacity and the 128-record safety ceiling.

Novelty is measured against delivered Required and previously selected Relevant. It is an approximate redundancy signal, not semantic equivalence or authority. A rejection does not prevent a later valuable/fitting record from being considered. Traversal can stop when all remaining records are below the monotonic score floor or none can fit. Ranking uses sorted scope/category queues, preserving diversity ordering without sorting the whole candidate set on each step.

This deliberately leaves spare capacity when the next information is weak or redundant. The first target is still governed by existing retrieval eligibility; it is not a guarantee that eight records exist. Settings retain compatibility names (`maxRelevantItems`, `requiredContextBudgetTokens`) in existing contracts; `allocation` gives their unambiguous target/reserve meaning.

## Diagnostics and compatibility

`ContextResult.allocation.version = 2` reports demand, delivery, borrowed tokens, completeness, hard ceilings, beyond-target selection, capacity/safety/marginal omissions, skill allocation, and unused total capacity. Existing metrics remain for compatibility. Required pressure relative to the reserve can be high while delivery is complete; readiness/completeness, not that ratio, decides whether work can continue.

Omitted records retain legacy `reason` plus precise `constraint` where applicable. Retrieval evidence adds `marginal-value`; snapshots retain the actual allocation rather than rerunning retrieval. View Context exposes allocation Details and omitted-record causes; text presentation uses the same Core result. Normal UI remains counts and readiness.

Legacy `budgetTokens`/`requiredBudgetTokens` config aliases remain supported. No config edit or knowledge migration is required for this allocator.

Skill curation previously simulated a one-token Required ceiling to retrieve those records as optional evidence. It now consumes delivered Required and Relevant explicitly; no escape hatch can bypass the Required safety ceiling.

## Stable acceptance fixtures

`test/helpers/context-v2-fixture.mjs` creates synthetic temporary projects with explicit v3 policies/applicability. Fixed token demands exercise Required borrowing, Relevant novelty and skill competition using the actual estimator, catalog and selector. These fixtures are not a copy of a private project.

## Limitations

Token counts remain byte-based estimates of knowledge/skill payload, not a tokenizer count of the entire MCP/JSON envelope or host prompt. Marginal novelty cannot prove semantic redundancy; synonymous notes or incidental vocabulary may be misestimated. Thresholds are deterministic heuristics, tested against synthetic workloads, not a guarantee for arbitrary live project corpora. The first target uses existing retrieval quality. Large genuinely mandatory corpora can still produce incomplete context; the allocator does not silently relax protection.

## Validation

- Server TypeScript build and MCP Apps UI/plugin builds: passed through `npm test` pretest.
- `git diff --check`: passed.
- Ten focused allocator regressions cover actual selector fixtures, Required borrowing/completeness and hard ceilings, oversized whole records, strong/weak Relevant, Skill competition, readiness precedence, MCP/text serialization and View Context diagnostics. Existing budget, pressure, curation simulation and instruction-review tests now exercise real total-capacity failures rather than the retired ordinary item stops.

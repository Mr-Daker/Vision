# V014 — Domain Transitions and Persistence Invariants

**Status:** Ready for owner approval
**Roadmap task:** V014 · **Prerequisites:** V003, V011, V012, V013 · **Owner:** Backend + QA
**Code:** `packages/domain/src/{transitions,alias,participation}.ts` · **Tests:** `domain-policy.test.ts` (24), `persistence.dbtest.ts` (30)

> Executable policy with no storage, clock, or network access, plus real-database tests. Matching, merging and reopening **workflows** are still V027–V035; this task supplies the rules and constructed histories they will be built on.

## 1. The five pure function groups V014 requires

| Requirement             | Module             | Key property                                                                                                                                |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Transition validation   | `transitions.ts`   | Submission, `IssueMatch` and `CanonicalIssue` matrices with every V003 precondition as an explicit input                                    |
| Participant eligibility | `participation.ts` | Session validity and `demo_processing` consent are both required; simulated identity counts within the demo cohort with provenance recorded |
| Recurrence              | `participation.ts` | Returns `requiresHumanDecision: true` and **two** permitted treatments — it refuses to classify                                             |
| Alias rules             | `alias.ts`         | Active-edge resolution, cycle rejection, 16-hop bound, closure enumeration                                                                  |
| Correction semantics    | `participation.ts` | Close-and-supersede plan; refuses backdating, empty reasons, and a tree that already has two active rows                                    |

## 2. The acceptance condition

> _A resolution claim cannot become externally confirmed merely because a status field is supplied by a client._

`canTransitionIssue("resolution_claimed", "resolution_confirmed", …)` **denies** unless a persisted `ResolutionConfirmation` is passed in, its decision actually reads `confirmed`, and — for a participant actor — their participation counts on the issue. A reviewer needs no participation, and the actor type stays visible so reviewer confirmation is never shown as citizen confirmation.

The same shape guards acknowledgment: `routed_internal → agency_ack_received` denies without a recorded provider response, and rejects the inconsistent combination of a `real` provider mode with `simulated_fixture` authenticity.

## 3. Alias behaviour worth noting

An issue with no active outgoing edge is its own root. That is why merge **reversal needs no replacement issue**: closing the edge restores the original issue immediately, which a test asserts directly. Cycles and >16-hop chains fail safely rather than resolving.

## 4. Real-database tests (30)

Constraint rejections for all three V012 invariants and all four partial unique indexes, each paired with a positive case proving a successor is allowed once the prior row is closed. Plus: terminal-match result requirements, self-merge and self-alias rejection, event-version uniqueness, event/ingestion time separation, exactly-one-of confirmation actors, one confirmation per claim, replayed claim rejection, and the privacy constraints listed in [V012 §6](V012-database-schema-and-invariants.md).

**Optimistic concurrency** is tested end to end: writer A commits at version 1, writer B's stale `where current_version = 1` update affects **0 rows**, and the row retains A's status at version 2.

Two harness lessons are recorded in the file itself: expected violations need `SAVEPOINT`, because PostgreSQL aborts a whole transaction after any failed statement; and `now()` is constant within a transaction, so effective-dated originals must be inserted with an explicit earlier timestamp.

## 5. Not yet done

Wiring these guards into request handlers (V018+) · the finalisation transaction itself (V028) · merge/reversal workflows (V032) · analytics over the alias closure (V037–V039).

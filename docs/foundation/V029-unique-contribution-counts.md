# V029 — Enforce Unique Contribution Counts Across Merges

**Status:** Ready for owner approval
**Roadmap task:** V029 · **Prerequisites:** V009, V014, V025, V028 · **Owner:** Backend + QA
**Code:** `packages/adapters/src/participation-counts.ts`
**Tests:** `participation-counts.dbtest.ts` (14) · 18 mutations, 0 survivors

## 1. Four numbers, kept apart

"Fourteen people reported this" is the most quotable number this system produces, so collapsing these would be the easiest way to overstate public concern:

| Quantity              | Means                                                       |
| --------------------- | ----------------------------------------------------------- |
| `submittedMediaItems` | how much evidence arrived                                   |
| `uniqueContributors`  | how many distinct people reported                           |
| `onsiteEvidenceItems` | evidence carrying a **device measurement**, not a typed pin |
| `populationEstimate`  | **permanently `undefined`**                                 |

Population is never estimated. A count of reporters says nothing about how many people are affected, and presenting one as the other would be an invention. The field exists as an explicit absence so a caller finds nothing rather than substituting a contributor count.

## 2. Every route to inflating a count

- **One person, many reports** → one participation row, window widened, count unchanged.
- **A retry or duplicate delivery** → the unique constraint on `(participant_id, canonical_issue_id)` makes it a no-op; `created` is false.
- **Repeated accounts** → prevented upstream: the V009 identity mapping is unique on the hashed provider subject, so a second login with the same credential reaches the same participant. A test asserts the database refuses a second mapping for one subject.
- **A merge** → contributors are **unioned**, never summed. Two issues with two contributors each, one shared, give **three** — not four.

An ineligible contribution is recorded with a stated reason rather than dropped, so "not counted" is auditable instead of invisible.

## 3. A merge must not rewrite history

A participation moved onto the surviving issue keeps its own `first_evidence_at`: when someone first reported is history, and a merge is not licence to change it.

**A real bug found by mutation testing:** `onlyMovedByMerge` was accepted and then ignored, so reversing a merge swept the surviving issue's _own_ contributors onto the retired issue — corrupting both counts. Reversal now moves back only what that merge brought over, identified from the provenance recorded at merge time.

A participation that was _folded_ into an existing row (the same person on both sides) also records the fold, so reversal can recreate it. Without that, undoing a merge would silently lose the fact that the person had reported the other issue too.

## 4. Corrections and erasure

A superseded evidence link stops counting as media — a correction supersedes rather than deletes (V003), and counting the old row would double-count after every correction. Erased evidence drops out entirely: a tombstone is not evidence.

## 5. The corroboration signal goes live

`LiveCorroborationAdapter` replaces V025's `FixtureCorroborationAdapter`. `inputIsFixture` is now **false** and the descriptor reads `real`, because the number comes from counted participations.

A zero still means "no other counted participant", never "nobody else has this problem". A test caught this the hard way: the original assertion pattern included `/nobody else/`, which happily matched the sentence _"nobody else reported this"_ — the exact claim it was meant to forbid. The disclaimer is now asserted literally.

## 6. Verification

14 database tests, 18 mutations, 0 survivors.

## 7. Not done

Nothing calls `recordParticipation` from the submission path yet; V028's assignment creates the links but does not record participation — that wiring is still open · eligibility is supplied by the caller rather than evaluated here (V014's `evaluateParticipationEligibility` exists and is not yet connected) · `unionParticipationOnMerge` is a separate call from `mergeIssues` rather than part of it, so a merge without the follow-up leaves participations behind.

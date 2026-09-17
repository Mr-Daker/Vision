# V040 — Scoped contextual data with lineage

**Roadmap task:** V040 · **Prerequisites:** V004, V010, V011, V012, V013 · **Owner:** Data
**Code:** `packages/domain/src/context-import.ts`, `packages/adapters/src/context-import.ts` · **Schema:** migration `0028` · **Pack:** `packs/demo-district-a/context.json`

Population, enrolment, access and investment figures for the district — and the record of every row that was refused on the way in.

These are the numbers most likely to be quoted out of this system and the least likely to have been checked, because they arrive from somewhere else and look authoritative on arrival. Everything below follows from that.

## 1. There is no permitted external dataset, and the code enforces it

V004 §5 downgraded every candidate source. LGD and Know Your School are reference-only: a person may visit them to verify a citation, and no record value is copied. UDISE+, eGramSwaraj, population/demographics, funding and contractor candidates are all unavailable pending a Data-owner review that has not happened.

So every context figure in this demonstration is **team-created synthetic**, and that is checked in three places rather than assumed once:

- `loadContextPack` refuses a pack whose source is not `permitted`, `synthetic` or `consented`, and refuses a pack whose notice does not say in its own words that the figures are synthetic — because every screen showing one inherits that claim.
- `validateContextRow` rejects each row of a non-ingestible source with a reason naming V004.
- `ensureSourceRecord` refuses to write at all, so a caller that skipped the validator still cannot load one.

A test drives `reference_only`, `unavailable` and `verification_pending` through the loader and asserts each is refused.

## 2. Nothing is converted

There is no unit conversion in this task and there is not going to be one. A row declaring `households` where the dataset declares `persons` is **rejected**, not multiplied by an average household size somebody guessed. The conversion factor is the invention, and an invented factor is indistinguishable from a correct one once the number is on a screen.

The unit vocabulary is closed per kind — `persons`, `students`, `percent_of_households`, `inr` — in the domain module _and_ as a database CHECK. A share is always a percentage out of 100, never a bare ratio: `0.62` and `62` are the same access level written two ways and nothing downstream could tell them apart from the number alone.

Value parsing is deliberately strict. No thousands separators, no currency symbols, no trailing units. `12,400` is an error in the file, not an absence, and accepting it is how a decimal comma becomes a factor of a hundred.

## 3. Missing stays missing, and the database will not hold an unexplained null

Source files say `NA`, `-`, `n/a`, `not surveyed` and empty strings, and every one of them means _we do not know_. Each parses to a null carrying the indicator that produced it, and `context_observation` has a CHECK that a value and a missing-data indicator are mutually exclusive and jointly exhaustive: a null with no reason cannot be stored at all, because an unexplained null is exactly the state that later becomes a zero.

This is the same rule V037 M15 states for reporting, enforced one layer earlier at the point of ingestion.

## 4. Stale is reported, not refused and not refreshed

A population from three years ago is still the best figure available. What would be dishonest is presenting it without the three years. `stalenessOf` returns the age, whether it passes the dataset's currency window, and a sentence that says both — including, when it is stale, that it remains the most recent figure available.

The shipped pack contains a deliberately old access figure so this path is exercised by the demo rather than only by tests.

## 5. Everything refused is recorded, not logged

`context_import_rejection` persists the row index, the reason code, the human-readable detail and the row exactly as it arrived. The V040 acceptance clause is that invalid units, stale records and unmatched assets are _reported_, and a refusal that only ever existed in a log line is not reportable after the fact — "what did not load, and why" has to be answerable from the database a week later.

Every reason a row failed is reported rather than the first, so a file can be corrected in one pass. A run that rejects every row still commits: the dataset, the run and its rejections are the record of what was attempted, and rolling that back would leave nothing to look at but the failure of the command.

Re-running replaces a dataset's observations wholesale, so a corrected file does not leave the rows it corrected sitting beside their replacements.

## 6. Where it shows up

`npm run context:import` loads the pack and prints what it refused. `npm run context:report` prints the last run per dataset and every loaded value with its lineage.

The V039 district dashboard gained a **District context** section. Each figure is a card carrying the lineage sentence in the card itself — not in a tooltip, because a claim a reader has to hover to find is a claim the page did not make. `contextFigure` returns nothing for a value that could not carry a lineage sentence, so "every displayed context value links to a source record or is visibly synthetic" is true by construction rather than by review. A missing figure reads **Not known**, never `0`. A stale figure keeps full contrast and gains a caution marker: a number somebody can barely read is not a number they were warned about.

The refused rows appear on the same page with their reasons, and a clean import still says "none refused" — because an absent section and zero refusals are different statements.

## 7. V037 M14 is no longer permanently unknown

`Estimated population served` now reads from the loaded observations, and distinguishes two unknowns that were previously one:

- **`no_population_source`** — nothing was imported for this boundary.
- **`source_reported_unknown`** — a source was imported and recorded `NA` or `not surveyed`. That is a fact about the survey, not about this system, and it is reported with the source's own words.

Neither ever becomes `0`, and report volume is never substituted for either. M14 remains `requires_exclusive_boundaries`: the demo blocks nest inside their district, so summing them would count the same people twice, and `combineAcrossBoundaries` refuses.

## 8. Limits

- **Every figure is invented.** Nothing here describes a real place and none of it may be quoted. Moving any source to `permitted` requires the V004 Data-owner review, not a code change.
- **Asset-level context is supported but unused.** `context_observation` accepts an `asset_id` subject and the validator rejects unmatched ones, but the shipped pack carries only jurisdiction-level rows because V011's synthetic asset fixtures are not loaded in the demo path.
- **Import is a command, not a pipeline.** There is no scheduled refresh and no change-detection against a remote file; `npm run context:import` is run by hand. With no external source approved, a scheduler would have nothing to poll.

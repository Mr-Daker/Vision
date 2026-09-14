# V021 — Process Media into Usable, Traceable Evidence

**Status:** Ready for owner approval
**Roadmap task:** V021 · **Prerequisites:** V016, V017, V018 · **Owner:** Backend + AI
**Code:** `packages/media/` (decoders, fingerprints, region redaction) · `packages/domain/src/redaction-policy.ts` · `packages/adapters/src/media-pipeline.ts` (pure) · `packages/adapters/src/media-processing.ts` (IO shell)
**Tests:** 65 decoder tests + `index.test.ts` · `redaction-policy.test.ts` (11) · `redact-regions.test.ts` (10) · `media-pipeline.test.ts` (13) · `media-processing.dbtest.ts` (10)
**Run it:** `npm run db:up && npm run db:migrate && npm run test:db`

## 1. Three defects that made V021 unusable before this task

The decoders existed and their 65 tests passed, but the package could not be consumed by anything:

- **`packages/media/package.json` pointed at `./src/index.ts`, which did not exist.** Importing `@vision/media` failed with `ERR_MODULE_NOT_FOUND`.
- **`@vision/media` was never symlinked into `node_modules`** — `npm install` had not been re-run after the package was added.
- **`packages/adapters` did not declare the dependency**, so `check:imports` would have rejected the import once it worked.

None of the 65 tests caught any of this, because they import sibling files by relative path and so never exercise the package boundary. `index.test.ts` now imports by package name and asserts the public surface, which is the only test that could have failed.

## 2. What redaction can and cannot do here, stated plainly

The roadmap asks for "the approved face, number-plate, and contact-detail redaction policy". These are not equally tractable and the code says so:

| Concern                                 | Status                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contact details in text and transcripts | **Real.** Phone numbers, email addresses and identifier-like digit runs are located deterministically and replaced with `[contact detail removed]` |
| Covering a region once located          | **Real.** `applyRegionRedaction` fills it with one flat colour — irreversible, unlike a blur                                                       |
| **Locating faces and number plates**    | **Not implemented. No detector exists**, and adding a model or third-party dependency is out of scope                                              |

So `decidePhotoRedaction` treats **every** photograph as an _unresolved_ case: `needs_review`, `mayEnterPublicView: false`, `mayEnterAiPath: false`. That is what V021 requires of an unresolved redaction case, and it is the honest state rather than an assumption that a photograph is probably fine. A detector can be supplied later without changing a caller; a detector whose label names a simulation is still refused evidence-grade status.

**Consequence the owner should weigh:** with no detector configured, no photograph can reach the AI path or a public view at all. The demo's real-inference path is therefore text-first. This is a deliberate consequence of not having a detector, not an oversight.

Over-redaction is treated as its own failure: `"3 of 12 taps are broken since 2024"` and `"taps in rooms 1 2 3 4 5"` are left untouched, because destroying the report is not a safe default either.

## 3. The pipeline, and why it is split

`media-pipeline.ts` is pure — no database, object store, clock or network — so every decision is a function of the bytes and is tested over real fixtures. `media-processing.ts` does only what needs IO.

Obligations, mostly negative:

- Bytes that disagree with their declared type are **quarantined, not decoded**.
- Malformed media is quarantined with the decoder's own reason code (`decode_failed:<reason>`), never silently rejected.
- An unresolved redaction decision yields **no derivative bytes at all**.
- A derivative is re-encoded from pixels, so no EXIF, colour profile or text chunk from the original can travel with it. Asserted by scanning the output for `eXIf`, `tEXt`, `iTXt`, `zTXt`, `tIME`.
- SHA-256 of the original bytes is the cryptographic fingerprint; a perceptual hash is stored alongside it and the two are never confused.

The no-derivative rule is enforced in **four** independent places: the pipeline emits no bytes, the shell refuses to write them, `writeApprovedDerivative` refuses again, and `evidence_item_derivative_needs_approval_ck` refuses the row. Mutation testing cannot distinguish the middle two while the outer ones hold — which is what defence in depth looks like, and is documented as such in the code rather than papered over with a test that proves nothing.

## 4. Reuse without mistreating anyone

`findFingerprintReuse` reports other active evidence records with the same fingerprint. Every response carries `isIndependentCorroboration: false`: the same photograph submitted twice is one observation, not two. The earlier contributor's record is **never** deleted — asserted directly.

## 5. Two boundaries this task had to add

- **`grantStageOriginalAccess`.** Reading a private original required a _human_ role decision, and no role in that model is the worker. V006 §4 already intends a service identity ("`worker` may read originals for its stage"), so a narrow, purpose-bound, audited service grant was added rather than having the pipeline impersonate a reviewer — a false actor in an audit trail is worse than no entry.
- **`contentTypeOf`.** The accepted content type is knowledge the object store holds; the shell needed it without re-sniffing.

## 6. Where the format-mismatch boundary actually is

V016's `finalizeUpload` already sniffs and quarantines a declared/actual mismatch, so a mismatched upload **cannot reach the pipeline**. The pipeline keeps its own check (it is callable on bytes that did not come through V016), but the database test asserts the reachable truth — that the upload is refused — instead of testing an unreachable branch through a path that cannot produce it. The reachable decode-failure path is tested by corrupting a stored original after acceptance.

## 7. Verification

All mutation-tested: redaction policy 0 survivors of 10; region redaction 0 of 9; pipeline 0 of 16; IO shell 2 of 10, both documented as redundant layers whose enforcing counterpart is pinned instead (the store's refusal, and the erasure constraint).

Two survivors were kept and explained rather than killed with a test that would only restate the implementation: clamping a region's negative `y` (always a no-op, since a negative `y` yields a negative offset a typed array ignores) and the shell's inner publish check.

## 8. Not done

No face or number-plate detector, so no photograph is ever auto-approved · no reviewer interface to resolve a `needs_review` item (V032) · audio is probed by `packages/media` but not yet run through this stage · thumbnails are generated but nothing consumes them yet.

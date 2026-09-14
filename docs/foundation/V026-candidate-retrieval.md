# V026 — Retrieve Nearby and Asset-Related Issue Candidates

**Status:** Ready for owner approval
**Roadmap task:** V026 · **Prerequisites:** V011, V013, V021, V023 · **Owner:** Backend + Data
**Code:** `packages/adapters/src/candidates.ts` · `migrations/0010_semantic_vectors.sql`, `0011_issue_representative_embedding.sql`
**Tests:** `candidates.dbtest.ts` (15) · 13 mutations, 0 survivors

## 1. The radius follows the reported accuracy

A citizen's position arrives with an error estimate, and a fixed radius is wrong in both directions: too tight and a boundary-adjacent issue is missed for someone whose phone could not get a good fix; too wide and half the district becomes a candidate. So the radius is `base + accuracy`, and an **unknown** accuracy uses a stated allowance (250 m) rather than assuming precision.

An absurd accuracy figure is capped rather than used: a 50 km "accuracy" would make every issue in the district a candidate, which is the same as having no location at all.

Distances are computed on `geography`, so they are metres. A `geometry` column would return degrees here and the radius would be meaningless by five orders of magnitude — a mutation swapping the cast is caught.

## 2. An exact asset match is not subject to the radius

An asset identifier names the physical thing, not a place near it. An issue on the same asset is a candidate however far the reporter was standing, because a citizen can notice a broken school tap from the far side of the compound.

A nearby issue in a **different** category is still retrieved, but flagged `categoryMatches: false`. Retrieving it lets V027 decide; hiding it would remove a reviewer's chance to see a mis-categorisation.

## 3. Why there is no vector index

`gemini-embedding-001` returns **3072 dimensions** (measured at V023). pgvector's `ivfflat` and `hnsw` cap at 2000. Rather than shrink the vector to fit an index, this follows V026's instruction directly — "exact vector reranking over bounded candidates". The spatial index prunes; the cosine comparison runs exactly over what survives.

That is _more_ accurate than an approximate index, and honest about scale: V069 is where growth is benchmarked and an index strategy chosen from measured data, not guessed at now.

Both the model name and the width are stored per row, so a vector from a different model can never be silently compared with one from this model. A candidate carrying **no** comparable vector sorts last, not first: an earlier `nulls first` would have ranked "we cannot compare this" ahead of a measured close match, treating an unknown as a certainty.

## 4. An empty result is never proof

This is a bounded search — a radius, a time window and a row cap. Every result carries `absenceIsNotProof: true` and a note saying so, and `diagnostics.exhaustive` is false whenever the cap was hit. A `candidate_query_log` row records the bounds actually used, so a later reader can tell an empty answer from a query that never ran.

This is V002 row 20's prohibition applied to retrieval: absence of a match is not evidence of absence.

## 5. Verification

15 database tests over real PostGIS, including boundary-adjacent locations at exactly the radius edge, an imprecise fix that must widen the search, repeated issues on one asset, a nearby different defect, and mixed vector/no-vector reranking. 13 mutations, 0 survivors.

## 6. Not done

No index tuning or load measurement (V049, V069).

**Closed since this was written**

- The chain runs end to end. `packages/adapters/src/matching-pipeline.ts` invokes V026 → V027 → V028 → V029 → V033 inside one V017 stage lease, and writes the embedding, so `representative_embedding` is no longer populated only by tests.
- The uncalibrated window is gone as a _code_ default. `runMatchingStage` **requires** `bounds`, supplied as data by `loadMatchingBounds`; there is no fallback to 90 days in code, because a default in code is exactly what makes an uncalibrated number invisible. The bounds carry their own `version` and `note`, the note says the values are reasoned rather than measured and that V046 is where they would be calibrated, and every run records which bounds it searched — reported from the diagnostics retrieval actually used, so the note cannot quote a window that was not searched. A test proves a narrow window really narrows retrieval rather than merely being reported.

The numbers themselves are still uncalibrated. What changed is that they are now a stated, versioned, changeable decision with a caveat attached, rather than a constant nobody chose.

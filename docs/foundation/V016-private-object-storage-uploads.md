# V016 — Private Object-Storage Upload Contracts

**Status:** Ready for owner approval
**Roadmap task:** V016 · **Prerequisites:** V005, V008, V013, V015 · **Owner:** Backend + Platform
**Code:** `packages/adapters/src/object-store.ts` · **Tests:** `object-store.test.ts` (20)

> The backend is a local filesystem, not a managed bucket. What is implemented is the **storage semantics** — scoped grants, unique paths, completion validation, quarantine, limits, cleanup. A managed driver (V051) must pass the same tests. Nothing here claims a production storage posture.

## 1. Four trees, because mixing them is how evidence leaks

| Tree           | Contents                                      | Class                                    |
| -------------- | --------------------------------------------- | ---------------------------------------- |
| `staging/`     | upload in progress; expires if never finished | L2                                       |
| `originals/`   | accepted private evidence; never public       | L2, exceptional access only (V015 §3)    |
| `quarantine/`  | failed or suspicious bytes, isolated          | L2                                       |
| `derivatives/` | redaction-approved, public-safe output only   | L1 once approved (V021 decides approval) |

**The invariant that matters most: a failed upload never produces accepted evidence.** Every rejection path either leaves nothing behind or moves the bytes to `quarantine/` — never to `originals/`.

## 2. A grant authorizes one object, not a bucket

`createUploadGrant` returns a reference bound to a fresh date-partitioned UUID path plus an HMAC over `(reference, owner pseudonym, intended content type, max bytes)`. The write path checks that MAC with `timingSafeEqual`, so a client cannot:

- write to an object it was not granted (the owner is inside the MAC),
- change the declared type or the size ceiling after the grant (both are inside the MAC),
- guess another object's path (the path is a random UUID, never derived from anything the client supplies).

Expiry is **not** in the MAC; it is held in the server-side grant record and checked on every write and finalize. That is a deliberate split — the MAC authorizes _what_ may be written, and server state decides _whether it still may be_, so revoking a grant does not require the token to change.

Paths are resolved and range-checked **before** any filesystem call, and a traversal attempt raises `ObjectStoreError` rather than returning a quiet `false`. That was a real bug during implementation: the resolution originally sat inside a `try` that swallowed it, so an escape attempt looked like an ordinary rejection.

## 3. Completion is validated against the bytes, not the metadata

`finalizeUpload` rejects, without accepting evidence:

- a forged or mismatched completion MAC,
- content whose **magic bytes** disagree with the declared type (`image/jpeg`, `image/png`, `audio/webm`, `audio/ogg` are the permitted set),
- an empty object, or one exceeding the granted `max_bytes` ceiling (itself capped at `MAX_OBJECT_BYTES`, 8 MiB),
- a finalize for an object that was never granted, or whose grant expired before completion.

A finalize replay for the same reference returns the same accepted object instead of storing a second one, so a retried request cannot double-count evidence.

## 4. Reading an original is exceptional

`grantOriginalAccess(decision, purpose)` takes a V015 `Decision` and refuses a purpose shorter than 8 characters. It returns the grant plus the audit obligation, so a routine read cannot become an untracked original read. Redacted-derivative access is the normal path and is not flagged.

## 5. Cleanup

`STAGING_TTL_SECONDS` is 24 h. `cleanupExpiredStaging` removes staged objects past their TTL (or past their grant expiry) and returns the references it removed, so a job can report what it cleaned; it never touches `originals/`, `quarantine/` or `derivatives/`. Scheduling belongs to the worker (V017 gives the durable execution primitives); this task supplies the operation.

## 6. Capability honesty

`OBJECT_STORE_CAPABILITY` is declared `simulated` and, per [V002](V002-capability-evidence-matrix.md) row 5, **may claim** only stored byte size, content type and a cryptographic fingerprint. It **must not claim** "verified authentic photograph" or "confirmed not AI-generated". A fingerprint proves byte identity and nothing about provenance.

## 7. Not yet done

**Grant state is a process-local `Map`, not a table** — a restart forgets in-flight staging grants, so an upload interrupted by a restart must be started again. Persisting grant records belongs with the managed driver (V051); the accepted objects themselves are on disk and are unaffected.

Managed private buckets and lifecycle rules (V051) · media normalisation, thumbnails, perceptual fingerprints and redaction (V021) · virus scanning · signed direct-to-storage uploads from the browser.

# V044 — Demonstration notices and private-data handling

**Roadmap task:** V044 · **Prerequisites:** V002, V005, V015, V019, V021, V030, V032 · **Owner:** Security + Frontend
**Code:** `packages/domain/src/privacy-audit.ts`, `packages/adapters/src/privacy-audit.ts`, `packages/adapters/src/erasure.ts` · **Schema:** migration `0031` · **Command:** `npm run audit:privacy`

V015 built the boundaries and V005 wrote the rules. This is the task that goes looking for places they were not kept, and the one that makes the demonstration say what it is at the screens where somebody might assume otherwise.

## 1. The audit is checked against planted data

An audit that always passes is indistinguishable from an audit that does not work. So every class the scanner claims to detect is planted and caught before the real data is declared clean: an email address in an event payload, a mobile number, a raw model request kept in the cache, a cleartext provider subject, a private original's reference. `PLANTED_PROBES` exists for that, and a test asserts every pattern has one — a detector nobody has proved works is a source of false confidence.

`npm run audit:privacy` exits non-zero on any finding, so it can gate a release rather than be read.

## 2. A finding never reproduces what it found

`scanText` reports the pattern that matched and a **masked** excerpt — first character, last character, length. An audit report that prints the leaked email address has leaked it a second time, into a file that is easier to read and more widely circulated than the one it came from. A test asserts that nothing in a whole scan result reproduces a planted value.

## 3. What it scans, and what it refuses to claim

| Scope          | What is scanned                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| identity store | every `identity_mapping`: a digest, or an erased tombstone, and nothing else                              |
| model traces   | every `ai_result_cache` result and provider request id                                                    |
| logs           | `private_evidence_access_log` purposes, every `status_event` payload, every `outbox` payload              |
| public views   | the public representation of **every** issue, built by running `toPublicIssueView`                        |
| fixtures       | every committed text file under `packages/fixtures`, the config packs, `tools`, `docs` and `deliverables` |

Public views are **built rather than sampled**. Running the one function that produces a public representation over every issue catches a field added upstream on the very issue it would have leaked from, rather than on whichever issue somebody happened to open.

The limits are printed with every result, because a clean audit is evidence that the detectable classes are absent and is not a guarantee that nothing personal is present. It does not attempt to recognise people's names — a name detector would miss most names and match place names, and a clean result from one would be read as proof there are none. It does not read image or audio content; a face inside a photograph is a redaction question (V021).

**Two refinements were made against real false positives.** Number patterns are bounded against hexadecimal context, because the last group of a UUID produced a "mobile number" on roughly one identifier in ten; and the private-original pattern requires a real path rather than the tree's name, because the V005 document discusses `originals/` correctly and was being reported as leaking from it. Each trades a possible miss for findings a reader will act on — an audit whose findings are mostly noise teaches its readers to skip them.

## 4. Notices at the screens that need them

Two things are said where a reader would otherwise assume the opposite, and both at the screen rather than in a policy page nobody opens:

- **identity is simulated**, wherever somebody signs in or their account is shown;
- **departments and recipients are simulated**, wherever a department, a recipient or a delivery appears.

`notices.test.ts` checks the shipped HTML rather than a constant, so a notice removed during a redesign fails the build instead of being noticed by a user. It also asserts that no screen claims a report reached a real authority.

The audit found two real gaps. **`app.html` — the screen a citizen actually reports from — said neither.** Its only disclosure was rendered by script into the footer after a receipt. It now carries a localised notice above the sign-in, in English and Marathi, with the English inline as the pre-script fallback so a reader whose scripts have not run still sees it. The reviewer workspace said identity was simulated but not departments, and now says both.

> The Marathi string added here is team-authored and is part of what V024's native-speaker review must cover.

## 5. Deletion requests

`eraseParticipant` acts on a request. What it removes and what it keeps are separate decisions, and the second is the one worth stating.

**Removed**: the keyed identity digest, every submission's precise location and accuracy, and every piece of evidence content — object references, fingerprints, perceptual hashes, capture metadata, transcripts and derivatives. Live sessions are revoked.

**Kept**: the rows, as tombstones, and every count the person contributed to. This is not a compromise. V029's unique-contribution counts exist so "fourteen people reported this" cannot be inflated; if erasure deleted participation rows, every deletion request would quietly reduce a public number and the count would stop meaning what it says. The response says so to the person asking, because it is the part they would not expect.

**Not stored at all**: the requester's own words. The record carries a reason _code_ from a closed list and counts — a free-text field is exactly where somebody types the number they want removed, and it would land in an event payload this task's own audit then has to find. A test scans the erasure record itself and asserts it is clean.

Migration `0031` adds `erasure` as a session revocation reason. Recording it as `admin_revocation` would put a staff decision in the audit trail where a citizen's request belongs, and `logout` would read as the person closing a tab.

Erasure is idempotent: asking twice is asking the same thing, and an error would read as a refusal.

## 6. Limits

- **The scanner detects classes, not people.** See §3.
- **`POST /v1/me/erasure` has no screen.** The endpoint derives the participant from the session and never from the body; a citizen-facing control for it belongs with the V030 tracking surface and is not built here.
- **Exports** are named in the task's build line and have no implementation to apply rules to: nothing in this system exports data today, so there is no export path for the audit to cover. Recorded rather than quietly treated as done.

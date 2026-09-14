# V020 — Resilient Drafts and Submission Retries

**Status:** Ready for owner approval
**Roadmap task:** V020 · **Prerequisites:** V005, V018, V019 · **Owner:** Frontend + Backend
**Code:** `apps/web/src/drafts.ts`, `submission.ts` (`SubmitGuard`), `upload.ts` (retry), `main.ts`
**Tests:** the V020 cases in `capture.test.ts`, plus the browser walkthrough in §5

> The failure this task is about: a citizen with a weak connection must not lose their report, **and** must not be shown a receipt that does not exist. Those are two different failures and both are addressed here.

## 1. Losing connectivity never looks like acceptance

A send that never reaches the server produces `offline: false → true` in the API client, and the interface says "You appear to be offline. Nothing was sent." The receipt panel stays hidden, the form stays usable, and the draft is kept.

Verified in a browser by replacing `fetch` with a rejecting stub mid-flow: no receipt appeared, the draft survived, and the same idempotency key was reused on the retry, which then returned a real receipt.

## 2. Reconnecting preserves the original idempotency key

The key is minted once per report attempt and stored **with the draft**, so it survives a reload, a restored draft and a signed-out-and-back-in session. A retry therefore returns the original receipt rather than filing a second report ([V018](V018-submission-acceptance-and-receipt.md) §2). "Report another problem" mints a new key — reusing the old one would replay the previous receipt.

The key is deliberately **not** a hash of the form contents: two genuine reports about the same pothole from the same place must both be accepted.

## 3. Duplicate taps

`SubmitGuard` refuses a second send while one is in flight and for 1.5 s afterwards. It is time-and-state based rather than relying on a disabled attribute, because a second tap can arrive before a repaint. `end()` runs in a `finally`, so an attempt that throws does not wedge the button — tested.

The send button is additionally disabled whenever something blocks submission, but only for reasons the interface has already explained on screen.

## 4. Consent-aware device drafts

Nothing is written to the device until the citizen agrees, and the request states what is kept, where it stays, and for how long **before** they decide.

| Rule                    | How it is enforced                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No consent, no storage  | `save()` returns `false` and writes nothing; declining stores only the decision itself                               |
| Withdrawing consent     | Deletes the existing draft, not just future writes                                                                   |
| Disclosed lifetime      | `DRAFT_TTL_HOURS` = 24; an expired draft is **deleted** on the next load, and the lifetime is shown beside the draft |
| Media bytes             | Never stored — only a reference to an upload the server already accepted                                             |
| Unfinished uploads      | Not restored as attached photos: the citizen is asked to choose the photo again                                      |
| Untrusted storage       | Hand-edited or corrupt storage never becomes form state; an unknown `source` value is dropped rather than defaulted  |
| Sign-out                | Clears the draft **and** the consent decision, so a shared phone does not leak the last person's report              |
| Storage full or blocked | `save()` reports failure so the interface does not claim a draft was kept                                            |
| Discard                 | The citizen can delete the draft themselves; the form stays as it is on screen                                       |

Retention follows the [V005](V005-data-privacy-and-retention.md) device-draft policy. Draft content is L2 while it exists and is confined to the browser that wrote it.

## 5. Stale-location prompts

A device reading 10 minutes old or older shows "This location was captured N minutes ago. If you have moved since then, capture it again", with a re-capture button; the prompt is re-evaluated when the page becomes visible again, because a phone is usually pocketed between capture and send. A **typed** position never goes stale — it is a claim about a place, not a measurement of where the phone is now — and re-prompting for it would be nagging about nothing.

Verified in a browser with an injected 25-minute-old reading: the prompt appeared and cleared on re-capture.

## 6. Upload retry and cleanup

An explicit retry keeps the granted `objectReference`, so retrying re-sends bytes to the object already granted instead of leaking a fresh grant per attempt. Unfinished staged objects are removed by `cleanupExpiredStaging` after the 24-hour staging TTL ([V016](V016-private-object-storage-uploads.md) §5).

**Resumption is partial, and stated as such.** Bytes are never kept on the device, and V016 grant state is a process-local map, so an upload interrupted by a page reload or a server restart must be re-selected. The roadmap asks for "safe upload resumption _where supported_"; what is supported here is retrying an interrupted send in the same session without duplicating the object. Byte-range resumption needs the persisted grant records that come with the managed driver (V051).

## 7. Not yet done

No service worker, so the shell does not load with no connection at all — the app must be reachable once per session. Queued background send (a report finished while offline and sent later without the citizen present) is **not** implemented: it would mean holding report content on the device for longer than the disclosed rule and sending it without the citizen watching, which needs an owner decision first. Byte-range upload resumption (V051). Server-side crash and duplicate-delivery verification is V022.

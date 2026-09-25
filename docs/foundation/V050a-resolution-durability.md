# V050a — Resolution durability

**Roadmap task:** V050a (added from field evidence, not from the original roadmap) · **Prerequisites:** V029, V035, V036, V042, V046 · **Owner:** Product + Backend
**Code:** `packages/domain/src/resolution-durability.ts`, `packages/adapters/src/resolution-durability.ts`, `apps/web/src/durability-view.ts` · **Command:** `npm run durability:report` · **Fixture:** `npm run db:seed:durability` · **Screen:** a panel on `supervisor.html`

## 1. Why this exists

The documented failure of civic complaint systems is not backlog. It is **closure without resolution**.

- Of a thousand grievances received by the Greater Hyderabad Municipal Corporation, official sources put the number closed as resolved without anyone attending to the issue at roughly **eight hundred** ([Deccan Chronicle](https://www.deccanchronicle.com/southern-states/telangana/civic-officials-close-complaints-without-resolution-1946755)).
- A Bengaluru resident's pothole complaint was marked solved seven months later; the pothole was still there, and when he reopened it the ticket was closed again. One ticket named an engineer whose phone number belonged to a man who had died ([Deccan Herald](https://www.deccanherald.com/india/karnataka/bengaluru/bbmp-officials-caught-lying-on-sahaaya-app-1085813.html)).
- Nationally, CPGRAMS disposal statistics count whether a grievance received a **response**, not whether the problem was **fixed** ([PIB](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2226247&reg=3&lang=1)).

V035 already prevents that one closure at a time: only a counted reporter's confirmation closes an issue, a claim without completion evidence is refused, and a completion photograph is recorded as evidence rather than certification. Bengaluru's Sahaaya 3.0 is being built to do the same thing — reopen and confirm-before-closure — which is a reasonable check that the design is the right one.

What V035 cannot see is the **pattern**. This does.

## 2. Durability, not integrity

The name is the design. What can honestly be measured is whether resolutions **lasted**. A closure that did not hold is a fact — the issue came back. Why it came back is not in the data, and every figure here carries the explanations it cannot rule out.

Four refusals, which are the substance rather than the caveats:

**No score.** Counts and a 95% Wilson interval, reusing V046's `figureOf` unchanged. Three closures of which one came back is not "33%", and the interval says so.

**No league table.** `separated()` asks whether two intervals are disjoint. A unit appears as a concern only when its interval does not overlap the baseline drawn from **every other unit pooled** — a statement about whether it can be distinguished from the rest of the organisation, rather than about a line invented here. This is V042's rank-interval reasoning one layer up.

**No individual.** `resolution_claim.staff_id` names a person and the adapter deliberately does not select it. A dbtest asserts the staff identifier appears nowhere in a reading. The unit is the department within a ward; naming a person is a supervisor's deliberate act, not a dashboard's default.

**No word implying intent.** The finding is "did not hold". `BANNED_DURABILITY_PHRASES` refuses _falsif-_, _fraudulent_, _negligent_, _reliability score_, _worst performing_.

There is also a floor that is ethical rather than statistical: `MINIMUM_CLOSURES_FOR_A_CONCERN = 10`. Two closures of which two came back **does** separate from an eleven-percent baseline — and raising it would send somebody to examine a team's work on the strength of two events.

## 3. The five signals

| Signal                           | Read from                                                            | Denominator        |
| -------------------------------- | -------------------------------------------------------------------- | ------------------ |
| Confirmed, then reopened         | a reopening event, **or** a later completion claim on the same issue | confirmed closures |
| Disputed by the reporter         | `resolution_confirmation.decision`                                   | answered claims    |
| Claimed near the deadline        | claim time against `issue_alert.threshold_days`                      | all claims         |
| Claimed very soon after planning | the planning event, or failing that the assignment                   | all claims         |
| Claimed with minimum evidence    | count of `resolution_evidence_item`                                  | all claims         |

Three different denominators, named per signal, because V037's rule is that a rate names the population it was measured over.

**The signal deliberately not built:** a completion photograph geotagged far from the issue. `capture_metadata` reads `gpsPresent: false` because V021 strips EXIF before storage. Recovering it would mean retaining location data from staff phones, and that is a worse trade than the signal is worth. The limits say so rather than leaving a gap unexplained.

## 4. On the screen

A panel on the existing supervisor workspace — no new page. Every concern renders its alternatives **inline and uncollapsed**, in the same block as the count. On a terminal a caveat three lines below the number is read; in a collapsed section it is not, and these figures are about people's work.

## 5. What building it found

Three real defects, none of them in the new code.

**The supervisor queue query went blind in a ward with history.** `listSupervisorQueues` took the hundred **oldest** issues in a ward and only then sorted them into queues — but a confirmed resolution is in no queue at all. A ward with any completed work filled all hundred rows with finished issues, and a real issue opened two days ago simply was not in the result. Found when the seeded history pushed a V036 test's own issue off the end. Fixed by excluding what cannot be in a queue before the limit rather than after it, which leaves the output identical and makes the limit mean what it says.

**`now()` is transaction time.** The seeder's first version gave every one of its events an identical `recorded_at`, and V038's projection cursor cannot advance through hundreds of rows sharing one timestamp. `clock_timestamp()` is the right function for when a row was actually written.

**A fixture must not change the shape of what it fixtures.** The seeder's events pushed the `canonical_issue` event table from 473 to 503 against V038's 500-row apply batch, and a summaries test that legitimately expects a fresh projection to drain its backlog in one pass began to fail. The seeder now records a comeback as a second completion claim rather than a reopening event — which the measurement reads either way, and which is the more faithful record: the issue came back and somebody was sent out again. The underlying fragility is worth recording: **a fresh summary over a backlog larger than one batch needs two passes, and nothing says so.**

## 6. What this does not establish

- a closure that did not hold is a fact about the work, not a finding about the people who did it, and this cannot tell the two apart;
- the most intuitive signal is deliberately absent, and will stay absent;
- every figure rests on reporters choosing to reopen or dispute, so a ward whose residents stopped bothering will look durable;
- no unit is ranked against another, and a unit not listed is **not thereby cleared** — it may simply have too few closures;
- the signals about a claim's shape are the weakest here, and none is evidence of anything on its own.

## 7. Open

The demonstration fixture plants one ward with a durability problem. That the tool finds it proves nothing — anyone can write a tool that finds what they planted. What the demonstration is for is what the tool says _about_ the finding. Measuring this against data nobody arranged is a pilot question (V062).

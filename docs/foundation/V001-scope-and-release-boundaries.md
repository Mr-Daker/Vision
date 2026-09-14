# V001 — Scope and Release Boundaries

**Status:** Complete — Hackathon baseline locked on 9 September 2026; later changes require a versioned scope revision.
**Roadmap task:** V001 (Foundation) · **Prerequisites:** None · **Owner:** Product
**Companion documents:** [V002 capability/evidence matrix](V002-capability-evidence-matrix.md) · [V003 domain and lifecycle contracts](V003-domain-and-lifecycle-contracts.md) · [Vision system design](../../deliverables/Vision-system-design.docx) · [Vision development checklist](../../deliverables/Vision-development-checklist.md)

> This document defines scope and boundaries only. As of this task, no application code, database, or deployed environment exists. Nothing below should be read as a claim that any listed capability is already built.

**Revision note (this version):** locks Sangli district, Marathi + English, the government-school-infrastructure category, and the complete demonstration boundary. Appendix G defines the configuration contract that permits future district, language and category expansion without redesigning the core lifecycle.

---

## Scope-Lock Summary (one page)

**Product (one sentence):** Vision is a mobile-first web platform that lets a citizen report a public-infrastructure problem using only a location, a photo, and a short text or voice description, and converts that evidence into a tracked, deduplicated, department-routed issue with a visible, disputable resolution history.

**Problem hypothesis (validate, don't assume):** reporting is fragmented, repeated complaints on the same defect aren't connected, citizens can't see whether a report leads to action, and asset/funding context is disconnected from the complaint — see Appendix A for the full framing.

**Locked Hackathon scope:**

| Dimension               | Value                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial district        | **Sangli district, Maharashtra, India** — demonstration scope only; no government relationship or endorsement is implied                                                                |
| Category                | Government school infrastructure                                                                                                                                                        |
| Demonstration languages | **Marathi (`mr-IN`) + English (`en-IN`)** for the complete citizen reporting path; staff/reviewer UI may be English-first but must preserve and display the citizen's original language |
| Input media             | Photograph, short text, recorded voice — **video explicitly deferred** (Scale-phase, evidence-gated: V066)                                                                              |
| Citizen experience      | Mobile-first responsive web application / PWA                                                                                                                                           |
| Demo data boundary      | Team-created synthetic Sangli district/asset/routing fixtures plus separately consented evaluation media; no government dataset or department integration is implied                    |

**Selection rationale:** the Code for Communities Digital Public Infrastructure & Governance challenge asks for scalable, multilingual collection of citizen priorities, and GDG India's campaign highlights Sangli MP Vishal Patil describing the difficulty of hearing and responding to constituents at scale. Sangli therefore gives the demo a direct stakeholder narrative. Marathi is Maharashtra's official language and is supported by Gemini transcription as `mr-IN`; English provides a judge-friendly fallback. Sangli **district** is only the demo data boundary and must never be presented as identical to the Sangli parliamentary constituency. See Appendix E and the [source register](V004-source-and-reuse-register.md).

**Roles:** Citizen (submit, follow, confirm/dispute) · Reviewer (uncertain cases, flags, mistaken merges) · Department staff (acknowledge, act, claim resolution) · Supervisor (ageing, performance) · Administrator (configuration, accounts). Full table: Appendix A.

**Golden path (target, not built):** report → evidence processing → structured issue → duplicate/new-issue decision (owned by `IssueMatch` — see [V003](V003-domain-and-lifecycle-contracts.md)) → department routing → prioritization → resolution claim → citizen confirm/dispute → analytics. None of this is implemented by V001–V005. Full walkthrough: Appendix A.

**Hackathon boundary (V018–V054):** one district, one category, real Gemini inference, simulated identity (`IdentityMapping` + `Participant` + `Session`) and simulated department adapters — no real DigiLocker or government integration. Top exclusions: no native app, no video, no engineering-safety certification, no "proof of presence" claim, no perfect AI-image detection. Full exclusion list: Appendix B.

**Winning the demo** = all 12 observable acceptance criteria in Appendix C pass, **and** none of the 9 prohibited claims enumerated in [V002](V002-capability-evidence-matrix.md) appear anywhere in the UI, demo video, or slides. Meeting the criteria while violating a prohibition does not count as winning.

**Pilot (V055–V064) and Scale (V065–V072):** gated on named partners, approved policy, and pilot-measured evidence respectively — never assumed as a natural continuation of the Hackathon build. Full scope: Appendix D.

**Expansion rule:** no core workflow may contain Sangli-, Marathi-, or school-specific branches. Jurisdiction, locale, taxonomy, routing and policy versions enter through configuration packs; expansion therefore adds a reviewed pack and evaluation corpus rather than forking the application. Full contract: Appendix G.

### Sign-off (locks this document)

| Decision                                                | Value                                          | Approved by                                    | Date             |
| ------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- | ---------------- |
| Initial district                                        | Sangli district, Maharashtra, India            | Project owner — user-authorized scope decision | 9 September 2026 |
| Regional language                                       | Marathi (`mr-IN`), alongside English (`en-IN`) | Project owner — user-authorized scope decision | 9 September 2026 |
| Product Owner scope approval (this document as a whole) | Approved as the Hackathon baseline             | Project owner — user-authorized scope decision | 9 September 2026 |

---

## Appendix A — Problem framing, roles, and golden path (detail)

### A.1 Problem being solved

Based on the supplied Team Vision brief and the companion system design, the product hypotheses under test are:

- Reporting a public-infrastructure problem today is fragmented across channels, and repeated complaints about the same defect are not connected to one another.
- Citizens have weak visibility into whether a report leads to any action, which weakens trust in reporting at all.
- Asset condition history and public planning/funding context are disconnected from the complaint itself, making prioritization decisions hard to justify.

These are **hypotheses to validate with real citizens and staff**, not proven adoption or impact results. Vision's premise is: "report what you see; Vision structures it," followed by a visible next action — not a promise that reporting alone causes repair.

### A.2 Target users and roles

| Role             | Responsibility                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| Citizen          | Submits evidence, follows an issue's status, confirms or disputes a staff resolution claim.     |
| Reviewer         | Handles uncertain classifications, evidence flags, ambiguous matches, and mistaken merges.      |
| Department staff | Acknowledges assigned issues, records action taken, and claims resolution with evidence.        |
| Supervisor       | Monitors ageing, criticality, and department-level performance across assigned issues.          |
| Administrator    | Manages configuration (taxonomy, jurisdiction directory versions) and authorized-user accounts. |

### A.3 End-to-end "golden path" (conceptual demonstration target)

This is the full conceptual flow the hackathon build aims to demonstrate by V052. **None of these steps are implemented by this task (V001–V005); this section describes the target, not the current state.**

1. **Report** — citizen allows location capture, adds a photo and a short text or voice description, submits.
2. **Evidence processing** — media is validated, redacted where required, fingerprinted, and analyzed. If the citizen opts into voice, the recording is sent to the disclosed Gemini transcription operation; only its transcript continues into classification and consistency analysis (see [V005 §§4–7](V005-data-privacy-and-retention.md)).
3. **Structured issue** — evidence is proposed a category/defect type from a versioned taxonomy.
4. **Duplicate/new-issue decision** — owned entirely by an `IssueMatch` record ([V003](V003-domain-and-lifecycle-contracts.md) §3): the report is proposed as matching an existing canonical issue or starting a new one, with reviewable reasons. This decision is now explicitly separate from the canonical issue's own operational status.
5. **Department routing** — the canonical issue is mapped to a responsible department via a versioned jurisdiction directory.
6. **Prioritization** — issues are ranked using a disclosed, versioned policy combining severity, persistence, service population, and existing project context.
7. **Resolution claim** — staff record completion evidence.
8. **Citizen confirmation or dispute** — the reporting citizen (or another eligible participant, per `IssueParticipation`) confirms or disputes the claim; disputes reopen the issue.
9. **Analytics** — district/category summaries show backlog, resolution cohorts, and time-to-resolution with disclosed coverage and denominators.

## Appendix B — Hackathon scope and exclusions (detail)

### B.1 Hackathon scope (V018–V054)

The Hackathon phase builds a complete, deployed, Sangli-district, government-school-infrastructure demonstration of the golden path above, using Marathi and English citizen flows, real Gemini inference (V023), and clearly labeled simulated identity and department-recipient adapters (V009, V010). See the [checklist](../../deliverables/Vision-development-checklist.md) for the full task list.

### B.2 Explicitly excluded capabilities (all phases through Hackathon)

- Native mobile application (PWA only).
- Bounded/long video capture (photo, text, and voice only; video is a Scale-phase, evidence-gated decision).
- Real DigiLocker identity verification (simulated demo identity only; see [V002](V002-capability-evidence-matrix.md)).
- Real government department integration or acknowledgment (simulated department adapter only).
- Any perfect AI-image-authenticity detection.
- Any automatic proof that a report is genuine, or that a person was physically present.
- Any automatic engineering/structural-safety certification derived from photos or AI output.
- BigQuery, additional messaging/notification channels, and multi-jurisdiction onboarding (all explicitly deferred to Scale, and only if measurements justify them).
- National or multi-district deployment.

## Appendix C — Hackathon acceptance criteria (observable, testable)

Each item below must be independently checkable by an evaluator without relying on team narration.

- [ ] A citizen completes the full report flow (location permission → photo → text or voice → versioned consent → submit → receipt) on a mobile browser in Marathi and in English, **without** selecting a department, category, or severity anywhere in the form; locale switching does not discard a draft, and optional Gemini voice processing has a separate unchecked-by-default consent purpose.
- [ ] The submission screen displays a location-accuracy value (e.g., "±12 m") before submission, and no screen states or implies that a captured location proves the citizen was physically present.
- [ ] Every successful submission returns a durable receipt (a stable identifier and status URL) that remains retrievable after a page reload, app restart, or network interruption during submission.
- [ ] Each processed submission displays a structured classification (category, defect type) together with the evidence used to produce it, and shows an explicit "review pending" state when classification confidence is low — never a bare confidence percentage presented as a truth probability.
- [ ] Each submission is shown either attached to an existing canonical issue (duplicate) or as a newly created canonical issue, with the candidate signals used (location, asset, similarity) visible to a reviewer, per the `IssueMatch` record that produced the decision.
- [ ] Each canonical issue displays the department it is routed to, and visibly distinguishes "internally routed" from "acknowledgment received," with an explicit note that acknowledgment is simulated in this build.
- [ ] Each canonical issue shows a chronological timeline of status events (submitted → review → routed → acknowledged → resolution claimed → confirmed/disputed/reopened).
- [ ] A citizen can confirm or dispute a staff resolution claim, and the issue's displayed status changes accordingly (confirmed vs. disputed vs. reopened).
- [ ] A district/category analytics view displays at least backlog count, a defined cohort resolution rate, and time-to-resolution for the demo dataset, each labeled with its data coverage and as-of date.
- [ ] The citizen report flow passes a basic accessibility check: full keyboard-only completion, and screen-reader announcements for location, photo, and submit controls.
- [ ] Every simulated provider (identity, department acknowledgment, and any synthetic funding/project data) is visibly labeled as simulated everywhere its output is shown in the UI.
- [ ] No screen, label, notification, or presentation slide states or implies: verified real-world identity, proof of physical presence, official government receipt, confirmed engineering safety/certification, or a calibrated probability that a report is genuine.

## Appendix D — Pilot and national-expansion scope (detail)

### D.1 Authorized-pilot scope (V055–V064)

A controlled pilot with a named participating authority, a real department recipient with verifiable acknowledgment, approved real citizen identity (via an eligible provider), an approved onsite-evidence policy, and a passed security/retention/restore drill — gated on named partners, not assumed. See the checklist for full pilot prerequisites (V055–V064).

### D.2 National-expansion scope (V065–V072)

Staged expansion to additional jurisdictions, categories, and languages, with optional technology (richer media, a data warehouse, additional notification channels, deeper historical/contractor analytics) adopted only where pilot-measured evidence justifies it — never assumed necessary for geographic expansion. See checklist V065–V072.

### D.3 Pilot learning goals (measurable, not yet executed)

- Measured citizen completion rate and time versus a comparable existing reporting channel (V045).
- Measured identity-verification drop-off, isolated from form-completion speed, once real identity is introduced (V057, V059) — and separately, measured session-related friction (logins/re-logins) versus genuine identity friction, since [V003](V003-domain-and-lifecycle-contracts.md) now models these as distinct (`Session` vs. `Participant`).
- Measured classification and duplicate-detection accuracy against a frozen, reviewed holdout, reported per language and category (V046).
- Measured department response and acknowledgment latency from an actual real recipient (V058, V063).
- Documented accessibility findings from real users, including assistive-technology use (V065).

## Appendix E — Locked decisions, assumptions, and selection rationale

| Item                                 | Status                                                                                                                                                                                                                                                                               | Owner                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Initial district                     | Locked: Sangli district, Maharashtra, India; internal jurisdiction ID only until an external identifier is permitted                                                                                                                                                                 | Product                 |
| Regional language                    | Locked: Marathi (`mr-IN`) with English (`en-IN`)                                                                                                                                                                                                                                     | Product                 |
| School-defect taxonomy               | Not yet drafted (owned by V011)                                                                                                                                                                                                                                                      | AI + Data               |
| User-testing cohort                  | Not yet recruited (owned by V045)                                                                                                                                                                                                                                                    | Product + QA            |
| Team stack expertise, hosting budget | Assumed to match the system design's recommended stack (TypeScript PWA, modular API/worker, PostgreSQL/PostGIS/pgvector); not yet confirmed by Team lead                                                                                                                             | Team lead               |
| Hackathon voice processing           | Gemini transcription is the proposed implementation; raw audio crosses that external boundary only after explicit opt-in and disclosure, and the transcript alone feeds classification. Product/Security approval is still required — see [V005](V005-data-privacy-and-retention.md) | Product + Security + AI |

**Why this pair fits the Hackathon:**

- [GDG India's Code for Communities campaign](https://www.linkedin.com/company/gdgindia) describes the governance track as helping policymakers hear citizen voices at scale and specifically highlights Sangli MP Vishal Patil's constituent-reach problem. That is unusually close to Vision's core workflow and makes Sangli a stronger demonstration anchor than an arbitrary large city.
- The [official Sangli district profile](https://sangli.nic.in/en/about-district/) documents varied geographic, social, urban and rural contexts across the district. It supports the scope rationale as a reference only; its records are not ingested or copied into fixtures.
- A [Government of Maharashtra language circular](https://gr.maharashtra.gov.in/Site/Upload/Government%20Resolutions/English/201712051645450633.pdf) identifies Marathi as Maharashtra's official language, and [Google's Gemini transcription documentation](https://ai.google.dev/gemini-api/docs/transcribe) lists Marathi as `mr-IN`. Marathi + English therefore gives the demo a defensible, executable accessibility story without taking on several untested languages at once.
- V011 uses synthetic schools, boundaries, departments and history labeled as synthetic. Any real photograph/voice example requires V005 consent and must not identify children or bystanders.
- Marathi model/transcription quality remains a claim to measure on a frozen bilingual holdout at V046, not an assumption made by this scope decision.
- Sangli district and the Sangli Lok Sabha constituency overlap but are not identical. District analytics must never be labeled as constituency coverage or an MP's performance.

## Appendix F — What "winning the demo" means (detail)

The demonstration is considered successful when a judge can observe, start to finish, without team narration filling a gap:

1. One real Gemini classification call on real, consented and approved/redacted photographic evidence; if voice is demonstrated, one separately disclosed Gemini transcription call whose transcript—not the audio—feeds classification (per [V005](V005-data-privacy-and-retention.md)).
2. Two distinct citizen reports against the same synthetic school context — one Marathi voice report correctly matched (`IssueMatch=match_confirmed`) to an existing canonical issue, and one English text report correctly kept as a distinct issue (`IssueMatch=no_match` — a different defect nearby).
3. One full staff-resolution-claim → citizen-dispute-or-confirmation cycle.
4. One Sangli-district/category policy or analytics view, with disclosed synthetic/consented coverage, denominators and as-of date, and no claim that district coverage equals parliamentary-constituency coverage.
5. Passing accessibility checks for the citizen report flow (Appendix C).
6. No occurrence, anywhere in the UI, demo video, or slides, of any claim listed as excluded in Appendix B or prohibited in [V002](V002-capability-evidence-matrix.md).

Meeting items 1–5 while violating item 6 does **not** count as winning the demo — see the enumerated prohibited-claim list in V002.

## Appendix G — Future-extension contract

The first release is intentionally narrow; the implementation must not be. These rules preserve a clean route from one-district demo to a multi-jurisdiction product:

1. **Jurisdiction configuration:** use an internal `jurisdiction_profile_id` and a versioned hierarchy. For the Hackathon, the profile represents Sangli district using synthetic geometry and asset identifiers. External LGD/department identifiers remain nullable until their reuse and authority are approved.
2. **Locale configuration:** store BCP 47 locale tags (`mr-IN`, `en-IN`) and keep user-authored text/audio provenance in the original language. UI copy, prompts and notifications live in locale resources; taxonomy IDs and lifecycle states remain language-neutral.
3. **Taxonomy configuration:** `school-infrastructure.v1` is a versioned category pack, not application branching. A future roads, water, health or sanitation pack supplies its labels, defect types, validation rules and routing mappings through the same interfaces.
4. **Routing configuration:** departments and responsibility rules come from an effective-dated directory with `synthetic`/`real` provenance. Adding a district replaces configuration data, never workflow code.
5. **Policy configuration:** matching radius, review thresholds, retention, public-location precision and prioritization weights are versioned per jurisdiction/category; every issue records the versions used.
6. **Expansion gate:** a new district/language/category is enabled only with an approved or explicitly synthetic data pack, translated and accessibility-reviewed citizen copy, a sealed local-language evaluation corpus, source/permission records, and rollback capability.
7. **No hard-coded scope:** CI must reject production logic that branches on `Sangli`, `mr-IN`, or `school-infrastructure`; tests load at least one second synthetic jurisdiction/locale/category pack to prove portability before Pilot.

This contract permits later expansion without pretending that the Hackathon has already validated multi-district, multi-category or national operation.

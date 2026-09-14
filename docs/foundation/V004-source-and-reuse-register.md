# V004 — Source and Reuse Register

**Status:** Ready for owner approval
**Roadmap task:** V004 (Foundation) · **Prerequisites:** V001, V003 · **Owner:** Data
**Registers:** [source-register.csv](registers/source-register.csv) · [external-access-register.csv](registers/external-access-register.csv)

> This document inventories _candidate_ sources and _prospective_ external-access requests. Listing a source here is not a claim that it has been accessed, licensed, or approved. No onboarding form, application, or outreach message described below has been sent — see §3.

**Revision note (this version):** V001 now scopes the Hackathon to Sangli district with Marathi + English. Official Sangli/Maharashtra pages and Gemini language documentation are recorded only as scope/feasibility citations; they do not supply fixture values. Every source previously carrying a `verification pending` licence remains either **reference-only** or **unavailable / not-approved for ingestion**. No source's `demo_status` may read `permitted source data` unless its licence is actually `permitted` or the data is `synthetic`/`consented` — see §5.

## 1. Purpose and method

This register exists so that every piece of data Vision's demonstration displays can be traced to one of exactly four `demo_status` labels:

- **permitted source data** — a publicly available or explicitly licensed dataset, confirmed reusable within its stated terms, and actually ingested;
- **team-created synthetic data** — authored internally, with no claim of representing a real record;
- **consented evaluation data** — real data contributed by a consenting participant for demonstration/evaluation only;
- **unavailable / not approved** — a candidate source that is not yet usable and must not appear in any demo path (this includes every reference-only source — see §5).

The `licence_or_permission_status` column (a separate, finer-grained field on each `SourceRecord`) may additionally read **reference-only**, meaning: a person may visit the live source to verify a citation or eligibility criterion, but no record value is copied into fixtures or the datastore on that basis.

**Public visibility of a dataset (e.g., a government lookup page) is not treated as blanket permission to copy or redistribute it in bulk, and it is not treated as permission to ingest it as demo data.** `verification_pending` is retained in the domain contract only as a transient state for a brand-new, not-yet-triaged candidate — no source may sit in `verification pending` indefinitely as a final answer; see §5.

## 2. Source register summary

The full inventory is in [source-register.csv](registers/source-register.csv) (16 columns per the V004 specification: dataset name, publisher, URL/location, access method, geographic coverage, publication/update date, access date, licence/permission status, permitted intended use, personal-data presence, useful identifiers, refresh cadence, known limitations, demo status, owner, verification status).

| Category                            | Candidate(s)                                                                                        | Demo status                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Administrative boundaries           | Local Government Directory (LGD)                                                                    | Unavailable / not approved for ingestion — reference-only (manual citation/eligibility check permitted; no record values copied)                                     |
| School / infrastructure assets      | Know Your School (KYS); UDISE+ Data Sharing registration                                            | KYS: unavailable / not approved — reference-only (manual citation/eligibility check only; no record values copied). UDISE+: unavailable — registration not initiated |
| Rural planning / asset context      | eGramSwaraj                                                                                         | Unavailable — candidate only, not yet evaluated                                                                                                                      |
| Government complaint data           | CPGRAMS public grievance portal                                                                     | Not used as an ingested dataset — reference only, to illustrate that Vision is not a CPGRAMS integration                                                             |
| Department responsibility directory | Team-authored fixture (to be built under V011)                                                      | Team-created synthetic data (planned)                                                                                                                                |
| Population / demographics           | Candidate: Census of India / state enrolment statistics — not selected                              | Unavailable / not approved                                                                                                                                           |
| Sanctioned projects / funding       | Candidate: state e-governance portals / PFMS — not selected                                         | Unavailable / not approved                                                                                                                                           |
| Contractors / work orders           | No candidate identified                                                                             | Unavailable / not approved                                                                                                                                           |
| Scope and language references       | Official Sangli district profile; Maharashtra language circular; Gemini transcription documentation | Reference-only documentation; no record values ingested into fixtures                                                                                                |
| Historical resolution information   | No candidate identified for Sangli district                                                         | Unavailable / not approved                                                                                                                                           |
| Evaluation media                    | Reviewed fixtures and sealed holdout (V011 corpus)                                                  | Team-created synthetic and/or consented evaluation data (planned, not yet created)                                                                                   |
| Identity provider                   | DigiLocker (Requester)                                                                              | Unavailable / not approved for Hackathon — simulated identity used instead                                                                                           |
| Prospective government recipient    | Sangli district education authority (exact legal office/contact not yet verified)                   | Unavailable / not approved — simulated department-inbox adapter used instead                                                                                         |

Reused entries (LGD, KYS, UDISE+ registration, eGramSwaraj, CPGRAMS, DigiLocker) carry the same publisher, URL, and checked date already established in the [Vision system design](../../deliverables/Vision-system-design.docx) sources list, to keep citations consistent across documents.

## 3. External access register and prepared outreach

The full inventory is in [external-access-register.csv](registers/external-access-register.csv) (entity/partner, desired capability, responsible owner, onboarding prerequisites, current status, blocking/non-blocking, next action, whether a draft request is prepared, notes).

**Live DigiLocker access and a real department-recipient integration are not required for the Hackathon demonstration.** Both are explicitly Pilot-phase gates (V057, V058), themselves gated on V055/V056 partner and policy approval. The Hackathon build uses simulated adapters for both (V009, V010) as recorded in [V002](V002-capability-evidence-matrix.md).

### Appendix A — draft DigiLocker requester inquiry (NOT SENT)

> Draft only. Requires review and authorization by the Partnerships owner before any contact is made. No email address, submission form, or organisation has been contacted.

```
Subject: Requester onboarding inquiry — Vision civic-reporting pilot

We are a team building Vision, a citizen infrastructure-reporting platform,
currently in a pre-pilot design phase (no real user data collected yet).
We would like to understand the organisational eligibility, vetting, and
agreement steps to become a DigiLocker Requester for a future authorized
pilot, per the published Partners SOP. We are not requesting production
access at this stage and have no live user base.

[Placeholder — organisation name, contact, and pilot description to be
completed by the Product/Partnerships owner before sending.]
```

### Appendix B — draft department-recipient inquiry (NOT SENT)

> Draft only. Sangli district is selected, but the exact legal recipient and contact remain unverified. Partnerships-owner review is required before any contact is made.

```
Subject: Exploratory inquiry — civic infrastructure reporting pilot

We are developing Vision, a citizen-reporting tool for public-infrastructure
issues (starting with school infrastructure), and would like to explore
whether the appropriate education authority for Sangli district, Maharashtra,
would be open to a small, controlled pilot:
receiving routed, evidence-backed reports and providing acknowledgment and
resolution updates through an agreed channel. This is an early inquiry, not
a request for immediate integration or data sharing.

[Placeholder — exact legal department/entity and authorized contact to be
verified and completed by the Product/Partnerships owner before sending.]
```

## 4. Outstanding verification items

- V001 has selected Sangli district with Marathi and English. V011 must create clearly synthetic Sangli-scoped assets, boundaries and routing fixtures; V019 must create reviewed `mr-IN`/`en-IN` locale resources. This selection does not authorize ingestion of an external dataset.
- LGD and Know Your School are confirmed live and publicly reachable, but are reference-only — a human may verify a citation or district-selection criterion, but no record value is copied into a fixture or datastore, neither is ingested, and neither backs a demo claim as "permitted source data."
- UDISE+ Data Sharing registration, population/demographics, sanctioned-project/funding, and contractor/work-order sources have no confirmed dataset selected; all are `unavailable / not approved` until a Data-owner review is completed.
- No organisation (DigiLocker, any department, or any data publisher) has been contacted. The draft texts in §3 are prepared, not sent.

## 5. Licence downgrade rule (this revision)

No source may be ingested into Vision's datastore, or cited as backing a demo claim, unless its `licence_or_permission_status` is `permitted` (confirmed) or the data is `synthetic`/`consented`. Concretely, in this revision:

| Source                               | Prior licence status   | Corrected licence status                   | Corrected demo status                    |
| ------------------------------------ | ---------------------- | ------------------------------------------ | ---------------------------------------- |
| Local Government Directory (LGD)     | `verification pending` | `reference-only`                           | `unavailable / not approved`             |
| Know Your School (KYS)               | `verification pending` | `reference-only`                           | `unavailable / not approved`             |
| UDISE+ Data Sharing registration     | `verification pending` | `unavailable / not-approved for ingestion` | `unavailable / not approved` (unchanged) |
| eGramSwaraj                          | `verification pending` | `unavailable / not-approved for ingestion` | `unavailable / not approved` (unchanged) |
| Population/demographics candidate    | `verification pending` | `unavailable / not-approved for ingestion` | `unavailable / not approved` (unchanged) |
| Sanctioned project/funding candidate | `verification pending` | `unavailable / not-approved for ingestion` | `unavailable / not approved` (unchanged) |
| Contractor/work-order candidate      | `verification pending` | `unavailable / not-approved for ingestion` | `unavailable / not approved` (unchanged) |
| Historical resolution candidate      | `verification pending` | `unavailable / not-approved for ingestion` | `unavailable / not approved` (unchanged) |

Every row above previously permitted a reading of "probably fine to use, pending confirmation." None now support that reading: the Hackathon demonstration's boundary, asset, and population/context data must come from **team-created synthetic data** unless and until a Data-owner review moves a specific source to `permitted` with a confirmed licence.

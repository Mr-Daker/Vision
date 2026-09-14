# V033 — Resolve Location and Category Through Versioned Directories

**Status:** Complete and verified  
**Roadmap task:** V033 · **Prerequisites:** V003, V010, V023, V028, V032 · **Owner:** Backend + Data  
**Code:** `packages/adapters/src/jurisdictions.ts` · `packages/adapters/src/routing.ts` · `packages/adapters/src/matching-pipeline.ts` · `apps/worker/src/dev-worker.ts`  
**Configuration:** `packages/config-packs/src/packs/demo-district-a/profile.json` · `routing.json`  
**Schema:** `migrations/0021_jurisdiction_resolution.sql` · `migrations/0022_candidate_jurisdiction_filter.sql`

## 1. The deployed path now uses location, not a configured answer

The worker no longer attributes every report to `WORKER_JURISDICTION_ID`. At startup it loads one reviewed configuration pack, idempotently installs its versioned boundaries and responsibility rules, and resolves each submission's own observed point before matching or routing.

For the Hackathon, the polygons and department records are deliberately **team-created synthetic data**. The pack notice says they are invented demonstration boundaries and correspond to no real administrative area. No LGD polygon, official responsibility mapping, government integration or endorsement is claimed. V060 is the gate for replacing these fixtures with partner-reviewed pilot data.

## 2. Point-in-boundary resolution is deterministic and conservative

`resolveJurisdictionAtLocation` uses PostGIS over a named profile and boundary version at the submission's observation time. Parent/child overlap is expected, so the deepest active boundary wins. Equally specific sibling overlaps are not broken by row order.

| Spatial result                                           | Outcome                |
| -------------------------------------------------------- | ---------------------- |
| Point safely inside one most-specific boundary           | `resolved`             |
| Point covered by two equally specific boundaries         | `ambiguous`            |
| GPS accuracy reaches a boundary edge                     | `boundary_uncertain`   |
| Point outside the configured profile                     | `outside_profile`      |
| Named version has no boundary active at observation time | `no_active_boundaries` |

Only `resolved` may populate `canonical_issue.jurisdiction_id`. Every other outcome remains unscoped for human handling; none silently selects the first polygon or falls back to a district-wide ID. An unresolved report also searches only unscoped candidate issues, preventing cross-boundary deduplication from becoming an indirect scope assignment.

The candidate query records the jurisdiction filter it used. A new issue receives the resolved jurisdiction in its creation transaction, and an existing unscoped issue may inherit it; a conflicting existing scope is preserved and reported rather than overwritten.

## 3. The spatial decision is immutable evidence for the route

`jurisdiction_resolution` records:

- submission and resulting issue;
- profile and boundary version;
- deterministic method and outcome;
- selected and considered jurisdictions;
- whether the result was applied;
- reason and synthetic provenance.

`routing_decision.jurisdiction_resolution_id` links the department lookup to that record. A route therefore preserves both version axes: the boundary version that scoped the issue and the responsibility-directory version that chose the recipient.

Reusing a boundary or routing version with changed content is refused. A new polygon definition or department owner requires a new version rather than silently changing the meaning of old decisions.

## 4. Category-to-department routing stays separate from AI

The classifier proposes a language-neutral category. Routing is a deterministic lookup on:

`resolved jurisdiction + category + routing directory version + effective time`

There is no model call in routing. A missing, expired or not-yet-effective rule becomes `no_directory_entry`; an absent safe jurisdiction becomes `unknown_owner_review`. Every successful route records its category, jurisdiction, directory version, responsibility row, department and recipient mode.

The configuration now scopes each responsibility rule by `jurisdiction_internal_code`. Seeding validates every code before writing and is idempotent. The Hackathon seed hard-codes `provider_mode = simulated`, and every displayed department label includes “simulated”.

## 5. Routing is not delivery or acknowledgment

Routing means Vision determined an internal owner from its configured directory. It is not transport delivery, staff acceptance or an external acknowledgment. `isGovernmentAcknowledgment` remains the literal value `false`, and the disclosure states that a simulated route is not a government acknowledgment. Actual provider submission remains V058.

## 6. Verification

Verified 13 September 2026:

- Real PostGIS tests cover idempotent polygon installation, deepest-boundary selection, shared-edge ambiguity, GPS-accuracy edge handling, outside-profile points, effective time and an end-to-end spatial-resolution → directory-route chain.
- Pipeline verification proves the resolved jurisdiction scopes matching, is applied to the issue, is stored immutably and is linked from the route.
- Routing tests cover versioned/effective ownership, missing owners, cross-jurisdiction refusal, simulated-recipient disclosures, repeated routing history, idempotent seeding and same-version drift refusal.
- The deployable `demo-district-a` pack was seeded against the local database; a sample point resolved to `DDA-B1` under `demo-jurisdiction.v1`, and all eight scoped synthetic rules loaded under `demo-routing.v1`.
- No citizen or reviewer UI file changed.
- Full gates: **596/596 unit tests** and **443/443 PostgreSQL tests** pass.

## 7. Remaining boundary

The Hackathon geometry and departments are synthetic. Production or pilot routing still requires approved source rights, reviewed real boundaries, responsibility owners, effective-date change procedures and an authorized recipient integration under V058/V060. V033 proves the mechanism and failure behavior; it does not claim that the demonstration directory is legally authoritative.

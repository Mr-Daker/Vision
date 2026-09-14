# V034 — Build Staff Triage and Acknowledgment

**Status:** Complete and verified  
**Roadmap task:** V034 · **Prerequisites:** V010, V015, V030, V033 · **Owner:** Frontend + Backend  
**Service:** `packages/adapters/src/staff-inbox.ts`  
**HTTP:** `apps/api/src/staff-routes.ts`  
**Interface:** `apps/web/public/staff.html` · `apps/web/src/staff-main.ts`  
**Persistence:** `migrations/0013_review_and_routing.sql` · `migrations/0019_staff_grants.sql` · `migrations/0023_staff_department_grants.sql`

## 1. Authenticated responsibility, not a client-selected role

The fixed `demo-staff-one` identity is available only from the private staff login surface. Authentication creates an ordinary application session; the server then looks up a durable `department_staff` account and its exact `(jurisdiction, department)` responsibility pairs. Role, staff id and scope never come from a request body or browser storage.

Citizen, reviewer and staff surfaces use separate `HttpOnly` session and CSRF cookies, so they can remain open together. A staff request for another jurisdiction or another department is refused even when the caller edits the URL or JSON body.

The shipped identity and responsibility directory remain explicitly simulated. Real staff identity is still a future provider integration under V057.

## 2. Three facts that never collapse into “acknowledged”

| Record                                     | Meaning                                                 | External provenance |
| ------------------------------------------ | ------------------------------------------------------- | ------------------- |
| `delivery_attempted` / `delivery_accepted` | Our configured transport attempted or accepted delivery | Forbidden           |
| `internal_acceptance`                      | A Vision staff user picked up the work                  | Forbidden           |
| `recipient_acknowledgment`                 | A recipient replied                                     | Required            |

Each fact is its own immutable acknowledgment row with actor and occurrence time. The external row additionally requires provider mode, authenticity and an optional provider reference. The database enforces the provenance biconditional and one row of each kind per issue. Retrying the three-event simulated demonstration is idempotent and does not abort its transaction.

The interface renders these as three named lifecycle steps. A simulated response is always labelled **simulated recipient** and carries a `SIM-ACK-…` reference; it is never displayed as a government acknowledgment.

## 3. Department inbox and assignment

The inbox follows only the latest V033 routing decision. A re-routed issue immediately leaves the old department’s queue while the routing history remains. Each card shows:

- issue reference, category and age;
- evidence and counted-participant totals, without exposing a private original;
- current assignee and assignment time;
- the three delivery/acceptance/acknowledgment states and their recorded times;
- the configured queue position and its explanation.

Staff can accept internally and assign or reassign an issue to themselves. A reason is mandatory. Reassignment closes the previous effective-dated assignment and links the replacement instead of deleting history. Every action revalidates that the issue is still present in the selected department inbox.

## 4. Queue attention without invented severity

V034 does not fabricate an urgency or risk score before V046 has a calibrated model. The selected deployment’s `triage.json` instead defines a versioned category order and an age-escalation threshold. Every item explains its placement, and the policy note travels through the API to the interface with the explicit statement that it is not a severity, risk or urgency assessment.

Reporter count is displayed but never used to order the queue. The final tiebreak is deterministic, so refreshing cannot reshuffle equally placed work.

## 5. Verification

Verified 13 September 2026:

- 601/601 unit and browser-presentation tests pass.
- 451/451 PostgreSQL and live HTTP tests pass.
- Department tests cover fixture isolation, durable grants, separate-session sign-out, exact jurisdiction/department enforcement, CSRF, current-inbox target validation, internal acceptance, assignment actor/history, three distinct simulated-delivery facts, external provenance and retry idempotency.
- A real browser run completed staff login, internal acceptance, self-assignment and a simulated recipient reply against the running local application.
- Browser console reported no errors or warnings.
- At 390 px, the page had no horizontal overflow and lifecycle steps reflowed to one column.

No official government endpoint is contacted or implied.

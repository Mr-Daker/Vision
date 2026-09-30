/**
 * The staff door's routing decisions (role dashboards design, 2026-09-29).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ROLE_HOME,
  STAFF_ROLES,
  destinationFor,
  roleForPage,
  roleFromHash,
  staffDoorUrl,
  usablePrincipals,
} from "./team.ts";

test("every role has a home, and each home is a different workspace", () => {
  const homes = STAFF_ROLES.map((role) => ROLE_HOME[role]);
  assert.deepEqual(homes, ["/staff.html", "/reviewer.html", "/supervisor.html"]);
});

test("a role is chosen from the hash and nothing else", () => {
  assert.equal(roleFromHash("#reviewer"), "reviewer");
  assert.equal(roleFromHash("supervisor"), "supervisor");
  assert.equal(roleFromHash("#"), undefined);
  assert.equal(roleFromHash("#admin"), undefined);
});

test("only well-formed, usable demo principals become buttons", () => {
  assert.deepEqual(
    usablePrincipals([
      { credential: "c1", label: "Demo staff 1" },
      { credential: "", label: "empty credential" },
      { credential: "c3" },
      { credential: "c4", label: "Revoked staff", credential_state: "revoked" },
      { credential: "c5", label: "Active staff", credential_state: "active" },
      "not an object",
    ]),
    [
      { credential: "c1", label: "Demo staff 1" },
      { credential: "c5", label: "Active staff" },
    ],
  );
  assert.deepEqual(usablePrincipals(undefined), []);
});

test("after signing in, a role returns to the page that sent it, and only to its own pages", () => {
  assert.equal(destinationFor("supervisor", "/dashboard.html"), "/dashboard.html");
  assert.equal(
    destinationFor("supervisor", "/supervisor.html#queues/overdue"),
    "/supervisor.html#queues/overdue",
  );
  assert.equal(destinationFor("department", "/staff.html"), "/staff.html");
  // Another role's page, another site, or anything malformed: the role's home.
  assert.equal(destinationFor("department", "/supervisor.html"), "/staff.html");
  assert.equal(destinationFor("reviewer", "https://example.com/reviewer.html"), "/reviewer.html");
  assert.equal(destinationFor("reviewer", "//example.com/reviewer.html"), "/reviewer.html");
  assert.equal(destinationFor("supervisor", "/dashboard.html#<script>"), "/supervisor.html");
  assert.equal(destinationFor("supervisor", null), "/supervisor.html");
});

test("a workspace page knows which role's door to send a visitor to", () => {
  assert.equal(roleForPage("/staff.html"), "department");
  assert.equal(roleForPage("/compare.html"), "supervisor");
  assert.equal(roleForPage("/app.html"), undefined);
});

test("a workspace opened without a session sends its visitor to its role's door, and back", () => {
  assert.equal(staffDoorUrl("/dashboard.html", ""), "/team.html?next=%2Fdashboard.html#supervisor");
  assert.equal(
    staffDoorUrl("/supervisor.html", "#queues/overdue"),
    "/team.html?next=%2Fsupervisor.html%23queues%2Foverdue#supervisor",
  );
  assert.equal(staffDoorUrl("/staff.html", ""), "/team.html?next=%2Fstaff.html#department");
  // The round trip lands where it started.
  const url = new URL(staffDoorUrl("/supervisor.html", "#durability"), "http://x");
  assert.equal(
    destinationFor("supervisor", url.searchParams.get("next")),
    "/supervisor.html#durability",
  );
  // Not a workspace page: the plain door.
  assert.equal(staffDoorUrl("/app.html", ""), "/team.html");
});

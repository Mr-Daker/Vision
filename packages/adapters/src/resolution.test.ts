import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Queryable } from "./outbox.ts";
import { claimResolution, ResolutionError } from "./resolution.ts";

test("V035: a stale lifecycle write rolls back instead of overwriting newer state", async () => {
  const jurisdictionId = randomUUID();
  const issueId = randomUUID();
  const statements: string[] = [];
  const tx: Queryable = {
    query: async (sql) => {
      statements.push(sql.trim());
      if (sql.includes("select i.current_status")) {
        return {
          rows: [
            {
              current_status: "work_planned",
              category: "water_supply",
              jurisdiction_id: jurisdictionId,
              retired: false,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("from resolution_claim where staff_id")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("update canonical_issue")) {
        // Another action changed the issue after issueRow was read.
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: null };
    },
  };

  await assert.rejects(
    () =>
      claimResolution(tx, {
        principal: {
          role: "department_staff",
          staffId: randomUUID() as never,
          jurisdictionScope: [jurisdictionId],
          sessionId: randomUUID() as never,
        },
        issueId,
        idempotencyKey: `claim-${randomUUID()}`,
        description: "Replaced the failed pipe section with a new joint.",
        completionEvidence: [
          {
            mediaType: "photo",
            objectReference: `2026-09/${randomUUID()}`,
            fingerprintHash: `sha256:${"a".repeat(64)}`,
            redactionStatus: "needs_review",
          },
        ],
      }),
    (error: Error) =>
      error instanceof ResolutionError && /state changed.*refresh and retry/.test(error.message),
  );

  assert.ok(statements.includes("rollback"), "the stale transaction must roll back");
  assert.ok(!statements.includes("commit"), "a stale transition must never commit");
});

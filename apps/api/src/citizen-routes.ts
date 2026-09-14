/**
 * Citizen read endpoints (roadmap V030).
 *
 * Three surfaces with deliberately different access rules:
 *
 *  - `GET /v1/me/reports` — **private**. Bound to the session, never cacheable.
 *    A shared cache holding one citizen's report list would hand it to the
 *    next person behind the same proxy.
 *  - `GET /v1/issues/nearby` — **public**. No session, because discovering
 *    local problems must not require an account.
 *  - `GET /v1/issues/:publicReference` — **public**, addressed by the public
 *    reference only. The internal id is not an address: accepting it would
 *    make the public reference decorative and leak an identifier the public
 *    projection deliberately withholds.
 *
 * Every input is validated rather than coerced. A malformed position is a 400,
 * not a silent default — a search centred on a guessed point would return
 * confident, wrong results.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  confirmMatch,
  discoverNearbyIssues,
  findIssueIdByReference,
  getIssueDetail,
  listMyReports,
  presentCandidate,
  readCitizenResolutionView,
  rejectMatch,
  reopenIssue,
  ResolutionError,
  respondToClaim,
  type CitizenResolutionView,
  type Queryable,
} from "@vision/adapters";
import { newCorrelationId, type CorrelationId } from "@vision/contracts";
import type { ConfirmationPolicyPack } from "@vision/domain";

import { parseCookies, readJsonBody, sendError, sendJson, type ApiConfig } from "./app.ts";

export type CitizenRouteDependencies = {
  readonly client: Queryable;
  readonly config: ApiConfig;
  /** Reads published derivatives. Confined to the derivatives tree by the store. */
  readonly objectStore: {
    readApprovedDerivative(reference: string): Promise<Buffer | undefined>;
  };
  /** Resolves the participant behind the session, or undefined when there is none. */
  resolveParticipantId(request: IncomingMessage): Promise<string | undefined>;
  /** True when the request carries a CSRF token matching its cookie. */
  csrfMatches(request: IncomingMessage): boolean;
  /**
   * The classification identifiers this deployment permits, from its pack.
   *
   * Supplied rather than read here, so this module stays free of file access
   * and the composition stays in one place (`pack-composition.ts`).
   */
  readonly taxonomy: {
    readonly version: string;
    readonly categories: readonly { readonly id: string; readonly label: string }[];
    readonly note: string;
    readonly labelLanguage: string;
    readonly labelNote: string;
  };
  /**
   * The loaded confirmation policy (V035).
   *
   * Supplied rather than defaulted: the number of confirmations a category
   * needs is a configured decision, and a screen showing "1 of 2 needed" must
   * be quoting a policy somebody wrote, not a constant in this file.
   */
  readonly confirmationPolicy: ConfirmationPolicyPack;
};

/** Cursors are base64url. Anything else is a caller error, not something to ignore. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Magic bytes only: a stored file's own claim about its type is not evidence. */
const sniffImageType = (bytes: Buffer): string | undefined => {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  // The derivative encoder emits PNG, but a four-byte test fixture and a
  // future JPEG path both need to work, so the signature prefix is enough.
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return undefined;
};

/** Ownership check used before any per-report view or decision. */
const ownsSubmission = async (
  tx: Queryable,
  submissionId: string,
  participantId: string,
): Promise<boolean> => {
  const { rows } = await tx.query(
    `select 1 from submission
      where submission_id = $1 and participant_id = $2 and privacy_state = 'active'`,
    [submissionId, participantId],
  );
  return rows[0] !== undefined;
};

const finiteNumber = (raw: string | null): number | undefined => {
  if (raw === null || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * The resolution payload a signed-in participant receives.
 *
 * `object_reference` appears nowhere in this function, and
 * `readCitizenResolutionView` does not select it — so there is no private
 * original here to leak, by this path or by a later edit that forgets.
 */
const resolutionPayload = (view: CitizenResolutionView) => ({
  issue_status: view.issueStatus,
  claim:
    view.claim === undefined
      ? null
      : {
          claimed_at: view.claim.claimedAt,
          description: view.claim.description,
          completion_evidence: view.claim.evidence.map((item) => ({
            media_type: item.mediaType,
            derivative_reference: item.derivativeReference ?? null,
            viewable: item.viewable,
            why_not_viewable: item.whyNotViewable ?? null,
          })),
        },
  confirmation_policy_version: view.policyVersion,
  required_confirmations: view.requiredConfirmations,
  confirmations_recorded: view.confirmationsRecorded,
  disputes_recorded: view.disputesRecorded,
  confirmation_status: view.status,
  // Never true for anything but a standing confirmed resolution. A reopened
  // issue reports false, so a reader cannot treat it as closed.
  is_verified_resolution: view.isVerifiedResolution,
  counts_as_closed: view.countsAsClosed,
  // Who decided it, because "confirmed" by the people who live there and
  // "confirmed" over their objection are not the same fact.
  resolved_by_reviewer: view.resolvedByReviewer,
  requires_qualified_inspection: view.requiresQualifiedInspection,
  may_respond: view.mayRespond,
  may_respond_blocked_by: view.mayRespondBlockedBy ?? null,
  may_reopen: view.mayReopen,
  history: view.history.map((entry) => ({
    at: entry.at,
    kind: entry.kind,
    what: entry.what,
    comment: entry.comment ?? null,
    by_reviewer: entry.byReviewer,
  })),
  disclosures: [NOT_A_CERTIFICATION_NOTICE, ...view.disclosures],
});

/**
 * The sentence every resolution state carries.
 *
 * Held by the API so a surface cannot render a repair claim without it, and
 * worded in the second person because this is what a person reads.
 */
export const NOT_A_CERTIFICATION_NOTICE =
  "A confirmed repair means participants agreed the visible problem appears fixed. It is not a professional inspection, engineering certification, safety guarantee, or guarantee that the repair is permanent.";

export const createCitizenRoutes = (deps: CitizenRouteDependencies) => {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const correlationId: CorrelationId = newCorrelationId();

    // ---- V031 citizen confirmation ----

    const candidateMatch = /^\/v1\/me\/submissions\/([^/]+)\/candidate\/([^/]+)$/.exec(path);
    if (method === "GET" && candidateMatch !== null) {
      const participantId = await deps.resolveParticipantId(request);
      if (participantId === undefined) {
        sendError(response, "unauthenticated", "no active session", correlationId);
        return true;
      }
      const submissionId = decodeURIComponent(candidateMatch[1] ?? "");
      const candidateIssueId = decodeURIComponent(candidateMatch[2] ?? "");

      // Ownership first: presenting a candidate for someone else's report
      // would disclose where that report was made.
      if (!(await ownsSubmission(deps.client, submissionId, participantId))) {
        sendError(response, "not_found", "no such report", correlationId);
        return true;
      }

      const view = await presentCandidate(deps.client, { submissionId, candidateIssueId });
      if (view === undefined) {
        sendError(response, "not_found", "no such candidate", correlationId);
        return true;
      }
      sendJson(
        response,
        200,
        {
          candidate: {
            public_reference: view.candidate.publicReference,
            category: view.candidate.category,
            opened_at: view.candidate.openedAt,
            last_evidence_at: view.candidate.lastEvidenceAt ?? null,
            coarse_location: view.candidate.coarseLocation ?? null,
            distance_metres: view.candidate.distanceMetres ?? null,
            counted_participants: view.candidate.countedParticipants,
            entry_count: view.candidate.entryCount,
            preview_derivatives: view.candidate.previewDerivatives,
          },
          resolved_through_alias: view.resolvedThroughAlias,
        },
        correlationId,
      );
      return true;
    }

    const decisionMatch = /^\/v1\/me\/submissions\/([^/]+)\/(confirm-match|reject-match)$/.exec(
      path,
    );
    if (method === "POST" && decisionMatch !== null) {
      const participantId = await deps.resolveParticipantId(request);
      if (participantId === undefined) {
        sendError(response, "unauthenticated", "no active session", correlationId);
        return true;
      }
      if (!deps.csrfMatches(request)) {
        sendError(response, "forbidden", "missing or mismatched CSRF token", correlationId);
        return true;
      }

      const submissionId = decodeURIComponent(decisionMatch[1] ?? "");
      const body = await readJsonBody(request);
      if (body === undefined || typeof body !== "object" || body === null) {
        sendError(response, "validation_failed", "a JSON body is required", correlationId);
        return true;
      }
      const fields = body as Record<string, unknown>;
      const candidateIssueId = fields["candidate_issue_id"];
      if (typeof candidateIssueId !== "string" || candidateIssueId.length === 0) {
        sendError(response, "validation_failed", "candidate_issue_id is required", correlationId);
        return true;
      }
      // The citizen was asked whether two problems are the same, not which
      // department owns one. Accepting a category here would quietly
      // reintroduce the requirement V031 exists to remove.
      if ("category" in fields || "defect_id" in fields) {
        sendError(
          response,
          "validation_failed",
          "a category may not be supplied with a match decision",
          correlationId,
        );
        return true;
      }

      if (decisionMatch[2] === "confirm-match") {
        const result = await confirmMatch(deps.client, {
          submissionId,
          participantId,
          candidateIssueId,
        });
        if (result.status === "not_yours") {
          sendError(response, "not_found", "no such report", correlationId);
          return true;
        }
        if (result.status === "revalidate") {
          // 409: the answer was about a world that has moved, so the question
          // must be asked again rather than answered approximately.
          sendJson(response, 409, { status: result.status, reason: result.reason }, correlationId);
          return true;
        }
        sendJson(
          response,
          200,
          result.status === "attached"
            ? {
                status: result.status,
                issue_id: result.issueId,
                resolved_through_alias: result.resolvedThroughAlias,
                attached_evidence: result.attachedEvidence,
              }
            : { status: result.status, issue_id: result.issueId },
          correlationId,
        );
        return true;
      }

      const note = fields["citizen_note"];
      const result = await rejectMatch(deps.client, {
        submissionId,
        participantId,
        candidateIssueId,
        ...(typeof note === "string" ? { citizenNote: note } : {}),
      });
      if (result.status === "not_yours") {
        sendError(response, "not_found", "no such report", correlationId);
        return true;
      }
      if (result.status === "revalidate") {
        sendJson(response, 409, { status: result.status, reason: result.reason }, correlationId);
        return true;
      }
      sendJson(
        response,
        200,
        {
          status: result.status,
          issue_id: result.issueId,
          public_reference: result.publicReference,
        },
        correlationId,
      );
      return true;
    }

    // ---- V035 resolution: read, answer, reopen --------------------------
    //
    // All three are session-bound. The participant is resolved from the
    // session and never read from the body: accepting a participant_id would
    // let anyone answer on anyone's behalf, which is the whole substance of
    // "only a counted participant may confirm".

    const resolutionMatch = /^\/v1\/me\/issues\/([^/]+)\/resolution$/.exec(path);
    if (method === "GET" && resolutionMatch !== null) {
      const participantId = await deps.resolveParticipantId(request);
      if (participantId === undefined) {
        sendError(response, "unauthenticated", "no active session", correlationId);
        return true;
      }
      const issueId = await findIssueIdByReference(
        deps.client,
        decodeURIComponent(resolutionMatch[1] ?? ""),
      );
      if (issueId === undefined) {
        sendError(response, "not_found", "no such issue", correlationId);
        return true;
      }
      const view = await readCitizenResolutionView(deps.client, {
        issueId,
        policy: deps.confirmationPolicy,
        participantId,
      });
      if (view === undefined) {
        sendError(response, "not_found", "no such issue", correlationId);
        return true;
      }
      // Session-bound, so never cacheable: a shared cache holding one
      // participant's "you may answer" would hand it to the next person.
      // `sendJson` already sends `cache-control: no-store` on every JSON
      // response, which covers shared and private caches alike — so there is
      // nothing to add here beyond saying why it matters.
      sendJson(response, 200, resolutionPayload(view), correlationId);
      return true;
    }

    const respondMatch = /^\/v1\/me\/issues\/([^/]+)\/resolution\/respond$/.exec(path);
    if (method === "POST" && respondMatch !== null) {
      const participantId = await deps.resolveParticipantId(request);
      if (participantId === undefined) {
        sendError(response, "unauthenticated", "no active session", correlationId);
        return true;
      }
      if (!deps.csrfMatches(request)) {
        sendError(response, "forbidden", "missing or mismatched CSRF token", correlationId);
        return true;
      }
      const body = await readJsonBody(request);
      const fields = (body ?? {}) as Record<string, unknown>;
      const decision = fields["decision"];
      const comment = fields["comment"];
      if (decision !== "confirmed" && decision !== "disputed") {
        sendError(
          response,
          "validation_failed",
          "decision must be 'confirmed' or 'disputed'",
          correlationId,
        );
        return true;
      }
      // A dispute must say what is still wrong. Without that the crew is sent
      // back with nothing to act on, and the reviewer has nothing to weigh.
      if (decision === "disputed" && (typeof comment !== "string" || comment.trim().length < 8)) {
        sendError(
          response,
          "validation_failed",
          "a dispute must say what is still wrong, so the crew knows what to look at",
          correlationId,
        );
        return true;
      }
      // An identity in the body is refused rather than ignored: a client
      // sending one has misunderstood who decides, and a silent drop would
      // leave that belief in place.
      if ("participant_id" in fields) {
        sendError(
          response,
          "validation_failed",
          "a participant may not be named in the body; the responder is the signed-in session",
          correlationId,
        );
        return true;
      }

      const issueId = await findIssueIdByReference(
        deps.client,
        decodeURIComponent(respondMatch[1] ?? ""),
      );
      if (issueId === undefined) {
        sendError(response, "not_found", "no such issue", correlationId);
        return true;
      }
      const before = await readCitizenResolutionView(deps.client, {
        issueId,
        policy: deps.confirmationPolicy,
        participantId,
      });
      if (before?.claim === undefined) {
        sendError(response, "not_found", "this issue has no repair claim to answer", correlationId);
        return true;
      }
      if (!before.mayRespond) {
        // 409 rather than 403 for a stale view: the answer was about a world
        // that has moved, so the page must be re-read rather than retried.
        const stale = before.mayRespondBlockedBy === "no_claim_awaiting_an_answer";
        sendJson(
          response,
          stale ? 409 : 403,
          {
            error: {
              code: stale ? "conflict" : "forbidden",
              message: `this account may not answer this claim (${before.mayRespondBlockedBy ?? "unknown"})`,
              correlation_id: correlationId,
            },
          },
          correlationId,
        );
        return true;
      }

      try {
        const result = await respondToClaim(deps.client, {
          claimId: before.claim.claimId,
          decision,
          policy: deps.confirmationPolicy,
          participantId,
          ...(typeof comment === "string" && comment.trim().length > 0
            ? { comment: comment.trim() }
            : {}),
        });
        const after = await readCitizenResolutionView(deps.client, {
          issueId,
          policy: deps.confirmationPolicy,
          participantId,
        });
        sendJson(
          response,
          200,
          {
            recorded: true,
            resulting_status: result.resultingStatus,
            ...(after === undefined ? {} : resolutionPayload(after)),
          },
          correlationId,
        );
      } catch (error) {
        if (error instanceof ResolutionError) {
          sendError(response, "conflict", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    const reopenMatch = /^\/v1\/me\/issues\/([^/]+)\/reopen$/.exec(path);
    if (method === "POST" && reopenMatch !== null) {
      const participantId = await deps.resolveParticipantId(request);
      if (participantId === undefined) {
        sendError(response, "unauthenticated", "no active session", correlationId);
        return true;
      }
      if (!deps.csrfMatches(request)) {
        sendError(response, "forbidden", "missing or mismatched CSRF token", correlationId);
        return true;
      }
      const body = await readJsonBody(request);
      const reason = (body ?? {})["reason"];
      if (typeof reason !== "string" || reason.trim().length < 8) {
        sendError(
          response,
          "validation_failed",
          "reopening requires a reason saying what is still wrong",
          correlationId,
        );
        return true;
      }
      const issueId = await findIssueIdByReference(
        deps.client,
        decodeURIComponent(reopenMatch[1] ?? ""),
      );
      if (issueId === undefined) {
        sendError(response, "not_found", "no such issue", correlationId);
        return true;
      }
      try {
        await reopenIssue(deps.client, {
          issueId,
          actorType: "citizen",
          actorId: participantId,
          reason: reason.trim(),
        });
        const after = await readCitizenResolutionView(deps.client, {
          issueId,
          policy: deps.confirmationPolicy,
          participantId,
        });
        sendJson(
          response,
          200,
          { reopened: true, ...(after === undefined ? {} : resolutionPayload(after)) },
          correlationId,
        );
      } catch (error) {
        if (error instanceof ResolutionError) {
          sendError(response, "conflict", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    if (method !== "GET") return false;

    // ---- GET /v1/taxonomy : public, so discovery's filter has options ----
    //
    // V030 recorded that the category filter "is populated with no options
    // until a taxonomy pack is loaded, so it currently shows only 'All
    // categories'". This is where the browser learns what the pack holds.
    //
    // Public, with no session: discovery itself is public, so requiring one
    // would make the filter unusable for exactly the people browsing without
    // signing in.
    if (path === "/v1/taxonomy") {
      sendJson(
        response,
        200,
        {
          taxonomy_version: deps.taxonomy.version,
          // Only categories. Defect identifiers are what a reviewer confirms,
          // and V018 §2 is explicit that a citizen is never asked to classify
          // — serving them here would invite an interface that does.
          categories: deps.taxonomy.categories.map((category) => ({
            id: category.id,
            label: category.label,
          })),
          note: deps.taxonomy.note,
          // The labels are English and untranslated. Said out loud so the
          // interface can say so too, rather than a Marathi reader finding
          // English in a page that claims to be translated.
          label_language: deps.taxonomy.labelLanguage,
          label_note: deps.taxonomy.labelNote,
        },
        correlationId,
      );
      return true;
    }

    // ---- GET /v1/me/reports : private, session-bound ----
    if (path === "/v1/me/reports") {
      const participantId = await deps.resolveParticipantId(request);
      if (participantId === undefined) {
        sendError(response, "unauthenticated", "no active session", correlationId);
        return true;
      }

      const cursor = url.searchParams.get("cursor");
      if (cursor !== null && !CURSOR_PATTERN.test(cursor)) {
        sendError(
          response,
          "validation_failed",
          "cursor is not a valid page cursor",
          correlationId,
        );
        return true;
      }

      const limit = finiteNumber(url.searchParams.get("limit"));
      const page = await listMyReports(deps.client, {
        participantId,
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === null ? {} : { cursor }),
      });

      sendJson(
        response,
        200,
        {
          reports: page.reports.map((report) => ({
            submission_id: report.submissionId,
            submitted_at: report.submittedAt,
            observed_at: report.observedAt,
            status_label: report.statusLabel,
            issue_public_reference: report.issuePublicReference ?? null,
            issue_status: report.issueStatus ?? null,
            evidence_count: report.evidenceCount,
            // V031: the question waiting for this reporter, if any.
            awaiting_answer_for_issue_id: report.awaitingAnswerForIssueId ?? null,
          })),
          next_cursor: page.nextCursor ?? null,
        },
        correlationId,
      );
      return true;
    }

    // ---- GET /v1/issues/nearby : public discovery ----
    if (path === "/v1/issues/nearby") {
      const lon = finiteNumber(url.searchParams.get("lon"));
      const lat = finiteNumber(url.searchParams.get("lat"));
      if (lon === undefined || lat === undefined) {
        sendError(
          response,
          "validation_failed",
          "lon and lat are required and must be numbers",
          correlationId,
        );
        return true;
      }
      // A position outside the possible range is a caller error. Clamping it
      // would centre the search somewhere the caller never asked about.
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        sendError(
          response,
          "validation_failed",
          "lon must be within -180..180 and lat within -90..90",
          correlationId,
        );
        return true;
      }

      const cursor = url.searchParams.get("cursor");
      if (cursor !== null && !CURSOR_PATTERN.test(cursor)) {
        sendError(
          response,
          "validation_failed",
          "cursor is not a valid page cursor",
          correlationId,
        );
        return true;
      }

      const radius = finiteNumber(url.searchParams.get("radius_m"));
      if (radius !== undefined && radius <= 0) {
        sendError(response, "validation_failed", "radius_m must be positive", correlationId);
        return true;
      }

      const category = url.searchParams.get("category");
      const limit = finiteNumber(url.searchParams.get("limit"));

      const page = await discoverNearbyIssues(deps.client, {
        lon,
        lat,
        ...(radius === undefined ? {} : { radiusMetres: radius }),
        ...(category === null ? {} : { category }),
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === null ? {} : { cursor }),
      });

      sendJson(
        response,
        200,
        {
          issues: page.issues.map((issue) => ({
            public_reference: issue.publicReference,
            category: issue.category,
            current_status: issue.currentStatus,
            coarse_location: issue.coarseLocation ?? null,
            counted_participants: issue.countedParticipants,
            approved_derivative_references: issue.approvedDerivativeReferences,
            last_evidence_at: issue.lastEvidenceAt ?? null,
          })),
          next_cursor: page.nextCursor ?? null,
          applied_limit: page.appliedLimit,
          applied_filters: {
            category: page.appliedFilters.category ?? null,
            radius_m: page.appliedFilters.radiusMetres,
          },
          note: page.note,
        },
        correlationId,
      );
      return true;
    }

    // ---- GET /v1/media/derivatives/... : approved derivatives only ----
    if (path.startsWith("/v1/media/")) {
      const rest = path.slice("/v1/media/".length);
      // Only the derivatives tree is addressable here. This is defence in
      // depth: the enforcing layer is the object store, whose
      // `readApprovedDerivative` resolves strictly inside the derivatives
      // tree, and mutation testing confirms that is the check a test can
      // actually distinguish. This one is kept so a new tree added later is
      // denied by name rather than exposed by omission.
      if (!rest.startsWith("derivatives/")) {
        sendError(response, "not_found", "no such media", correlationId);
        return true;
      }
      const reference = decodeURIComponent(rest.slice("derivatives/".length));
      // A dot segment never belongs in an object reference; refusing before
      // the store sees it keeps the two checks independent.
      if (reference.split("/").some((segment) => segment === "." || segment === "..")) {
        sendError(response, "not_found", "no such media", correlationId);
        return true;
      }

      const bytes = await deps.objectStore.readApprovedDerivative(reference);
      if (bytes === undefined) {
        sendError(response, "not_found", "no such media", correlationId);
        return true;
      }

      const contentType = sniffImageType(bytes);
      if (contentType === undefined) {
        // A derivative this service cannot identify is not served: an unknown
        // type handed to a browser is how a stored file becomes active
        // content.
        sendError(response, "not_found", "no such media", correlationId);
        return true;
      }

      response.writeHead(200, {
        "content-type": contentType,
        "content-length": String(bytes.byteLength),
        // A derivative is immutable once published, so it may be cached; it is
        // also already redaction-approved, so a shared cache is acceptable.
        "cache-control": "public, max-age=3600, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "referrer-policy": "no-referrer",
      });
      response.end(bytes);
      return true;
    }

    // ---- GET /v1/issues/:publicReference : public detail ----
    const detailMatch = /^\/v1\/issues\/([^/]+)$/.exec(path);
    if (detailMatch !== null) {
      const reference = decodeURIComponent(detailMatch[1] ?? "");
      const issueId = await findIssueIdByReference(deps.client, reference);
      if (issueId === undefined) {
        sendError(response, "not_found", "no such issue", correlationId);
        return true;
      }
      const detail = await getIssueDetail(deps.client, { issueId });
      if (detail === undefined) {
        sendError(response, "not_found", "no such issue", correlationId);
        return true;
      }

      sendJson(
        response,
        200,
        {
          public_reference: detail.publicReference,
          category: detail.category,
          current_status: detail.currentStatus,
          opened_at: detail.openedAt,
          last_evidence_at: detail.lastEvidenceAt ?? null,
          coarse_location: detail.coarseLocation ?? null,
          counted_participants: detail.countedParticipants,
          complaint_entries: detail.complaintEntries,
          evidence: detail.evidence.map((item) => ({
            media_type: item.mediaType,
            content_text: item.contentText ?? null,
            derivative_reference: item.derivativeReference ?? null,
            viewable: item.viewable,
            why_not_viewable: item.whyNotViewable ?? null,
            ingested_at: item.ingestedAt,
          })),
          infrastructure_history: detail.infrastructureHistory,
          infrastructure_history_note: detail.infrastructureHistoryNote,
          assignment: { is_live: detail.assignment.isLive, note: detail.assignment.note },
          resolution: { is_live: detail.resolution.isLive, note: detail.resolution.note },
          disclosures: detail.disclosures,
        },
        correlationId,
      );
      return true;
    }

    return false;
  };
};

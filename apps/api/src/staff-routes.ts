/**
 * Authenticated department inbox, triage actions (V034) and resolution claims
 * (V035).
 *
 * The V035 addition is a claim, and a claim is not a resolution. This surface
 * therefore does three things and stops:
 *
 *  - it takes real completion photographs through the same object-store
 *    grant/put/finalize path citizen evidence uses, so the bytes exist and
 *    were validated before anything references them;
 *  - it revalidates the staff member's jurisdiction *and* department
 *    responsibility on the mutation itself, not only when the inbox was
 *    listed, because a grant can be revoked between the two;
 *  - it answers with the issue at `resolution_claimed` and says in the payload
 *    that the claim is awaiting confirmation and is not a verified resolution.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import {
  assignIssue,
  claimResolution,
  csrfTokenMatches,
  demoDepartmentStaffPrincipals,
  InactiveIdentityError,
  listDepartmentInbox,
  grantStageOriginalAccess,
  MAX_OBJECT_BYTES,
  newCsrfToken,
  processPhotoBytes,
  readResolutionState,
  recordAcknowledgment,
  ResolutionError,
  StaffError,
  StaffGrantError,
  type CompletionEvidence,
  type FilesystemObjectStoreAdapter,
  type IdentityService,
  type PostgresStaffGrantRepository,
  type Queryable,
  type SessionService,
} from "@vision/adapters";
import {
  type CorrelationId,
  type IdentityProviderAdapter,
  newCorrelationId,
} from "@vision/contracts";
import {
  derivePrincipal,
  type ConfirmationPolicyPack,
  type Principal,
  type TriagePolicy,
  UnauthenticatedError,
} from "@vision/domain";

import { cookie, parseCookies, readJsonBody, sendError, sendJson, type ApiConfig } from "./app.ts";

export type StaffRouteDependencies = {
  readonly client: Queryable;
  readonly identityAdapter: IdentityProviderAdapter;
  readonly identityService: IdentityService;
  readonly sessionService: SessionService;
  readonly staffGrants: PostgresStaffGrantRepository;
  readonly jurisdictionProfileId: string;
  readonly configuredResponsibilities: readonly {
    readonly jurisdictionInternalCode: string;
    readonly departmentId: string;
  }[];
  readonly triagePolicy: TriagePolicy;
  /** Where completion photographs are stored. Same store as citizen evidence. */
  readonly objectStore: FilesystemObjectStoreAdapter;
  /** The loaded confirmation policy, so a claim can report the bar it faces. */
  readonly confirmationPolicy: ConfirmationPolicyPack;
  readonly config: ApiConfig;
};

type StaffWorkspaceOption = {
  readonly jurisdiction_id: string;
  readonly internal_code: string;
  readonly level_code: string;
  readonly synthetic: boolean;
  readonly department_id: string;
  readonly department_label: string;
  readonly recipient_mode: "simulated" | "real";
  readonly directory_version: string;
};

const workspaceOptions = async (
  client: Queryable,
  staffId: string,
): Promise<readonly StaffWorkspaceOption[]> => {
  const { rows } = await client.query(
    `select g.jurisdiction_id, j.internal_code, j.level_code, j.synthetic_provenance,
            g.department_id, r.department_label, r.provider_mode, r.directory_version
       from staff_department_grant g
       join jurisdiction j on j.jurisdiction_id = g.jurisdiction_id
       join lateral (
         select department_label, provider_mode, directory_version
           from responsibility_directory
          where jurisdiction_id = g.jurisdiction_id
            and department_id = g.department_id
            and effective_from <= now()
            and (effective_to is null or effective_to > now())
          order by effective_from desc limit 1
       ) r on true
      where g.staff_id = $1 and g.revoked_at is null
      order by j.level_code, j.internal_code, g.department_id`,
    [staffId],
  );
  return rows.map((row) => ({
    jurisdiction_id: String(row["jurisdiction_id"]),
    internal_code: String(row["internal_code"]),
    level_code: String(row["level_code"]),
    synthetic: row["synthetic_provenance"] === true,
    department_id: String(row["department_id"]),
    department_label: String(row["department_label"]),
    recipient_mode: row["provider_mode"] === "real" ? "real" : "simulated",
    directory_version: String(row["directory_version"]),
  }));
};

const inboxPayload = (inbox: Awaited<ReturnType<typeof listDepartmentInbox>>) => ({
  jurisdiction_id: inbox.jurisdictionId,
  department_id: inbox.departmentId,
  applied_limit: inbox.appliedLimit,
  exhaustive: inbox.exhaustive,
  ordering_policy_version: inbox.orderingPolicyVersion ?? null,
  ordering_note: inbox.orderingNote,
  items: inbox.items.map((item, index) => ({
    issue_id: item.issueId,
    public_reference: item.publicReference,
    category: item.category,
    current_status: item.currentStatus,
    opened_at: item.openedAt,
    age_days: item.ageDays,
    queue_position: index + 1,
    counted_participants: item.countedParticipants,
    evidence_count: item.evidenceCount,
    assigned_staff_id: item.assignedStaffId ?? null,
    assigned_at: item.assignedAt ?? null,
    assignment_reason: item.assignmentReason ?? null,
    delivery_attempted: item.deliveryAttempted,
    delivery_attempted_at: item.deliveryAttemptedAt ?? null,
    delivery_accepted: item.deliveryAccepted,
    delivery_accepted_at: item.deliveryAcceptedAt ?? null,
    internally_accepted: item.internallyAccepted,
    internally_accepted_at: item.internallyAcceptedAt ?? null,
    internally_accepted_by: item.internallyAcceptedBy ?? null,
    internal_acceptance_note: item.internalAcceptanceNote ?? null,
    recipient_acknowledged: item.recipientAcknowledged,
    recipient_acknowledgment_is_simulated: item.recipientAcknowledgmentIsSimulated,
    recipient_acknowledged_at: item.recipientAcknowledgedAt ?? null,
    recipient_acknowledgment_reference: item.recipientAcknowledgmentReference ?? null,
    recipient_acknowledgment_note: item.recipientAcknowledgmentNote ?? null,
    status_label: item.statusLabel,
    // V035. `resolution_claimed` is a claim awaiting confirmation, never a
    // verified resolution — the flag says so explicitly so a client cannot
    // infer otherwise from the status string alone.
    resolution_claimed_at: item.resolutionClaimedAt ?? null,
    resolution_claim_description: item.resolutionClaimDescription ?? null,
    completion_evidence_count: item.completionEvidenceCount,
    resolution_confirmations: item.resolutionConfirmations,
    resolution_disputes: item.resolutionDisputes,
    required_confirmations: item.requiredConfirmations ?? null,
    is_verified_resolution: item.currentStatus === "resolution_confirmed",
    ordering_basis: item.orderingBasis,
  })),
});

/** Reads a raw body with a hard ceiling, so an oversized PUT cannot exhaust memory. */
const readRawBody = async (
  request: IncomingMessage,
  limit: number,
): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

/**
 * What a citizen is told about a claim, in every payload that mentions one.
 *
 * Carried by the API rather than written into each screen, so a surface cannot
 * show a repair claim without it. The wording is the domain's
 * (`confirmation-policy.ts`), restated here in the second person because this
 * is the sentence a person reads.
 */
export const NOT_A_CERTIFICATION_NOTICE =
  "A confirmed repair means participants agreed the visible problem appears fixed. It is not a professional inspection, engineering certification, safety guarantee, or guarantee that the repair is permanent.";

export const createStaffRoutes = (deps: StaffRouteDependencies) => {
  const { config } = deps;

  const clearedCookies = (): readonly string[] => [
    cookie(config.sessionCookieName, "", {
      maxAgeSeconds: 0,
      httpOnly: true,
      secure: config.cookieSecure,
    }),
    cookie(config.csrfCookieName, "", {
      maxAgeSeconds: 0,
      httpOnly: false,
      secure: config.cookieSecure,
    }),
  ];

  const requireStaff = async (
    request: IncomingMessage,
    response: ServerResponse,
    correlationId: CorrelationId,
    requireCsrf: boolean,
  ): Promise<{ readonly principal: Principal; readonly participantId: string } | undefined> => {
    const cookies = parseCookies(request.headers.cookie);
    if (requireCsrf) {
      const header = request.headers["x-csrf-token"];
      const presented = Array.isArray(header) ? header[0] : header;
      if (!csrfTokenMatches(cookies[config.csrfCookieName], presented)) {
        sendError(response, "forbidden", "missing or mismatched CSRF token", correlationId);
        return undefined;
      }
    }

    const validation = await deps.sessionService.validate(cookies[config.sessionCookieName]);
    if (!validation.ok) {
      sendError(
        response,
        "unauthenticated",
        "no active department staff session",
        correlationId,
        clearedCookies(),
      );
      return undefined;
    }
    const grant = await deps.staffGrants.findActiveByParticipant(
      validation.participant.participant_id,
    );
    if (grant === undefined || grant.role !== "department_staff") {
      sendError(
        response,
        "forbidden",
        "this session has no active department staff grant",
        correlationId,
        clearedCookies(),
      );
      return undefined;
    }
    try {
      return {
        principal: derivePrincipal({
          ok: true,
          sessionId: validation.session.session_id,
          participant: validation.participant,
          grant: {
            role: grant.role,
            staffId: grant.staffId,
            jurisdictionScope: grant.jurisdictionScope,
            responsibilityScope: grant.responsibilityScope,
          },
        }),
        participantId: validation.participant.participant_id,
      };
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        sendError(
          response,
          "unauthenticated",
          "department staff grant cannot be used",
          correlationId,
        );
        return undefined;
      }
      throw error;
    }
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (!path.startsWith("/v1/staff/")) return false;
    const correlationId = newCorrelationId();

    if (method === "GET" && path === "/v1/staff/capabilities") {
      sendJson(
        response,
        200,
        {
          identity_mode: "simulated",
          identity_label: deps.identityAdapter.descriptor.capability.display_label,
          demo_principals: demoDepartmentStaffPrincipals().map((principal) => ({
            credential: principal.credential,
            label: principal.label,
            credential_state: principal.credential_state,
          })),
        },
        correlationId,
      );
      return true;
    }

    if (method === "POST" && path === "/v1/staff/auth/demo-login") {
      const body = await readJsonBody(request);
      const credential = body?.["credential"];
      if (typeof credential !== "string" || credential.length === 0) {
        sendError(response, "validation_failed", "credential is required", correlationId);
        return true;
      }
      const outcome = await deps.identityAdapter.authenticate(
        { credential, interface_locale: "en-IN" as never },
        { correlation_id: correlationId },
      );
      if (outcome.kind === "unavailable") {
        sendError(
          response,
          "dependency_unavailable",
          "identity provider unavailable",
          correlationId,
        );
        return true;
      }
      if (outcome.kind !== "success") {
        sendError(
          response,
          "unauthenticated",
          "the demonstration department staff credential was not accepted",
          correlationId,
        );
        return true;
      }

      try {
        const { participant } = await deps.identityService.resolveParticipant(outcome.value);
        const grant = await deps.staffGrants.ensureSimulatedDepartmentStaff(
          participant.participant_id,
          deps.jurisdictionProfileId,
          deps.configuredResponsibilities,
        );
        const issued = await deps.sessionService.issue(participant.participant_id);
        const csrf = newCsrfToken();
        sendJson(
          response,
          200,
          {
            authenticated: true,
            role: "department_staff",
            identity_mode: "simulated",
            identity_label: deps.identityAdapter.descriptor.capability.display_label,
            session_expires_at: issued.session.expires_at,
            csrf_token: csrf,
            workspaces: await workspaceOptions(deps.client, grant.staffId),
          },
          correlationId,
          [
            cookie(config.sessionCookieName, issued.cookieValue, {
              maxAgeSeconds: config.sessionTtlSeconds,
              httpOnly: true,
              secure: config.cookieSecure,
            }),
            cookie(config.csrfCookieName, csrf, {
              maxAgeSeconds: config.sessionTtlSeconds,
              httpOnly: false,
              secure: config.cookieSecure,
            }),
          ],
        );
      } catch (error) {
        if (error instanceof InactiveIdentityError) {
          sendError(response, "unauthenticated", "the staff identity is inactive", correlationId);
          return true;
        }
        if (error instanceof StaffGrantError) {
          sendError(response, "dependency_unavailable", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    if (method === "GET" && path === "/v1/staff/auth/session") {
      const actor = await requireStaff(request, response, correlationId, false);
      if (actor === undefined) return true;
      const { principal } = actor;
      sendJson(
        response,
        200,
        {
          authenticated: true,
          role: principal.role,
          identity_mode: "simulated",
          identity_label: deps.identityAdapter.descriptor.capability.display_label,
          workspaces: await workspaceOptions(deps.client, String(principal.staffId)),
        },
        correlationId,
      );
      return true;
    }

    if (method === "POST" && path === "/v1/staff/auth/logout") {
      const actor = await requireStaff(request, response, correlationId, true);
      if (actor === undefined) return true;
      const { principal } = actor;
      await deps.sessionService.revoke(principal.sessionId, "logout");
      sendJson(response, 200, { authenticated: false }, correlationId, clearedCookies());
      return true;
    }

    if (method === "GET" && path === "/v1/staff/inbox") {
      const actor = await requireStaff(request, response, correlationId, false);
      if (actor === undefined) return true;
      const { principal } = actor;
      const jurisdictionId = url.searchParams.get("jurisdiction_id");
      const departmentId = url.searchParams.get("department_id");
      if (
        jurisdictionId === null ||
        jurisdictionId.length === 0 ||
        departmentId === null ||
        departmentId.length === 0
      ) {
        sendError(
          response,
          "validation_failed",
          "jurisdiction_id and department_id are required",
          correlationId,
        );
        return true;
      }
      try {
        const inbox = await listDepartmentInbox(deps.client, {
          principal,
          jurisdictionId,
          departmentId,
          triagePolicy: deps.triagePolicy,
          confirmationPolicy: deps.confirmationPolicy,
        });
        sendJson(response, 200, inboxPayload(inbox), correlationId);
      } catch (error) {
        if (error instanceof StaffError) {
          sendError(response, "forbidden", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    // ---- Completion-evidence upload (V035) ------------------------------
    //
    // The same three-step path citizen evidence uses: a scoped grant, the
    // bytes, then a completion check that refuses anything whose content does
    // not match what was declared. Staff get their own prefix so the routes
    // authenticate against the staff session rather than the citizen one, but
    // the store, the size ceiling and the permitted types are shared.

    if (method === "POST" && path === "/v1/staff/uploads") {
      const actor = await requireStaff(request, response, correlationId, true);
      if (actor === undefined) return true;
      const body = await readJsonBody(request);
      const contentType = body?.["content_type"];
      const maxBytes = body?.["max_bytes"];
      if (typeof contentType !== "string" || typeof maxBytes !== "number") {
        sendError(
          response,
          "validation_failed",
          "content_type and max_bytes are required",
          correlationId,
        );
        return true;
      }
      const outcome = await deps.objectStore.createUploadGrant(
        {
          intended_content_type: contentType,
          max_bytes: Math.min(maxBytes, MAX_OBJECT_BYTES),
          // The pseudonymous participant behind the session owns the grant.
          // A staff id is not a participant and the store's ownership model is
          // the participant one.
          owner_pseudonym: actor.participantId as never,
        },
        {
          correlation_id: correlationId,
          idempotency_key: `staff-upload-${correlationId}` as never,
          idempotency_scope: `staff:${actor.participantId}:uploads.create` as never,
          request_fingerprint: `sha256:${"0".repeat(64)}` as never,
        },
      );
      if (outcome.kind !== "success") {
        sendError(
          response,
          "validation_failed",
          outcome.kind === "rejected" ? outcome.detail : "upload grant unavailable",
          correlationId,
        );
        return true;
      }
      sendJson(response, 201, outcome.value, correlationId);
      return true;
    }

    if (method === "PUT" && path.startsWith("/v1/staff/uploads/")) {
      const reference = decodeURIComponent(path.slice("/v1/staff/uploads/".length));
      const actor = await requireStaff(request, response, correlationId, false);
      if (actor === undefined) return true;
      const token = url.searchParams.get("token");
      if (token === null) {
        sendError(response, "forbidden", "upload token is required", correlationId);
        return true;
      }
      const bytes = await readRawBody(request, MAX_OBJECT_BYTES);
      if (bytes === undefined) {
        sendError(response, "validation_failed", "upload exceeds the maximum size", correlationId);
        return true;
      }
      const result = await deps.objectStore.putStagedObject(
        reference,
        token,
        bytes,
        String(request.headers["content-type"] ?? ""),
      );
      if (!result.ok) {
        sendError(
          response,
          result.reason === "grant_token_mismatch" ? "forbidden" : "validation_failed",
          result.reason,
          correlationId,
        );
        return true;
      }
      sendJson(response, 200, { staged: true, byte_size: bytes.byteLength }, correlationId);
      return true;
    }

    if (method === "POST" && /^\/v1\/staff\/uploads\/.+\/finalize$/.test(path)) {
      const reference = decodeURIComponent(
        path.slice("/v1/staff/uploads/".length, path.length - "/finalize".length),
      );
      const actor = await requireStaff(request, response, correlationId, true);
      if (actor === undefined) return true;
      if (!deps.objectStore.isUploadOwnedBy(reference, actor.participantId as never)) {
        sendError(
          response,
          "forbidden",
          "this upload grant belongs to a different account or is no longer active",
          correlationId,
        );
        return true;
      }
      const outcome = await deps.objectStore.finalizeUpload(reference, {
        correlation_id: correlationId,
        idempotency_key: `staff-finalize-${reference}` as never,
        idempotency_scope: `staff:${actor.participantId}:uploads.finalize` as never,
        request_fingerprint: `sha256:${"0".repeat(64)}` as never,
      });
      if (outcome.kind === "success") {
        sendJson(response, 200, { ...outcome.value, accepted: true }, correlationId);
        return true;
      }
      if (outcome.kind === "duplicate") {
        sendJson(
          response,
          200,
          { ...(outcome.existing_value ?? {}), accepted: true, replayed: true },
          correlationId,
        );
        return true;
      }
      sendError(
        response,
        "validation_failed",
        outcome.kind === "rejected" ? outcome.detail : "upload could not be validated",
        correlationId,
      );
      return true;
    }

    const actionPath = /^\/v1\/staff\/issues\/([^/]+)\/actions$/.exec(path);
    if (method === "POST" && actionPath !== null) {
      const actor = await requireStaff(request, response, correlationId, true);
      if (actor === undefined) return true;
      const { principal } = actor;
      const issueId = decodeURIComponent(actionPath[1] ?? "");
      const body = await readJsonBody(request);
      const action = body?.["action"];
      const jurisdictionId = body?.["jurisdiction_id"];
      const departmentId = body?.["department_id"];
      const note = body?.["note"];
      if (
        ![
          "accept_internal",
          "assign_to_self",
          "simulate_recipient_acknowledgment",
          "claim_resolution",
        ].includes(String(action)) ||
        typeof jurisdictionId !== "string" ||
        jurisdictionId.length === 0 ||
        typeof departmentId !== "string" ||
        departmentId.length === 0 ||
        typeof note !== "string" ||
        note.trim().length < 8
      ) {
        sendError(
          response,
          "validation_failed",
          "a supported action, jurisdiction_id, department_id and a specific note are required",
          correlationId,
        );
        return true;
      }

      try {
        const inbox = await listDepartmentInbox(deps.client, {
          principal,
          jurisdictionId,
          departmentId,
          triagePolicy: deps.triagePolicy,
          confirmationPolicy: deps.confirmationPolicy,
        });
        if (!inbox.items.some((item) => item.issueId === issueId)) {
          sendError(
            response,
            "conflict",
            "this issue is no longer in the selected department inbox; refresh before acting",
            correlationId,
          );
          return true;
        }

        if (action === "accept_internal") {
          const result = await recordAcknowledgment(deps.client, {
            principal,
            issueId,
            departmentId,
            kind: "internal_acceptance",
            note: note.trim(),
          });
          sendJson(
            response,
            200,
            { action, already_recorded: result.alreadyRecorded },
            correlationId,
          );
          return true;
        }

        if (action === "claim_resolution") {
          // A claim needs something a citizen can look at, so the evidence
          // list is validated before anything is written. Each reference must
          // already be a finalised object: this endpoint stores nothing itself
          // and invents nothing.
          const rawEvidence = body?.["completion_evidence"];
          const idempotencyKey = body?.["idempotency_key"];
          if (
            !Array.isArray(rawEvidence) ||
            rawEvidence.length === 0 ||
            typeof idempotencyKey !== "string" ||
            idempotencyKey.trim().length === 0
          ) {
            sendError(
              response,
              "validation_failed",
              "a resolution claim requires an idempotency_key and at least one completion photograph",
              correlationId,
            );
            return true;
          }
          if (note.trim().length < 12) {
            sendError(
              response,
              "validation_failed",
              "a resolution claim requires a specific description of the completed work",
              correlationId,
            );
            return true;
          }

          const completionEvidence: CompletionEvidence[] = [];
          for (const raw of rawEvidence as unknown[]) {
            const reference =
              typeof raw === "object" && raw !== null
                ? (raw as Record<string, unknown>)["object_reference"]
                : undefined;
            if (typeof reference !== "string" || reference.trim().length === 0) {
              sendError(
                response,
                "validation_failed",
                "every completion evidence entry needs an object_reference",
                correlationId,
              );
              return true;
            }
            if (
              !(await deps.objectStore.hasAcceptedEvidenceOwnedBy(
                reference,
                actor.participantId as never,
              ))
            ) {
              sendError(
                response,
                "validation_failed",
                "completion evidence must name an upload that finished successfully for this staff account",
                correlationId,
              );
              return true;
            }

            // Decoded rather than trusted. `finalizeUpload` already checked the
            // bytes against their declared type; this pass is what produces the
            // fingerprint, the redaction decision and — where a detector exists
            // — the publishable derivative. A truncated or header-only file is
            // refused here, not stored as though it were a photograph.
            const bytes = await deps.objectStore.readOriginal(
              reference,
              grantStageOriginalAccess(
                "v035-completion-evidence",
                "validating a department completion photograph before it is recorded as claim evidence",
              ),
            );
            const sniffed =
              bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
                ? "image/jpeg"
                : "image/png";
            const processed = processPhotoBytes({ bytes, declaredContentType: sniffed });
            if (!processed.ok) {
              sendError(
                response,
                "validation_failed",
                `this completion photograph was not accepted: ${processed.reasons.join("; ")}`,
                correlationId,
              );
              return true;
            }

            // A derivative exists only when the redaction decision resolved.
            // With no detector configured nothing is publishable, and the
            // citizen surface says so rather than showing an unchecked
            // photograph of a place where people live.
            let derivativeReference: string | undefined;
            if (processed.mayEnterPublicView && processed.derivative !== undefined) {
              derivativeReference = await deps.objectStore.writeApprovedDerivative(
                reference,
                Buffer.from(processed.derivative.bytes),
                processed.redactionStatus,
              );
            }
            completionEvidence.push({
              mediaType: "photo",
              objectReference: reference,
              fingerprintHash: processed.fingerprintHash,
              redactionStatus: processed.redactionStatus,
              ...(derivativeReference === undefined ? {} : { derivativeReference }),
              ...(processed.captureMetadata === undefined
                ? {}
                : { captureMetadata: processed.captureMetadata }),
            });
          }

          try {
            const claim = await claimResolution(deps.client, {
              principal,
              issueId,
              idempotencyKey: idempotencyKey.trim(),
              description: note.trim(),
              completionEvidence,
              hasStoredObject: (reference) =>
                deps.objectStore.hasAcceptedEvidenceOwnedBy(
                  reference,
                  actor.participantId as never,
                ),
            });
            const state = await readResolutionState(deps.client, {
              issueId,
              policy: deps.confirmationPolicy,
            });
            sendJson(
              response,
              200,
              {
                action,
                claim_id: claim.claimId,
                // A retry of the same key returns the first claim rather than
                // creating a second, and says which happened.
                replayed: claim.status === "already_claimed",
                issue_status: state?.issueStatus ?? "resolution_claimed",
                // Said in the payload, not only on the screen: a claim is not
                // a verified resolution, and a client that renders this
                // without reading the prose must still not be able to say so.
                is_verified_resolution: false,
                awaiting_confirmation: true,
                required_confirmations: state?.appliedRule.requiredConfirmations ?? null,
                confirmation_policy_version: state?.policyVersion ?? null,
                disclosures: [NOT_A_CERTIFICATION_NOTICE, ...(state?.disclosures ?? [])],
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

        if (action === "assign_to_self") {
          const result = await assignIssue(deps.client, {
            principal,
            issueId,
            departmentId,
            assignedStaffId: String(principal.staffId),
            reason: note.trim(),
          });
          sendJson(response, 200, { action, assignment_id: result.assignmentId }, correlationId);
          return true;
        }

        await deps.client.query("begin");
        try {
          await recordAcknowledgment(deps.client, {
            principal,
            issueId,
            departmentId,
            kind: "delivery_attempted",
            note: "Simulated delivery attempt recorded by the V034 demonstration.",
          });
          await recordAcknowledgment(deps.client, {
            principal,
            issueId,
            departmentId,
            kind: "delivery_accepted",
            note: "Configured simulated transport accepted the demonstration delivery.",
          });
          const acknowledgment = await recordAcknowledgment(deps.client, {
            principal,
            issueId,
            departmentId,
            kind: "recipient_acknowledgment",
            note: note.trim(),
            provenance: {
              providerMode: "simulated",
              authenticity: "simulated_fixture",
              providerReference: `SIM-ACK-${randomUUID().slice(0, 8).toUpperCase()}`,
            },
          });
          await deps.client.query("commit");
          sendJson(
            response,
            200,
            {
              action,
              already_recorded: acknowledgment.alreadyRecorded,
              recipient_mode: "simulated",
            },
            correlationId,
          );
        } catch (error) {
          await deps.client.query("rollback").catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (error instanceof StaffError) {
          sendError(response, "conflict", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    return false;
  };
};

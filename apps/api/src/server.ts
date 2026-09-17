/**
 * API composition root and HTTP server (roadmap V009).
 *
 * This is the only place that reads environment variables. Everything below it
 * receives explicit dependencies, which is what lets the tests build the same
 * app with a controllable clock and no environment at all.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { CONTRACT_VERSION, newCorrelationId } from "@vision/contracts";
import {
  loadJurisdictionProfile,
  loadRoutingDirectory,
  loadTriagePolicy,
} from "@vision/config-packs";

import {
  FilesystemObjectStoreAdapter,
  demoCitizenPrincipals,
  demoDepartmentStaffPrincipals,
  demoSupervisorPrincipals,
  demoReviewerPrincipals,
  SubmissionService,
  type TransactionalClient,
  IdentityService,
  InMemoryIdentityMappingRepository,
  InMemoryParticipantRepository,
  InMemorySessionRepository,
  PostgresIdentityMappingRepository,
  PostgresParticipantRepository,
  PostgresSessionRepository,
  PostgresStaffGrantRepository,
  SessionService,
  type IdentityMappingRepository,
  type ParticipantRepository,
  type SessionRepository,
  SimulatedDepartmentRecipientAdapter,
  SimulatedIdentityAdapter,
  SyntheticSourceImportAdapter,
} from "@vision/adapters";

import { buildCapabilityMetadata } from "./capability-metadata.ts";
import { createStaticFileHandler } from "./static-files.ts";
import { createRequestHandler, type ApiConfig, type ApiDependencies } from "./app.ts";
import { createSubmissionRoutes } from "./submission-routes.ts";
import { createCitizenRoutes } from "./citizen-routes.ts";
import { createReviewerRoutes } from "./reviewer-routes.ts";
import { createStaffRoutes } from "./staff-routes.ts";
import { createSupervisorRoutes } from "./supervisor-routes.ts";
import { createDashboardRoutes } from "./dashboard-routes.ts";
import {
  resolveAgeingPolicy,
  resolveConfirmationPolicy,
  resolveTaxonomy,
  resolveRecommendationPolicy,
} from "./pack-composition.ts";

export type EnvironmentLike = Readonly<Record<string, string | undefined>>;

const required = (env: EnvironmentLike, name: string): string => {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
};

const optionalNumber = (env: EnvironmentLike, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`environment variable ${name} must be a positive number`);
  }
  return parsed;
};

/**
 * Where participant, mapping and session rows live.
 *
 * `buildApp` defaults to in-memory so a clean checkout with no database still
 * serves the session surface (V007). `buildAppWithDatabase` supplies the
 * PostgreSQL implementations, which it must: a submission row has a foreign
 * key to `participant`, so a participant that exists only in process memory
 * cannot own a report.
 */
export type IdentityRepositories = {
  readonly participants: ParticipantRepository;
  readonly mappings: IdentityMappingRepository;
  readonly sessions: SessionRepository;
};

/**
 * Builds the fully wired application from environment configuration.
 *
 * The Hackathon build only supports simulated identity and recipient providers.
 * Asking for `real` fails loudly rather than silently falling back to a
 * simulation, because a silent fallback is exactly how a demo ends up claiming
 * a verification it never performed (V002 rows 1 and 16).
 */
export const buildApp = (
  env: EnvironmentLike = process.env,
  repositories?: IdentityRepositories,
) => {
  const identityMode = env["IDENTITY_PROVIDER_MODE"] ?? "simulated";
  if (identityMode !== "simulated") {
    throw new Error(
      `IDENTITY_PROVIDER_MODE='${identityMode}' is not supported: real identity requires V057 approval and credentials`,
    );
  }

  const recipientMode = env["RECIPIENT_PROVIDER_MODE"] ?? "simulated";
  if (recipientMode !== "simulated") {
    throw new Error(
      `RECIPIENT_PROVIDER_MODE='${recipientMode}' is not supported: a real recipient requires V058 approval`,
    );
  }

  const { participants, mappings, sessions } = repositories ?? {
    participants: new InMemoryParticipantRepository(),
    mappings: new InMemoryIdentityMappingRepository(),
    sessions: new InMemorySessionRepository(),
  };

  // This login surface derives citizen permissions. Staff and reviewer
  // fixtures stay excluded because their separate private surfaces resolve
  // durable server-side grants before deriving either privileged role.
  const identityAdapter = new SimulatedIdentityAdapter(demoCitizenPrincipals());
  const recipientAdapter = new SimulatedDepartmentRecipientAdapter();
  const sourceAdapter = new SyntheticSourceImportAdapter();

  const identityService = new IdentityService(
    participants,
    mappings,
    required(env, "IDENTITY_MAPPING_HMAC_KEY"),
  );

  const sessionTtlSeconds = optionalNumber(env, "SESSION_TTL_SECONDS", 3600);
  const sessionService = new SessionService(sessions, participants, {
    tokenHmacKey: required(env, "SESSION_TOKEN_HMAC_KEY"),
    ttlSeconds: sessionTtlSeconds,
  });

  const config: ApiConfig = {
    sessionCookieName: env["SESSION_COOKIE_NAME"] ?? "vision_session",
    csrfCookieName: env["SESSION_CSRF_COOKIE_NAME"] ?? "vision_csrf",
    cookieSecure: env["SESSION_COOKIE_SECURE"] === "true",
    sessionTtlSeconds,
  };

  const dependencies: ApiDependencies = {
    identityAdapter,
    identityService,
    sessionService,
    capabilities: buildCapabilityMetadata({
      descriptors: [
        identityAdapter.descriptor.capability,
        recipientAdapter.descriptor.capability,
        sourceAdapter.descriptor.capability,
      ],
    }),
    config,
  };

  return { dependencies, handler: createRequestHandler(dependencies) };
};

export const createApiServer = (env: EnvironmentLike = process.env): Server => {
  const { handler } = buildApp(env);
  return createServer((request, response) => {
    handler(request, response).catch(() => {
      if (!response.headersSent) {
        const correlationId = newCorrelationId();
        response.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-correlation-id": correlationId,
        });
        response.end(
          JSON.stringify({
            error: {
              code: "internal_error",
              message: "an unexpected error occurred",
              correlation_id: correlationId,
              contract_version: CONTRACT_VERSION,
            },
          }),
        );
        return;
      }
      // No error detail is echoed to the caller, and nothing is logged here
      // that could contain a cookie or a body (V005 §8).
      response.end();
    });
  });
};

/**
 * Builds the app with the database-backed upload and submission routes
 * (V016/V018) attached.
 *
 * Separate from `buildApp` on purpose: the session surface must keep working
 * with no database, which is the V007 clean-checkout condition. Only this
 * entry point requires PostgreSQL.
 *
 * It also swaps the V009 identity and session repositories to their PostgreSQL
 * implementations. That is not an optimisation: `submission.participant_id`
 * references `participant`, so an in-memory participant would make every
 * submission fail its foreign key.
 */
export const buildAppWithDatabase = (
  client: TransactionalClient,
  objectStore: FilesystemObjectStoreAdapter,
  env: EnvironmentLike = process.env,
  /**
   * Directory holding the built citizen interface (V019). Given only by the
   * dev entry point; the tests leave it out so a missing build cannot make an
   * API test fail.
   */
  webRoot?: string,
) => {
  const base = buildApp(env, {
    participants: new PostgresParticipantRepository(client),
    mappings: new PostgresIdentityMappingRepository(client),
    sessions: new PostgresSessionRepository(client),
  });

  const submissionService = new SubmissionService(client, objectStore, {
    localePackVersion: env["LOCALE_PACK_VERSION"] ?? "demo-locales.v1",
    taxonomyVersion: env["TAXONOMY_PACK_VERSION"] ?? "demo-taxonomy.v1",
    // Required, with no default: a locale list baked in here would be scope
    // living in code (V001 Appendix G rule 7). Refusing to start is better
    // than silently assuming which languages this deployment supports.
    supportedLocales: required(env, "SUPPORTED_LOCALES")
      .split(",")
      .map((locale) => locale.trim())
      .filter((locale) => locale.length > 0),
  });

  // Read endpoints (V030). Separate from the write routes because their
  // access rules differ: discovery is public, "my reports" is session-bound,
  // and neither performs a mutation.
  const confirmationPolicy = resolveConfirmationPolicy(
    env["JURISDICTION_PROFILE_ID"] ?? "demo-district-a",
  ).policy;

  const citizenRoutes = createCitizenRoutes({
    client,
    config: base.dependencies.config,
    objectStore,
    // V035: the bar a repair claim must clear is configured, not compiled in.
    confirmationPolicy,
    // The pack decides what this deployment will classify (V023), and the
    // discovery filter offers exactly those categories (V030).
    taxonomy: resolveTaxonomy(env["JURISDICTION_PROFILE_ID"] ?? "demo-district-a"),
    resolveParticipantId: async (request) => {
      const cookieHeader = request.headers.cookie;
      const cookies = Object.fromEntries(
        (cookieHeader ?? "")
          .split(";")
          .map((pair) => pair.trim())
          .filter((pair) => pair.length > 0)
          .map((pair) => {
            const index = pair.indexOf("=");
            return [pair.slice(0, index), decodeURIComponent(pair.slice(index + 1))] as const;
          }),
      );
      const validation = await base.dependencies.sessionService.validate(
        cookies[base.dependencies.config.sessionCookieName],
      );
      return validation.ok ? validation.participant.participant_id : undefined;
    },
    csrfMatches: (request) => {
      // Double-submit: the header must equal the cookie. A read needs none,
      // but every citizen write does (V009).
      const cookieHeader = request.headers.cookie ?? "";
      const cookieValue = cookieHeader
        .split(";")
        .map((pair) => pair.trim())
        .find((pair) => pair.startsWith(`${base.dependencies.config.csrfCookieName}=`));
      const expected =
        cookieValue === undefined
          ? undefined
          : decodeURIComponent(cookieValue.slice(cookieValue.indexOf("=") + 1));
      const header = request.headers["x-csrf-token"];
      const presented = Array.isArray(header) ? header[0] : header;
      return (
        expected !== undefined &&
        expected.length > 0 &&
        presented !== undefined &&
        presented === expected
      );
    },
  });

  const submissionRoutes = createSubmissionRoutes({
    sessionService: base.dependencies.sessionService,
    submissionService,
    objectStore,
    config: base.dependencies.config,
  });

  const reviewerRoutes = createReviewerRoutes({
    client,
    identityAdapter: new SimulatedIdentityAdapter(demoReviewerPrincipals()),
    identityService: base.dependencies.identityService,
    sessionService: base.dependencies.sessionService,
    staffGrants: new PostgresStaffGrantRepository(client),
    objectStore,
    jurisdictionProfileId: env["JURISDICTION_PROFILE_ID"] ?? "demo-district-a",
    confirmationPolicy,
    jurisdictionInternalCodes: (() => {
      const configured = env["REVIEWER_JURISDICTION_CODES"]
        ?.split(",")
        .map((code) => code.trim())
        .filter((code) => code.length > 0);
      if (configured !== undefined && configured.length > 0) return configured;
      return loadJurisdictionProfile(env["JURISDICTION_PROFILE_ID"] ?? "demo-district-a").nodes.map(
        (node) => node.internal_code,
      );
    })(),
    config: {
      ...base.dependencies.config,
      // A reviewer can keep the citizen app open in another tab without one
      // surface overwriting the other's session.
      sessionCookieName: env["REVIEWER_SESSION_COOKIE_NAME"] ?? "vision_reviewer_session",
      csrfCookieName: env["REVIEWER_CSRF_COOKIE_NAME"] ?? "vision_reviewer_csrf",
    },
  });

  const profileId = env["JURISDICTION_PROFILE_ID"] ?? "demo-district-a";
  const routingDirectory = loadRoutingDirectory(profileId);
  const configuredStaffResponsibilities = (() => {
    const explicit = env["STAFF_RESPONSIBILITIES"]
      ?.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (explicit === undefined || explicit.length === 0) {
      return routingDirectory.entries.map((entry) => ({
        jurisdictionInternalCode: entry.jurisdictionInternalCode,
        departmentId: entry.departmentId,
      }));
    }
    return explicit.map((entry) => {
      const separator = entry.indexOf(":");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error("STAFF_RESPONSIBILITIES entries must use jurisdiction-code:department-id");
      }
      return {
        jurisdictionInternalCode: entry.slice(0, separator),
        departmentId: entry.slice(separator + 1),
      };
    });
  })();
  const staffRoutes = createStaffRoutes({
    client,
    identityAdapter: new SimulatedIdentityAdapter(demoDepartmentStaffPrincipals()),
    identityService: base.dependencies.identityService,
    sessionService: base.dependencies.sessionService,
    staffGrants: new PostgresStaffGrantRepository(client),
    jurisdictionProfileId: profileId,
    configuredResponsibilities: configuredStaffResponsibilities,
    triagePolicy: loadTriagePolicy(profileId),
    objectStore,
    confirmationPolicy,
    config: {
      ...base.dependencies.config,
      // Staff, reviewer and citizen tabs may remain open together without
      // overwriting one another's sessions.
      sessionCookieName: env["STAFF_SESSION_COOKIE_NAME"] ?? "vision_staff_session",
      csrfCookieName: env["STAFF_CSRF_COOKIE_NAME"] ?? "vision_staff_csrf",
    },
  });

  const supervisorRoutes = createSupervisorRoutes({
    client,
    identityAdapter: new SimulatedIdentityAdapter(demoSupervisorPrincipals()),
    identityService: base.dependencies.identityService,
    sessionService: base.dependencies.sessionService,
    staffGrants: new PostgresStaffGrantRepository(client),
    jurisdictionProfileId: profileId,
    jurisdictionInternalCodes: loadJurisdictionProfile(profileId).nodes.map(
      (node) => node.internal_code,
    ),
    // V036: how long this deployment said it would tolerate a wait. Loaded,
    // never defaulted.
    ageingPolicy: resolveAgeingPolicy(profileId),
    config: {
      ...base.dependencies.config,
      // A supervisor may keep the citizen, staff and reviewer tabs open at the
      // same time without any of them overwriting another's session.
      sessionCookieName: env["SUPERVISOR_SESSION_COOKIE_NAME"] ?? "vision_supervisor_session",
      csrfCookieName: env["SUPERVISOR_CSRF_COOKIE_NAME"] ?? "vision_supervisor_csrf",
    },
  });

  // V039. Rides the supervisor session rather than adding a sixth role: the
  // dashboard needs exactly what a supervisor already has, and nothing more.
  const dashboardRoutes = createDashboardRoutes({
    client,
    sessionService: base.dependencies.sessionService,
    staffGrants: new PostgresStaffGrantRepository(client),
    trackedCategories: resolveTaxonomy(profileId).categoryIds,
    jurisdictionProfileId: profileId,
    recommendationPolicy: resolveRecommendationPolicy(profileId),
    config: {
      ...base.dependencies.config,
      sessionCookieName: env["SUPERVISOR_SESSION_COOKIE_NAME"] ?? "vision_supervisor_session",
      csrfCookieName: env["SUPERVISOR_CSRF_COOKIE_NAME"] ?? "vision_supervisor_csrf",
    },
  });

  // Order matters: API routes first, then files. `/v1/...` never reaches the
  // file handler, so a mistyped endpoint returns a JSON 404 rather than HTML.
  const serveFiles = webRoot === undefined ? undefined : createStaticFileHandler({ root: webRoot });
  const extraRoutes = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> =>
    (await submissionRoutes(request, response)) ||
    (await citizenRoutes(request, response)) ||
    (await reviewerRoutes(request, response)) ||
    (await staffRoutes(request, response)) ||
    (await supervisorRoutes(request, response)) ||
    (await dashboardRoutes(request, response)) ||
    (serveFiles === undefined ? false : await serveFiles(request, response));

  const dependencies: ApiDependencies = { ...base.dependencies, extraRoutes };
  return { dependencies, submissionService, handler: createRequestHandler(dependencies) };
};

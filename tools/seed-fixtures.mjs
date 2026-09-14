/**
 * Seeds the local database with the V011 development corpus (roadmap V013).
 *
 * Seeds the DEVELOPMENT split only. The evaluation holdout is never seeded:
 * a seeded holdout would leak into demo rehearsal and invalidate V046. This
 * module deliberately does not import the holdout loader at all, which
 * `tools/check-holdout-seal.mjs` enforces.
 *
 * Idempotent: every insert is ON CONFLICT DO NOTHING keyed on a deterministic
 * id, so re-seeding does not duplicate rows.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CORPUS_DIR = join(process.cwd(), "packages/fixtures/src/corpus");
const readCorpus = (name) => JSON.parse(readFileSync(join(CORPUS_DIR, name), "utf8"));

/**
 * Deterministic UUID from a stable name, so re-running the seed produces the
 * same identifiers and the seed stays idempotent.
 */
const stableUuid = (namespace, name) => {
  const digest = createHash("sha256").update(`${namespace}:${name}`).digest("hex");
  const bytes = digest.slice(0, 32).split("");
  // Force version 4 / RFC variant bits so the value satisfies a UUID check.
  bytes[12] = "4";
  const variant = "89ab"[parseInt(digest[16], 16) % 4];
  bytes[16] = variant;
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const multipolygonWkt = (rings) => {
  const polygons = rings.map(
    (polygon) =>
      `(${polygon
        .map((ring) => `(${ring.map(([lon, lat]) => `${lon} ${lat}`).join(", ")})`)
        .join(", ")})`,
  );
  return `SRID=4326;MULTIPOLYGON(${polygons.join(", ")})`;
};

export const seedDevelopmentCorpus = async (client) => {
  const taxonomy = readCorpus("taxonomy.v1.json");
  const jurisdictions = readCorpus("jurisdictions.json");
  const assets = readCorpus("assets.json");
  const routing = readCorpus("responsibility-directory.json");
  const development = readCorpus("reports.development.json");

  if (development.split !== "development") {
    throw new Error("refusing to seed: corpus is not the development split");
  }

  const summary = {
    jurisdictions: 0,
    assets: 0,
    responsibility_rules: 0,
    participants: 0,
    submissions: 0,
    evidence: 0,
  };

  await client.query("begin");
  try {
    // --- jurisdictions (parents before children) ---
    const jurisdictionIds = new Map();
    const ordered = [...jurisdictions.nodes].sort((a, b) =>
      a.parent_internal_code === null ? -1 : b.parent_internal_code === null ? 1 : 0,
    );
    for (const node of ordered) {
      const id = stableUuid(
        "jurisdiction",
        `${jurisdictions.jurisdiction_profile_id}/${node.internal_code}`,
      );
      jurisdictionIds.set(node.internal_code, id);
      const parentId =
        node.parent_internal_code === null ? null : jurisdictionIds.get(node.parent_internal_code);

      const result = await client.query(
        `insert into jurisdiction (
           jurisdiction_id, jurisdiction_profile_id, parent_jurisdiction_id, internal_code,
           external_source_code, directory_version, level_scheme, level_code, boundary,
           effective_from, source_record_id, synthetic_provenance
         ) values ($1,$2,$3,$4,null,$5,$6,$7,$8::geography,$9,null,true)
         on conflict (jurisdiction_id) do nothing`,
        [
          id,
          jurisdictions.jurisdiction_profile_id,
          parentId,
          node.internal_code,
          jurisdictions.directory_version,
          jurisdictions.level_scheme,
          node.level_code,
          multipolygonWkt(node.boundary_multipolygon),
          node.effective_from,
        ],
      );
      summary.jurisdictions += result.rowCount;
    }

    // --- assets ---
    for (const asset of assets.assets) {
      const result = await client.query(
        `insert into infrastructure_asset (
           asset_id, asset_type, source_record_id, synthetic_provenance, name, location,
           jurisdiction_id, effective_from
         ) values ($1,$2,null,true,$3, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, $6,$7)
         on conflict (asset_id) do nothing`,
        [
          asset.asset_id,
          asset.asset_type,
          asset.name,
          asset.lon,
          asset.lat,
          jurisdictionIds.get(asset.jurisdiction_internal_code),
          asset.effective_from,
        ],
      );
      summary.assets += result.rowCount;
    }

    // --- responsibility directory ---
    for (const rule of routing.rules) {
      const id = stableUuid(
        "responsibility",
        `${routing.directory_version}/${rule.jurisdiction_internal_code}/${rule.category_id}`,
      );
      const department = routing.departments.find((d) => d.department_id === rule.department_id);
      const result = await client.query(
        `insert into responsibility_directory (
           responsibility_id, directory_version, jurisdiction_id, category, department_id,
           department_label, provider_mode, effective_from
         ) values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (responsibility_id) do nothing`,
        [
          id,
          routing.directory_version,
          jurisdictionIds.get(rule.jurisdiction_internal_code),
          rule.category_id,
          rule.department_id,
          department.label,
          department.provider_mode,
          "2026-01-01T00:00:00Z",
        ],
      );
      summary.responsibility_rules += result.rowCount;
    }

    // --- participants referenced by the corpus ---
    const participantIds = new Map();
    for (const ref of new Set(development.reports.map((report) => report.participant_ref))) {
      const id = stableUuid("participant", ref);
      participantIds.set(ref, id);
      const result = await client.query(
        `insert into participant (participant_id) values ($1) on conflict do nothing`,
        [id],
      );
      summary.participants += result.rowCount;
    }

    // --- submissions and their evidence ---
    for (const report of development.reports) {
      const submissionId = stableUuid("submission", report.report_id);
      const submission = await client.query(
        `insert into submission (
           submission_id, participant_id, observed_location, observed_accuracy_m,
           observed_location_source, observed_at, interface_locale, language_hint,
           locale_pack_version, idempotency_key, taxonomy_version, processing_status
         ) values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, $5,
                   'device_geolocation', $6,$7,$8,'demo-locales.v1',$9,$10,'accepted')
         on conflict (participant_id, idempotency_key) do nothing`,
        [
          submissionId,
          participantIds.get(report.participant_ref),
          report.observed.lon,
          report.observed.lat,
          report.observed.accuracy_m,
          report.observed.observed_at,
          report.interface_locale,
          report.source_language === "und" ? null : report.source_language,
          `fixture:${report.report_id}`,
          taxonomy.taxonomy_version,
        ],
      );
      summary.submissions += submission.rowCount;

      for (const [index, media] of report.media.entries()) {
        const evidenceId = stableUuid("evidence", `${report.report_id}/${String(index)}`);
        const isText = media.media_type === "text";
        const result = await client.query(
          `insert into evidence_item (
             evidence_id, submission_id, media_type, object_reference, content_text,
             fingerprint_hash, source_language, transcript_text, processing_status,
             redaction_status, captured_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,'usable',$9,$10)
           on conflict (evidence_id) do nothing`,
          [
            evidenceId,
            submissionId,
            media.media_type,
            isText ? null : `fixture-object/${report.report_id}/${String(index)}`,
            isText ? report.text : null,
            isText ? null : media.fingerprint_hash,
            report.source_language === "und" ? null : report.source_language,
            media.media_type === "voice" ? (media.transcript_expected ?? null) : null,
            isText ? "not_required" : "pending",
            report.observed.observed_at,
          ],
        );
        summary.evidence += result.rowCount;
      }
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  return summary;
};

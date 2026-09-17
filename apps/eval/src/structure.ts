/**
 * Seeding the world a corpus row is reported into (roadmap V046).
 *
 * Jurisdictions, assets and the responsibility directory — the structure the
 * fixture corpus refers to, and nothing else. In particular **no reports**:
 * the development split is not loaded, so a holdout report can only match
 * another holdout report, which is what makes a merge attributable to a
 * reviewer-labelled pair rather than to whatever else happened to be nearby.
 *
 * That is also a limitation, and the report says so: retrieval measured in a
 * database holding eight reports is not retrieval measured at the density a
 * district would actually have.
 *
 * This is a separate implementation from `tools/seed-fixtures.mjs` on purpose:
 * that one seeds the development split for a demo and must never be able to
 * touch the holdout. Structure is not the thing under measurement, so a second
 * implementation of it costs nothing; the pipeline, which *is* under
 * measurement, is never reimplemented.
 */

import { createHash } from "node:crypto";

import type { Queryable } from "@vision/adapters";
import { loadAssets, loadJurisdictions, loadResponsibilityDirectory } from "@vision/fixtures";

/** Deterministic id from a stable name, so a re-run produces the same world. */
const stableUuid = (namespace: string, name: string): string => {
  const digest = createHash("sha256").update(`${namespace}:${name}`).digest("hex");
  const bytes = digest.slice(0, 32).split("");
  bytes[12] = "4";
  bytes[16] = "89ab"[parseInt(digest[16] ?? "0", 16) % 4] ?? "8";
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const multipolygonWkt = (
  rings: readonly (readonly (readonly (readonly number[])[])[])[],
): string => {
  const polygons = rings.map(
    (polygon) =>
      `(${polygon
        .map(
          (ring) =>
            `(${ring.map((point) => `${String(point[0])} ${String(point[1])}`).join(", ")})`,
        )
        .join(", ")})`,
  );
  return `SRID=4326;MULTIPOLYGON(${polygons.join(", ")})`;
};

export type SeededStructure = {
  readonly jurisdictions: number;
  readonly assets: number;
  readonly responsibilityRules: number;
  readonly directoryVersion: string;
  readonly boundaryVersion: string;
  readonly profileId: string;
};

export const seedCorpusStructure = async (client: Queryable): Promise<SeededStructure> => {
  const jurisdictions = loadJurisdictions();
  const assets = loadAssets();
  const routing = loadResponsibilityDirectory();

  const jurisdictionIds = new Map<string, string>();
  const ordered = [...jurisdictions.nodes].sort((a, b) =>
    a.parent_internal_code === null ? -1 : b.parent_internal_code === null ? 1 : 0,
  );

  let seededJurisdictions = 0;
  for (const node of ordered) {
    const id = stableUuid(
      "jurisdiction",
      `${jurisdictions.jurisdiction_profile_id}/${node.internal_code}`,
    );
    jurisdictionIds.set(node.internal_code, id);
    const parentId =
      node.parent_internal_code === null
        ? null
        : (jurisdictionIds.get(node.parent_internal_code) ?? null);
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
    seededJurisdictions += result.rowCount ?? 0;
  }

  let seededAssets = 0;
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
        jurisdictionIds.get(asset.jurisdiction_internal_code) ?? null,
        asset.effective_from,
      ],
    );
    seededAssets += result.rowCount ?? 0;
  }

  let seededRules = 0;
  for (const rule of routing.rules) {
    const id = stableUuid(
      "responsibility",
      `${routing.directory_version}/${rule.jurisdiction_internal_code}/${rule.category_id}`,
    );
    const department = routing.departments.find(
      (candidate) => candidate.department_id === rule.department_id,
    );
    if (department === undefined) continue;
    const result = await client.query(
      `insert into responsibility_directory (
         responsibility_id, directory_version, jurisdiction_id, category, department_id,
         department_label, provider_mode, effective_from
       ) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (responsibility_id) do nothing`,
      [
        id,
        routing.directory_version,
        jurisdictionIds.get(rule.jurisdiction_internal_code) ?? null,
        rule.category_id,
        rule.department_id,
        department.label,
        department.provider_mode,
        "2026-01-01T00:00:00Z",
      ],
    );
    seededRules += result.rowCount ?? 0;
  }

  return {
    jurisdictions: seededJurisdictions,
    assets: seededAssets,
    responsibilityRules: seededRules,
    directoryVersion: routing.directory_version,
    boundaryVersion: jurisdictions.directory_version,
    profileId: jurisdictions.jurisdiction_profile_id,
  };
};

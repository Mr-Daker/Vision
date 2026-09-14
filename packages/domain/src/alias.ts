/**
 * Canonical-issue resolution over alias edges (roadmap V014).
 *
 * A merge creates one active directed edge from the retired issue to the
 * surviving one. Resolution follows active edges until no edge remains, with
 * cycle rejection and a bounded depth (V003 §7 policy `canonical_resolution`).
 *
 * Nothing here mutates: reversal is modelled as closing an edge, and a closed
 * edge simply stops participating in resolution.
 */

export const MAX_ALIAS_HOPS = 16;

export type AliasEdge = {
  readonly source_issue_id: string;
  readonly target_issue_id: string;
  /** Null/undefined means currently active. A closed edge is history. */
  readonly valid_to?: string | null;
};

export type ResolutionResult =
  | { readonly ok: true; readonly rootIssueId: string; readonly hops: number }
  | {
      readonly ok: false;
      readonly reason: "cycle_detected" | "depth_exceeded";
      readonly path: readonly string[];
    };

const activeEdgeMap = (edges: readonly AliasEdge[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const edge of edges) {
    if (edge.valid_to === undefined || edge.valid_to === null) {
      // The database guarantees one active outgoing edge per source; if a
      // caller passes two, the first wins deterministically and the DB
      // constraint is what prevents the situation arising.
      if (!map.has(edge.source_issue_id)) {
        map.set(edge.source_issue_id, edge.target_issue_id);
      }
    }
  }
  return map;
};

/**
 * Follows active edges to the current canonical root.
 *
 * An issue with no active outgoing edge is its own root — which is why a merge
 * reversal needs no replacement issue: closing the edge restores the original
 * issue as its own root immediately.
 */
export const resolveActiveRoot = (
  issueId: string,
  edges: readonly AliasEdge[],
  maxHops: number = MAX_ALIAS_HOPS,
): ResolutionResult => {
  const active = activeEdgeMap(edges);
  const path: string[] = [issueId];
  const seen = new Set<string>([issueId]);
  let current = issueId;
  let hops = 0;

  for (;;) {
    const next = active.get(current);
    if (next === undefined) {
      return { ok: true, rootIssueId: current, hops };
    }
    if (seen.has(next)) {
      return { ok: false, reason: "cycle_detected", path: [...path, next] };
    }
    hops += 1;
    if (hops > maxHops) {
      return { ok: false, reason: "depth_exceeded", path: [...path, next] };
    }
    seen.add(next);
    path.push(next);
    current = next;
  }
};

/**
 * Whether adding source -> target would create a cycle. Checked before a merge
 * commits, because a cycle would make resolution non-terminating.
 */
export const wouldCreateCycle = (
  sourceIssueId: string,
  targetIssueId: string,
  edges: readonly AliasEdge[],
): boolean => {
  if (sourceIssueId === targetIssueId) return true;
  const resolved = resolveActiveRoot(targetIssueId, edges);
  if (!resolved.ok) return true;
  return resolved.rootIssueId === sourceIssueId;
};

/** An issue is retired for direct operational writes while it has an active edge. */
export const isRetiredByAlias = (issueId: string, edges: readonly AliasEdge[]): boolean =>
  activeEdgeMap(edges).has(issueId);

/**
 * Every original issue whose active chain resolves to `rootIssueId`, including
 * the root. Analytics counts distinct participants across this closure, never
 * by moving participation rows between issues.
 */
export const aliasClosureOf = (
  rootIssueId: string,
  edges: readonly AliasEdge[],
): readonly string[] => {
  const members = new Set<string>([rootIssueId]);
  const sources = new Set(
    edges
      .filter((edge) => edge.valid_to === undefined || edge.valid_to === null)
      .map((edge) => edge.source_issue_id),
  );

  for (const source of sources) {
    const resolved = resolveActiveRoot(source, edges);
    if (resolved.ok && resolved.rootIssueId === rootIssueId) {
      members.add(source);
    }
  }
  return [...members].sort();
};

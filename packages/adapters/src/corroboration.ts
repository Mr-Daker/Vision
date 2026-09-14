/**
 * Corroboration-signal adapter, fixture-backed (roadmap V025, live at V029).
 *
 * "How many other eligible participants reported this?" is a genuinely useful
 * signal and the one input V025 cannot compute yet: eligible participation
 * depends on the canonical-issue and participation work that lands at V029.
 *
 * So the count comes from fixtures — and the only thing that makes that
 * acceptable is that every consumer can tell. `inputIsFixture` is true on
 * every response, the descriptor says simulated, and the provenance carries
 * `simulated_fixture` plus the fixture id. Nothing here can quietly pass for
 * live participation.
 *
 * What it deliberately does not do: treat a zero count as "nobody else has
 * this problem". An empty result is a successful "we know of none" (V010's
 * rule, and V002 row 20's prohibition on reading absence as evidence).
 */

import {
  nowIso,
  type AdapterCallContext,
  type AdapterDescriptor,
  type AdapterOutcome,
  type SimulatedProvenance,
} from "@vision/contracts";

export const CORROBORATION_FIXTURE_ID = "corroboration.fixture.v1";

export class CorroborationFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorroborationFixtureError";
  }
}

export type CorroborationCount = {
  readonly eligibleParticipants: number;
  /** True while this comes from a fixture. V029 is what makes it false. */
  readonly inputIsFixture: boolean;
  readonly note: string;
};

export type FixtureCorroborationOptions = {
  /** Issue id to eligible-participant count. Absence means "no fixture", not zero corroboration. */
  readonly counts: Readonly<Record<string, number>>;
};

export class FixtureCorroborationAdapter {
  readonly descriptor: AdapterDescriptor;

  private readonly counts: Readonly<Record<string, number>>;

  constructor(options: FixtureCorroborationOptions) {
    for (const [issueId, count] of Object.entries(options.counts)) {
      if (!Number.isInteger(count) || count < 0) {
        throw new CorroborationFixtureError(
          `fixture count for '${issueId}' must be a non-negative integer, got ${String(count)}`,
        );
      }
    }
    this.counts = options.counts;
    this.descriptor = {
      provider_name: "fixture-corroboration",
      provider_mode: "simulated",
      capability: {
        capability: "source_import",
        provider_name: "fixture-corroboration",
        provider_mode: "simulated",
        display_label: "Simulated corroboration count from a fixture, not live participation",
        v002_row: 25,
        may_claim: ["how many fixture participants are recorded against this issue"],
        must_not_claim: [
          "that real people independently reported this",
          "that agreement between reports makes them accurate",
          "that a count of zero means nobody else has this problem",
        ],
      },
    };
  }

  async countEligibleParticipants(
    issueId: string,
    context: AdapterCallContext,
  ): Promise<AdapterOutcome<CorroborationCount>> {
    const provenance: SimulatedProvenance = {
      provider_mode: "simulated",
      authenticity: "simulated_fixture",
      provider_name: this.descriptor.provider_name,
      observed_at: nowIso(),
      fixture_id: CORROBORATION_FIXTURE_ID,
    };

    const known = Object.prototype.hasOwnProperty.call(this.counts, issueId);
    const count = known ? (this.counts[issueId] ?? 0) : 0;

    return {
      kind: "success",
      value: {
        eligibleParticipants: count,
        inputIsFixture: true,
        note: known
          ? `count of ${String(count)} comes from fixture ${CORROBORATION_FIXTURE_ID}`
          : `no fixture records this issue, so the count is unknown rather than zero corroboration; live participation arrives at V029`,
      },
      provenance,
      correlation_id: context.correlation_id,
    };
  }
}

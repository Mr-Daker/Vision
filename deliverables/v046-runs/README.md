# V046 run records

One JSON file per evaluation run, named `<runId>-<split>-<provider>.json`. Each holds the verdict, the per-row scores, the pair outcomes and every provider call, so two runs can be compared by reading rather than by remembering.

They are kept **including the ones that came out worse**, because the point of a record is that it was written before anybody knew what it would say.

Two things to know when reading an older record:

- **The provider is not deterministic.** Two runs of identical code against identical rows, minutes apart, differ in how many calls the provider answers at all. The `20260917130311` holdout record has three classification calls that never returned a proposal — two HTTP 503s and one reply the schema guard refused. That is why the harness now retries on the deployment's own policy.
- **The scorer changed on 17 September 2026**, in response to what those failures revealed. Records written before that change count a row with no proposal as an abstention; records written after it count such a row as unscorable and report the provider outcome separately. An abstention is the system declining and is the behaviour V002 row 10 asks for; a 503 is a property of an afternoon. Do not compare an abstention figure across that boundary.

A `development` split in a filename is a rehearsal of the harness, not a measurement. Its own report says so in the verdict, at the top.

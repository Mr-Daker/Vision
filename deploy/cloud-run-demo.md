# Cloud Run hackathon-demo deployment

## Current demo environment (23 September 2026)

- Google Cloud project: `vision-new-india` (owned by the new personal account)
- Region: `asia-south1`
- Public app and API: `https://vision-api-716180242189.asia-south1.run.app`
- Internal worker: `vision-worker`
- Cloud SQL: `vision-db-demo`, database `vision_dev`
- Private evidence bucket: `gs://vision-new-india-media-716180242189`
- Docker repository: `asia-south1-docker.pkg.dev/vision-new-india/vision-repo`
- BigQuery datasets: `voice_analytics` and `voice_eval` (keep their access controls separate)

The old `vision-508301` deployment is retained as a rollback and must not be
changed or removed without explicit approval. This new environment was seeded
with synthetic demonstration data; no live database, bucket contents, or
credentials were copied from the old project. The local `.firebaserc` points
to `vision-new-india`, but the application is currently served directly by
Cloud Run, not Firebase Hosting.

The new BigQuery warehouse is populated from the local dataset: 500,000
synthetic reports, seven analytics source tables, three evaluation-label
tables, and the safe/analysis views. Dataset IAM was checked with the
`voice-analytics` service account: analytics returns HTTP 200 and evaluation
returns HTTP 403. The strict BigQuery-vs-DuckDB validator currently passes
60/64 checks. Its four failures are analysis-output parity differences in
floating rank/band calculations and boundary reason codes; every final
decision/classification parity check passes. The six frozen analysis SQL files
were left unchanged to preserve the recorded evaluation history.

This deployment is deliberately labelled a **demonstration**: identity,
recipient routing, and AI provider modes can be simulated. Do not represent it
as a live government grievance system or collect real citizen evidence.

The `vision-api` service is public. It connects to Cloud SQL through the Cloud
SQL Unix socket and mounts a private, uniform-access Cloud Storage bucket at
`/mnt/vision-media`. It is constrained to one instance because the current
filesystem object-store adapter holds short-lived upload grants in process
memory. The `vision-worker` service has internal ingress, one continuously
allocated instance, the same database connection and the same mount.

Runtime secrets are supplied only through Secret Manager:

- `DATABASE_URL`
- `SESSION_TOKEN_HMAC_KEY`
- `IDENTITY_MAPPING_HMAC_KEY`
- `OBJECT_STORE_GRANT_HMAC_KEY`
- `GEMINI_API_KEY` only when a real Gemini-backed demo has been explicitly
  configured.

Before a public demo, deploy the current revision, verify `/v1/health`,
`/v1/capabilities`, sign-in and one synthetic report submission, then inspect
the private worker logs for both relay stages. The evidence bucket must never
be made public.

# Local development PostgreSQL for Vision (roadmap V013).
#
# Built from the official multi-arch postgres image because the upstream
# postgis/postgis image publishes no linux/arm64 manifest, which would have
# excluded Apple Silicon development machines.
#
# Extension package names are pinned; the exact installed versions are recorded
# and verified by `node tools/db.mjs verify` rather than assumed from docs
# (V013 "done when").
FROM postgres:17.11@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675

ARG POSTGIS_PACKAGE_VERSION=3.6.4+dfsg-2.pgdg13+1
ARG PGVECTOR_PACKAGE_VERSION=0.8.6-1.pgdg13+1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        "postgresql-17-postgis-3=${POSTGIS_PACKAGE_VERSION}" \
        "postgresql-17-pgvector=${PGVECTOR_PACKAGE_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

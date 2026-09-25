# Reproducible Cloud Run image for the Vision hackathon demonstration.
# Node 26 runs the repository's TypeScript directly with type stripping;
# browser assets are compiled during the build stage.
FROM node:26-alpine AS build

WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build:web

FROM node:26-alpine

WORKDIR /app
COPY --from=build /app /app
RUN npm ci --omit=dev

ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
ENV PORT=8080

CMD ["node", "apps/api/src/cloud-run-server.ts"]

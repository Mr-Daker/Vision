/**
 * API entry point (roadmap V009).
 *
 * Run locally with:  node apps/api/src/index.ts
 * Requires .env values to be exported in the shell; see .env.example.
 */

import { createApiServer } from "./server.ts";

const host = process.env["API_HOST"] ?? "127.0.0.1";
const port = Number(process.env["API_PORT"] ?? "8080");

const server = createApiServer();

server.listen(port, host, () => {
  // Intentionally minimal: no configuration values are printed, because the
  // process environment contains L3c secrets (V005 §7).
  process.stdout.write(`vision api listening on http://${host}:${String(port)}\n`);
});

const shutdown = (): void => {
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { server };

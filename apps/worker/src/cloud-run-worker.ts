/**
 * Cloud Run service wrapper for the long-running demonstration relay.
 *
 * Cloud Run services need an HTTP listener even though this process performs
 * queue work. The listener is only reachable through the worker service's
 * internal ingress policy; it exists solely for platform health checks.
 */

import { createServer } from "node:http";

const port = Number(process.env["PORT"] ?? 8080);
const host = process.env["API_HOST"] ?? "0.0.0.0";

const healthServer = createServer((_request, response) => {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end('{"status":"ok","service":"vision-worker"}');
});

healthServer.listen(port, host, () => {
  process.stdout.write(`vision Cloud Run worker health listener on ${host}:${String(port)}\n`);
  void import("./dev-worker.ts").catch((error: unknown) => {
    console.error("vision worker failed to start", error);
    process.exitCode = 1;
    healthServer.close(() => process.exit(1));
  });
});

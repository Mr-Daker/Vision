/**
 * Cloud Run entry point for the Vision demonstration.
 *
 * Unlike `dev-server.ts`, this has no local credentials or filesystem
 * fallbacks. Cloud Run injects DATABASE_URL and HMAC keys from Secret Manager
 * and mounts the private evidence bucket at OBJECT_STORE_ROOT.
 */

import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { FilesystemObjectStoreAdapter } from "@vision/adapters";

import { buildAppWithDatabase } from "./server.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be configured for Cloud Run`);
  }
  return value;
};

const port = Number(process.env["PORT"] ?? 8080);
const host = process.env["API_HOST"] ?? "0.0.0.0";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const client = new pg.Client({ connectionString: required("DATABASE_URL") });

await client.connect();

const objectStore = new FilesystemObjectStoreAdapter({
  root: required("OBJECT_STORE_ROOT"),
  grantHmacKey: required("OBJECT_STORE_GRANT_HMAC_KEY"),
});

const { handler } = buildAppWithDatabase(
  client,
  objectStore,
  process.env,
  process.env["WEB_PUBLIC_DIR"] ?? join(repoRoot, "apps/web/public"),
);
const server = createServer((request, response) => {
  void handler(request, response);
});

server.listen(port, host, () => {
  process.stdout.write(`vision Cloud Run API listening on ${host}:${String(port)}\n`);
});

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void client.end().finally(() => process.exit(0));
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

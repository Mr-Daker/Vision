/**
 * Local development entry point (roadmap V019).
 *
 * Serves the API and the built citizen interface from one origin, which is
 * what the `SameSite=Strict` session cookie and the double-submit CSRF token
 * need. Requires PostgreSQL (`npm run db:up && npm run db:migrate`) and a
 * built interface (`npm run build:web`).
 *
 * Development only. There is no TLS, no process supervision and no graceful
 * connection draining here, and the object store writes to a local directory.
 */

import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { FilesystemObjectStoreAdapter } from "@vision/adapters";

import { buildAppWithDatabase } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const port = Number(process.env["PORT"] ?? 8787);
const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const webRoot = process.env["WEB_PUBLIC_DIR"] ?? join(repoRoot, "apps/web/public");
const storeRoot = process.env["OBJECT_STORE_ROOT"] ?? join(repoRoot, ".local/object-store");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

await mkdir(storeRoot, { recursive: true });
const objectStore = new FilesystemObjectStoreAdapter({
  root: storeRoot,
  grantHmacKey: process.env["OBJECT_STORE_GRANT_HMAC_KEY"] ?? "local-dev-grant-key-not-a-secret",
});

const { handler } = buildAppWithDatabase(client, objectStore, process.env, webRoot);

const server = createServer((request, response) => {
  void handler(request, response);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`vision dev server on http://127.0.0.1:${String(port)}\n`);
  process.stdout.write(`  interface: ${webRoot}\n`);
  process.stdout.write(`  objects:   ${storeRoot}\n`);
});

const shutdown = (): void => {
  server.close(() => {
    void client.end().then(() => process.exit(0));
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

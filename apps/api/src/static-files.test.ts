/**
 * Static file handler tests (roadmap V019).
 *
 * This module is a directory-traversal boundary, and until now it was checked
 * only by hand with curl. A manual check leaves no record of what was covered
 * and cannot re-run when the code changes, so the boundary is asserted here
 * against a real HTTP server and a real temporary directory.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStaticFileHandler } from "./static-files.ts";

let server: Server;
let baseUrl: string;
/** Holds the served root plus a sibling directory that must stay unreachable. */
let sandbox: string;

const SECRET = "outside-the-root-must-never-be-served";

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "vision-static-"));
  const root = join(sandbox, "public");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.html"), "<h1>interface</h1>");
  // A WebP, because the brand mark is one and an image the allowlist does not
  // know about is served as a 404 that looks like a missing file.
  await writeFile(join(root, "logo.webp"), Buffer.from("RIFF....WEBPVP8 ", "binary"));
  await writeFile(join(root, "hero.mp4"), Buffer.from("\0\0\0\x18ftypmp42", "binary"));
  // A secret that lives outside the served root.
  await writeFile(join(sandbox, "secret.txt"), SECRET);
  // A symlink *inside* the root whose target is outside it. The containment
  // check is lexical, so this is the case it cannot see.
  await symlink(join(sandbox, "secret.txt"), join(root, "leak.txt"));

  const serve = createStaticFileHandler({ root });
  server = createServer((request, response) => {
    // Mirrors the real composition in `server.ts`/`app.ts`: an unserved path
    // falls through to the router's 404, and a throw becomes a 500. Without
    // the catch, a throwing handler leaves the request hanging, which turns a
    // clean assertion failure into an opaque timeout.
    void serve(request, response)
      .then((served) => {
        if (!served) {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("not served");
        }
      })
      .catch(() => {
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
        response.end("handler threw");
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("V019: a symlink whose target escapes the root is not served", async () => {
  const response = await fetch(`${baseUrl}/leak.txt`);
  const body = await response.text();

  assert.equal(response.status, 404, "a symlink out of the root must not be served");
  assert.doesNotMatch(body, new RegExp(SECRET), "content from outside the root reached the client");
});

test("V019: the interface shell is served for the root path", async () => {
  const response = await fetch(`${baseUrl}/`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await response.text(), /interface/);
});

test("V019: a traversal path is refused in plain and percent-encoded form", async () => {
  for (const path of [
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/%2E%2E%2Fsecret.txt",
    "/a/../../secret.txt",
    "/%2e%2e%2f%2e%2e%2fetc/hosts",
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must not be served`);
    assert.doesNotMatch(await response.text(), new RegExp(SECRET), `${path} leaked the secret`);
  }
});

test("V019: a dotfile is never served", async () => {
  // The extension must be allowlisted, otherwise the allowlist refuses this
  // first and the dot-segment rule is never reached: `extname(".env")` is "",
  // so a plain `.env` proves nothing about the dotfile check.
  await writeFile(join(sandbox, "public", ".hidden.js"), "const secretToken = 1;");

  const response = await fetch(`${baseUrl}/.hidden.js`);

  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /secretToken/);
});

test("V019: an extension outside the allowlist is refused even inside the root", async () => {
  await writeFile(join(sandbox, "public", "notes.md"), "# not servable");

  const response = await fetch(`${baseUrl}/notes.md`);

  assert.equal(response.status, 404);
  // "not served" proves the handler declined and the router answered, rather
  // than the handler half-answering with an undefined content type.
  assert.equal(await response.text(), "not served");
});

test("V019: a directory is never listed", async () => {
  // Named with an allowlisted extension on purpose: a plain `assets` has no
  // extension, so the allowlist would refuse it before `isFile()` is reached.
  await mkdir(join(sandbox, "public", "bundle.js"), { recursive: true });

  const response = await fetch(`${baseUrl}/bundle.js`);

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "not served");
});

test("V019: an API path is left to the router even when a matching file exists", async () => {
  // A file that the allowlist would happily serve, placed under /v1/. Without
  // the passthrough this would be returned as a file and would shadow the API,
  // so an existing file is what makes this test bite.
  await mkdir(join(sandbox, "public", "v1"), { recursive: true });
  await writeFile(join(sandbox, "public", "v1", "sessions.json"), '{"shadowed":true}');

  const response = await fetch(`${baseUrl}/v1/sessions.json`);

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "not served", "an API path must reach the router");
});

test("V019: every served response carries the restrictive headers", async () => {
  const response = await fetch(`${baseUrl}/`);
  const csp = response.headers.get("content-security-policy") ?? "";

  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  // An inline script must stay inert: no 'unsafe-inline', and no wildcard.
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);

  // Images come from this origin, a data: URI, or a blob the page itself made
  // for the photo preview. Pinned because `blob:` was added deliberately and
  // narrowly: it is a same-origin handle to bytes already in the page and
  // reaches no network, but the list must not grow past these three.
  assert.match(csp, /img-src 'self' data: blob:;/);
});

// Node's HTTP server suppresses a body on a HEAD response by itself, so the
// handler's early return is an optimisation rather than a boundary. This
// asserts the observable contract only, and claims nothing more.
test("V019: HEAD returns the headers with no body", async () => {
  const response = await fetch(`${baseUrl}/`, { method: "HEAD" });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "18");
  assert.equal(await response.text(), "");
});

test("V019: a write method is never handled by the file server", async () => {
  const response = await fetch(`${baseUrl}/index.html`, { method: "POST" });

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "not served");
});

test("V019: a WebP image is served with its own content type", async () => {
  // The allowlist is the security control here — only known extensions are
  // served at all — so adding an image format is a deliberate act, not a
  // default. WebP sits with the PNG and JPEG already on the list: a raster
  // image, no active content, and what the brand mark is encoded as.
  const response = await fetch(`${baseUrl}/logo.webp`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("V019: an MP4 is served, because the interface serves its own video", async () => {
  // The API's Content-Security-Policy is `media-src 'self'`, so the background
  // video has to come from this origin — which means this handler has to be
  // willing to serve it. The alternative was widening the policy to a CDN for
  // the whole application, which is a much larger concession than adding one
  // passive media type here.
  const response = await fetch(`${baseUrl}/hero.mp4`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

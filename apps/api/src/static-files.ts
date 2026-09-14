/**
 * Static file serving for the citizen interface (roadmap V019).
 *
 * Why the API serves the interface: the session cookie is `SameSite=Strict`
 * and CSRF uses a double-submit token, both of which need the page and the API
 * to share an origin. A separate static host would mean either weakening the
 * cookie policy or adding a proxy, and neither is worth it for a demonstration
 * ([V006](../../../docs/foundation/V006-architecture-and-deployment-decisions.md)
 * D3 still treats the PWA as its own deployable unit; this is how it is served
 * locally, not a decision to merge them).
 *
 * A static server is a directory-traversal risk, so:
 *  - the resolved path must stay inside the configured root,
 *  - only an allowlisted extension is served,
 *  - directories are never listed,
 *  - a dotfile is never served.
 */

import { createReadStream, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, normalize, resolve, sep, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  // A raster image with no active content, same class as the two above. The
  // brand mark is a WebP, and an extension missing from this list is served
  // as a 404 that reads like a missing file rather than a refused type.
  ".webp": "image/webp",
  // Passive media. The API's CSP is `media-src 'self'`, so the landing page's
  // background video must be served from here — the alternative was widening
  // that policy to a third-party origin for the whole application.
  ".mp4": "video/mp4",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export type StaticFileOptions = {
  /** Directory to serve. Nothing outside it is reachable. */
  readonly root: string;
  /** Served for `/` and for a path with no extension (single-page entry). */
  readonly indexFile?: string;
};

/**
 * Returns a handler that serves a file and reports whether it did, so the API
 * router can fall through to its own 404 for unknown API paths.
 */
export const createStaticFileHandler = (options: StaticFileOptions) => {
  // Resolved through symlinks, because containment is re-checked below
  // against the real path and the two must be in the same form. If the root
  // does not exist yet, the lexical path is kept and every request 404s.
  const root = (() => {
    const lexical = resolve(options.root);
    try {
      return realpathSync(lexical);
    } catch {
      return lexical;
    }
  })();
  const indexFile = options.indexFile ?? "index.html";

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return false;

    const url = new URL(request.url ?? "/", "http://localhost");
    // API paths are never files; leaving them to the router keeps a typo in an
    // endpoint returning a JSON 404 rather than the HTML shell.
    if (url.pathname.startsWith("/v1/")) return false;

    const decoded = (() => {
      try {
        return decodeURIComponent(url.pathname);
      } catch {
        return undefined;
      }
    })();
    if (decoded === undefined) return false;

    const requested = decoded === "/" || decoded.endsWith("/") ? `${decoded}${indexFile}` : decoded;
    if (requested.split("/").some((segment) => segment.startsWith("."))) return false;

    const candidate = resolve(join(root, normalize(requested)));
    // Lexical traversal backstop. With the dot-segment rule above in place
    // this is unreachable on POSIX — no `..` survives to here, and nothing
    // else escapes `join` — so mutation testing shows no test can distinguish
    // it. It is kept deliberately as the guard that still holds if the
    // dot-segment rule is ever relaxed; the reachable containment check is the
    // realpath one below.
    if (candidate !== root && !candidate.startsWith(root + sep)) return false;

    const extension = extname(candidate).toLowerCase();
    const contentType = CONTENT_TYPES[extension];
    if (contentType === undefined) return false;

    let size: number;
    let filePath: string;
    try {
      // `resolve` above is lexical, so it cannot see a symlink inside the root
      // whose target is outside it. The real path is what would actually be
      // read, so containment is re-checked against that.
      filePath = await realpath(candidate);
      if (filePath !== root && !filePath.startsWith(root + sep)) return false;
      const info = await stat(filePath);
      if (!info.isFile()) return false;
      size = info.size;
    } catch {
      return false;
    }

    response.writeHead(200, {
      "content-type": contentType,
      "content-length": String(size),
      // The demonstration is edited constantly; a cached shell hides changes.
      "cache-control": "no-store",
      // The interface loads only its own assets, so a tight policy costs
      // nothing here and makes an injected script inert.
      //
      // `blob:` is allowed for images as well as media. The citizen's chosen
      // photo is previewed from an object URL, and a blob URL is an opaque
      // same-origin handle to bytes the page already holds — it cannot reach
      // the network, so this admits no request the policy did not already
      // allow. The alternative was a base64 `data:` URL, which would mean
      // holding a second copy of an image up to 8 MB in memory on the cheap
      // phone this interface is built for.
      "content-security-policy":
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });

    if (method === "HEAD") {
      response.end();
      return true;
    }

    await new Promise<void>((resolvePromise) => {
      const stream = createReadStream(filePath);
      stream.on("error", () => {
        response.end();
        resolvePromise();
      });
      stream.on("end", () => resolvePromise());
      stream.pipe(response);
    });
    return true;
  };
};

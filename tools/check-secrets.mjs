#!/usr/bin/env node
/**
 * Refuses to let an L3c secret or private evidence enter version control
 * (V005 §7, V007 "done when": secrets and private media are excluded from
 * version control and build artifacts).
 *
 * Scans tracked plus non-ignored untracked files. This keeps a brand-new
 * repository from passing vacuously before its first commit while respecting
 * .gitignore for local secrets and evidence. Deliberately conservative
 * patterns look for credential values, not words such as "secret" in prose.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const TEXT_EXTENSIONS =
  /\.(ts|mts|js|mjs|cjs|json|ya?ml|md|txt|sh|env|example|sql|html|css|toml|ini)$/i;

/** Prose is exempt only from the noisy generic entropy heuristic. */
const GENERIC_ASSIGNMENT_EXEMPT =
  /^(docs\/|deliverables\/|design-work\/|README|tools\/check-secrets\.mjs$)/;

/** Precise provider formats. A match here is almost certainly a real credential. */
const VALUE_PATTERNS = [
  { label: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // Newer Google/Gemini key format. Added because the AIza pattern above does
  // not match it, so a real key in this format would have passed the scan.
  { label: "Google API key (AQ format)", pattern: /\bAQ\.[A-Za-z0-9_-]{30,}/ },
  { label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Slack token", pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { label: "JSON service-account private key", pattern: /"private_key"\s*:\s*"-----BEGIN/ },
];

/**
 * Generic heuristic for `KEY = "<value>"` assignments.
 *
 * Naming a variable `credential` is not a finding — the *value* has to look
 * like a credential. Kebab-case words are how this codebase writes demo
 * identifiers and placeholders (`test-only-session-key`,
 * `not-a-real-demo-principal`), so they are excluded; a real secret is
 * high-entropy and mixes character classes.
 */
// The keyword may be embedded in a longer identifier (SESSION_TOKEN_HMAC_KEY,
// apiKeyValue), so surrounding identifier characters are allowed.
const ASSIGNMENT_PATTERN =
  /[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|credential)[A-Za-z0-9_]*\s*[:=]\s*["']([^"']{16,})["']/gi;

const looksRandom = (value) => {
  // A template interpolation or shell/env expansion is code, not a literal
  // secret: the value is computed at runtime and is not committed here.
  if (/[$][{(]/.test(value)) return false;
  // Kebab / snake case sequences of words: a placeholder or an identifier.
  if (/^[a-z0-9]+([-_][a-z0-9]+)+$/.test(value)) return false;
  // A readable sentence or path is not a credential.
  if (/\s|\//.test(value)) return false;

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  return value.length >= 24 && classes >= 3;
};

/** Values that are obviously placeholders and must not trip the check. */
const PLACEHOLDER =
  /(replace-me|placeholder|example|dummy|not-a-secret|not-a-real|local-dev|test-only|xxx+)/i;

const FORBIDDEN_PATHS = [
  { label: "committed .env", pattern: /^\.env$/ },
  { label: "committed .env variant", pattern: /^\.env\.(?!example$)/ },
  { label: "private key file", pattern: /\.(pem|key|p12|pfx)$/ },
  { label: "service-account credentials", pattern: /(service-account|gcp-credentials).*\.json$/ },
  {
    label: "private evidence directory",
    pattern: /^(private-media|evidence-originals|quarantine|local-object-store)\//,
  },
];

let candidates;
try {
  candidates = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
} catch {
  console.error("check:secrets FAILED — the workspace is not a git repository");
  process.exit(1);
}

const violations = [];

for (const path of candidates) {
  for (const { label, pattern } of FORBIDDEN_PATHS) {
    if (pattern.test(path)) {
      violations.push({ path, line: 0, label: `${label} must not be tracked`, text: path });
    }
  }

  if (!TEXT_EXTENSIONS.test(path)) continue;

  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    continue;
  }
  if (size > 2 * 1024 * 1024) continue;

  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    continue;
  }

  content.split("\n").forEach((line, index) => {
    if (PLACEHOLDER.test(line)) return;

    for (const { label, pattern } of VALUE_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ path, line: index + 1, label, text: line.trim().slice(0, 80) });
      }
    }

    if (!GENERIC_ASSIGNMENT_EXEMPT.test(path)) {
      ASSIGNMENT_PATTERN.lastIndex = 0;
      for (const match of line.matchAll(ASSIGNMENT_PATTERN)) {
        if (looksRandom(match[1])) {
          violations.push({
            path,
            line: index + 1,
            label: "assigned credential value",
            text: line.trim().slice(0, 80),
          });
        }
      }
    }
  });
}

if (violations.length > 0) {
  console.error("Possible secret or private evidence in version control (V005 §7):\n");
  for (const v of violations) {
    console.error(`  ${v.path}${v.line > 0 ? `:${v.line}` : ""}  [${v.label}]`);
    if (v.line > 0) console.error(`      ${v.text}`);
  }
  console.error("\nRemove the value, rotate it if it was ever real, and inject it at runtime.");
  process.exit(1);
}

console.log(`check:secrets OK — ${candidates.length} tracked/non-ignored files scanned`);

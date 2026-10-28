#!/usr/bin/env node
/**
 * Fails (exit 1) when a tracked or staged file would commit a secret:
 *   - Clerk/GitHub/Slack/AWS keys, private keys, internal/MCP keys, JWTs, long hex secrets
 *   - .env files and key/cert files
 *
 * Runs on pre-commit (.githooks), before `npm pack`, and in CI.
 * Usage: node scripts/check-secrets.mjs [--staged]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const staged = process.argv.includes("--staged");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

/** Files this check reads: what is staged (pre-commit) or everything tracked. */
const files = (
  staged
    ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
    : git("ls-files")
)
  .split("\n")
  .filter(Boolean)
  .filter((file) => file !== "package-lock.json");

const FORBIDDEN_FILES = [
  { pattern: /(^|\/)\.env(\..+)?$/, reason: "environment file" },
  { pattern: /\.(pem|key|p12|pfx|crt)$/i, reason: "key or certificate file" },
];

/** Content rules: [name, regex]. Matches are reported with file and line. */
const CONTENT_RULES = [
  ["Clerk key", /\b(sk|pk)_(test|live)_[A-Za-z0-9]{10,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["MCP / internal key", /\b(kd|kx|lvbl|kn)_[A-Za-z0-9_-]{20,}/],
  ["hex secret", /\b[a-f0-9]{48,}\b/],
];

const problems = [];

for (const file of files) {
  for (const rule of FORBIDDEN_FILES) {
    if (rule.pattern.test(file))
      problems.push(`${file}: ${rule.reason} must not be committed`);
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted or unreadable in the working tree
  }
  if (text.includes("\u0000")) continue; // binary
  text.split("\n").forEach((line, index) => {
    for (const [name, regex] of CONTENT_RULES) {
      if (regex.test(line)) problems.push(`${file}:${index + 1}: ${name}`);
    }
  });
}

if (problems.length) {
  console.error("Secret check failed — remove these before committing or publishing:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Secret check passed (${files.length} files).`);

#!/usr/bin/env node
/**
 * This repository is public. Fails (exit 1) when a tracked file or a commit would leak
 * something that must stay private:
 *   - secrets: Clerk/GitHub/Slack/AWS keys, private keys, internal API keys, JWTs
 *   - .env files and key/cert files
 *   - internal hostnames, emails and IP addresses (use example.com / 203.0.113.x)
 *   - commit authors with a real email (use <id>+<login>@users.noreply.github.com)
 *
 * Runs on pre-commit (.githooks), before `npm pack`, and in CI.
 * Usage: node scripts/check-public.mjs [--staged]
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
  [
    "internal hostname",
    /\b[a-z0-9.-]*\b(kinex\.ai|kinhotel\.com|kinliving\.vn|inbox4us\.xyz|clerk\.accounts\.dev|vultrdb\.com)\b/i,
  ],
  [
    "IP address",
    /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?!203\.0\.113\.)(?!198\.51\.100\.)(?!192\.0\.2\.)\d{1,3}(\.\d{1,3}){3}\b/,
  ],
];

/** Emails allowed in files: documentation placeholders and noreply addresses. */
const ALLOWED_EMAIL =
  /@(example\.(com|org|net)|users\.noreply\.github\.com|anthropic\.com)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

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
    for (const email of line.match(EMAIL) ?? []) {
      if (!ALLOWED_EMAIL.test(email))
        problems.push(`${file}:${index + 1}: email ${email}`);
    }
  });
}

// Commit authors and committers in history (CI / prepack; pre-commit checks the
// configured identity instead, since history may be what is being rewritten).
let identities = "";
if (!staged) {
  try {
    identities = git("log", "--format=%ae%n%ce", "--all");
  } catch {
    identities = "";
  }
}
for (const email of new Set(identities.split("\n").filter(Boolean))) {
  if (!ALLOWED_EMAIL.test(email)) {
    problems.push(
      `commit identity ${email}: use your GitHub noreply email (git config user.email)`,
    );
  }
}
const configured = (() => {
  try {
    return git("config", "user.email").trim();
  } catch {
    return "";
  }
})();
if (staged && configured && !ALLOWED_EMAIL.test(configured)) {
  problems.push(
    `git config user.email is ${configured}: use your GitHub noreply email`,
  );
}

if (problems.length) {
  console.error(
    "Public repository check failed — remove these before committing or publishing:",
  );
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Public repository check passed (${files.length} files).`);

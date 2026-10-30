// License check for the npm dependencies (Ai-Agent builds only on permissive open source).
// Reads the licenses npm records in package-lock.json — no extra tool. Fails (exit 1) on any
// license outside the policy, so CI stops a new dependency before it ships.
//
//   npm run license:check
//
// Not covered: the Docker images' own packages (Python in the voice and gateway images, the
// base images). The gateway image removes LiteLLM's proprietary code itself (gateway/Dockerfile).

import { readFileSync } from "node:fs";

// Permissive: fine anywhere.
const ALLOWED = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "BSD", "0BSD", "Unlicense", "Zlib", "CC0-1.0", "BlueOak-1.0.0", "Python-2.0", "CC-BY-4.0"]);
// Weak copyleft, file-level: acceptable for build-time tools that are never shipped.
const DEV_ONLY = new Set(["MPL-2.0"]);

type Lock = { packages: Record<string, { license?: string | { type?: string }; dev?: boolean }> };
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as Lock;

// An SPDX expression such as "(MIT OR GPL-3.0-or-later)" or "(MIT AND Zlib)".
function acceptable(expression: string, dev: boolean): boolean {
  const ok = (id: string) => ALLOWED.has(id) || (dev && DEV_ONLY.has(id));
  const inner = expression.replace(/^\((.*)\)$/, "$1").trim();
  if (/ OR /.test(inner)) return inner.split(/ OR /).some((part) => acceptable(part.trim(), dev)); // we may choose
  if (/ AND /.test(inner)) return inner.split(/ AND /).every((part) => acceptable(part.trim(), dev)); // we must meet all
  return ok(inner);
}

const problems: string[] = [];
let checked = 0;
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path) continue; // the project itself
  checked++;
  const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
  const name = path.replace(/^.*node_modules\//, "");
  if (!license) problems.push(`${name}: no license recorded`);
  else if (!acceptable(license, pkg.dev === true)) problems.push(`${name}: ${license}${pkg.dev ? " (dev)" : ""}`);
}

if (problems.length) {
  console.error(`✗ ${problems.length} of ${checked} packages have a license outside the policy:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log(`✓ all ${checked} npm packages have permissive licenses (MPL-2.0 allowed only for dev tools)`);
}

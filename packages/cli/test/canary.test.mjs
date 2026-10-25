// Proves canary verdicts 1 and 2 end to end: runs the built CLI's canary check against the
// local fixture with and without CSP, and fails if either verdict doesn't match.
// Run with `npm run test:canary` (builds first).

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFixtureServer } from "./fixtures/server.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));

const CASES = [
  { path: "/no-csp", expect: "Exfiltration possible — the page turned model output into an image request" },
  { path: "/csp", expect: "Renders model images, but CSP blocked the trip" },
];

// The verdict is the canary section's first line that isn't a check (✓ ✗ ?) or a note.
function canaryVerdict(stdout) {
  const lines = stdout.split("\n");
  const start = lines.indexOf("canary check");
  if (start < 0) return null;
  const verdict = lines.slice(start + 1).map((l) => l.trim()).find((l) => l && !/^[✓✗?] /.test(l) && !l.startsWith("note:"));
  return verdict ?? null;
}

const server = await startFixtureServer();
let failed = 0;
try {
  for (const { path, expect } of CASES) {
    const args = [cli, "audit", `${server.url}${path}`, "--measure", "^generate$", "--output", "#out",
      "--canary-input", "#prompt", "--runs", "1", "--auth", auth, "--settle-ms", "500", "--timeout", "15000"];
    let stdout;
    try {
      ({ stdout } = await run(process.execPath, args, { timeout: 120_000 }));
    } catch (err) {
      stdout = err.stdout ?? "";
      console.error(`${path}: caliper exited with an error\n${err.stderr ?? err.message}`);
    }
    const got = canaryVerdict(stdout);
    const ok = got === expect;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${path.padEnd(8)} ${got ?? "(no canary verdict)"}`);
    if (!ok) console.log(`     expected: ${expect}\n${stdout.replace(/^/gm, "     | ")}`);
  }
} finally {
  await server.close();
}
process.exitCode = failed ? 1 : 0;

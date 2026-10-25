// Proves Caliper doesn't hang on a stream Chromium ends net::ERR_ABORTED after the full body
// (an SSE reply sent with Cache-Control: no-store): the audit finishes well inside --timeout,
// labels the request as treated as finished in the terminal and the HTML report, and doesn't
// give that label to a stream the page really aborted mid-body.
// Run with `npm run test:nostore` (builds first).

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFixtureServer } from "./fixtures/server.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));
const LABEL = "ended ERR_ABORTED after full body — treated as finished";
const TIMEOUT_MS = 15_000; // the old hang waited this long, then failed the audit

const CASES = [
  { name: "click, full body", path: "/stream-nostore", args: ["--measure", "^generate$", "--output", "#out"], label: true },
  { name: "click, real abort", path: "/stream-nostore?abort=3", args: ["--measure", "^generate$", "--output", "#out"], label: false },
];

const server = await startFixtureServer();
const dir = mkdtempSync(join(tmpdir(), "caliper-nostore-"));
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};

try {
  for (const [i, c] of CASES.entries()) {
    const report = join(dir, `report-${i}.html`);
    const args = [cli, "audit", `${server.url}${c.path}`, ...c.args, "--runs", "2", "--auth", auth,
      "--settle-ms", "500", "--timeout", String(TIMEOUT_MS), "--report", report];
    const started = Date.now();
    let stdout = "";
    let error = null;
    try {
      ({ stdout } = await run(process.execPath, args, { timeout: 120_000 }));
    } catch (err) {
      stdout = err.stdout ?? "";
      error = (err.stderr || err.message).trim();
    }
    const took = Date.now() - started;
    let html = "";
    try {
      html = readFileSync(report, "utf8");
    } catch {}

    check(error === null, `${c.name}: audit completed${error ? ` (${error})` : ""}`);
    check((stdout.match(/^run \d/gm) ?? []).length === 2, `${c.name}: both runs measured`);
    check(took < TIMEOUT_MS, `${c.name}: took ${took} ms, not stuck on --timeout`);
    const labelled = stdout.includes(LABEL) && html.includes(LABEL);
    const unlabelled = !stdout.includes(LABEL) && !html.includes(LABEL);
    check(c.label ? labelled : unlabelled,
      `${c.name}: ${c.label ? "labelled in terminal and report" : "not labelled as treated as finished"}`);
    if (!c.label) check(stdout.includes("full body not confirmed"), `${c.name}: noted as ERR_ABORTED, full body not confirmed`);
    if (failed) console.log(stdout.replace(/^/gm, "     | "));
  }
} finally {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;

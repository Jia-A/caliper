// README: "If you skip it [npx playwright install chromium], Caliper tells you to run it."
// Points Playwright at an empty browsers folder (PLAYWRIGHT_BROWSERS_PATH), so the launch fails
// with Playwright's real missing-browser error, and checks that `caliper audit` and
// `caliper login` print Caliper's one-line instruction instead of Playwright's box. Fails if
// Playwright's wording drifts away from the pattern in src/browser.ts.
// Run with `npm run test:browser` (builds first).

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFixtureServer } from "./fixtures/server.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));
const emptyBrowsers = mkdtempSync(join(tmpdir(), "caliper-no-browsers-"));

// The Playwright version Caliper pins, in the command: outside a project, a bare
// `npx playwright` fetches the latest Playwright, whose Chromium build Caliper can't use.
const EXPECTED = "error: Chromium for Playwright isn't installed. Run:\n\n  npx playwright@1.64.1 install chromium\n";

const server = await startFixtureServer();
let failed = 0;
const outputs = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};

async function caliper(name, args) {
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers };
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { env, timeout: 60_000 });
    outputs.push(`--- ${name} (exit 0) ---\n${stdout}${stderr}`);
    return { code: 0, stdout, stderr };
  } catch (err) {
    outputs.push(`--- ${name} (exit ${err.code}) ---\n${err.stdout ?? ""}${err.stderr ?? err.message}`);
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}
const NO_REPORT = "no report written: the audit stopped on the error below";

try {
  const cases = [
    ["audit", ["audit", `${server.url}/stream-nostore`, "--measure", "^generate$", "--output", "#out", "--runs", "1", "--auth", auth, "--no-report"]],
    ["login", ["login", `${server.url}/no-csp`, "--auth", join(emptyBrowsers, "auth.json")]],
  ];
  for (const [name, args] of cases) {
    const { code, stderr } = await caliper(name, args);
    check(code === 1, `${name}: exits 1 (got ${code})`);
    check(stderr.includes(EXPECTED), `${name}: says "Chromium for Playwright isn't installed. Run: npx playwright@1.64.1 install chromium"`);
    check(!stderr.includes("Executable doesn't exist") && !stderr.includes("╔"), `${name}: Playwright's own error box isn't printed`);
  }
  // Every stranger's first run: no --no-report, so the last line says why there's no report.
  const dir = mkdtempSync(join(tmpdir(), "caliper-no-browsers-report-"));
  const first = await caliper("audit, report on", ["audit", `${server.url}/stream-nostore`, "--measure", "^generate$", "--output", "#out", "--runs", "1", "--auth", auth, "--report", join(dir, "r.html")]);
  check(first.code === 1 && first.stderr.includes(EXPECTED) && first.stdout.trimEnd().split("\n").at(-1) === NO_REPORT && !existsSync(join(dir, "r.html")),
    `audit, report on: the instruction, and "${NO_REPORT}" (got: ${first.stdout.trimEnd().split("\n").at(-1) || "nothing"})`);
  const quiet = await caliper("audit, --no-report", cases[0][1]);
  check(!quiet.stdout.includes("no report written"), "audit, --no-report: no report line");
} finally {
  await server.close();
}
if (failed) console.log(outputs.join("\n").replace(/^/gm, "     | "));
process.exitCode = failed ? 1 : 0;

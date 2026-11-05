// README: "If you skip it [npx playwright install chromium], Caliper tells you to run it."
// Points Playwright at an empty browsers folder (PLAYWRIGHT_BROWSERS_PATH), so the launch fails
// with Playwright's real missing-browser error, and checks that `caliper audit` and
// `caliper login` print Caliper's one-line instruction instead of Playwright's box. Fails if
// Playwright's wording drifts away from the pattern in src/browser.ts.
// Run with `npm run test:browser` (builds first).

import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFixtureServer } from "./fixtures/server.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));
const emptyBrowsers = mkdtempSync(join(tmpdir(), "caliper-no-browsers-"));

const EXPECTED = "error: Chromium for Playwright isn't installed. Run:\n\n  npx playwright install chromium\n";

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
    return { code: 0, stderr };
  } catch (err) {
    outputs.push(`--- ${name} (exit ${err.code}) ---\n${err.stdout ?? ""}${err.stderr ?? err.message}`);
    return { code: err.code, stderr: err.stderr ?? "" };
  }
}

try {
  const cases = [
    ["audit", ["audit", `${server.url}/stream-nostore`, "--measure", "^generate$", "--output", "#out", "--runs", "1", "--auth", auth, "--no-report"]],
    ["login", ["login", `${server.url}/no-csp`, "--auth", join(emptyBrowsers, "auth.json")]],
  ];
  for (const [name, args] of cases) {
    const { code, stderr } = await caliper(name, args);
    check(code === 1, `${name}: exits 1 (got ${code})`);
    check(stderr.includes(EXPECTED), `${name}: says "Chromium for Playwright isn't installed. Run: npx playwright install chromium"`);
    check(!stderr.includes("Executable doesn't exist") && !stderr.includes("╔"), `${name}: Playwright's own error box isn't printed`);
  }
} finally {
  await server.close();
}
if (failed) console.log(outputs.join("\n").replace(/^/gm, "     | "));
process.exitCode = failed ? 1 : 0;

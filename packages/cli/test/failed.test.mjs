// A failed AI request is never timed, and an image is never the AI request (caliper-test-3 A7).
// Runs the built CLI against /failed, where your avatar image loads just before the page shows
// "Error occurred", in three cases:
//   refused    the reply's POST goes to a port nothing listens on (connection refused). The run
//              is "not identified", lists the requests it saw, and says which one failed, "if
//              it's your AI request" — never that it was.
//   503        the reply's POST answers 503. Its bytes explain the error bubble, so it's the
//              AI request, and the run is "AI request failed", naming it.
//   503 named  the same with --request "POST /failed/stream".
// None may show a number, a streaming verdict or advice.
// Run with `npm run test:failed` (builds first).

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFixtureServer } from "./fixtures/server.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));

// A port nothing listens on: bind one, then close it. After the fixture server is up, so the
// OS can't hand it the same port.
const server = await startFixtureServer();
const deadPort = await new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const dead = `http://127.0.0.1:${deadPort}/stream`;
const dir = mkdtempSync(join(tmpdir(), "caliper-failed-"));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const CASES = [
  { name: "refused", path: `/failed?api=${encodeURIComponent(dead)}`, args: [] },
  { name: "503", path: "/failed", args: [] },
  { name: "503 named", path: "/failed", args: ["--request", "POST /failed/stream"] },
];

try {
  for (const [i, c] of CASES.entries()) {
    const report = join(dir, `report-${i}.html`);
    const args = [cli, "audit", `${server.url}${c.path}`, "--input", "#msg", "--prompt", "hello", "--output", "#messages",
      ...c.args, "--runs", "2", "--auth", auth, "--settle-ms", "500", "--timeout", "8000", "--report", report];
    let stdout = "";
    try {
      ({ stdout } = await run(process.execPath, args, { timeout: 120_000 }));
    } catch (err) {
      stdout = err.stdout ?? "";
      console.error(`${c.name}: caliper ${err.killed ? "was killed after 120 s (hung)" : "exited with an error"}\n${err.stderr || err.message}`);
    }
    let html = "";
    try {
      html = readFileSync(report, "utf8");
    } catch {}
    const runLines = stdout.match(/^run \d.*$/gm) ?? [];

    // A chosen request is printed as "METHOD url → status type", then "chosen from …".
    check(!/user-icon\.png\S* → 200 image\/png\n\s+chosen/.test(stdout), `${c.name}: the avatar image is never chosen`);
    check(!/People waited \d+ ms/.test(stdout) && !/People waited/.test(html), `${c.name}: no first-word number in the verdict`);
    check(!stdout.includes("Doesn't stream") && !stdout.includes("Stream the response"), `${c.name}: no streaming verdict or advice`);
    // --runs 2 was given: the warm run wasn't timed, not missing.
    check(stdout.includes("No warm run was timed (runs 2 and later; see each run above for why), so there's no median wait.") && !stdout.includes("Use --runs 2 or more"),
      `${c.name}: the verdict says the warm run wasn't timed, not to use --runs 2`);
    if (c.name === "refused") {
      check(runLines.length === 2 && runLines.every((l) => l.endsWith("— AI request not identified, timing inconclusive")),
        `${c.name}: both runs "AI request not identified" (got ${JSON.stringify(runLines)})`);
      const seen = stdout.match(/^ {4}requests seen: (.*)$/gm) ?? [];
      check(seen.length === 2 && seen.every((l) => l.includes(`POST ${dead} → failed (net::ERR_CONNECTION_REFUSED)`) && /GET \S+\/failed\/user-icon\.png\S* → 200 image\/png \(an image: never the AI request\)/.test(l)),
        `${c.name}: each run lists the requests it saw, the failed POST and the image (got ${JSON.stringify(seen)})`);
      const said = stdout.match(/^ {4}this request failed: .*$/gm) ?? [];
      check(said.length === 2 && said.every((l) => l === `    this request failed: POST ${dead} (net::ERR_CONNECTION_REFUSED) — if it's your AI request, the run can't be timed: fix the failure (your server's log will say why) and rerun.`),
        `${c.name}: each run names the failed request "if it's your AI request" (got ${JSON.stringify(said)})`);
      check(!/AI request failed/.test(stdout), `${c.name}: never claims the failed request was the AI request`);
    } else {
      check(runLines.length === 2 && runLines.every((l) => l.endsWith("— AI request failed, not timed")),
        `${c.name}: both runs "AI request failed, not timed" (got ${JSON.stringify(runLines)})`);
      const named = stdout.match(/^ {4}POST \S+\/failed\/stream → 503 application\/json$/gm) ?? [];
      check(named.length === 2, `${c.name}: each run names the request that failed and its status (got ${named.length})`);
      check(stdout.includes("Inconclusive — the AI request failed in every run, so no timing"), `${c.name}: summary says the AI request failed in every run`);
      check(html.includes("AI request failed"), `${c.name}: the HTML report says the AI request failed`);
    }
    if (failures.length) console.log(stdout.replace(/^/gm, "     | "));
  }
} finally {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}

process.exitCode = failures.length ? 1 : 0;

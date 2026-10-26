// Reproduces a real queue-style chat app: a fast JSON side-call (~200 ms) renders your message
// and a placeholder, while the reply streams later over a separate SSE GET that was still open
// when the output first changed. Fails unless Caliper picks the stream, times the first word
// after the reply's wait (not the side-call's render), and never calls it done before the
// stream's last token. Also checks that a page whose output no request explains (the canary
// fixture writes its reply without any network request) is reported as not identified, with
// no number. Run with `npm run test:sidecall` (builds first).

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SIDECALL_MIN_DONE_MS, SIDECALL_WAIT_MS, startFixtureServer } from "./fixtures/server.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));

const runBlocks = (stdout) => stdout.split(/^(?=run \d)/m).filter((b) => /^run \d/.test(b)).map((b) => b.split(/^cold /m)[0]);
const msOf = (block, label) => {
  const m = block.match(new RegExp(`^\\s+${label}\\s+(-?\\d+) ms`, "m"));
  return m ? Number(m[1]) : null;
};

const server = await startFixtureServer();
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};

let stdout = "";
try {
  const args = [cli, "audit", `${server.url}/sidecall`, "--input", "#msg", "--prompt", "hello", "--measure", "^send$",
    "--output", "#chat", "--runs", "2", "--auth", auth, "--settle-ms", "500", "--timeout", "15000"];
  try {
    ({ stdout } = await run(process.execPath, args, { timeout: 120_000 }));
  } catch (err) {
    stdout = err.stdout ?? "";
    console.error(`caliper exited with an error\n${err.stderr ?? err.message}`);
  }

  const blocks = runBlocks(stdout);
  check(blocks.length === 2, `2 runs reported (got ${blocks.length})`);
  for (const block of blocks) {
    const name = block.split("\n")[0].replace(/\s+\d+ ms$/, "").trim();
    const chosen = block.split("\n")[1]?.trim() ?? "";
    check(/^GET \S+\/sidecall\/stream /.test(chosen), `${name}: chose the stream (got: ${chosen || "nothing"})`);
    const firstWord = msOf(block, "send → first word");
    check(firstWord !== null && firstWord >= SIDECALL_WAIT_MS,
      `${name}: first word (${firstWord} ms) is after the reply's ${SIDECALL_WAIT_MS} ms wait`);
    const done = msOf(block, "send → done");
    check(done !== null && done >= SIDECALL_MIN_DONE_MS, `${name}: done (${done} ms) isn't before the last token (≥ ${SIDECALL_MIN_DONE_MS} ms)`);
  }

  // No request correlates: never guess.
  let local = "";
  try {
    ({ stdout: local } = await run(process.execPath, [cli, "audit", `${server.url}/no-csp`, "--measure", "^generate$", "--output", "#out",
      "--runs", "2", "--auth", auth, "--settle-ms", "500", "--timeout", "15000"], { timeout: 120_000 }));
  } catch (err) {
    local = err.stdout ?? "";
    console.error(`caliper exited with an error\n${err.stderr ?? err.message}`);
  }
  const notIdentified = local.match(/^run \d.* — AI request not identified, timing inconclusive$/gm) ?? [];
  check(notIdentified.length === 2, `no request correlates: both runs say "AI request not identified" (got ${notIdentified.length})`);
  check(!/^run \d.*\s\d+ ms$/m.test(local) && !/^cold \d/m.test(local), "no request correlates: no timing reported");
  if (failed) stdout += `\n--- no-request page ---\n${local}`;
} finally {
  await server.close();
}
if (failed) console.log(stdout.replace(/^/gm, "     | "));
process.exitCode = failed ? 1 : 0;

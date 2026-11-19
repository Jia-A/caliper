// A page that stops rendering frames never hangs Caliper (found while testing 0.6.1: three runs
// in the full suite waited until the test killed them). /norender's requestAnimationFrame never
// calls back, so the watcher's frames never come. Caliper must stop within --timeout plus its
// 10 s guard and say why, instead of waiting forever.
// Run with `npm run test:stall` (builds first).

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFixtureServer } from "./fixtures/server.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));
const TIMEOUT = 3000;
const LIMIT = 60_000; // far over --timeout + the 10 s guard; a hang is killed here

const server = await startFixtureServer();
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const started = Date.now();
let out = { stdout: "", stderr: "", killed: false, code: 0 };
try {
  out = { ...(await run(process.execPath, [cli, "audit", `${server.url}/norender`, "--measure", "^generate$", "--output", "#out",
    "--runs", "1", "--auth", auth, "--timeout", String(TIMEOUT), "--no-report"], { timeout: LIMIT })), killed: false, code: 0 };
} catch (err) {
  out = { stdout: err.stdout ?? "", stderr: err.stderr ?? "", killed: !!err.killed, code: err.code };
} finally {
  await server.close();
}
const took = Date.now() - started;
check(!out.killed && took < TIMEOUT + 10_000 + 15_000, `stops on its own (took ${took} ms${out.killed ? ", killed: it hung" : ""})`);
check(/the page stopped rendering frames \(requestAnimationFrame didn't run within 2 s\)/.test(out.stderr),
  `says the page stopped rendering frames (stderr: ${out.stderr.trim() || "none"})`);
check(!/\d+ ms\n/.test(out.stdout.split("\n").filter((l) => /^run 1/.test(l)).join("\n")), "no number for the run");
process.exitCode = failed ? 1 : 0;

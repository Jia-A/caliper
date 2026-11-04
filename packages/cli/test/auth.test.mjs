// --auth is optional. With it, Caliper loads that saved session exactly as before; a path with
// no file is an error before any run. Without it, there's no saved session (like an empty
// auth.json): one line says so, and an auth.json in the current directory is NOT loaded.
// The fixture server records the cookie header of every request, so a session counts as loaded
// only when its cookie reached the page. Fails unless:
//   (a) no --auth, no auth.json here: the run is timed, no cookie sent, the line is printed;
//   (b) no --auth, an auth.json with a cookie here: still no cookie sent;
//   (c) --auth auth.json (relative, resolved from the current directory): its cookie reaches
//       every request, and the no-session line isn't printed;
//   (d) --auth naming a missing file: the same "No saved session" error as before, no run.
// Run with `npm run test:auth` (builds first).

import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFixtureServer } from "./fixtures/server.mjs";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const NO_SESSION = "No --auth given: running without a saved session.";
const timedRuns = (stdout) => (stdout.match(/^run \d.*\s\d+ ms$/gm) ?? []).length;

// Runs the CLI in `cwd`; never throws. Returns { code, stdout, stderr }.
async function caliper(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "audit", ...args], { cwd, timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}

const server = await startFixtureServer();
const page = `${server.url}/stream-nostore`;
const run = [page, "--measure", "^generate$", "--output", "#out", "--runs", "1", "--settle-ms", "500", "--timeout", "15000"];
// A Playwright storage state with one cookie for the fixture's host.
const SESSION = { cookies: [{ name: "caliper_session", value: "s3cret", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] };
const failures = [];
const logs = [];
const check = (ok, what, out) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) {
    failures.push(what);
    if (out) logs.push(`--- ${what} ---\n${out.stdout}${out.stderr}`);
  }
};
// The requests the server saw during fn, and fn's result.
async function watching(fn) {
  const from = server.cookies.length;
  const out = await fn();
  return { out, requests: server.cookies.slice(from) };
}

// realpath: on macOS the temp dir is a symlink, and the CLI prints the resolved path.
const empty = realpathSync(mkdtempSync(join(tmpdir(), "caliper-auth-none-")));
const withFile = realpathSync(mkdtempSync(join(tmpdir(), "caliper-auth-file-")));
writeFileSync(join(withFile, "auth.json"), JSON.stringify(SESSION));

try {
  // (a) No --auth, nothing saved here.
  const a = await watching(() => caliper(empty, run));
  check(a.out.code === 0 && timedRuns(a.out.stdout) === 1, `(a) no --auth, no auth.json: the run is timed (exit ${a.out.code}, timed ${timedRuns(a.out.stdout)})`, a.out);
  check(a.out.stdout.split("\n").includes(NO_SESSION), `(a) prints "${NO_SESSION}"`, a.out);
  check(a.requests.length > 0 && a.requests.every((r) => r.cookie === null), `(a) no request carried a cookie (${a.requests.length} requests)`, a.out);

  // (b) No --auth, but an auth.json sits in the current directory: it isn't loaded.
  const b = await watching(() => caliper(withFile, run));
  check(b.out.code === 0 && timedRuns(b.out.stdout) === 1, `(b) no --auth, auth.json present: the run is timed (exit ${b.out.code})`, b.out);
  check(b.out.stdout.split("\n").includes(NO_SESSION), `(b) prints "${NO_SESSION}"`, b.out);
  check(b.requests.length > 0 && b.requests.every((r) => r.cookie === null),
    `(b) the auth.json in the current directory isn't loaded: no request carried a cookie (got: ${[...new Set(b.requests.map((r) => r.cookie))].join(", ")})`, b.out);

  // (c) --auth auth.json, relative: loaded as before.
  const c = await watching(() => caliper(withFile, [...run, "--auth", "auth.json"]));
  check(c.out.code === 0 && timedRuns(c.out.stdout) === 1, `(c) --auth auth.json: the run is timed (exit ${c.out.code})`, c.out);
  const pageLoads = c.requests.filter((r) => r.method === "GET" && r.path === "/stream-nostore");
  check(pageLoads.length > 0 && c.requests.every((r) => r.cookie === "caliper_session=s3cret"),
    `(c) the session's cookie reached every request (got: ${[...new Set(c.requests.map((r) => r.cookie))].join(", ")})`, c.out);
  check(!c.out.stdout.includes(NO_SESSION), `(c) no "${NO_SESSION}" line`, c.out);

  // (d) --auth naming a missing file: the error from before, before any run.
  const d = await watching(() => caliper(empty, [...run, "--auth", "missing.json"]));
  const want = `No saved session at ${join(empty, "missing.json")}.\nRun: caliper login <url> --auth missing.json`;
  check(d.out.code !== 0 && d.out.stderr.includes(want) && timedRuns(d.out.stdout) === 0 && d.requests.length === 0,
    `(d) --auth missing.json: "No saved session" error, no run, no request (exit ${d.out.code}, requests ${d.requests.length})`, d.out);
} finally {
  await server.close();
  rmSync(empty, { recursive: true, force: true });
  rmSync(withFile, { recursive: true, force: true });
}

if (logs.length) console.log(logs.join("\n").replace(/^/gm, "     | "));
process.exitCode = failures.length ? 1 : 0;

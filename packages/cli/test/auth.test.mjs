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
// A --measure or --step button that never appears keeps its error and adds things to check,
// only from what Caliper can see:
//   (e) no --auth: the buttons it saw (the first 15 visible names, trimmed, deduped), what
//       didn't match, and that no saved login was used;
//   (f) --auth whose cookie for this site expired: the login line with the file and date;
//   (g) --auth with a valid cookie: nothing about login;
//   (h) the same for a --step button.
// The HTML report is on by default:
//   (i) no --report: caliper-report.html in the current directory, last line "report: wrote
//       <path>"; a second run "report: overwrote <path>";
//   (j) --no-report: no file, no report line; (k) --report <path>: written there;
//   (l) every run fails to load: "no report written: every run failed to load", no file;
//   (m) --report with --no-report: an error before any run;
//   (n) an audit stopped by an error: "no report written: the audit stopped on the error below";
//   (o) the same for stops before any run (a flag check, a missing --auth file, a bad --stop
//       regex), and nothing with --no-report.
// Run with `npm run test:auth` (builds first).

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
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
const buttons = `${server.url}/buttons`;
const noButton = (extra) => [buttons, "--measure", "^nosuch$", "--output", "#out", "--runs", "1", "--timeout", "3000", ...extra];
const SEEN = `Buttons I saw: ${["Spaced out", ...Array.from({ length: 14 }, (_, i) => `Option ${i + 1}`)].map((n) => JSON.stringify(n)).join(", ")} (and 6 more). None matched /^nosuch$/i.`;
const NO_LOGIN = "No saved login was used. If this button only shows when logged in, run caliper login first and pass --auth.";
const cookieState = (expires) => ({ cookies: [{ ...SESSION.cookies[0], expires }], origins: [] });
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

  // (e) --measure button never appears, no --auth.
  const e = await caliper(empty, noButton([]));
  const eLines = e.stderr.split("\n");
  check(e.code !== 0 && eLines[0] === "error: No button matching /^nosuch$/i (--measure) appeared within 3000 ms.",
    "(e) keeps the error", e);
  check(eLines.includes("Things to check:") && eLines.includes(`  - ${SEEN}`), `(e) lists the first 15 buttons it saw, trimmed and deduped (want: ${SEEN})`, e);
  check(!e.stderr.includes("Hidden"), "(e) a hidden button isn't listed", e);
  check(eLines.includes(`  - ${NO_LOGIN}`), "(e) no --auth: says no saved login was used", e);

  // (f) --auth with this site's cookie expired.
  writeFileSync(join(empty, "old.json"), JSON.stringify(cookieState(Date.UTC(2026, 9, 30) / 1000)));
  const f = await caliper(empty, noButton(["--auth", "old.json"]));
  const login = `  - Your saved login (old.json) has cookies that expired on 2026-10-30 — run: caliper login ${buttons} --auth old.json`;
  check(f.code !== 0 && f.stderr.split("\n").includes(login), `(f) expired cookie: the login line (want: ${login.trim()})`, f);
  check(!f.stderr.includes("No saved login was used"), "(f) no 'no saved login' line with --auth", f);

  // (g) --auth with a valid cookie: nothing about login.
  writeFileSync(join(empty, "fresh.json"), JSON.stringify(cookieState(Date.now() / 1000 + 86_400)));
  const g = await caliper(empty, noButton(["--auth", "fresh.json"]));
  check(g.code !== 0 && g.stderr.split("\n").includes(`  - ${SEEN}`) && !/login/i.test(g.stderr), "(g) valid cookie: the buttons line, nothing about login", g);

  // (h) A --step button that never appears gets the same things to check.
  const h = await caliper(empty, [buttons, "--step", "^nostep$", "--measure", "^nosuch$", "--output", "#out", "--runs", "1", "--timeout", "3000"]);
  const hSeen = SEEN.replace("/^nosuch$/i", "/^nostep$/i");
  check(h.code !== 0 && h.stderr.includes("No button matching /^nostep$/i (--step) appeared within 3000 ms.") && h.stderr.split("\n").includes(`  - ${hSeen}`) && h.stderr.includes(NO_LOGIN),
    "(h) --step: same things to check", h);

  // (i) The report is on by default, in the current directory.
  const reports = realpathSync(mkdtempSync(join(tmpdir(), "caliper-auth-report-")));
  const lastLine = (out) => out.stdout.trimEnd().split("\n").at(-1);
  const file = join(reports, "caliper-report.html");
  const i1 = await caliper(reports, run);
  check(i1.code === 0 && existsSync(file) && lastLine(i1) === `report: wrote ${file}`, `(i) no --report: writes ${file}, last line "report: wrote …" (got: ${lastLine(i1)})`, i1);
  const i2 = await caliper(reports, run);
  check(i2.code === 0 && lastLine(i2) === `report: overwrote ${file}`, `(i) again: "report: overwrote …" (got: ${lastLine(i2)})`, i2);
  // (j) --no-report: nothing written, no report line.
  rmSync(file, { force: true });
  const j = await caliper(reports, [...run, "--no-report"]);
  check(j.code === 0 && !existsSync(file) && !/^report:|no report written/m.test(j.stdout), "(j) --no-report: no file, no report line", j);
  // (k) --report <path>.
  const k = await caliper(reports, [...run, "--report", "custom.html"]);
  check(k.code === 0 && existsSync(join(reports, "custom.html")) && lastLine(k) === `report: wrote ${join(reports, "custom.html")}` && !existsSync(file),
    `(k) --report custom.html: written there (got: ${lastLine(k)})`, k);
  // (l) Every run fails to load: says why there's no report.
  const l = await caliper(reports, ["http://127.0.0.1:1/x", "--measure", "^generate$", "--output", "#out", "--runs", "1", "--timeout", "5000"]);
  check(l.code === 0 && lastLine(l) === "no report written: every run failed to load" && !existsSync(file), `(l) every run failed: "no report written: every run failed to load" (got: ${lastLine(l)})`, l);
  // (m) Both flags: an error.
  const m = await caliper(reports, [...run, "--report", "x.html", "--no-report"]);
  check(m.code !== 0 && m.stderr.includes("audit: pass --report <path> or --no-report, not both.") && timedRuns(m.stdout) === 0, "(m) --report with --no-report is an error before any run", m);
  // (n) Stopped by an error.
  const n = await caliper(reports, noButton([]));
  check(n.code !== 0 && lastLine(n) === "no report written: the audit stopped on the error below" && !existsSync(file), `(n) stopped by an error: says no report was written (got: ${lastLine(n)})`, n);
  // (o) Stops before any run (a flag check, a missing --auth file, a bad --stop regex) end the
  // same way; with --no-report, none of them prints it.
  const early = [
    ["--input without --prompt", [...run, "--input", "#msg"], "audit: --input needs --prompt <text>."],
    ["missing --auth file", [...run, "--auth", "nosuch.json"], `No saved session at ${join(reports, "nosuch.json")}.`],
    ["bad --stop regex", [...run, "--stop", "("], `--stop "(" is not a valid regular expression`],
  ];
  for (const [what, args, error] of early) {
    const o = await caliper(reports, args);
    check(o.code === 1 && o.stderr.includes(error) && lastLine(o) === "no report written: the audit stopped on the error below" && timedRuns(o.stdout) === 0 && !existsSync(file),
      `(o) ${what}: its error, and "no report written: the audit stopped on the error below" (got: ${lastLine(o) ?? "nothing"})`, o);
    const quiet = await caliper(reports, [...args, "--no-report"]);
    check(quiet.code === 1 && quiet.stderr.includes(error) && !/no report written/.test(quiet.stdout), `(o) ${what} with --no-report: its error, no report line`, quiet);
  }
  // A command line that can't be parsed: the usage, and no report line (--no-report can't be read).
  const unparsed = await caliper(reports, [...run, "--nosuch"]);
  check(unparsed.code === 1 && unparsed.stderr.includes("Usage:") && !/no report written/.test(unparsed.stdout), "(o) an unknown flag: the usage, no report line", unparsed);
  rmSync(reports, { recursive: true, force: true });
} finally {
  await server.close();
  rmSync(empty, { recursive: true, force: true });
  rmSync(withFile, { recursive: true, force: true });
}

if (logs.length) console.log(logs.join("\n").replace(/^/gm, "     | "));
process.exitCode = failures.length ? 1 : 0;

// The marked visit (server timings, step 1): with --server-timings <origin> and CALIPER_TOKEN
// set, after the unmarked runs Caliper builds a match key from the AI request each run picked
// (method + origin + path, query dropped, path segments that differ between runs as a
// one-segment wildcard) and, only if the key's origin is exactly the named one, loads the page
// once more, stamping x-caliper-run + x-caliper-token on the first request after the click that
// matches the key. The fixture server records which requests carried the headers. Fails unless:
//   (a) a query-only change keeps the key exact and the reply is stamped;
//   (b) one changing path segment becomes a wildcard and the reply is stamped (also in chat
//       mode, and with --request picking the request);
//   (c) runs that disagree on segment count skip the marked visit, naming both paths;
//   (d) a second match during the marked visit makes it invalid, naming both URLs;
//   (e) no match during the marked visit is reported, naming the key;
//   (f) font, analytics and page-load requests are never stamped, and the page-load request to
//       the reply's endpoint doesn't count as a match;
//   (g) a stamped request that isn't the marked visit's AI request is reported, naming both;
//   (h) CALIPER_TOKEN without --server-timings: no marked visit, nothing stamped or printed;
//   (i) --server-timings naming another origin: nothing stamped, naming both origins;
//   (j) look-alike origins (a subdomain, a host prefix, a port prefix) are never a match;
// with --runs 1 the line says the key came from one run; a --server-timings that isn't an
// origin, or one without CALIPER_TOKEN, is an error before any run. In every case the unmarked
// runs are never stamped, and the token is never printed.
// Step 2, against the fixture server's fake wrapper (it checks in the same order as Quill's):
// before the marked visit a token pre-check asks for a malformed id, so it can never reach a
// record: 400 goes ahead, 401 / 404 / anything else skip the visit with the reason. Either way
// one "pre-check:" line says what it got (400: "feature on, token accepted"). After a
// stamped run Caliper fetches the record and prints each recorded mark in the order they
// happened, a span per <name>Start / <name>End pair when both are there in that order (else a
// line saying why: case s), "model call → first bytes sent", and the Workers note only when the
// record says runtime "workers"; Quill's postgresStart/postgresEnd show as "postgres";
// nothing that wasn't recorded (partial record),
// and "?" for a missing record. The user-timing summary never includes these numbers.
// Several marked visits (--server-runs <n>, default 3, 1–10): before any run one line says how
// many times the audit triggers the AI feature; the pre-check runs once, then n visits, each
// with a fresh run id and the same key and rules. A failed visit prints its own "?" line and is
// left out; the block shows each visit's values, then min · median · max over the visits that
// recorded them (just the value with one visit), spans computed inside each visit first. With
// no visit succeeding: "0 of n marked visits succeeded". Fails unless (m) n = 3 by default, all
// succeed, the numbers and the summary match the records, and the median span isn't the
// difference of the medians; (q) one visit's record lacks a mark: "–"; (v) one of three fails: its "?" line, k = 2; (e3) all fail;
// (m1) n = 1: no median; out-of-range n is an error before any run.
// Failed page loads: the key comes from the runs that loaded, and the lines say which ones
// (with the one-run note too when only one loaded); with none loaded, nothing changes. Every
// "page failed to load" line is followed by things to check for that error type (Playwright's
// timeout, ERR_CONNECTION_REFUSED), then "Rerun to try again." — only that for any other type.
// The same lines follow a marked visit's "?" line when its own page fails to load.
// The HTML report (--report): the same block, with the pre-check and visit lines, in its own
// section only with --server-timings (h: none without it); (m) every row has the terminal's
// numbers and the browser tiles stay the timed runs' own; (e3) no visit succeeded: the lines,
// no table.
// Run with `npm run test:marked` (builds first).

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GENERIC_PROBLEM, startFixtureServer } from "./fixtures/server.mjs";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));
const TOKEN = `caliper-test-${randomBytes(8).toString("hex")}`;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ONE_RUN = " (key from 1 run — changing path parts can't be detected)";
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/; // the fake wrapper's (and Quill's) valid run ids
// SPEC v1: modelCallSent and firstChunk are reserved and labelled; every other mark is shown
// under its own name, and each <name>Start / <name>End pair is a span called <name>.
const RESERVED = { modelCallSent: "model call sent", firstChunk: "server: first bytes sent" };
const MODEL_SPAN = "model call → first bytes sent";
const markLabel = (name) => RESERVED[name] ?? name;
const PAIR = /^([A-Za-z][A-Za-z0-9_]*)(Start|End)$/;
const PRECHECK_LINE = /^Server timings (\? )?— pre-check: /;
const PRECHECK_OK = "Server timings — pre-check: feature on, token accepted (400 on caliper.precheck)";
const NOTE = "    Workers time waits only — a span with only computation inside (no I/O) can read 0 ms.";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const timedRuns = (stdout) => (stdout.match(/^run \d.*\s\d+ ms$/gm) ?? []).length;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
};

// The span names in these records: every <name> with a <name>Start or <name>End mark.
const spanNames = (records) => [...new Set(records.flatMap((r) => Object.keys(r.marks).map((k) => PAIR.exec(k)?.[1]).filter(Boolean)))];
// One record's <name> span, or why there isn't one (the CLI's wording).
function spanOf(record, name) {
  const [s, e] = [record.marks[`${name}Start`], record.marks[`${name}End`]];
  if (s === undefined) return { why: `${name}Start wasn't recorded` };
  if (e === undefined) return { why: `${name}End wasn't recorded` };
  if (e < s) return { why: `${name}End (${e} ms) is before ${name}Start (${s} ms)` };
  return { value: e - s };
}

// Runs the CLI; never throws. Returns { code, stdout, stderr }.
async function caliper(url, args, env) {
  const all = [cli, "audit", url, "--measure", "^generate$", "--output", "#out", "--settle-ms", "500", "--timeout", "15000", "--auth", auth, ...args];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, all, { timeout: 120_000, env: { ...process.env, CALIPER_TOKEN: "", ...env } });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}

const server = await startFixtureServer(0, { caliperToken: TOKEN });
const noSecret = await startFixtureServer(); // wrapper off: /__caliper 404s
const otherSecret = await startFixtureServer(0, { caliperToken: "a-rotated-token" });
const broken = await startFixtureServer(0, { caliperToken: TOKEN, caliperStatus: 500 });
const origin = server.url; // http://127.0.0.1:<port>
const port = new URL(origin).port;
const failures = [];
const logs = [];
const check = (ok, what, out) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) {
    failures.push(what);
    if (out) logs.push(`--- ${what} ---\n${out.stdout}${out.stderr}`);
  }
};

// --report into a temp dir, one file per case; the report's server section, or null without one.
const reportDir = mkdtempSync(join(tmpdir(), "caliper-marked-"));
const reportArgs = (name) => ["--report", join(reportDir, `${name}.html`)];
const readReport = (name) => {
  try {
    return readFileSync(join(reportDir, `${name}.html`), "utf8");
  } catch {
    return null;
  }
};
const SERVER_SECTION = '<section aria-labelledby="server-h">';
const serverPart = (html) => {
  const at = html?.indexOf(SERVER_SECTION) ?? -1;
  return at === -1 ? null : html.slice(at, html.indexOf("</section>", at));
};
// The server section's table rows: label (without its note) → cell texts.
function htmlRows(html) {
  const rows = new Map();
  for (const [, head, body] of html.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/gs)) {
    rows.set(head.replace(/<span.*$/s, ""), [...body.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => m[1]));
  }
  return rows;
}

// One case: run Caliper on /marked?case=…, then check what's common to every case. By default
// with the token and --server-timings naming the page's own origin.
// serverRuns: --server-runs to pass (null: leave it out, so the default applies).
// fail / hang: load numbers whose page load is dropped / never answered. Up to --runs they're
// timed runs; after that, marked visits.
async function runCase(label, kase, { srv = server, runs = 2, serverRuns = 1, host = srv.url, named = host, env = { CALIPER_TOKEN: TOKEN }, args = [], fail = [], hang = [] } = {}) {
  const id = `${kase}-${randomBytes(4).toString("hex")}`;
  const visits = named && serverRuns !== null ? ["--server-runs", String(serverRuns)] : [];
  const flags = ["--runs", String(runs), ...(named ? ["--server-timings", named, ...visits] : []), ...args];
  const [asked, lookups] = [srv.caliper.asked.length, srv.caliper.lookups];
  const broke = [...fail, ...hang].filter((load) => load <= runs).sort((x, y) => x - y);
  const loadArgs = `${fail.length ? `&fail=${fail.join(",")}` : ""}${hang.length ? `&hang=${hang.join(",")}` : ""}`;
  const out = await caliper(`${host}/marked?case=${kase}&id=${id}&runs=${runs}${loadArgs}`, flags, env);
  const { loads, requests } = srv.marked(id);
  const stamped = requests.filter((r) => r.run !== null || r.token !== null);
  const timed = runs - broke.length;
  check(out.code === 0 && timedRuns(out.stdout) === timed, `(${label}) ${timed} of the ${runs} unmarked run(s) are timed (got ${timedRuns(out.stdout)})`, out);
  check(!requests.some((r) => r.load <= runs && (r.run !== null || r.token !== null)), `(${label}) no request in the unmarked runs is stamped`, out);
  check(!`${out.stdout}${out.stderr}`.includes(TOKEN), `(${label}) the token is never printed`, out);
  const all = out.stdout.match(/^Server timings.*$/gm) ?? [];
  const precheck = all.filter((l) => PRECHECK_LINE.test(l)); // the pre-check's own line(s)
  const lines = all.filter((l) => !PRECHECK_LINE.test(l));
  // What the sent and "?" lines end with: which runs the key came from.
  const keyNote = [
    broke.length ? ` (key from ${timed} of ${runs} runs; ${broke.length === 1 ? "run" : "runs"} ${broke.join(", ")} failed to load)` : "",
    timed === 1 ? ONE_RUN : "",
  ].join("");
  return {
    label, runs, host, out, loads, requests, stamped, lines, line: lines[0] ?? null, precheck, keyNote,
    asked: srv.caliper.asked.slice(asked), // ids the wrapper was asked for during this case
    lookups: srv.caliper.lookups - lookups, // store lookups during this case
  };
}

// The pre-check asked first, for an id the wrapper rejects before any store lookup.
function checkPrecheck({ label, out, asked }) {
  check(asked.length > 0 && !RUN_ID.test(asked[0]), `(${label}) the token pre-check asks for a malformed id (asked: ${asked.join(", ") || "nothing"})`, out);
}

// The pre-check printed exactly one line: `want` (default: it got 400 and went ahead).
function checkPrecheckLine({ label, out, precheck }, want = PRECHECK_OK) {
  check(precheck.length === 1 && precheck[0] === want, `(${label}) prints the pre-check result once: ${want} (got: ${precheck.join(" | ") || "nothing"})`, out);
}

// The "Inside the server" block: the record's marks, as recorded, and only those.
function checkBlock({ label, out }, record) {
  const text = out.stdout;
  const header = `Inside the server (from 1 of 1 marked run) — ms after the request arrived, status ${record.status}`;
  check(text.split("\n").includes(header), `(${label}) prints the block header (want: ${header})`, out);
  const lines = text.split("\n");
  const at = (re) => lines.findIndex((l) => re.test(l));
  // Every recorded mark, as recorded, in the order the marks happened (record order on ties).
  const order = Object.entries(record.marks).sort(([, a], [, b]) => a - b);
  for (const [name, v] of order) {
    const line = new RegExp(`^    ${esc(markLabel(name))}\\s+(\\d+) ms$`, "m").exec(text);
    check(!!line && Number(line[1]) === v, `(${label}) "${markLabel(name)}" is the recorded ${v} ms (got ${line?.[1] ?? "nothing"})`, out);
  }
  const rows = order.map(([name]) => at(new RegExp(`^    ${esc(markLabel(name))}\\s+\\d+ ms`)));
  check(rows.every((r, i) => r !== -1 && (i === 0 || r > rows[i - 1])), `(${label}) marks are printed in the order they happened (${order.map(([n]) => n).join(", ")})`, out);
  for (const [name, wording] of Object.entries(RESERVED)) {
    if (record.marks[name] === undefined) check(at(new RegExp(`^    ${esc(wording)}\\s`)) === -1, `(${label}) no "${wording}" line: ${name} wasn't recorded`, out);
  }
  // Each <name>Start / <name>End pair: a span row, or a line saying why there's none.
  for (const name of spanNames([record])) {
    const got = spanOf(record, name);
    const row = new RegExp(`^    ${esc(name)}\\s+(\\d+) ms   \\(${name}Start → ${name}End\\)$`, "m").exec(text);
    const why = `    no ${name} span: ${got.why}`;
    if (got.value !== undefined) check(!!row && Number(row[1]) === got.value, `(${label}) span "${name}" is ${name}End − ${name}Start = ${got.value} ms (got ${row?.[1] ?? "nothing"})`, out);
    else check(!row && lines.includes(why), `(${label}) no "${name}" span, and the block says why (want: ${why.trim()})`, out);
  }
  const m = record.marks;
  const model = new RegExp(`^    ${MODEL_SPAN}\\s+(\\d+) ms$`, "m").exec(text);
  if (m.modelCallSent === undefined || m.firstChunk === undefined) check(!model, `(${label}) no "${MODEL_SPAN}": ${m.modelCallSent === undefined ? "modelCallSent" : "firstChunk"} wasn't recorded`, out);
  else check(!!model && Number(model[1]) === m.firstChunk - m.modelCallSent, `(${label}) "${MODEL_SPAN}" is firstChunk − modelCallSent = ${m.firstChunk - m.modelCallSent} ms (got ${model?.[1] ?? "nothing"})`, out);
  check(!/^    \S.*(done|end) → model/m.test(text), `(${label}) no span for the computation between the query and the model call`, out);
  if (record.runtime === "workers") check(text.split("\n").includes(NOTE), `(${label}) the Workers note is under the block (runtime "workers")`, out);
  else check(!text.includes(NOTE.trim()), `(${label}) no Workers note: the record's runtime is ${JSON.stringify(record.runtime ?? null)}`, out);
}

// The marked visit stamped exactly one request: the reply, with a fresh run id and the token,
// and the page's own headers left as they were. The printed line names that run id.
function checkStamped(c, url, key) {
  const { label, runs, host, out, loads, stamped, line, lookups, keyNote } = c;
  checkPrecheck(c);
  checkPrecheckLine(c);
  check(loads === runs + 1, `(${label}) one marked visit after the runs (page loads: ${loads})`, out);
  check(stamped.length === 1, `(${label}) exactly one request stamped (got ${stamped.length})`, out);
  const s = stamped[0];
  check(!!s && s.load === runs + 1 && s.method === "POST" && url.test(s.url) && !/kind=ping/.test(s.url),
    `(${label}) the stamped request is the marked visit's reply (got ${s ? `${s.method} ${s.url}` : "none"})`, out);
  check(!!s && s.token === TOKEN && new RegExp(`^${UUID}$`).test(s.run ?? ""), `(${label}) it carries x-caliper-token and a fresh x-caliper-run id`, out);
  check(!!s && s.contentType === "application/json", `(${label}) its own content-type header is untouched (got ${s?.contentType})`, out);
  const suffix = esc(keyNote);
  const want = new RegExp(`^Server timings — marked visit 1 of 1 sent x-caliper-run (${UUID}) on POST ${esc(host)}\\S+ \\(matched ${esc(key)}\\)${suffix}$`);
  const m = line?.match(want);
  check(!!m && m[1] === s?.run, `(${label}) prints the stamped request, its key and run id (got: ${line ?? "nothing"})`, out);
  check(lookups === 1, `(${label}) the record is looked up once, for the run id (lookups: ${lookups})`, out);
  const record = server.caliper.records.get(s?.run);
  check(!!record, `(${label}) the fake wrapper recorded the stamped request`, out);
  if (record) checkBlock(c, record);
}

// No marked visit at all: the page loaded only for the runs, and nothing was stamped.
function checkNoVisit({ label, runs, out, loads, stamped, lookups, asked, precheck }) {
  if (asked.length === 0) check(precheck.length === 0, `(${label}) no pre-check, so no pre-check line (got: ${precheck.join(" | ")})`, out);
  check(loads === runs, `(${label}) no marked visit (page loads: ${loads})`, out);
  check(stamped.length === 0, `(${label}) nothing stamped (got ${stamped.length})`, out);
  check(lookups === 0 && !/^Inside the server/m.test(out.stdout), `(${label}) no record fetched or printed (lookups: ${lookups})`, out);
}

// A row of the several-visits block: each visit's value (– where it wasn't recorded), then
// min · median · max, or just the values with fewer than two.
function statsRow(text, wording) {
  const m = new RegExp(`^    ${esc(wording)} +((?:\\d+|–)(?: +(?:\\d+|–))*)(?:   min (\\d+) · median (\\d+) · max (\\d+))? ms(?:   \\(.*\\))?$`, "m").exec(text);
  if (!m) return null;
  const values = m[1].trim().split(/ +/).map((x) => (x === "–" ? null : Number(x)));
  return { values, stats: m[2] === undefined ? null : { min: Number(m[2]), median: Number(m[3]), max: Number(m[4]) }, median: m[3] === undefined ? null : Number(m[3]) };
}

// n marked visits, of which `ok` (visit numbers) succeeded and the rest matched nothing: the
// count line before any run, one pre-check, a fresh run id per stamped visit, and a block whose
// values are each successful visit's record, summarised per mark and per span.
function checkVisits(c, n, ok) {
  const { label, runs, out, loads, stamped, asked, lookups, lines } = c;
  const text = out.stdout;
  const k = ok.length;
  const count = `This audit triggers the AI feature up to ${runs + n} times for timing (${runs} timed + ${n} marked).`;
  const at = text.split("\n").indexOf(count);
  check(at !== -1 && at < text.indexOf("run 1"), `(${label}) prints "${count}" before any run`, out);
  checkPrecheck(c);
  checkPrecheckLine(c);
  check(asked.filter((id) => !RUN_ID.test(id)).length === 1, `(${label}) the token pre-check runs once (asked: ${asked.join(", ")})`, out);
  check(loads === runs + n, `(${label}) ${n} marked visit(s) after the runs (page loads: ${loads})`, out);
  check(stamped.length === k && stamped.every((s) => s.token === TOKEN && new RegExp(`^${UUID}$`).test(s.run ?? "")) && new Set(stamped.map((s) => s.run)).size === k,
    `(${label}) ${k} request(s) stamped, each with the token and its own run id (got ${stamped.map((s) => s.run).join(", ")})`, out);
  check(stamped.every((s) => s.load > runs && /^\/marked\/reply\?/.test(s.url)), `(${label}) only marked visits' replies are stamped`, out);
  check(lookups === k, `(${label}) one record lookup per successful visit (lookups: ${lookups})`, out);
  ok.forEach((visit, j) => {
    const sent = new RegExp(`^Server timings — marked visit ${visit} of ${n} sent x-caliper-run (${UUID}) on POST `);
    const line = lines.find((l) => sent.test(l));
    check(line?.match(sent)?.[1] === stamped[j]?.run, `(${label}) visit ${visit} prints its run id (got: ${line ?? "nothing"})`, out);
  });

  const records = stamped.map((s) => server.caliper.records.get(s.run));
  check(records.every(Boolean), `(${label}) the fake wrapper recorded every stamped request`, out);
  if (!records.every(Boolean)) return;
  const header = `Inside the server (from ${k} of ${plural(n, "marked run")}) — ms after the request arrived, status 200`;
  check(text.split("\n").includes(header), `(${label}) prints the block header (want: ${header})`, out);
  const columns = new RegExp(`^    marked visit +${ok.join(" +")}$`, "m");
  check(k === 1 ? !/^    marked visit/m.test(text) : columns.test(text), `(${label}) ${k === 1 ? "no visit column row" : `columns are visits ${ok.join(", ")}`}`, out);

  const checkRow = (wording, values) => {
    const row = statsRow(text, wording);
    const want = values.filter((x) => x !== null);
    check(!!row && JSON.stringify(row.values) === JSON.stringify(values), `(${label}) "${wording}" per visit is ${values.join(", ")} (got ${row?.values.join(", ") ?? "nothing"})`, out);
    if (want.length < 2) check(!!row && row.stats === null, `(${label}) "${wording}" has no min · median · max with ${want.length} value`, out);
    else {
      const stats = { min: Math.min(...want), median: median(want), max: Math.max(...want) };
      check(JSON.stringify(row?.stats) === JSON.stringify(stats), `(${label}) "${wording}" is min ${stats.min} · median ${stats.median} · max ${stats.max} (got ${JSON.stringify(row?.stats ?? null)})`, out);
    }
  };
  for (const name of new Set(records.flatMap((r) => Object.keys(r.marks)))) checkRow(markLabel(name), records.map((r) => r.marks[name] ?? null));
  for (const name of spanNames(records)) {
    const values = records.map((r) => spanOf(r, name).value ?? null);
    if (values.some((x) => x !== null)) checkRow(name, values);
    else check(!statsRow(text, name), `(${label}) no "${name}" span row: no visit has both marks in order`, out);
  }
  const model = (r) => (r.marks.modelCallSent === undefined || r.marks.firstChunk === undefined ? null : r.marks.firstChunk - r.marks.modelCallSent);
  checkRow(MODEL_SPAN, records.map(model));
  if (k === 1) check(!/median/.test(text.slice(text.indexOf("Inside the server"))), `(${label}) the word "median" isn't in the block with 1 visit`, out);
}

// The lines under "run <i> — page failed to load": the error, then what to check.
function failedRunLines(stdout, run) {
  const lines = stdout.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^run ${run}( \\(cold\\))? — page failed to load$`).test(l));
  if (at === -1) return null;
  const end = lines.findIndex((l, i) => i > at && !l.startsWith("    "));
  return lines.slice(at + 1, end === -1 ? undefined : end);
}

// The indented lines right after the first stdout line matching `re`.
function linesAfter(stdout, re) {
  const lines = stdout.split("\n");
  const at = lines.findIndex((l) => re.test(l));
  if (at === -1) return null;
  const end = lines.findIndex((l, i) => i > at && !l.startsWith("    "));
  return [lines[at], ...lines.slice(at + 1, end === -1 ? undefined : end)];
}

// A dropped connection (net::ERR_EMPTY_RESPONSE) has no candidates: just the rerun line.
function checkDropped({ label, out }, run) {
  const got = failedRunLines(out.stdout, run);
  check(!!got && got.length === 2 && /^    page\.goto: net::ERR_EMPTY_RESPONSE at /.test(got[0]) && got[1] === "    Rerun to try again.",
    `(${label}) run ${run}: the error, then only "Rerun to try again." (got: ${got?.join(" | ") ?? "no failed-load line"})`, out);
}

try {
  // (a) Only the query string changes between runs: the key stays exact.
  const a = await runCase("a", "a");
  checkStamped(a, /^\/marked\/reply\?/, `POST ${origin}/marked/reply`);

  // (b) One path segment changes between runs: it becomes a wildcard.
  const b = await runCase("b", "b");
  checkStamped(b, /^\/marked\/s\/[a-z0-9]+\/reply\?/, `POST ${origin}/marked/s/*/reply`);
  const chat = await runCase("b, chat mode", "b", { args: ["--input", "#msg", "--prompt", "hello"] });
  checkStamped(chat, /^\/marked\/s\/[a-z0-9]+\/reply\?/, `POST ${origin}/marked/s/*/reply`);
  const byRegex = await runCase("b, --request", "b", { args: ["--request", "/marked/s/"] });
  checkStamped(byRegex, /^\/marked\/s\/[a-z0-9]+\/reply\?/, `POST ${origin}/marked/s/*/reply`);

  // (c) The runs' AI requests have different segment counts: no marked visit.
  const c = await runCase("c", "c");
  checkNoVisit(c);
  check(c.line === `Server timings ? — runs disagree on the number of path segments: run 1 POST ${origin}/marked/a/reply, run 2 POST ${origin}/marked/a/b/reply`,
    `(c) reports the skip with both paths (got: ${c.line ?? "nothing"})`, c.out);

  // (d) Two requests match the key during the marked visit: invalid, naming both.
  const d = await runCase("d", "d");
  check(d.loads === 3, `(d) one marked visit after the runs (page loads: ${d.loads})`, d.out);
  const reply = `${origin}/marked/reply`;
  const two = new RegExp(`^Server timings \\? — marked visit 1 of 1: 2 requests matched POST ${esc(reply)}: ${esc(reply)}\\?\\S*kind=ping\\S*, ${esc(reply)}\\?(?!\\S*kind=ping)\\S+$`);
  check(two.test(d.line ?? ""), `(d) reports 2 matches with both URLs (got: ${d.line ?? "nothing"})`, d.out);

  // (e) No request matches the key during the marked visit.
  const e = await runCase("e", "e");
  check(e.loads === 3, `(e) one marked visit after the runs (page loads: ${e.loads})`, e.out);
  check(e.stamped.length === 0, `(e) nothing stamped (got ${e.stamped.length})`, e.out);
  check(e.line === `Server timings ? — marked visit 1 of 1: no request matched POST ${origin}/marked/reply`, `(e) reports no match, naming the key (got: ${e.line ?? "nothing"})`, e.out);

  // (f) Font, analytics and a page-load request to the same endpoint are left alone.
  const f = await runCase("f", "f");
  checkStamped(f, /^\/marked\/reply\?/, `POST ${origin}/marked/reply`);
  const marked = f.requests.filter((r) => r.load === 3);
  for (const [what, test] of [["font", (r) => r.url.startsWith("/marked/font.woff2")], ["analytics", (r) => r.url.startsWith("/marked/analytics")],
    ["page-load request", (r) => /at=load/.test(r.url)]]) {
    const seen = marked.filter(test);
    check(seen.length > 0 && seen.every((r) => r.run === null && r.token === null), `(f) the marked visit's ${what} is sent unstamped (seen ${seen.length})`, f.out);
  }

  // (g) The one stamped request isn't what the marked visit's output came from.
  const g = await runCase("g", "g");
  check(g.loads === 3 && g.stamped.length === 1 && /kind=ping/.test(g.stamped[0]?.url ?? ""),
    `(g) the marked visit stamped its ping (loads ${g.loads}, stamped: ${g.stamped.map((r) => r.url).join(", ") || "none"})`, g.out);
  const notPicked = new RegExp(`^Server timings \\? — marked visit 1 of 1: its AI request was POST ${esc(origin)}/marked/other/reply\\?\\S+, not the stamped POST ${esc(reply)}\\?\\S*kind=ping\\S*$`);
  check(notPicked.test(g.line ?? ""), `(g) reports the AI request isn't the stamped one, naming both (got: ${g.line ?? "nothing"})`, g.out);

  // (h) The token without --server-timings: nothing happens.
  const h = await runCase("h", "a", { named: null, args: reportArgs("h") });
  checkNoVisit(h);
  const hHtml = readReport("h");
  check(!!hHtml && serverPart(hHtml) === null && !hHtml.includes("Inside the server"), "(h) the HTML report has no server section without --server-timings", h.out);
  check(h.line === null, `(h) nothing printed about server timings (got: ${h.line ?? "nothing"})`, h.out);

  // (i) --server-timings names another origin: the token isn't sent.
  const other = `http://localhost:${port}`;
  const i = await runCase("i", "a", { named: other });
  checkNoVisit(i);
  check(i.line === `Server timings ? — AI request goes to ${origin}, not ${other}; token not sent.`, `(i) names both origins (got: ${i.line ?? "nothing"})`, i.out);

  // (j) Look-alikes: the named host as a parent domain, as a prefix of the real host, and the
  // named port as a prefix of the real port.
  for (const [what, host, named] of [
    ["subdomain of the named host", `http://evil.localhost:${port}`, `http://localhost:${port}`],
    ["named host is a prefix", `http://api.localhost.localhost:${port}`, `http://api.localhost:${port}`],
    ["named port is a prefix", origin, `http://127.0.0.1:${port.slice(0, -1)}`],
  ]) {
    const j = await runCase(`j, ${what}`, "a", { host, named });
    checkNoVisit(j);
    check(j.line === `Server timings ? — AI request goes to ${host}, not ${named}; token not sent.`, `(j, ${what}) names both origins (got: ${j.line ?? "nothing"})`, j.out);
  }

  // The user-timing summary is the 2 timed runs only: cold is run 1, median is run 2.
  const runMs = [...a.out.stdout.matchAll(/^run \d.*?\s(\d+) ms$/gm)].map((r) => Number(r[1]));
  const summary = a.out.stdout.match(/^cold (\d+) ms · median (\d+) ms/m);
  check(!!summary && Number(summary[1]) === runMs[0] && Number(summary[2]) === runMs[1],
    `(a) the summary is the timed runs only (runs ${runMs.join(", ")}; got: ${summary?.[0] ?? "nothing"})`, a.out);

  // Server-side failures after the stamp: no fetch for a visit that wasn't valid.
  for (const [label, c] of [["d", d], ["e", e], ["g", g]]) {
    check(c.lookups === 0 && !/^Inside the server/m.test(c.out.stdout), `(${label}) no record fetched or printed (lookups: ${c.lookups})`, c.out);
    check(c.lines[1] === "Server timings ? — 0 of 1 marked visit succeeded", `(${label}) ends with 0 of 1 succeeded (got: ${c.lines[1] ?? "nothing"})`, c.out);
  }

  // A partial record: only what was recorded, no span missing one of its marks.
  const p = await runCase("p, partial record", "p");
  checkStamped(p, /^\/marked\/reply\?/, `POST ${origin}/marked/reply`);

  // The Workers note follows the record's runtime, and only "workers" counts.
  const w = await runCase("w, runtime workers", "w");
  checkStamped(w, /^\/marked\/reply\?/, `POST ${origin}/marked/reply`);
  const o = await runCase("o, runtime node", "o");
  checkStamped(o, /^\/marked\/reply\?/, `POST ${origin}/marked/reply`);

  // Quill's record today (postgresStart/postgresEnd) still shows, as the span "postgres".
  check(/^    postgres +\d+ ms   \(postgresStart → postgresEnd\)$/m.test(o.out.stdout) && !/database (wait|query)/.test(o.out.stdout),
    `(o) Quill's postgresStart/postgresEnd show as the span "postgres"`, o.out);

  // (s) App-chosen names: every <name>Start / <name>End pair is a span; a Start without its
  // End, an End without its Start, or an End before its Start is no span, with the reason.
  const s = await runCase("s, app-chosen span names", "s");
  checkStamped(s, /^\/marked\/reply\?/, `POST ${origin}/marked/reply`);
  const sRecord = server.caliper.records.get(s.stamped[0]?.run);
  check(JSON.stringify(Object.keys(sRecord?.marks ?? {})) === JSON.stringify(["dbStart", "dbEnd", "vectorSearchStart", "vectorSearchEnd", "cacheStart", "warmupEnd", "lockEnd", "lockStart", "modelCallSent", "firstChunk"]),
    `(s) the fixture recorded the generic marks (got ${Object.keys(sRecord?.marks ?? {}).join(", ")})`, s.out);
  check(!/^    postgres/m.test(s.out.stdout), "(s) no postgres span when the record has none", s.out);
  const sLines = s.out.stdout.split("\n");
  const sAt = sLines.indexOf("  problems reported by the server");
  check(sAt !== -1 && sLines[sAt + 1] === `    ${GENERIC_PROBLEM}`, `(s) prints the problem the record reports, under its heading`, s.out);
  // (s2) Two visits: the spans per visit, and one "no span" line per broken pair, for both
  // visits: the reason once when it's the same, else each visit's values.
  const s2 = await runCase("s2, app-chosen names, 2 visits", "s", { serverRuns: 2 });
  checkVisits(s2, 2, [1, 2]);
  const s2Lines = s2.out.stdout.split("\n");
  const s2Records = s2.stamped.map((st) => server.caliper.records.get(st.run));
  if (s2Records.length === 2 && s2Records.every(Boolean)) {
    for (const name of ["cache", "warmup", "lock"]) {
      const [a, b] = s2Records.map((r) => spanOf(r, name).why);
      const values = s2Records.map((r, i) => `visit ${i + 1}: ${name}End ${r.marks[`${name}End`]} ms, ${name}Start ${r.marks[`${name}Start`]} ms`).join(" · ");
      const want = `    no ${name} span in 2 of 2 visits: ${a === b ? a : `${name}End is before ${name}Start (${values})`}`;
      check(s2Lines.includes(want) && s2Lines.filter((l) => l.startsWith(`    no ${name} span`)).length === 1, `(s2) one line for ${name}: ${want.trim()}`, s2.out);
    }
  } else check(false, `(s2) the fake wrapper recorded both visits`, s2.out);
  check(s2Lines.includes(`    ${GENERIC_PROBLEM}   (2 of 2 visits)`), `(s2) the problem is printed once, for both visits`, s2.out);

  // Token OK and wrapper there, but nothing recorded for the run.
  const n = await runCase("n, no record", "n");
  checkPrecheck(n);
  checkPrecheckLine(n);
  const nRun = n.stamped[0]?.run;
  check(n.stamped.length === 1 && n.lookups === 1, `(n) stamped once, looked up once (stamped ${n.stamped.length}, lookups ${n.lookups})`, n.out);
  check(n.lines[1] === `Server timings ? — marked visit 1 of 1: token OK and wrapper present, but no record for run ${nRun}.` &&
    n.lines[2] === "Server timings ? — 0 of 1 marked visit succeeded" && !/^Inside the server/m.test(n.out.stdout),
    `(n) reports the missing record with its run id (got: ${n.lines.join(" | ") || "nothing"})`, n.out);

  // Pre-check answers that skip the marked visit.
  const k404 = await runCase("pre-check 404", "a", { srv: noSecret });
  checkNoVisit(k404);
  checkPrecheckLine(k404, `Server timings ? — pre-check: feature off (404 on caliper.precheck): no Caliper wrapper at ${noSecret.url}, or CALIPER_TOKEN not set on the server; no marked visit.`);
  const k401 = await runCase("pre-check 401", "a", { srv: otherSecret });
  checkNoVisit(k401);
  checkPrecheck(k401);
  checkPrecheckLine(k401, "Server timings ? — pre-check: token rejected (401 on caliper.precheck): wrong, expired or rotated; no marked visit.");
  const k500 = await runCase("pre-check 500", "a", { srv: broken });
  checkNoVisit(k500);
  checkPrecheckLine(k500, `Server timings ? — pre-check: got HTTP 500 on caliper.precheck from ${broken.url}/__caliper/timings/${k500.asked[0]}; no marked visit.`);
  for (const c of [k404, k401, k500]) {
    check(c.lines.length === 0, `(${c.label}) the pre-check line is the only Server timings line (got: ${c.lines.join(" | ")})`, c.out);
  }
  for (const c of [k401, k500]) {
    check(c.asked.length === 1, `(${c.label}) only the pre-check reached the wrapper (asked ${c.asked.length})`, c.out);
  }

  // --runs 1: the key is exact, and the line says so.
  const one = await runCase("runs 1", "a", { runs: 1 });
  checkStamped(one, /^\/marked\/reply\?/, `POST ${origin}/marked/reply`);

  // Errors before any run: not an origin, or no token.
  for (const bad of [`${origin}/marked`, `${origin}?x=1`, "127.0.0.1", "ftp://127.0.0.1"]) {
    const out = await caliper(`${origin}/marked?case=a&id=bad`, ["--runs", "1", "--server-timings", bad], { CALIPER_TOKEN: TOKEN });
    check(out.code !== 0 && out.stderr.includes(`--server-timings must be an origin like https://api.example.com (scheme, host and optional port), got "${bad}".`) && timedRuns(out.stdout) === 0,
      `--server-timings "${bad}" is an error before any run`, out);
  }
  const noToken = await caliper(`${origin}/marked?case=a&id=notoken`, ["--runs", "1", "--server-timings", origin], {});
  check(noToken.code !== 0 && noToken.stderr.includes("--server-timings needs CALIPER_TOKEN set in the environment.") && timedRuns(noToken.stdout) === 0,
    "--server-timings without CALIPER_TOKEN is an error before any run", noToken);

  // (f1) Run 2 of 3 fails to load: the key comes from runs 1 and 3, and the visit goes ahead.
  const f1 = await runCase("f1, 1 of 3 failed", "a", { runs: 3, fail: [2] });
  checkStamped(f1, /^\/marked\/reply\?/, `POST ${origin}/marked/reply`);
  checkDropped(f1, 2);

  // (f2) Runs 1 and 3 fail: the key comes from run 2 alone, with the one-run note too.
  const f2 = await runCase("f2, 2 of 3 failed", "a", { runs: 3, fail: [1, 3] });
  checkStamped(f2, /^\/marked\/reply\?/, `POST ${origin}/marked/reply`);

  // (f3) Every run fails to load: as before, no marked visit and no server line.
  const f3 = await runCase("f3, all failed", "a", { runs: 2, fail: [1, 2] });
  checkNoVisit(f3);
  check(f3.out.stdout.split("\n").includes("Inconclusive — page failed to load") && f3.line === null,
    `(f3) "Inconclusive — page failed to load", no server timings line (got: ${f3.line ?? "nothing"})`, f3.out);
  for (const run of [1, 2]) checkDropped(f3, run);

  // (t) Run 1 times out: things to check for a timeout, then the rerun line; run 2 makes the key.
  const t = await runCase("t, run 1 timed out", "a", { runs: 2, hang: [1], args: ["--timeout", "4000"] });
  checkStamped(t, /^\/marked\/reply\?/, `POST ${origin}/marked/reply`);
  const tLines = failedRunLines(t.out.stdout, 1);
  const tWant = ["    page.goto: Timeout 4000ms exceeded.", `    things to check: your network connection · whether ${origin} is up · --timeout (now 4000 ms)`, "    Rerun to try again."];
  check(JSON.stringify(tLines) === JSON.stringify(tWant), `(t) run 1: the timeout, things to check, rerun (got: ${tLines?.join(" | ") ?? "no failed-load line"})`, t.out);

  // (r) Nothing listening on the port: things to check for a refused connection.
  const closed = await startFixtureServer();
  await closed.close();
  const r = await caliper(`${closed.url}/marked?case=a&id=refused`, ["--runs", "1"], {});
  const rLines = failedRunLines(r.stdout, 1);
  const rWant = [`    page.goto: net::ERR_CONNECTION_REFUSED at ${closed.url}/marked?case=a&id=refused`, `    things to check: whether ${closed.url} is up · the port in the URL`, "    Rerun to try again."];
  check(JSON.stringify(rLines) === JSON.stringify(rWant), `(r) connection refused: things to check, rerun (got: ${rLines?.join(" | ") ?? "no failed-load line"})`, r);

  // (fv) Marked visit 2 of 3 fails to load (dropped): its "?" line, then only the rerun line.
  const fv = await runCase("fv, visit 2 load dropped", "a", { runs: 2, serverRuns: 3, fail: [4] });
  checkVisits(fv, 3, [1, 3]);
  const fvLines = linesAfter(fv.out.stdout, /^Server timings \? — marked visit 2 of 3:/);
  check(!!fvLines && fvLines.length === 2 && /^Server timings \? — marked visit 2 of 3: page failed to load: page\.goto: net::ERR_EMPTY_RESPONSE at \S+$/.test(fvLines[0]) &&
    fvLines[1] === "    Rerun to try again.", `(fv) visit 2: page failed to load, then only the rerun line (got: ${fvLines?.join(" | ") ?? "nothing"})`, fv.out);

  // (tv) The only marked visit times out: things to check for a timeout, then the rerun line.
  const tv = await runCase("tv, visit load timed out", "a", { runs: 2, serverRuns: 1, hang: [3], args: ["--timeout", "4000"] });
  const tvLines = linesAfter(tv.out.stdout, /^Server timings \? — marked visit 1 of 1:/);
  const tvWant = ["Server timings ? — marked visit 1 of 1: page failed to load: page.goto: Timeout 4000ms exceeded.",
    `    things to check: your network connection · whether ${origin} is up · --timeout (now 4000 ms)`, "    Rerun to try again."];
  check(JSON.stringify(tvLines) === JSON.stringify(tvWant), `(tv) visit 1: page failed to load, things to check, rerun (got: ${tvLines?.join(" | ") ?? "nothing"})`, tv.out);
  check(tv.lines.at(-1) === "Server timings ? — 0 of 1 marked visit succeeded" && tv.stamped.length === 0,
    `(tv) nothing stamped, 0 of 1 succeeded (got: ${tv.lines.join(" | ")})`, tv.out);

  // (m) Default --server-runs: 3 marked visits, all succeed.
  const m = await runCase("m, 3 visits by default", "m", { serverRuns: null, args: reportArgs("m") });
  checkVisits(m, 3, [1, 2, 3]);
  const mRunMs = [...m.out.stdout.matchAll(/^run \d.*?\s(\d+) ms$/gm)].map((r) => Number(r[1]));
  const mSummary = m.out.stdout.match(/^cold (\d+) ms · median (\d+) ms/m);
  // The HTML report: the same rows and numbers as the terminal block, and the pre-check line.
  const mHtml = readReport("m");
  const mServer = serverPart(mHtml);
  check(!!mServer && mServer.includes(PRECHECK_OK), "(m) the HTML report has a server section with the pre-check line", m.out);
  const mBlock = m.out.stdout.slice(m.out.stdout.indexOf("Inside the server"));
  const mTerminal = [...mBlock.matchAll(/^    (\S.*?) {2,}(?:\d+|–)(?: +(?:\d+|–))*(?:   min \d+ · median \d+ · max \d+)? ms/gm)].map((r) => r[1]);
  const mRows = htmlRows(mServer ?? "");
  check(mTerminal.length > 0 && JSON.stringify([...mRows.keys()]) === JSON.stringify(mTerminal), `(m) the HTML rows are the terminal rows, in order (terminal: ${mTerminal.join(", ")}; html: ${[...mRows.keys()].join(", ")})`, m.out);
  for (const label of mTerminal) {
    const row = statsRow(mBlock, label);
    if (!row) continue; // checkVisits already failed on it
    const want = [...row.values.map((x) => (x === null ? "–" : String(x))), ...(row.stats ? [row.stats.min, row.stats.median, row.stats.max].map(String) : ["", "", ""])];
    check(JSON.stringify(mRows.get(label)) === JSON.stringify(want), `(m) HTML "${label}" is ${want.join(" ")} like the terminal (got ${mRows.get(label)?.join(" ") ?? "nothing"})`, m.out);
  }
  const mTiles = [...(mHtml ?? "").matchAll(/<div class="tile-value">([\d,]+)<small>/g)].map((t) => Number(t[1].replace(/,/g, "")));
  check(!!mSummary && mTiles[0] === Number(mSummary[1]) && mTiles[1] === Number(mSummary[2]),
    `(m) the HTML tiles are the timed runs' cold and median (want ${mSummary?.[1]}, ${mSummary?.[2]}; got ${mTiles.join(", ")})`, m.out);
  check(!!mSummary && Number(mSummary[1]) === mRunMs[0] && Number(mSummary[2]) === mRunMs[1],
    `(m) the browser summary is the 2 timed runs only (runs ${mRunMs.join(", ")}; got: ${mSummary?.[0] ?? "nothing"})`, m.out);
  // Spans inside each visit first: with these marks the median span isn't median(end) − median(start).
  const mRecords = m.stamped.map((r) => server.caliper.records.get(r.run)).filter(Boolean);
  const starts = mRecords.map((r) => r.marks.postgresStart);
  const ends = mRecords.map((r) => r.marks.postgresEnd);
  const spans = mRecords.map((r) => r.marks.postgresEnd - r.marks.postgresStart);
  const dbRow = statsRow(m.out.stdout, "postgres");
  check(median(spans) !== median(ends) - median(starts), `(m) the fixture tells the two apart (median span ${median(spans)}, difference of medians ${median(ends) - median(starts)})`, m.out);
  check(dbRow?.median === median(spans), `(m) "postgres" median is the median of the per-visit spans, ${median(spans)} (got ${dbRow?.median ?? "nothing"})`, m.out);

  // (v) One of three visits fails: its own "?" line, and it's left out of the block.
  const v = await runCase("v, visit 2 of 3 fails", "v", { serverRuns: 3 });
  checkVisits(v, 3, [1, 3]);
  check(v.lines.includes(`Server timings ? — marked visit 2 of 3: no request matched POST ${origin}/marked/reply`),
    `(v) visit 2 prints its own ? line (got: ${v.lines.join(" | ") || "nothing"})`, v.out);

  // (q) Visit 2's record has no firstChunk: "–" in its column, the summary over visits 1 and 3.
  const q = await runCase("q, visit 2 partial", "q", { serverRuns: 3 });
  checkVisits(q, 3, [1, 2, 3]);
  check(/^    server: first bytes sent +\d+ +– +\d+   min /m.test(q.out.stdout), `(q) "server: first bytes sent" shows – for visit 2`, q.out);

  // (e3) All three visits fail.
  const e3 = await runCase("e3, all 3 fail", "e", { serverRuns: 3, args: reportArgs("e3") });
  checkPrecheck(e3);
  checkPrecheckLine(e3);
  check(e3.loads === 5 && e3.stamped.length === 0 && e3.lookups === 0, `(e3) 3 visits, nothing stamped or looked up (loads ${e3.loads}, stamped ${e3.stamped.length}, lookups ${e3.lookups})`, e3.out);
  const want3 = [1, 2, 3].map((i) => `Server timings ? — marked visit ${i} of 3: no request matched POST ${origin}/marked/reply`);
  check(JSON.stringify(e3.lines) === JSON.stringify([...want3, "Server timings ? — 0 of 3 marked visits succeeded"]) && !/^Inside the server/m.test(e3.out.stdout),
    `(e3) three ? lines, then 0 of 3 succeeded, no block (got: ${e3.lines.join(" | ") || "nothing"})`, e3.out);
  const e3Server = serverPart(readReport("e3"));
  const e3Html = (line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  check(!!e3Server && [PRECHECK_OK, ...want3, "Server timings ? — 0 of 3 marked visits succeeded"].every((l) => e3Server.includes(e3Html(l))) && !e3Server.includes("<table"),
    "(e3) the HTML server section has the pre-check, the three ? lines and 0 of 3, and no table", e3.out);

  // (m1) --server-runs 1: just the values, no median.
  const m1 = await runCase("m1, --server-runs 1", "m", { serverRuns: 1 });
  checkVisits(m1, 1, [1]);

  // Out of range, or without --server-timings: an error before any run, and no count line.
  for (const bad of ["0", "11", "-1", "2.5", "abc", ""]) {
    const out = await caliper(`${origin}/marked?case=a&id=bad`, ["--runs", "1", "--server-timings", origin, `--server-runs=${bad}`], { CALIPER_TOKEN: TOKEN });
    check(out.code !== 0 && out.stderr.includes(`--server-runs must be a whole number from 1 to 10, got "${bad}".`) && timedRuns(out.stdout) === 0 && !/^This audit/m.test(out.stdout),
      `--server-runs "${bad}" is an error before any run`, out);
  }
  const alone = await caliper(`${origin}/marked?case=a&id=alone`, ["--runs", "1", "--server-runs", "2"], { CALIPER_TOKEN: TOKEN });
  check(alone.code !== 0 && alone.stderr.includes("--server-runs needs --server-timings <origin>.") && timedRuns(alone.stdout) === 0,
    "--server-runs without --server-timings is an error before any run", alone);
} finally {
  await Promise.all([server, noSecret, otherSecret, broken].map((srv) => srv.close()));
  rmSync(reportDir, { recursive: true, force: true });
}

if (logs.length) console.log(logs.join("\n").replace(/^/gm, "     | "));
process.exitCode = failures.length ? 1 : 0;

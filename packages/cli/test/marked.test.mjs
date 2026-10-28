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
// Run with `npm run test:marked` (builds first).

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFixtureServer } from "./fixtures/server.mjs";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));
const TOKEN = `caliper-test-${randomBytes(8).toString("hex")}`;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ONE_RUN = " (key from 1 run — changing path parts can't be detected)";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const timedRuns = (stdout) => (stdout.match(/^run \d.*\s\d+ ms$/gm) ?? []).length;

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

const server = await startFixtureServer();
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

// One case: run Caliper on /marked?case=…, then check what's common to every case. By default
// with the token and --server-timings naming the page's own origin.
async function runCase(label, kase, { runs = 2, host = origin, named = host, env = { CALIPER_TOKEN: TOKEN }, args = [] } = {}) {
  const id = `${kase}-${randomBytes(4).toString("hex")}`;
  const flags = ["--runs", String(runs), ...(named ? ["--server-timings", named] : []), ...args];
  const out = await caliper(`${host}/marked?case=${kase}&id=${id}&runs=${runs}`, flags, env);
  const { loads, requests } = server.marked(id);
  const stamped = requests.filter((r) => r.run !== null || r.token !== null);
  check(out.code === 0 && timedRuns(out.stdout) === runs, `(${label}) the ${runs} unmarked run(s) are timed (got ${timedRuns(out.stdout)})`, out);
  check(!requests.some((r) => r.load <= runs && (r.run !== null || r.token !== null)), `(${label}) no request in the unmarked runs is stamped`, out);
  check(!`${out.stdout}${out.stderr}`.includes(TOKEN), `(${label}) the token is never printed`, out);
  return { label, runs, host, out, loads, requests, stamped, line: out.stdout.match(/^Server timings.*$/m)?.[0] ?? null };
}

// The marked visit stamped exactly one request: the reply, with a fresh run id and the token,
// and the page's own headers left as they were. The printed line names that run id.
function checkStamped({ label, runs, host, out, loads, stamped, line }, url, key) {
  check(loads === runs + 1, `(${label}) one marked visit after the runs (page loads: ${loads})`, out);
  check(stamped.length === 1, `(${label}) exactly one request stamped (got ${stamped.length})`, out);
  const s = stamped[0];
  check(!!s && s.load === runs + 1 && s.method === "POST" && url.test(s.url) && !/kind=ping/.test(s.url),
    `(${label}) the stamped request is the marked visit's reply (got ${s ? `${s.method} ${s.url}` : "none"})`, out);
  check(!!s && s.token === TOKEN && new RegExp(`^${UUID}$`).test(s.run ?? ""), `(${label}) it carries x-caliper-token and a fresh x-caliper-run id`, out);
  check(!!s && s.contentType === "application/json", `(${label}) its own content-type header is untouched (got ${s?.contentType})`, out);
  const suffix = runs === 1 ? esc(ONE_RUN) : "";
  const want = new RegExp(`^Server timings — marked visit sent x-caliper-run (${UUID}) on POST ${esc(host)}\\S+ \\(matched ${esc(key)}\\); timings not fetched yet${suffix}$`);
  const m = line?.match(want);
  check(!!m && m[1] === s?.run, `(${label}) prints the stamped request, its key and run id (got: ${line ?? "nothing"})`, out);
}

// No marked visit at all: the page loaded only for the runs, and nothing was stamped.
function checkNoVisit({ label, runs, out, loads, stamped }) {
  check(loads === runs, `(${label}) no marked visit (page loads: ${loads})`, out);
  check(stamped.length === 0, `(${label}) nothing stamped (got ${stamped.length})`, out);
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
  const two = new RegExp(`^Server timings \\? — 2 requests matched POST ${esc(reply)}: ${esc(reply)}\\?\\S*kind=ping\\S*, ${esc(reply)}\\?(?!\\S*kind=ping)\\S+$`);
  check(two.test(d.line ?? ""), `(d) reports 2 matches with both URLs (got: ${d.line ?? "nothing"})`, d.out);

  // (e) No request matches the key during the marked visit.
  const e = await runCase("e", "e");
  check(e.loads === 3, `(e) one marked visit after the runs (page loads: ${e.loads})`, e.out);
  check(e.stamped.length === 0, `(e) nothing stamped (got ${e.stamped.length})`, e.out);
  check(e.line === `Server timings ? — no request matched POST ${origin}/marked/reply`, `(e) reports no match, naming the key (got: ${e.line ?? "nothing"})`, e.out);

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
  const notPicked = new RegExp(`^Server timings \\? — the marked visit's AI request was POST ${esc(origin)}/marked/other/reply\\?\\S+, not the stamped POST ${esc(reply)}\\?\\S*kind=ping\\S*$`);
  check(notPicked.test(g.line ?? ""), `(g) reports the AI request isn't the stamped one, naming both (got: ${g.line ?? "nothing"})`, g.out);

  // (h) The token without --server-timings: nothing happens.
  const h = await runCase("h", "a", { named: null });
  checkNoVisit(h);
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
} finally {
  await server.close();
}

if (logs.length) console.log(logs.join("\n").replace(/^/gm, "     | "));
process.exitCode = failures.length ? 1 : 0;

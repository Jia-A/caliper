// When Caliper can't tell which request is the AI reply, it asks instead of guessing. After the
// first visit that names a winner, the winner's share (its output changes ÷ the changes from its
// first body byte on) must be ≥ 95%, and no other request's bytes may come ≤ 250 ms before
// ≥ 50% of those changes. Otherwise: in a terminal, list the candidates and wait for a number
// (that request is then used for every visit); with no answer in time, or no terminal, stop
// with a --request line to rerun. --request "METHOD /path" skips the guessing.
// Cases:
//   - clean: one stream explains every change → no question, the share on every run
//   - split: two streams take turns (7 of 13 vs 6 of 13) → asks; the answer is used
//   - typewriter: the reply comes in 400 ms chunks shown a letter per 30 ms, next to a 50 ms
//     heartbeat → asks, never picks the heartbeat silently
//   - no terminal → stops at once with the --request line
//   - known limit, late: run 1 clear, later runs where another stream wins → later runs pick that
//     stream (only the first run is checked)
//   - the answered request's path changes per run → later runs fail, suggesting a regex --request
//   - tie: both streams explain 7 of 14 → asked about like any share under 95%, not "not identified"
//   - no answer in time → stops (CALIPER_ASK_TIMEOUT_MS shortens the 2-minute wait); Ctrl-C stops at once
//   - --request "POST /path" locks the request; one that matches nothing fails each visit; one
//     that matches 2+ requests in a visit fails it, listing every match (METHOD /path and regex)
//   - the answer also decides the marked visit (--server-timings), which would otherwise pick
//     the heartbeat; the HTML report shows each run's share
// The terminal runs go through test/fixtures/pty.py (needs python3).
// Run with `npm run test:ambiguous` (builds first).

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./fixtures/server.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const pty = fileURLToPath(new URL("./fixtures/pty.py", import.meta.url));
const auth = fileURLToPath(new URL("./fixtures/empty-auth.json", import.meta.url));

const server = await startFixtureServer();
const TOKEN = "ambiguous-test-token";
const wrapped = await startFixtureServer(0, { caliperToken: TOKEN }); // a fake Caliper wrapper, for the marked visit
let failed = 0;
const outputs = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};

// Runs one audit of /ambiguous?case=<page> (or a fixture path). With tty, inside a pty (stdout
// and stderr arrive together); answer(output) is asked after each new output and may return the
// line to type. Without tty, stdin is a pipe that's never written to.
function audit(name, page, { tty = false, answer = () => null, args = [], env = {}, report = null, on = server } = {}) {
  const url = page.startsWith("/") ? `${on.url}${page}` : `${on.url}/ambiguous?case=${page}`;
  const argv = [cli, "audit", url, "--measure", "^generate$", "--output", "#out", "--runs", "2", "--auth", auth,
    "--settle-ms", "500", "--timeout", "15000", ...(report ? ["--report", report] : ["--no-report"]), ...args];
  const [cmd, cmdArgs] = tty ? ["python3", ["-I", pty, process.execPath, ...argv]] : [process.execPath, argv];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let answered = false;
    const killer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (answered) return;
      const line = answer(stdout);
      if (line !== null) {
        answered = true;
        child.stdin.write(`${line}\n`);
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(killer);
      const all = `${stdout}${stderr}`.replace(/\r\n/g, "\n");
      outputs.push(`--- ${name} (exit ${code}) ---\n${all}`);
      resolve({ out: all, code, ms: Date.now() - started });
    });
  });
}

const chosen = (out) => [...out.matchAll(/^run \d.*\n {4}(\S+ \S+) → /gm)].map((m) => m[1].replace(server.url, "").replace(wrapped.url, ""));
const asked = (out) => out.includes("Not sure which request is the AI reply:");
// The number the question gave a request, e.g. "  2) POST /ambiguous/generate — 6 of 13 changes (46%)".
const numberOf = (out, request) => out.match(new RegExp(`^ +(\\d)\\) ${request} — `, "m"))?.[1] ?? null;
const answerWith = (request) => (out) => (/Which one\? \(number, waiting [^)]+\)/.test(out) ? numberOf(out, request) : null);

try {
  // Clean: no question, the stream on both runs, its share on each, in the report too.
  {
    const report = join(mkdtempSync(join(tmpdir(), "caliper-ambiguous-")), "report.html");
    const { out, code } = await audit("clean", "/stream-nostore", { report });
    check(code === 0, `clean: exits 0 (got ${code})`);
    check(!asked(out), "clean: no question");
    const picks = chosen(out);
    check(picks.length === 2 && picks.every((p) => p === "POST /chat/stream-nostore"), `clean: both runs chose POST /chat/stream-nostore (got ${picks.join(", ") || "none"})`);
    const shares = out.match(/^ {4}share: 13 of 13 output changes from its first body byte \(100%\)/gm) ?? [];
    check(shares.length === 2, `clean: "share: 13 of 13 … (100%)" on both runs (got ${shares.length})`);
    check(/the first run asks below 95% \(Caliper's own threshold, no outside source\)/.test(out), "clean: the 95% is labelled as Caliper's own threshold");
    let html = "";
    try {
      html = readFileSync(report, "utf8");
    } catch {}
    const inReport = html.match(/share: 13 of 13 output changes from its first body byte \(100%\) — the first run asks below 95% \(Caliper's own threshold, no outside source\)/g) ?? [];
    // Twice per run: the timeline and the request matching list.
    check(inReport.length === 4, `clean: the report shows the share and the threshold for both runs (got ${inReport.length} of 4)`);
  }

  // Split: asks, lists both streams with their counts, and the answer decides every run.
  {
    const { out, code } = await audit("split, answered", "split", { tty: true, answer: answerWith("POST /ambiguous/generate") });
    check(asked(out), "split: asks");
    check(/^ +\d\) POST \/ambiguous\/generate — 7 of 13 changes \(54%\)$/m.test(out), 'split: lists "POST /ambiguous/generate — 7 of 13 changes (54%)"');
    check(/^ +\d\) GET \/ambiguous\/status — 6 of 13 \(46%\)/m.test(out), 'split: lists "GET /ambiguous/status — 6 of 13 (46%)"');
    check(/Which one\? \(number, waiting 2 minutes\)/.test(out), 'split: "Which one? (number, waiting 2 minutes)"');
    check(code === 0, `split: exits 0 after the answer (got ${code})`);
    const picks = chosen(out);
    check(picks.length === 2 && picks.every((p) => p === "POST /ambiguous/generate?case=split"), `split: both runs use the answer (got ${picks.join(", ") || "none"})`);
    check((out.match(/you chose it/g) ?? []).length === 2, 'split: both runs say "you chose it"');
  }

  // Typewriter: the heartbeat wins most changes, but it isn't picked silently.
  {
    const { out, code } = await audit("typewriter, answered", "typewriter", { tty: true, answer: answerWith("POST /ambiguous/generate") });
    check(asked(out), "typewriter: asks");
    check(/^ +\d\) POST \/ambiguous\/generate — \d+ of \d+ \(\d+%\); its bytes came ≤ 250 ms before \d+ of \d+ \(\d+%\)$/m.test(out),
      "typewriter: lists the reply with how many changes its bytes came ≤ 250 ms before");
    const firstRun = out.split(/^run 2/m)[0];
    check(!/^run 1.*\n {4}GET \S+\/ambiguous\/heartbeat → /m.test(firstRun), "typewriter: run 1 isn't timed on the heartbeat");
    check(code === 0, `typewriter: exits 0 after the answer (got ${code})`);
    const picks = chosen(out);
    check(picks.length === 2 && picks.every((p) => p === "POST /ambiguous/generate?case=typewriter"), `typewriter: both runs use the answer (got ${picks.join(", ") || "none"})`);
  }

  // The answer decides the marked visit too: without it, that visit would pick the heartbeat.
  {
    const { out, code } = await audit("typewriter, answered, marked visit", "typewriter", {
      tty: true,
      answer: answerWith("POST /ambiguous/generate"),
      on: wrapped,
      args: ["--server-timings", wrapped.url, "--server-runs", "1"],
      env: { CALIPER_TOKEN: TOKEN },
    });
    check(asked(out), "marked visit: asks after run 1");
    check(code === 0, `marked visit: exits 0 (got ${code})`);
    check(/^Server timings — marked visit 1 of 1 sent x-caliper-run \S+ on POST \S+\/ambiguous\/generate\?case=typewriter /m.test(out),
      "marked visit: stamps and keeps the chosen POST /ambiguous/generate");
    check(!/its AI request was GET/.test(out), "marked visit: doesn't pick the heartbeat");
  }

  // No terminal: stop at once, with the real candidates to rerun with.
  for (const page of ["split", "typewriter"]) {
    const { out, code, ms } = await audit(`${page}, no terminal`, page);
    check(code === 1, `${page}, no terminal: exits 1 (got ${code})`);
    check(asked(out), `${page}, no terminal: lists the candidates`);
    check(!/Which one\?/.test(out), `${page}, no terminal: doesn't ask`);
    const rerun = /Too close to choose\. Rerun with --request "(GET|POST) \/ambiguous\/\w+"( or --request "(GET|POST) \/ambiguous\/\w+")+/.test(out);
    check(rerun && out.includes('--request "POST /ambiguous/generate"'), `${page}, no terminal: "Too close to choose. Rerun with --request …" naming the reply`);
    check(!/^run 2/m.test(out), `${page}, no terminal: no more visits`);
    check(ms < 60_000, `${page}, no terminal: doesn't wait (${ms} ms)`);
  }

  // KNOWN LIMIT, not the behaviour we want: only the first run is checked. Run 1 is clear, so
  // nothing is asked, and runs 2 and 3, where the status stream explains more changes, pick it.
  {
    const { out, code } = await audit("late, known limit", "late&id=limit", { args: ["--runs", "3"] });
    check(code === 0, `late (known limit): exits 0 (got ${code})`);
    check(!asked(out), "late (known limit): no question");
    const picks = chosen(out);
    check(picks.join(", ") === "POST /ambiguous/generate?case=late, GET /ambiguous/status?case=late, GET /ambiguous/status?case=late",
      `late (known limit): run 1 picks the reply, runs 2 and 3 the status stream (got ${picks.join(", ") || "none"})`);
    check(/^ {4}share: 6 of 6 output changes from its first body byte \(100%\)/m.test(out), "late (known limit): run 1's share (6 of 6) is shown");
    check((out.match(/^ {4}share: 7 of 12 output changes from its first body byte \(58%\); POST \/ambiguous\/generate's bytes came ≤ 250 ms before 11 of 12 \(92%\)/gm) ?? []).length === 2,
      "late (known limit): runs 2 and 3 show the status stream's share (7 of 12, 58%) and the reply's 11 of 12");
  }

  // The answered request's path changes per run (/ambiguous/c/<random>/generate): later runs
  // fail, with the reason and a regex --request to rerun with.
  {
    const { out, code } = await audit("splitid, answered", "splitid", { tty: true, answer: answerWith("POST /ambiguous/c/\\w+/generate") });
    check(asked(out), "path changes: asks");
    check(code === 0, `path changes: the audit still finishes (got ${code})`);
    check(/^run 1 \(cold\)\s+\d+ ms$/m.test(out), "path changes: run 1 is timed");
    check(/^run 2 — AI request not identified, timing inconclusive\n {4}no request matches your answer "POST \/ambiguous\/c\/\w+\/generate" \(seen: .*\)\. If its path changes per run, rerun with --request and a regex on the URL \(e\.g\. --request "\/chat\/\[\^\/\]\+\/reply" for \/chat\/abc123\/reply\)\.$/m.test(out),
      "path changes: run 2 fails naming the answer and suggesting a regex --request");
  }

  // An exact tie is asked about (a share of 50%), not reported as not identified.
  {
    const { out, code } = await audit("tie, no terminal", "tie");
    check(code === 1, `tie: exits 1 (got ${code})`);
    check(/^ +1\) (POST \/ambiguous\/generate|GET \/ambiguous\/status) — 7 of 14 changes \(50%\)$/m.test(out), 'tie: lists the winner with "7 of 14 changes (50%)"');
    check(/^ +2\) (POST \/ambiguous\/generate|GET \/ambiguous\/status) — 7 of 14 \(50%\)/m.test(out), 'tie: lists the other with "7 of 14 (50%)"');
    check(/Too close to choose\. Rerun with --request "\S+ \/ambiguous\/\w+" or --request "\S+ \/ambiguous\/\w+"/.test(out), "tie: Too close to choose, with both to rerun with");
    check(!/not identified/.test(out), 'tie: not "AI request not identified"');
  }

  // No answer in time: stop.
  {
    const { out, code } = await audit("split, no answer", "split", { tty: true, env: { CALIPER_ASK_TIMEOUT_MS: "1500" } });
    check(/Which one\? \(number, waiting 1\.5 seconds\)/.test(out), 'no answer: "waiting 1.5 seconds"');
    check(code === 1, `no answer: exits 1 (got ${code})`);
    check(/No answer in 1\.5 seconds\. Too close to choose\. Rerun with --request "POST \/ambiguous\/generate" or --request "GET \/ambiguous\/status"/.test(out),
      'no answer: "No answer in 1.5 seconds. Too close to choose. Rerun with --request …"');
    check(!/^run 2/m.test(out), "no answer: no more visits");
  }

  // Ctrl-C at the question stops at once, instead of waiting out the timer.
  {
    const { out, code, ms } = await audit("split, Ctrl-C", "split", {
      tty: true,
      answer: (o) => (/Which one\?/.test(o) ? "\x03" : null),
      env: { CALIPER_ASK_TIMEOUT_MS: "60000" },
    });
    check(code === 1, `Ctrl-C: exits 1 (got ${code})`);
    check(/Stopped at the question\. Too close to choose\. Rerun with --request "POST \/ambiguous\/generate"/.test(out), 'Ctrl-C: "Stopped at the question. Too close to choose. Rerun with --request …"');
    check(ms < 30_000, `Ctrl-C: doesn't wait out the 60 s timer (${ms} ms)`);
  }

  // --request "METHOD /path": no question, that request on every run.
  {
    const { out, code } = await audit("split, --request", "split", { args: ["--request", "POST /ambiguous/generate"] });
    check(code === 0, `--request: exits 0 (got ${code})`);
    check(!asked(out), "--request: no question");
    const picks = chosen(out);
    check(picks.length === 2 && picks.every((p) => p === "POST /ambiguous/generate?case=split"), `--request: both runs use it (got ${picks.join(", ") || "none"})`);
    check((out.match(/^ {4}share: 7 of 13 output changes from its first body byte \(54%\)/gm) ?? []).length === 2, "--request: its share (54%) on both runs");
  }

  // A --request no request matches: each visit fails with the reason, nothing is timed.
  {
    const { out, code } = await audit("wrong --request", "split", { args: ["--request", "POST /nope"] });
    const fails = out.match(/^run \d.* — AI request not identified, timing inconclusive\n {4}no request matches --request "POST \/nope" \(seen: .*POST \S+\/ambiguous\/generate\?case=split.*\)$/gm) ?? [];
    check(fails.length === 2, `wrong --request: both runs fail naming it and the requests seen (got ${fails.length})`);
    check(!/^run \d.*\s\d+ ms$/m.test(out), "wrong --request: no timing reported");
    check(code === 0, `wrong --request: the audit itself still finishes (got ${code})`);
  }

  // The same with a regex --request.
  {
    const { out, code } = await audit("wrong regex --request", "split", { args: ["--request", "nomatch-\\d+"] });
    const fails = out.match(/^run \d.* — AI request not identified, timing inconclusive\n {4}no request matches --request "nomatch-\\d\+" \(seen: .*\)$/gm) ?? [];
    check(fails.length === 2, `wrong regex --request: both runs fail naming it (got ${fails.length})`);
    check(code === 0, `wrong regex --request: the audit itself still finishes (got ${code})`);
  }

  // A --request that matches 2+ requests in a visit (a JSON ping, then the reply, both POST
  // /marked/reply): each visit fails, listing every match, instead of timing the first.
  for (const request of ["POST /marked/reply", "/marked/reply"]) {
    const { out, code } = await audit(`two matches, --request ${request}`, `/marked?case=d&id=two-${request.length}`, { args: ["--request", request] });
    const re = new RegExp(`^run \\d.* — AI request not identified, timing inconclusive\\n {4}2 requests match --request "${request.replace(/[/]/g, "\\/")}": POST \\S+\\/marked\\/reply\\?\\S*kind=ping\\S*, POST \\S+\\/marked\\/reply\\?(?!\\S*kind=ping)\\S+\\. Caliper doesn't guess which one is the AI reply: rerun with a --request regex that matches only one\\.$`, "gm");
    check((out.match(re) ?? []).length === 2, `two matches (${request}): both runs fail, listing the ping and the reply (got ${(out.match(re) ?? []).length})`);
    check(!/^run \d.*\s\d+ ms$/m.test(out), `two matches (${request}): no timing reported`);
    check(code === 0, `two matches (${request}): the audit itself still finishes (got ${code})`);
  }
} finally {
  await server.close();
  await wrapped.close();
}
if (failed) console.log(outputs.join("\n").replace(/^/gm, "     | "));
process.exitCode = failed ? 1 : 0;

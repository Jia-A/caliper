// Prompt sizes end to end, with caliper-timings itself (its source, from packages/timings) on a
// node:http app: the route calls run?.prompt() with messages that carry a marker every way a
// prompt could (system text, a role that's really text, a list of parts, an extra key). The
// built CLI must print the sizes, and the marker must be nowhere in what it prints or the HTML
// report. Run with `npm run test:prompt` (builds first).

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTimings, MemoryStore } from "../../timings/src/node.ts";
import { LEAKY_MESSAGES, LEAKY_PARTS, SECRET } from "../../timings/test/leak.ts";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const TOKEN = "prompt-test-token";

const PAGE = `<!doctype html><meta charset="utf-8"><title>Prompt sizes</title>
<button id="generate">Generate</button><div id="out"></div>
<script>
  document.getElementById("generate").addEventListener("click", async () => {
    const res = await fetch("/generate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      document.getElementById("out").textContent += value;
    }
  });
</script>`;

// The app: the timings endpoint, the page, and POST /generate, which reports its prompt just
// before the "model call", then streams a reply.
const timings = createTimings({ token: TOKEN, store: new MemoryStore() });
const server = createServer(async (req, res) => {
  if (await timings.handle(req, res)) return;
  if (req.method === "GET" && req.url === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  if (req.method === "POST" && req.url === "/generate") {
    const run = await timings.start(req, res);
    req.resume();
    run?.mark("dbStart");
    await sleep(20);
    run?.mark("dbEnd");
    run?.prompt(LEAKY_MESSAGES(), { parts: LEAKY_PARTS() });
    run?.mark("modelCallSent");
    await sleep(100);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    for (const word of ["Hello ", "from ", "the ", "model."]) {
      res.write(word);
      await sleep(60);
    }
    return res.end();
  }
  res.writeHead(404).end("not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};

try {
  const report = join(mkdtempSync(join(tmpdir(), "caliper-prompt-")), "report.html");
  const args = [cli, "audit", `${origin}/`, "--measure", "^generate$", "--output", "#out", "--runs", "2", "--settle-ms", "500",
    "--timeout", "15000", "--server-timings", origin, "--server-runs", "2", "--report", report];
  let out;
  try {
    out = await execFileAsync(process.execPath, args, { timeout: 120_000, env: { ...process.env, CALIPER_TOKEN: TOKEN } });
    out.code = 0;
  } catch (err) {
    out = { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
  let html = "";
  try {
    html = readFileSync(report, "utf8");
  } catch {}
  const lines = out.stdout.split("\n");
  const at = lines.indexOf("  prompt sizes (the same in marked visits 1, 2) — UTF-8 bytes of each message's text as your app passed it to run.prompt(); not tokens");
  // LEAKY_MESSAGES: 42 bytes of system text, 25 bytes under a role that's really text, a list of
  // parts (not measured), 13 bytes of history, and the marker three times (72 bytes).
  // Parts: the system message as intro + marker (adding up to it exactly), and in message 5 a
  // part named with the marker (shown as "?") and one whose text isn't in it. Sources as labelled;
  // the ghost's source was the marker, so the wrapper dropped it: unknown, and the fix line.
  const want = [
    "    source = who wrote the text, as your app labelled it: app (your own text), user (the person using the feature), outside (anyone else), unknown (not labelled)",
    "    1 system                            42 bytes   28%",
    "        intro                           18 bytes   source: app (labelled by app)",
    "        marker                          24 bytes   source: outside (labelled by app)",
    "        rest of message 1                0 bytes   source: unknown (not labelled)",
    "    2 ?                                 25 bytes   16%   source: unknown (no parts named)",
    "    3 user                               – bytes   not measured (content wasn't a string)   source: unknown (no parts named)",
    "    4 assistant                         13 bytes   9%   source: unknown (no parts named)",
    "    5 user                              72 bytes   47%",
    "        ?                               24 bytes   source: user (labelled by app)",
    "        ghost                            – bytes   not found in message 5 (the text given isn't in it)   source: unknown (not labelled)",
    "        no rest of message 5: not every part was found in it",
    "    total (4 of 5 measured)            152 bytes",
    "        no by-source totals: message 3 wasn't measured",
  ];

  check(out.code === 0, `exits 0 (got ${out.code})`);
  check(at !== -1, "prints the prompt sizes heading: the same in both marked visits");
  check(JSON.stringify(lines.slice(at + 1, at + 1 + want.length)) === JSON.stringify(want),
    `the rows: system, ? (a role that was text), user not measured, assistant, user, total of 4 measured (got:\n${lines.slice(at + 1, at + 1 + want.length).join("\n")})`);
  check(!out.stdout.includes(SECRET), "the marker isn't in the terminal output");
  check(!out.stderr.includes(SECRET), "the marker isn't in stderr");
  // Advice: the unlabelled-part fix moved there, and the part labelled outside named with its bytes.
  const adviceAt = lines.indexOf("Advice — from this run's numbers");
  const advice = adviceAt === -1 ? [] : lines.slice(adviceAt + 1, lines.findIndex((l, i) => i > adviceAt && !l.startsWith("    ")));
  check(advice.includes('    - 1 part not labelled (ghost): add source: "app", "user" or "outside" to each in run.prompt() — needs caliper-timings 0.6.0; see its README, "Choosing a source"'),
    `Advice has the unlabelled-part line (got: ${advice.join(" | ") || "no Advice section"})`);
  check(advice.some((l) => l.startsWith("    - marker (24 bytes): your app labelled it outside")), `Advice names the part labelled outside (got: ${advice.join(" | ") || "no Advice section"})`);
  check(!out.stdout.split("\n").slice(at, adviceAt === -1 ? undefined : adviceAt).some((l) => l.includes("not labelled (ghost)")), "the unlabelled-part line isn't in the prompt sizes any more");
  // Advice right after the verdict, which ends with how many things there are to look at.
  const verdictAt = lines.indexOf("verdict");
  const count = advice.filter((l) => l.startsWith("    - ")).length;
  check(verdictAt !== -1 && adviceAt > verdictAt && lines[adviceAt - 1] === `    ${count} thing${count === 1 ? "" : "s"} to look at ↓` && lines.slice(verdictAt, adviceAt).every((l, i) => i === 0 || l.startsWith("    ")),
    `Advice comes right after the verdict, whose last line counts its ${count} items (got: ${lines.slice(verdictAt, adviceAt + 1).join(" | ")})`);
  check(at > 0 && lines[at - 1] === "  Request Map — what's inside each AI request (sizes only)", `the Request Map title is right above the prompt sizes (got: ${lines[at - 1] ?? "nothing"})`);
  check(html.length > 0, "the report was written");
  check(html.includes("<h3>Request Map — what's inside each AI request (sizes only)</h3>"), "the HTML report titles the section Request Map");
  check(html.includes("<h4>Prompt sizes (the same in marked visits 1, 2)</h4>") && html.includes('<tr><th scope="row">5 user</th><td class="num">72</td><td>47%</td><td class="source"></td></tr>'),
    "the HTML report has the prompt sizes table, with the terminal's numbers");
  check(html.includes(`<tr class="part"><th scope="row">ghost</th><td class="num">–</td><td>not found in message 5 (the text given isn't in it)</td><td class="source"><span class="src src-unknown"></span>unknown <span class="muted">not labelled</span></td></tr>`),
    "the HTML report has the parts, with the not-found one");
  check(html.includes(`<tr class="part"><th scope="row">marker</th><td class="num">24</td><td></td><td class="source"><span class="src src-outside"></span>outside <span class="muted">labelled by app</span></td></tr>`),
    "the HTML report has each part's source");
  check(out.stdout.includes(`prompt part 4: source isn't "app", "user" or "outside"; recorded without a source`),
    "the wrapper's problem about the ghost's source is printed, by number only");
  check(!html.includes(SECRET), "the marker isn't in the HTML report");
  if (failed) console.log(`${out.stdout}\n${out.stderr}`.replace(/^/gm, "     | "));
} finally {
  server.closeAllConnections(); // a killed CLI's browser can leave one open, and close() would wait for it
  server.close();
}
process.exitCode = failed ? 1 : 0;

// Unit tests for the "Inside the server" block, on fixed records (the end-to-end runs in
// test:marked can't pin timings). Run with `npm run test:serverblock` (Node 22.18+ runs .ts directly).

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReport, serverSection, type ReportInput } from "../src/report.ts";
import { formatServerBlock, parseServerRecord, serverBlock, type ServerRecord, type ServerReport } from "../src/serverblock.ts";

// The visits of one block, from plain records (id is the run id each one is parsed against).
function visits(...records: { marks: Record<string, number>; status?: number; runtime?: string; problems?: unknown; prompt?: unknown }[]) {
  return records.map((r, i) => {
    const parsed = parseServerRecord({ id: `run${i + 1}`, status: 200, ...r }, `run${i + 1}`);
    assert.equal(typeof parsed, "object", `record ${i + 1} parses: ${parsed as string}`);
    return { visit: i + 1, record: parsed as ServerRecord };
  });
}
const lines = (block: string) => block.split("\n");
const text = (v: ReturnType<typeof visits>, n: number) => formatServerBlock(serverBlock(v, n));
const FIRST_BYTES = "  first bytes sent = the server's first write to the browser. If your app writes anything before the model's reply (a heartbeat, an envelope), this is that write.";
const SIZES_HEAD = (visit: number) => `  prompt sizes (marked visit ${visit}) — UTF-8 bytes of each message's text as your app passed it to run.prompt(); not tokens`;
const NONE = "  prompt sizes: none recorded (needs caliper-timings 0.2.0 or later, and run.prompt(messages) before the model call)";

test("one visit, Quill's record: marks in order, the postgres span and the model span", () => {
  const block = text(visits({ marks: { postgresStart: 1, postgresEnd: 301, modelCallSent: 301, firstChunk: 402 } }), 1);
  assert.equal(block, [
    "Inside the server (from 1 of 1 marked run) — ms after the request arrived, status 200",
    "    postgresStart                        1 ms",
    "    postgresEnd                        301 ms",
    "    model call sent                    301 ms",
    "    server: first bytes sent           402 ms",
    "  spans",
    "    postgres                           300 ms   (postgresStart → postgresEnd)",
    "    model call → first bytes sent      101 ms",
    NONE,
    FIRST_BYTES,
  ].join("\n"));
});

test("one visit: each pair without a valid span gets one line with the reason", () => {
  const block = text(visits({ marks: { cacheStart: 10, warmupEnd: 20, lockEnd: 58, lockStart: 63 } }), 1);
  assert.deepEqual(lines(block).slice(-5), [
    "  spans",
    "    no cache span: cacheEnd wasn't recorded",
    "    no warmup span: warmupStart wasn't recorded",
    "    no lock span: lockEnd (58 ms) is before lockStart (63 ms)",
    NONE,
  ]);
});

test("several visits, same reason and same values: one line for the pair, naming how many visits", () => {
  const r = { marks: { cacheStart: 10, lockEnd: 58, lockStart: 63 } };
  const block = text(visits(r, r, r), 3);
  assert.ok(lines(block).includes("    no cache span in 3 of 3 visits: cacheEnd wasn't recorded"), block);
  assert.ok(lines(block).includes("    no lock span in 3 of 3 visits: lockEnd (58 ms) is before lockStart (63 ms)"), block);
  assert.equal(lines(block).filter((l) => l.startsWith("    no ")).length, 2, block);
});

test("several visits, reversed with different values: one line, with each visit's values", () => {
  const block = text(visits({ marks: { lockEnd: 58, lockStart: 63 } }, { marks: { lockEnd: 59, lockStart: 64 } }), 2);
  assert.ok(lines(block).includes(
    "    no lock span in 2 of 2 visits: lockEnd is before lockStart (visit 1: lockEnd 58 ms, lockStart 63 ms · visit 2: lockEnd 59 ms, lockStart 64 ms)",
  ), block);
});

test("several visits, some with the span: the line names the visits without it", () => {
  const ok = { marks: { cacheStart: 10, cacheEnd: 30 } };
  const broken = { marks: { cacheStart: 10 } };
  const block = text(visits(ok, broken, broken), 3);
  assert.ok(lines(block).includes("    no cache span in 2 of 3 visits (2, 3): cacheEnd wasn't recorded"), block);
  assert.ok(/^    cache +20 +– +–/m.test(block), block);
  const one = text(visits(ok, broken), 2);
  assert.ok(lines(one).includes("    no cache span in 1 of 2 visits (2): cacheEnd wasn't recorded"), one);
});

test("several visits, different reasons: one line, with each visit's reason", () => {
  const block = text(visits({ marks: { cacheStart: 50 } }, { marks: { cacheEnd: 40, cacheStart: 50 } }), 2);
  assert.ok(lines(block).includes(
    "    no cache span in 2 of 2 visits: visit 1: cacheEnd wasn't recorded · visit 2: cacheEnd (40 ms) is before cacheStart (50 ms)",
  ), block);
});

test("problems the server reported are printed, last, under their own heading", () => {
  const problem = 'mark name "db-start" rejected — use a letter, then up to 63 letters, digits or _ (e.g. dbStart)';
  const block = text(visits({ marks: { dbStart: 1, dbEnd: 301 }, runtime: "workers", problems: [problem] }), 1);
  assert.deepEqual(lines(block).slice(-4), [
    "    Workers time waits only — a span with only computation inside (no I/O) can read 0 ms.",
    NONE,
    "  problems reported by the server",
    `    ${problem}`,
  ]);
});

test("no problems: no problems heading", () => {
  const block = text(visits({ marks: { dbStart: 1 } }, { marks: { dbStart: 1 }, problems: [] }), 2);
  assert.ok(!block.includes("problems"), block);
});

test("several visits: each distinct problem once, with the visits that reported it", () => {
  const a = "mark name \"db-start\" rejected — use a letter, then up to 63 letters, digits or _ (e.g. dbStart)";
  const b = "mark name \"x y\" rejected — use a letter, then up to 63 letters, digits or _ (e.g. dbStart)";
  const block = text(visits({ marks: {}, problems: [a] }, { marks: {}, problems: [a, b] }, { marks: {}, problems: [a] }), 3);
  assert.deepEqual(lines(block).slice(-3), [
    "  problems reported by the server",
    `    ${a}   (3 of 3 visits)`,
    `    ${b}   (1 of 3 visits: 2)`,
  ]);
});

test("a problem's control characters are shown escaped, and a long one is cut", () => {
  const block = text(visits({ marks: {}, problems: ["bad \u001b[31mred\u001b[0m\nnext", "x".repeat(400)] }), 1);
  assert.ok(lines(block).includes("    bad \\u001b[31mred\\u001b[0m\\u000anext"), block);
  assert.ok(lines(block).includes(`    ${"x".repeat(200)}…`), block);
  assert.ok(!block.includes("\u001b"), "no raw escape character reaches the terminal");
});

test("a record whose problems aren't a list of strings can't be used, and says why", () => {
  for (const problems of ["one", [1], [null], {}]) {
    assert.equal(
      parseServerRecord({ id: "run1", status: 200, marks: {}, problems }, "run1"),
      "the record for run run1 has a problems field that isn't a list of strings.",
      JSON.stringify(problems),
    );
  }
  assert.equal(typeof parseServerRecord({ id: "run1", status: 200, marks: {} }, "run1"), "object", "no problems field is fine");
});

test("the first-bytes line is under the block only when a visit recorded firstChunk", () => {
  const with1 = text(visits({ marks: { firstChunk: 40 } }, { marks: {} }), 2);
  assert.equal(lines(with1).at(-1), FIRST_BYTES, with1);
  const without = text(visits({ marks: { dbStart: 1, dbEnd: 5 } }), 1);
  assert.ok(!without.includes("first bytes sent"), without);
});

// --- The same block in the HTML report ---

// The table rows of the HTML server section: label (without its note) → cell texts.
function htmlRows(html: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const [, head, body] of html.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/gs)) {
    rows.set(head!.replace(/<span.*$/s, ""), [...body!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => m[1]!));
  }
  return rows;
}
// The same rows from the terminal block: label → each visit's value, then min, median, max ("" when not shown).
function textRows(block: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const [, label, cells, min, med, max] of block.matchAll(/^    (\S.*?) {2,}((?:\d+|–)(?: +(?:\d+|–))*)(?:   min (\d+) · median (\d+) · max (\d+))? ms/gm)) {
    rows.set(label!, [...cells!.trim().split(/ +/), ...(cells!.trim().split(/ +/).length > 1 ? [min ?? "", med ?? "", max ?? ""] : [])]);
  }
  return rows;
}
const report = (v: ReturnType<typeof visits>, n: number, lines: string[] = []): ServerReport => ({ lines, block: serverBlock(v, n) });
const PRECHECK = "Server timings — pre-check: feature on, token accepted (400 on caliper.precheck)";

test("HTML: every mark and span row has the terminal's numbers, per visit and min · median · max", () => {
  const v = visits(
    { marks: { postgresStart: 1, postgresEnd: 42, modelCallSent: 42, firstChunk: 343 } },
    { marks: { postgresStart: 31, postgresEnd: 42, modelCallSent: 42 } },
    { marks: { postgresStart: 10, postgresEnd: 81, modelCallSent: 81, firstChunk: 382 } },
  );
  const terminal = textRows(text(v, 3));
  const html = htmlRows(serverSection(report(v, 3)));
  assert.deepEqual(
    [...terminal.keys()],
    ["postgresStart", "postgresEnd", "model call sent", "server: first bytes sent", "postgres", "model call → first bytes sent"],
  );
  assert.deepEqual([...html.keys()], [...terminal.keys()]);
  for (const [label, cells] of terminal) assert.deepEqual(html.get(label), cells, label);
  assert.deepEqual(html.get("server: first bytes sent"), ["343", "–", "382", "343", "363", "382"]);
});

test("HTML: one visit has one value column and no min · median · max", () => {
  const html = serverSection(report(visits({ marks: { dbStart: 1, dbEnd: 301 } }), 1));
  assert.deepEqual(htmlRows(html).get("db"), ["300"]);
  assert.ok(!html.includes("median"), html);
});

test("HTML: the pre-check and visit lines, broken pairs, Workers note, problems and first-bytes line", () => {
  const problem = 'mark name "db-start" rejected — use a letter, then up to 63 letters, digits or _ (e.g. dbStart)';
  const visitLines = [PRECHECK, "Server timings — marked visit 1 of 2 sent x-caliper-run abc on POST http://x/reply (matched POST http://x/reply)", "Server timings ? — marked visit 2 of 2: no request matched POST http://x/reply"];
  const html = serverSection(report(visits({ marks: { cacheStart: 10, lockEnd: 58, lockStart: 63, firstChunk: 90 }, runtime: "workers", problems: [problem] }), 2, visitLines));
  for (const want of [
    "Inside the server",
    "From separate marked runs, on the server's clock. Never added to the browser timings above: different runs, different clocks.",
    PRECHECK,
    "Server timings ? — marked visit 2 of 2: no request matched POST http://x/reply",
    "Inside the server (from 1 of 2 marked runs) — ms after the request arrived, status 200",
    "no cache span: cacheEnd wasn't recorded",
    "no lock span: lockEnd (58 ms) is before lockStart (63 ms)",
    "Workers time waits only — a span with only computation inside (no I/O) can read 0 ms.",
    "Problems reported by the server",
    "mark name &quot;db-start&quot; rejected",
    "first bytes sent = the server's first write to the browser. If your app writes anything before the model's reply (a heartbeat, an envelope), this is that write.",
  ]) assert.ok(html.includes(want), `has: ${want}\n${html}`);
});

test("HTML: with no visit succeeding, the lines are shown open and there's no table", () => {
  const lines = [PRECHECK, "Server timings ? — 0 of 3 marked visits succeeded"];
  const html = serverSection({ lines, block: null });
  assert.ok(html.includes("Server timings ? — 0 of 3 marked visits succeeded"), html);
  assert.ok(html.includes("<details open><summary>Run details</summary>"), html);
  assert.ok(!html.includes("<table"), html);
});

test("HTML: the table comes first; the pre-check and visit lines are in a collapsed Run details", () => {
  const sent = "Server timings — marked visit 1 of 1 sent x-caliper-run abc on POST http://x/reply (matched POST http://x/reply)";
  const html = serverSection(report(visits({ marks: { dbStart: 1, dbEnd: 301 } }), 1, [PRECHECK, sent]));
  const details = html.indexOf("<details><summary>Run details</summary>");
  assert.ok(details !== -1, html);
  assert.ok(html.indexOf("<table") < details, "table before Run details");
  for (const line of [PRECHECK, sent]) assert.ok(html.indexOf(line) > details, `inside Run details: ${line}`);
});

test("HTML: mark names and problems from the server are escaped", () => {
  const html = serverSection(report(visits({ marks: { "<img src=x>Start": 1 }, problems: ["<script>alert(1)</script>"] }), 1));
  assert.ok(!html.includes("<img src=x>") && !html.includes("<script>"), html);
  assert.ok(html.includes("&lt;img src=x&gt;Start") && html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), html);
});

// A minimal report input: one timed run, nothing but the timing.
function input(server: ServerReport | null): ReportInput {
  return {
    url: "http://127.0.0.1/marked", measure: { name: "^generate$" }, chat: null, output: "#out", steps: [], startedAt: new Date(0),
    summary: { cold: 500, coldUnidentified: false, median: null, worst: 500, warm: 0, warmFailed: 0, warmUnidentified: 0 },
    runs: [{ run: 1, total: 500, request: null, segments: [], clock: null, reply: { firstByte: null, preReply: [] } }],
    failed: [], unidentified: [], stop: null, double: null, canary: null, csp: null,
    streaming: { status: "unknown", verdict: "Inconclusive", checks: [], notes: [] }, checks: [], server,
    hints: { browser: null, server: null },
    verdict: ["People waited a median of 500 ms for the first word (1 warm run)."],
    bars: { browser: null, server: null },
  };
}

test("HTML report: the server section only with --server-timings, and the browser numbers are unchanged by it", () => {
  const without = renderReport(input(null));
  assert.ok(!without.includes("Inside the server"), "no server section without --server-timings");
  const v = visits({ marks: { modelCallSent: 100, firstChunk: 9000 } });
  const withServer = renderReport(input(report(v, 1, [PRECHECK])));
  assert.ok(withServer.includes("Inside the server"));
  // Everything but the two server sections (the top one and the marks table in the details), and
  // the details summary that names them.
  const cut = (html: string, id: string) => {
    const at = html.indexOf(`<section aria-labelledby="${id}">`);
    return at === -1 ? html : html.slice(0, at) + html.slice(html.indexOf("</section>", at) + "</section>".length);
  };
  const browserPart = (html: string) => cut(cut(html, "server-top-h"), "server-h").replace(", server marks</summary>", "</summary>").replace(/\n\s*\n/g, "\n");
  assert.equal(browserPart(withServer), browserPart(without), "verdict, tiles, timeline and tables are the same with and without server numbers");
  assert.ok(!browserPart(withServer).includes("9000") && !browserPart(withServer).includes("8900"), "no server number in the browser part");
});

// Prompt sizes (caliper-timings 0.2.0's run.prompt): each message's role and bytes, never text.
const QUILL_MARKS = { postgresStart: 1, postgresEnd: 301, modelCallSent: 301, firstChunk: 402 };
const promptLines = (block: string) => lines(block).filter((l) => l.startsWith("  prompt sizes") || /^    (\d+ \S+|total)/.test(l));

test("prompt sizes: one row per message with its role, bytes and share of the total, then the total", () => {
  const prompt = { messages: [{ role: "system", bytes: 2310 }, { role: "user", bytes: 5874 }] };
  const block = text(visits({ marks: QUILL_MARKS, prompt }), 1);
  assert.deepEqual(promptLines(block), [
    SIZES_HEAD(1),
    "    1 system                          2310 bytes   28%",
    "    2 user                            5874 bytes   72%",
    "    total                             8184 bytes",
  ]);
  // After the spans, before the first-bytes line.
  assert.ok(lines(block).indexOf(SIZES_HEAD(1)) > lines(block).indexOf("    model call → first bytes sent      101 ms"), block);
  assert.ok(lines(block).indexOf(SIZES_HEAD(1)) < lines(block).indexOf(FIRST_BYTES), block);
});

test("prompt sizes: a message with no size says so, and the total counts the measured ones only", () => {
  const prompt = { messages: [{ role: "system", bytes: 100 }, { role: "?", bytes: null }, { role: "user", bytes: 300 }] };
  assert.deepEqual(promptLines(text(visits({ marks: QUILL_MARKS, prompt }), 1)).slice(1), [
    "    1 system                           100 bytes   25%",
    "    2 ?                                  – bytes   not measured (content wasn't a string)",
    "    3 user                             300 bytes   75%",
    "    total (2 of 3 measured)            400 bytes",
  ]);
});

test("prompt sizes: an empty prompt or a zero total has no percentages", () => {
  assert.deepEqual(promptLines(text(visits({ marks: QUILL_MARKS, prompt: { messages: [{ role: "user", bytes: 0 }] } }), 1)).slice(1), [
    "    1 user                               0 bytes",
    "    total                                0 bytes",
  ]);
  const empty = lines(text(visits({ marks: QUILL_MARKS, prompt: { messages: [] } }), 1));
  assert.deepEqual(empty.slice(empty.indexOf(SIZES_HEAD(1)) + 1, empty.indexOf(SIZES_HEAD(1)) + 2), ["    no messages"]);
  assert.ok(!empty.some((l) => l.startsWith("    total")), empty.join("\n"));
});

test("prompt sizes: no visit recorded any, one line says what's needed", () => {
  const block = text(visits({ marks: QUILL_MARKS }, { marks: QUILL_MARKS }), 2);
  assert.ok(lines(block).includes(NONE), block);
  assert.equal(promptLines(block).length, 1, block);
});

test("prompt sizes: from the first visit that recorded one, named in the heading", () => {
  const prompt = { messages: [{ role: "user", bytes: 10 }] };
  const block = text(visits({ marks: QUILL_MARKS }, { marks: QUILL_MARKS, prompt }), 2);
  assert.equal(promptLines(block)[0], SIZES_HEAD(2));
  assert.ok(!lines(block).includes(NONE), block);
});

test("prompt sizes: a malformed prompt keeps the visit's timings and says why, never showing the role", () => {
  const cases: [unknown, string][] = [
    ["a string", "the prompt field isn't { messages: [...] }"],
    [{ messages: "x" }, "the prompt field isn't { messages: [...] }"],
    [{ messages: [{ role: "You are a secret system prompt", bytes: 5 }] }, "message 1's role isn't a lowercase name of up to 32 letters or _ (or \"?\"), so the prompt isn't shown"],
    [{ messages: [{ role: "user", bytes: 5 }, { role: "user", bytes: -1 }] }, "message 2's bytes isn't a whole number ≥ 0 or null"],
    [{ messages: [{ role: "user", bytes: 1.5 }] }, "message 1's bytes isn't a whole number ≥ 0 or null"],
    [{ messages: [{ role: "user" }] }, "message 1's bytes isn't a whole number ≥ 0 or null"],
    [{ messages: [null] }, "message 1 isn't { role, bytes }"],
  ];
  for (const [prompt, why] of cases) {
    const block = text(visits({ marks: QUILL_MARKS, prompt }), 1);
    assert.ok(lines(block).includes("    postgres                           300 ms   (postgresStart → postgresEnd)"), block);
    assert.ok(lines(block).includes(`  prompt sizes ? — marked visit 1: ${why}`), `${JSON.stringify(prompt)}\n${block}`);
    assert.ok(!block.includes("secret system prompt"), block);
    assert.ok(!lines(block).includes(NONE), block);
  }
});

// Prompt sizes in the HTML report: the terminal's rows, as a table under the marks and spans.
test("HTML: prompt sizes are a table with the terminal's rows: bytes and share per message, then the total", () => {
  const prompt = { messages: [{ role: "system", bytes: 2310 }, { role: "user", bytes: 5874 }] };
  const html = serverSection(report(visits({ marks: QUILL_MARKS, prompt }), 1));
  assert.ok(html.includes("<h3>Prompt sizes (marked visit 1)</h3>"), html);
  assert.ok(html.includes("UTF-8 bytes of each message's text as your app passed it to run.prompt(); not tokens"), html);
  const rows = htmlRows(html);
  assert.deepEqual(rows.get("1 system"), ["2310", "28%"]);
  assert.deepEqual(rows.get("2 user"), ["5874", "72%"]);
  assert.deepEqual(rows.get("total"), ["8184", ""]);
  // The prompt table comes after the marks and spans table.
  assert.ok(html.indexOf("Prompt sizes") > html.indexOf("model call → first bytes sent"), html);
});

test("HTML: a message with no size, and the total of the measured ones", () => {
  const prompt = { messages: [{ role: "system", bytes: 100 }, { role: "?", bytes: null }, { role: "user", bytes: 300 }] };
  const rows = htmlRows(serverSection(report(visits({ marks: QUILL_MARKS, prompt }), 1)));
  assert.deepEqual(rows.get("2 ?"), ["–", "not measured (content wasn't a string)"]);
  assert.deepEqual(rows.get("total (2 of 3 measured)"), ["400", ""]);
});

test("HTML: none recorded, no messages, and an unreadable prompt each get their line, and no table", () => {
  const none = serverSection(report(visits({ marks: QUILL_MARKS }), 1));
  assert.ok(none.includes("prompt sizes: none recorded (needs caliper-timings 0.2.0 or later, and run.prompt(messages) before the model call)"), none);
  assert.ok(!none.includes("<h3>Prompt sizes"), none);
  const empty = serverSection(report(visits({ marks: QUILL_MARKS, prompt: { messages: [] } }), 1));
  assert.ok(empty.includes("<h3>Prompt sizes (marked visit 1)</h3>") && empty.includes("no messages"), empty);
  assert.ok(!htmlRows(empty).has("total"), empty);
  const bad = serverSection(report(visits({ marks: QUILL_MARKS, prompt: { messages: "x" } }), 1));
  assert.ok(bad.includes("prompt sizes ? — marked visit 1: the prompt field isn't { messages: [...] }"), bad);
  assert.ok(!bad.includes("<h3>Prompt sizes"), bad);
});

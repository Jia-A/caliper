// Unit tests for the "Inside the server" block, on fixed records (the end-to-end runs in
// test:marked can't pin timings). Run with `npm run test:serverblock` (Node 22.18+ runs .ts directly).

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReport, serverSection, type ReportInput } from "../src/report.ts";
import { formatServerBlock, parseServerRecord, serverBlock, type ServerRecord, type ServerReport } from "../src/serverblock.ts";

// The visits of one block, from plain records (id is the run id each one is parsed against).
function visits(...records: { marks: Record<string, number>; status?: number; runtime?: string; problems?: unknown }[]) {
  return records.map((r, i) => {
    const parsed = parseServerRecord({ id: `run${i + 1}`, status: 200, ...r }, `run${i + 1}`);
    assert.equal(typeof parsed, "object", `record ${i + 1} parses: ${parsed as string}`);
    return { visit: i + 1, record: parsed as ServerRecord };
  });
}
const lines = (block: string) => block.split("\n");
const text = (v: ReturnType<typeof visits>, n: number) => formatServerBlock(serverBlock(v, n));
const FIRST_BYTES = "  first bytes sent = the server's first write to the browser. If your app writes anything before the model's reply (a heartbeat, an envelope), this is that write.";

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
    FIRST_BYTES,
  ].join("\n"));
});

test("one visit: each pair without a valid span gets one line with the reason", () => {
  const block = text(visits({ marks: { cacheStart: 10, warmupEnd: 20, lockEnd: 58, lockStart: 63 } }), 1);
  assert.deepEqual(lines(block).slice(-4), [
    "  spans",
    "    no cache span: cacheEnd wasn't recorded",
    "    no warmup span: warmupStart wasn't recorded",
    "    no lock span: lockEnd (58 ms) is before lockStart (63 ms)",
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
  assert.deepEqual(lines(block).slice(-3), [
    "    Workers time waits only — a span with only computation inside (no I/O) can read 0 ms.",
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

test("HTML: with no visit succeeding, the lines are shown and there's no table", () => {
  const lines = [PRECHECK, "Server timings ? — 0 of 3 marked visits succeeded"];
  const html = serverSection({ lines, block: null });
  assert.ok(html.includes("Server timings ? — 0 of 3 marked visits succeeded"), html);
  assert.ok(!html.includes("<table"), html);
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
  };
}

test("HTML report: the server section only with --server-timings, and the browser numbers are unchanged by it", () => {
  const without = renderReport(input(null));
  assert.ok(!without.includes("Inside the server"), "no server section without --server-timings");
  const v = visits({ marks: { modelCallSent: 100, firstChunk: 9000 } });
  const withServer = renderReport(input(report(v, 1, [PRECHECK])));
  assert.ok(withServer.includes("Inside the server"));
  const browserPart = (html: string) => html.slice(0, html.indexOf('<section aria-labelledby="streaming-h">'));
  assert.equal(browserPart(withServer), browserPart(without), "tiles, timeline and tables are the same with and without server numbers");
  assert.ok(!browserPart(withServer).includes("9000") && !browserPart(withServer).includes("8900"), "no server number in the browser part");
});

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
const TITLE = "  Request Map — what's inside each AI request (sizes only)";
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
    TITLE,
    NONE,
    FIRST_BYTES,
  ].join("\n"));
});

test("one visit: each pair without a valid span gets one line with the reason", () => {
  const block = text(visits({ marks: { cacheStart: 10, warmupEnd: 20, lockEnd: 58, lockStart: 63 } }), 1);
  assert.deepEqual(lines(block).slice(-6), [
    "  spans",
    "    no cache span: cacheEnd wasn't recorded",
    "    no warmup span: warmupStart wasn't recorded",
    "    no lock span: lockEnd (58 ms) is before lockStart (63 ms)",
    TITLE,
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
  assert.deepEqual(lines(block).slice(-5), [
    "    Workers time waits only — a span with only computation inside (no I/O) can read 0 ms.",
    TITLE,
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
const PRECHECK = "Server timings — pre-check: feature on, token accepted (expected 400 on the test id caliper.precheck)";

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
    streaming: { status: "unknown", verdict: "Inconclusive", checks: [], notes: [] }, checks: [], server, advice: [],
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
  assert.ok(html.includes("<h4>Prompt sizes (marked visit 1)</h4>"), html);
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
  assert.ok(!none.includes("<h4>Prompt sizes"), none);
  const empty = serverSection(report(visits({ marks: QUILL_MARKS, prompt: { messages: [] } }), 1));
  assert.ok(empty.includes("<h4>Prompt sizes (marked visit 1)</h4>") && empty.includes("no messages"), empty);
  assert.ok(!htmlRows(empty).has("total"), empty);
  const bad = serverSection(report(visits({ marks: QUILL_MARKS, prompt: { messages: "x" } }), 1));
  assert.ok(bad.includes("prompt sizes ? — marked visit 1: the prompt field isn't { messages: [...] }"), bad);
  assert.ok(!bad.includes("<h4>Prompt sizes"), bad);
});

// The Request Map: the prompt sizes' section title, once, right before what's there to show.
const TITLE_HTML = "<h3>Request Map — what's inside each AI request (sizes only)</h3>";
test("Request Map: the title comes once, right before the sizes, the none-recorded line or an unreadable prompt's line", () => {
  const sized = lines(text(visits({ marks: QUILL_MARKS, prompt: { messages: [{ role: "system", bytes: 10 }] } }), 1));
  const none = lines(text(visits({ marks: QUILL_MARKS }), 1));
  const bad = lines(text(visits({ marks: QUILL_MARKS, prompt: { messages: "x" } }), 1));
  for (const [what, block, next] of [["sizes", sized, SIZES_HEAD(1)], ["none", none, NONE], ["unreadable", bad, "  prompt sizes ? — marked visit 1: the prompt field isn't { messages: [...] }"]] as const) {
    assert.equal(block.filter((l) => l === TITLE).length, 1, `${what}: one title\n${block.join("\n")}`);
    assert.equal(block[block.indexOf(TITLE) + 1], next, `${what}: the title, then ${next}\n${block.join("\n")}`);
  }
});

test("HTML: the Request Map is the h3, above the prompt sizes heading; also with none recorded or an unreadable prompt", () => {
  const sized = serverSection(report(visits({ marks: QUILL_MARKS, prompt: { messages: [{ role: "system", bytes: 10 }] } }), 1));
  assert.ok(sized.includes(TITLE_HTML) && sized.indexOf(TITLE_HTML) < sized.indexOf("<h4>Prompt sizes (marked visit 1)</h4>"), sized);
  for (const prompt of [undefined, { messages: "x" }]) {
    const html = serverSection(report(visits({ marks: QUILL_MARKS, prompt }), 1));
    assert.ok(html.includes(TITLE_HTML) && html.indexOf(TITLE_HTML) < html.indexOf("prompt sizes"), html);
  }
});

// Prompt sizes over several marked visits.
const sizes = (...bytes: (number | null)[]) => ({ messages: bytes.map((b, i) => ({ role: i === 0 ? "system" : "user", bytes: b })) });

test("prompt sizes, several visits, the same in each: one table, and the heading says so", () => {
  const p = sizes(2310, 5874);
  const block = text(visits({ marks: QUILL_MARKS, prompt: p }, { marks: QUILL_MARKS, prompt: p }, { marks: QUILL_MARKS, prompt: p }), 3);
  assert.deepEqual(promptLines(block), [
    "  prompt sizes (the same in marked visits 1, 2, 3) — UTF-8 bytes of each message's text as your app passed it to run.prompt(); not tokens",
    "    1 system                          2310 bytes   28%",
    "    2 user                            5874 bytes   72%",
    "    total                             8184 bytes",
  ]);
});

test("prompt sizes, several visits, same messages but different sizes: a column per visit, then min · median · max", () => {
  const block = text(visits({ marks: QUILL_MARKS, prompt: sizes(2310, 5874) }, { marks: QUILL_MARKS, prompt: sizes(2310, 5900) }, { marks: QUILL_MARKS, prompt: sizes(2310, 5850) }), 3);
  const at = lines(block).findIndex((l) => l.startsWith("  prompt sizes"));
  assert.deepEqual(lines(block).slice(at, at + 5), [
    "  prompt sizes (marked visits 1, 2, 3) — UTF-8 bytes of each message's text as your app passed it to run.prompt(); not tokens",
    "    marked visit                         1     2     3",
    "    1 system                          2310  2310  2310   min 2310 · median 2310 · max 2310 bytes",
    "    2 user                            5874  5900  5850   min 5850 · median 5874 · max 5900 bytes",
    "    total                             8184  8210  8160   min 8160 · median 8184 · max 8210 bytes",
  ]);
});

test("prompt sizes, several visits: a message not measured in some shows –, and the total says measured only", () => {
  const block = text(visits({ marks: QUILL_MARKS, prompt: sizes(100, 300) }, { marks: QUILL_MARKS, prompt: sizes(100, null) }), 2);
  const at = lines(block).findIndex((l) => l.startsWith("  prompt sizes"));
  assert.deepEqual(lines(block).slice(at + 2, at + 5), [
    "    1 system                           100   100   min 100 · median 100 · max 100 bytes",
    "    2 user                             300     – bytes   not measured in marked visit 2 (content wasn't a string)",
    "    total (measured only)              400   100   min 100 · median 250 · max 400 bytes",
  ]);
});

test("prompt sizes, several visits with different messages: the first visit's table, and a line per visit that differs", () => {
  const other = { messages: [{ role: "system", bytes: 2310 }, { role: "user", bytes: 10 }, { role: "user", bytes: 20 }] };
  const block = text(visits({ marks: QUILL_MARKS, prompt: sizes(2310, 5874) }, { marks: QUILL_MARKS, prompt: other }), 2);
  assert.deepEqual(promptLines(block), [
    "  prompt sizes (marked visit 1) — UTF-8 bytes of each message's text as your app passed it to run.prompt(); not tokens",
    "    1 system                          2310 bytes   28%",
    "    2 user                            5874 bytes   72%",
    "    total                             8184 bytes",
    "  prompt sizes: marked visit 2 sent different messages (3: system, user, user), so it isn't compared",
  ]);
});

test("prompt sizes, several visits, one without any: compared over the others, and a line names it", () => {
  const block = text(visits({ marks: QUILL_MARKS, prompt: sizes(1, 2) }, { marks: QUILL_MARKS }, { marks: QUILL_MARKS, prompt: sizes(1, 2) }), 3);
  assert.equal(promptLines(block)[0], "  prompt sizes (the same in marked visits 1, 3) — UTF-8 bytes of each message's text as your app passed it to run.prompt(); not tokens");
  assert.ok(lines(block).includes("  prompt sizes: none recorded in marked visit 2"), block);
});

test("HTML: prompt sizes over several visits that differ: a column per visit, then min, median, max", () => {
  const html = serverSection(report(visits({ marks: QUILL_MARKS, prompt: sizes(2310, 5874) }, { marks: QUILL_MARKS, prompt: sizes(2310, 5900) }), 2));
  assert.ok(html.includes("<h4>Prompt sizes (marked visits 1, 2)</h4>"), html);
  const rows = htmlRows(html);
  assert.deepEqual(rows.get("2 user"), ["5874", "5900", "5874", "5887", "5900", ""]);
  assert.deepEqual(rows.get("total"), ["8184", "8210", "8184", "8197", "8210", ""]);
});

// Named parts under a message (caliper-timings 0.4.0): name, bytes, found.
const withParts = (parts: unknown, userBytes = 3328) => ({ messages: [{ role: "system", bytes: 2499 }, { role: "user", bytes: userBytes, parts }] });
const QUILL_PARTS = [
  { name: "author", bytes: 11, found: true },
  { name: "title", bytes: 21, found: true },
  { name: "code_snippet", bytes: 56, found: true },
  { name: "article", bytes: 3232, found: true },
];

test("parts: one row per part under its message, then the rest of the message", () => {
  const all = lines(text(visits({ marks: QUILL_MARKS, prompt: withParts(QUILL_PARTS) }), 1));
  const at = all.indexOf("    1 system                          2499 bytes   43%   source: unknown (no parts named)");
  assert.deepEqual(all.slice(at, at + 8), [
    "    1 system                          2499 bytes   43%   source: unknown (no parts named)",
    "    2 user                            3328 bytes   57%",
    "        author                          11 bytes   source: unknown (not labelled)",
    "        title                           21 bytes   source: unknown (not labelled)",
    "        code_snippet                    56 bytes   source: unknown (not labelled)",
    "        article                       3232 bytes   source: unknown (not labelled)",
    "        rest of message 2                8 bytes   source: unknown (not labelled)",
    "    total                             5827 bytes",
  ]);
});

test("parts: not found, not checked, or not measured each say so, and then there's no rest", () => {
  const block = text(visits({ marks: QUILL_MARKS, prompt: withParts([
    { name: "title", bytes: 21, found: true },
    { name: "summary", bytes: 40, found: false },
  ]) }), 1);
  assert.ok(lines(block).includes("        summary                          – bytes   not found in message 2 (the text given isn't in it)   source: unknown (not labelled)"), block);
  assert.ok(lines(block).includes("        no rest of message 2: not every part was found in it"), block);
  const unchecked = text(visits({ marks: QUILL_MARKS, prompt: withParts([{ name: "title", bytes: 21, found: null }, { name: "article", bytes: null, found: null }]) }), 1);
  assert.ok(lines(unchecked).includes("        title                           21 bytes   not checked (the server couldn't compare it with the message)   source: unknown (not labelled)"), unchecked);
  assert.ok(lines(unchecked).includes("        article                          – bytes   not measured (its text wasn't a string)   source: unknown (not labelled)"), unchecked);
  assert.ok(lines(unchecked).includes("        no rest of message 2: not every part was found in it"), unchecked);
});

test("parts that add up to more than the message: they overlap or repeat, and no rest is shown", () => {
  const block = text(visits({ marks: QUILL_MARKS, prompt: withParts([{ name: "a", bytes: 30, found: true }, { name: "b", bytes: 30, found: true }], 50) }), 1);
  assert.ok(lines(block).includes("        no rest of message 2: the parts add up to 60 bytes, more than the message (they overlap or repeat)"), block);
});

test("parts: a malformed parts field makes only that message's parts unreadable; never shows a name that could be text", () => {
  const cases: [unknown, string][] = [
    ["x", "parts isn't a list"],
    [[{ name: "You are secret text", bytes: 1, found: true }], "part 1's name isn't a lowercase name of up to 32 letters or _ (or \"?\")"],
    [[{ name: "a", bytes: -1, found: true }], "part 1's bytes isn't a whole number ≥ 0 or null"],
    [[{ name: "a", bytes: 1, found: "yes" }], "part 1's found isn't true, false or null"],
    [[null], "part 1 isn't { name, bytes, found }"],
  ];
  for (const [parts, why] of cases) {
    const block = text(visits({ marks: QUILL_MARKS, prompt: withParts(parts) }), 1);
    assert.ok(lines(block).includes("    2 user                            3328 bytes   57%"), block);
    assert.ok(lines(block).includes(`        parts ? — ${why}`), `${JSON.stringify(parts)}\n${block}`);
    assert.ok(!block.includes("secret text"), block);
  }
});

test("parts, several visits the same: one table with the parts; different parts sizes: a column per visit", () => {
  const p = withParts(QUILL_PARTS);
  const same = text(visits({ marks: QUILL_MARKS, prompt: p }, { marks: QUILL_MARKS, prompt: p }), 2);
  assert.ok(lines(same).includes("        article                       3232 bytes   source: unknown (not labelled)"), same);
  const other = withParts([...QUILL_PARTS.slice(0, 3), { name: "article", bytes: 3000, found: true }], 3096);
  const diff = text(visits({ marks: QUILL_MARKS, prompt: p }, { marks: QUILL_MARKS, prompt: other }), 2);
  assert.ok(lines(diff).includes("        article                       3232  3000   min 3000 · median 3116 · max 3232 bytes   source: unknown (not labelled)"), diff);
  assert.ok(lines(diff).includes("        rest of message 2                8     8   min 8 · median 8 · max 8 bytes   source: unknown (not labelled)"), diff);
});

test("parts: visits whose parts have different names aren't compared", () => {
  const other = withParts([{ name: "body", bytes: 3320, found: true }]);
  const block = text(visits({ marks: QUILL_MARKS, prompt: withParts(QUILL_PARTS) }, { marks: QUILL_MARKS, prompt: other }), 2);
  assert.ok(lines(block).includes("  prompt sizes: marked visit 2 named different parts, so it isn't compared"), block);
});

test("HTML: parts rows under their message, with the terminal's cells", () => {
  const html = serverSection(report(visits({ marks: QUILL_MARKS, prompt: withParts([{ name: "title", bytes: 21, found: true }, { name: "summary", bytes: 40, found: false }]) }), 1));
  assert.ok(html.includes('<tr class="part"><th scope="row">title</th><td class="num">21</td><td></td><td class="source"><span class="src src-unknown"></span>unknown <span class="muted">not labelled</span></td></tr>'), html);
  assert.ok(html.includes(`<tr class="part"><th scope="row">summary</th><td class="num">–</td><td>not found in message 2 (the text given isn't in it)</td><td class="source"><span class="src src-unknown"></span>unknown <span class="muted">not labelled</span></td></tr>`), html);
  assert.ok(html.includes('<tr class="part note"><th scope="row" colspan="4">no rest of message 2: not every part was found in it</th></tr>'), html);
});

// Who wrote each part (caliper-timings 0.6.0's source): as the app labelled it, never guessed.
const LABELLED = [
  { name: "instructions", bytes: 2499, found: true, source: "app" },
];
const QUILL_LABELLED = [
  { name: "author", bytes: 11, found: true, source: "user" },
  { name: "title", bytes: 21, found: true, source: "user" },
  { name: "code_snippet", bytes: 56, found: true, source: "app" },
  { name: "article", bytes: 3232, found: true, source: "user" },
];
const labelled = (sys: unknown = LABELLED, user: unknown = QUILL_LABELLED) => ({ messages: [{ role: "system", bytes: 2499, parts: sys }, { role: "user", bytes: 3328, parts: user }] });
const LEGEND = "    source = who wrote the text, as your app labelled it: app (your own text), user (the person using the feature), outside (anyone else), unknown (not labelled)";
const FIX = (n: number, names: string) => `    ${n} part${n > 1 ? "s" : ""} not labelled (${names}): add source: "app", "user" or "outside" to each in run.prompt() — needs caliper-timings 0.6.0; see its README, "Choosing a source"`;

test("source: each part says who wrote it, labelled by app; the rest of a message is unknown; a legend, and no fix line when all are labelled", () => {
  const all = lines(text(visits({ marks: QUILL_MARKS, prompt: labelled() }), 1));
  const at = all.indexOf(SIZES_HEAD(1));
  assert.deepEqual(all.slice(at, at + 12), [
    SIZES_HEAD(1),
    LEGEND,
    "    1 system                          2499 bytes   43%",
    "        instructions                  2499 bytes   source: app (labelled by app)",
    "        rest of message 1                0 bytes   source: unknown (not labelled)",
    "    2 user                            3328 bytes   57%",
    "        author                          11 bytes   source: user (labelled by app)",
    "        title                           21 bytes   source: user (labelled by app)",
    "        code_snippet                    56 bytes   source: app (labelled by app)",
    "        article                       3232 bytes   source: user (labelled by app)",
    "        rest of message 2                8 bytes   source: unknown (not labelled)",
    "    total                             5827 bytes",
  ]);
  assert.ok(!all.some((l) => l.includes("not labelled (")), "no fix line");
});

test("source: outside is shown as outside", () => {
  const block = text(visits({ marks: QUILL_MARKS, prompt: labelled(LABELLED, [{ name: "comments", bytes: 3328, found: true, source: "outside" }]) }), 1);
  assert.ok(lines(block).includes("        comments                      3328 bytes   source: outside (labelled by app)"), block);
});

test("source: unlabelled parts are unknown, and the view names them with the fix (shown in Advice, not here); a message without parts is unknown too", () => {
  const user = [{ name: "title", bytes: 21, found: true, source: "user" }, { name: "article", bytes: 3232, found: true }, { name: "author", bytes: 11, found: true }];
  const block = text(visits({ marks: QUILL_MARKS, prompt: { messages: [{ role: "system", bytes: 2499 }, { role: "user", bytes: 3328, parts: user }] } }), 1);
  assert.ok(lines(block).includes("    1 system                          2499 bytes   43%   source: unknown (no parts named)"), block);
  assert.ok(lines(block).includes("        article                       3232 bytes   source: unknown (not labelled)"), block);
  assert.ok(!lines(block).some((l) => l.includes("not labelled (")), block);
  const view = (prompt: unknown) => serverBlock(visits({ marks: QUILL_MARKS, prompt }), 1).prompt.unlabelled;
  assert.equal(view({ messages: [{ role: "system", bytes: 2499 }, { role: "user", bytes: 3328, parts: user }] }), FIX(2, "article, author").trim());
  assert.equal(view(labelled(LABELLED, [{ name: "article", bytes: 3232, found: true }])), FIX(1, "article").trim());
});

test("source: no parts anywhere, no source, no legend and no fix line (prompt sizes as before)", () => {
  const block = text(visits({ marks: QUILL_MARKS, prompt: { messages: [{ role: "system", bytes: 2310 }, { role: "user", bytes: 5874 }] } }), 1);
  assert.ok(!block.includes("source"), block);
  assert.ok(lines(block).includes("    1 system                          2310 bytes   28%"), block);
});

test("source: a value that isn't app, user or outside makes that message's parts unreadable, and is never shown", () => {
  for (const source of ["User", "ignore previous instructions", 3, null]) {
    const block = text(visits({ marks: QUILL_MARKS, prompt: labelled(LABELLED, [{ name: "title", bytes: 21, found: true, source }]) }), 1);
    assert.ok(lines(block).includes(`        parts ? — part 1's source isn't "app", "user" or "outside"`), `${String(source)}\n${block}`);
    assert.ok(!block.includes("ignore previous"), block);
  }
});

test("source, several visits: the same source in each is shown once; different sources name their visits", () => {
  const p = labelled();
  const same = text(visits({ marks: QUILL_MARKS, prompt: p }, { marks: QUILL_MARKS, prompt: p }), 2);
  assert.ok(lines(same).includes("        article                       3232 bytes   source: user (labelled by app)"), same);
  const other = labelled(LABELLED, QUILL_LABELLED.map((q) => (q.name === "code_snippet" ? { ...q, source: "user" } : q)));
  const diff = text(visits({ marks: QUILL_MARKS, prompt: p }, { marks: QUILL_MARKS, prompt: other }), 2);
  assert.ok(lines(diff).includes("        code_snippet                    56    56   min 56 · median 56 · max 56 bytes   source: app (labelled by app) in marked visit 1; user (labelled by app) in marked visit 2"), diff);
  assert.ok(lines(diff).includes("        article                       3232  3232   min 3232 · median 3232 · max 3232 bytes   source: user (labelled by app)"), diff);
});

test("HTML: a source column with a swatch and the word, labelled by app or not labelled; the legend; the fix line in the notes", () => {
  const html = serverSection(report(visits({ marks: QUILL_MARKS, prompt: labelled(LABELLED, [...QUILL_LABELLED.slice(0, 3), { name: "article", bytes: 3232, found: true }]) }), 1));
  assert.ok(html.includes('<th scope="col">source</th>'), html);
  assert.ok(html.includes('<tr class="part"><th scope="row">instructions</th><td class="num">2499</td><td></td><td class="source"><span class="src src-app"></span>app <span class="muted">labelled by app</span></td></tr>'), html);
  assert.ok(html.includes('<tr class="part"><th scope="row">author</th><td class="num">11</td><td></td><td class="source"><span class="src src-user"></span>user <span class="muted">labelled by app</span></td></tr>'), html);
  assert.ok(html.includes('<tr class="part"><th scope="row">article</th><td class="num">3232</td><td></td><td class="source"><span class="src src-unknown"></span>unknown <span class="muted">not labelled</span></td></tr>'), html);
  assert.ok(html.includes('<tr><th scope="row">total</th><td class="num">5827</td><td></td><td class="source"></td></tr>'), html);
  assert.ok(html.includes('<span class="src src-outside"></span>outside (anyone else)'), "legend");
  assert.ok(!html.includes("not labelled (article)"), html);
  const outside = serverSection(report(visits({ marks: QUILL_MARKS, prompt: labelled(LABELLED, [{ name: "comments", bytes: 3328, found: true, source: "outside" }]) }), 1));
  assert.ok(outside.includes('<td class="source"><span class="src src-outside"></span>outside <span class="muted">labelled by app</span></td>'), outside);
  const noParts = serverSection(report(visits({ marks: QUILL_MARKS, prompt: { messages: [{ role: "user", bytes: 10 }] } }), 1));
  assert.ok(!noParts.includes("source"), noParts);
});

// By source: the bytes each source wrote, summed exactly from the parts, or why it can't be.
const BY = (label: string, values: (number | string)[], tail = "") =>
  `    ${`by source: ${label}`.padEnd(32)}${values.map((v) => String(v).padStart(6)).join("")} bytes${tail ? `   ${tail}` : ""}`;

test("by source: after the total, app, user, outside and unknown add up to it, each with its share", () => {
  const all = lines(text(visits({ marks: QUILL_MARKS, prompt: labelled() }), 1));
  const at = all.indexOf("    total                             5827 bytes");
  // app: instructions 2499 + code_snippet 56; user: 11 + 21 + 3232; unknown: the rests (0 + 8).
  assert.deepEqual(all.slice(at + 1, at + 5), [BY("app", [2555], "44%"), BY("user", [3264], "56%"), BY("outside", [0], "0%"), BY("unknown", [8], "0%")]);
});

test("by source: unlabelled parts and a message with no parts named count as unknown", () => {
  const user = [{ name: "title", bytes: 21, found: true, source: "user" }, { name: "comments", bytes: 300, found: true, source: "outside" }, { name: "article", bytes: 3000, found: true }];
  const block = text(visits({ marks: QUILL_MARKS, prompt: { messages: [{ role: "system", bytes: 2499 }, { role: "user", bytes: 3328, parts: user }] } }), 1);
  // unknown: the system message 2499 + article 3000 + rest 7.
  for (const want of [BY("app", [0], "0%"), BY("user", [21], "0%"), BY("outside", [300], "5%"), BY("unknown", [5506], "94%")]) {
    assert.ok(lines(block).includes(want), `${want}\n${block}`);
  }
});

test("by source: not shown when a message's split isn't exact, and one line says why", () => {
  const cases: [unknown, string][] = [
    [{ messages: [{ role: "system", bytes: 2499 }, { role: "user", bytes: 3328, parts: [{ name: "a", bytes: 40, found: false, source: "user" }] }] }, "message 2: not every part was found in it"],
    [{ messages: [{ role: "system", bytes: 50, parts: [{ name: "a", bytes: 30, found: true, source: "app" }, { name: "b", bytes: 30, found: true, source: "app" }] }] }, "message 1: the parts add up to more than the message"],
    [{ messages: [{ role: "system", bytes: null }, { role: "user", bytes: 10, parts: [{ name: "a", bytes: 10, found: true, source: "user" }] }] }, "message 1 wasn't measured"],
    [{ messages: [{ role: "system", bytes: 10, parts: "x" }, { role: "user", bytes: 10, parts: [{ name: "a", bytes: 10, found: true, source: "user" }] }] }, "message 1's parts couldn't be read"],
  ];
  for (const [prompt, why] of cases) {
    const block = text(visits({ marks: QUILL_MARKS, prompt }), 1);
    assert.ok(!block.includes("by source: app"), block);
    assert.ok(lines(block).includes(`        no by-source totals: ${why}`), `${why}\n${block}`);
  }
});

test("by source: none without named parts", () => {
  const block = text(visits({ marks: QUILL_MARKS, prompt: { messages: [{ role: "system", bytes: 2310 }, { role: "user", bytes: 5874 }] } }), 1);
  assert.ok(!block.includes("by source") && !block.includes("by-source"), block);
});

test("by source, several visits that differ: a column per visit, then min · median · max; a visit that can't be split is named", () => {
  const other = labelled(LABELLED, QUILL_LABELLED.map((q) => (q.name === "article" ? { ...q, bytes: 3000 } : q)));
  (other.messages[1] as { bytes: number }).bytes = 3096;
  const block = text(visits({ marks: QUILL_MARKS, prompt: labelled() }, { marks: QUILL_MARKS, prompt: other }), 2);
  assert.ok(lines(block).includes(BY("user", [3264, 3032]) .replace(" bytes", "   min 3032 · median 3148 · max 3264 bytes")), block);
  assert.ok(lines(block).includes(BY("app", [2555, 2555]).replace(" bytes", "   min 2555 · median 2555 · max 2555 bytes")), block);
  const lost = labelled(LABELLED, QUILL_LABELLED.map((q) => (q.name === "article" ? { ...q, found: false } : q)));
  const one = text(visits({ marks: QUILL_MARKS, prompt: labelled() }, { marks: QUILL_MARKS, prompt: lost }), 2);
  assert.ok(lines(one).includes("        no by-source totals: message 2: not every part was found in it (marked visit 2)"), one);
});

test("HTML: by-source rows after the total, with the swatch and the word in the source column", () => {
  const html = serverSection(report(visits({ marks: QUILL_MARKS, prompt: labelled() }), 1));
  assert.ok(html.includes('<tr class="by-source"><th scope="row">by source: user</th><td class="num">3264</td><td>56%</td><td class="source"><span class="src src-user"></span>user</td></tr>'), html);
  assert.ok(html.indexOf("by source: app") > html.indexOf('<th scope="row">total</th>'), html);
});

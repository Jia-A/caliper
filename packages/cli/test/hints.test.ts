// Unit tests for "Where to look": each segment's median against its layer's limit, browser and
// server as separate lists. Run with `npm run test:hints` (Node 22.18+ runs .ts directly).

import assert from "node:assert/strict";
import { test } from "node:test";
import { browserBar, browserHints, coldGaps, formatHints, serverBar, serverHints, STREAMS_MIN_MS, streamingVerdict, verdictLines, type Bar, type HintList } from "../src/hints.ts";
import { adviceItems, formatAdvice, STREAMS_MIN_MS as ADVICE_STREAMS_MIN_MS } from "../src/advice.ts";
import { renderReport, serverTop, type ReportInput } from "../src/report.ts";
import { formatServerBlock, parseServerRecord, serverBlock, type ServerRecord } from "../src/serverblock.ts";
import type { Segment, SegmentKey } from "../src/types.ts";

const CAVEAT = "These limits were written for whole pages or interactions; applying them to one part of the wait is Caliper's reasoning.";
const DISCLAIMER = "Caliper sees timings, not your code — these are common causes, not a diagnosis.";
const APP_SPAN = "a step your app named; Caliper can't see inside it.";

const LABELS: Record<SegmentKey, string> = {
  click: "click → request sent",
  preflight: "CORS preflight",
  connection: "connection setup",
  ttfb: "browser: response headers received",
  download: "headers → done",
  render: "done → first paint",
  streaming: "headers → first paint",
  other: "unattributed",
};
// One warm run: its segments by key (ms), total = their sum.
function run(parts: Partial<Record<SegmentKey, number | null>>) {
  const segments: Segment[] = Object.entries(parts).map(([key, ms]) => ({ key: key as SegmentKey, label: LABELS[key as SegmentKey], ms: ms ?? null }));
  return { total: Object.values(parts).reduce<number>((a, b) => a + (b ?? 0), 0), segments };
}
const labels = (list: HintList) => list.hints.map((h) => h.label);

// The server block from plain records, as the report gets it.
function block(...records: { marks: Record<string, number> }[]) {
  const visits = records.map((r, i) => ({ visit: i + 1, record: parseServerRecord({ id: `r${i}`, status: 200, ...r }, `r${i}`) as ServerRecord }));
  return serverBlock(visits, records.length);
}

test("a segment under or at its limit gets no hint", () => {
  const list = browserHints([run({ click: 200, ttfb: 600, streaming: 100 }), run({ click: 150, ttfb: 500, streaming: 90 })]);
  assert.deepEqual(list.hints, []);
  assert.equal(list.none, "Every part is within its limit.");
});

test("each browser layer uses its own limit", () => {
  // click 250 > 200, ttfb 650 > 600, connection 150 > 100, streaming 150 > 100, render 150 > 100
  const over = browserHints([run({ click: 250, connection: 150, ttfb: 650, download: 150, render: 150 }), run({ click: 250, connection: 150, ttfb: 650, download: 150, render: 150 })]);
  // Ranked by how far over: 1.5× (connection, done, first paint), 1.25× (click), 1.08× (headers).
  assert.deepEqual(labels(over), ["connection setup", "headers → done", "done → first paint", "click → request sent", "browser: response headers received"]);
  assert.deepEqual(over.hints.map((h) => h.limit), [100, 100, 100, 200, 600]);
  // The same ms under the other limits: 150 is fine for click (200), 550 for headers (600).
  const under = browserHints([run({ click: 150, ttfb: 550, streaming: 90 }), run({ click: 150, ttfb: 550, streaming: 90 })]);
  assert.deepEqual(under.hints, []);
  const preflight = browserHints([run({ click: 10, preflight: 120, ttfb: 10 }), run({ click: 10, preflight: 120, ttfb: 10 })]);
  assert.deepEqual(labels(preflight), ["CORS preflight"]);
  assert.equal(preflight.hints[0]!.limit, 100);
});

test("each server layer uses its own limit: model at 400 ms no hint, an app span at 150 ms a hint", () => {
  const list = serverHints(block({ marks: { stepStart: 0, stepEnd: 150, modelCallSent: 150, firstChunk: 550 } }));
  assert.deepEqual(labels(list), ["step"]);
  assert.equal(list.hints[0]!.limit, 100);
  const model = serverHints(block({ marks: { modelCallSent: 0, firstChunk: 460 } }));
  assert.deepEqual(labels(model), ["model call → first bytes sent"]);
  assert.equal(model.hints[0]!.limit, 450);
});

test("furthest over its own limit first, not the most ms; the first is the full hint, the rest one short line each", () => {
  // headers 900 ms is 1.5× its 600; headers → first paint 400 ms is 4.0× its 100; click 300 ms is 1.5× its 200.
  const list = browserHints([run({ click: 300, ttfb: 900, streaming: 400 }), run({ click: 300, ttfb: 900, streaming: 400 })]);
  assert.deepEqual(labels(list), ["headers → first paint", "browser: response headers received", "click → request sent"]);
  const text = formatHints(list).split("\n");
  assert.equal(text[0], "Where to look — browser (median of 2 warm runs)");
  assert.equal(text[1], "    headers → first paint: median 400 ms — 4.0× its 100 ms limit, in 2 of 2 warm runs; 25% of the browser total");
  assert.ok(text.includes(`    Limit: Nielsen / RAIL: under 100 ms feels instant. ${CAVEAT}`), text.join("\n"));
  assert.ok(text.includes("    Things to check:"), text.join("\n"));
  assert.ok(text.includes(`    ${DISCLAIMER}`), text.join("\n"));
  assert.deepEqual(text.slice(-3), [
    "  also over their limits:",
    "    browser: response headers received: median 900 ms — 1.5× its 600 ms limit, in 2 of 2 warm runs — learn more: https://web.dev/optimize-ttfb/",
    "    click → request sent: median 300 ms — 1.5× its 200 ms limit, in 2 of 2 warm runs — learn more: https://web.dev/articles/optimize-inp · https://web.dev/optimize-long-tasks/",
  ]);
  // 2 to 4 things to check, worded as possibilities.
  const checks = list.hints[0]!.checks;
  assert.ok(checks.length >= 2 && checks.length <= 4, checks.join(" | "));
});

test("every basis says the limits weren't written for one part of the wait", () => {
  const all = [
    browserHints([run({ click: 300, preflight: 200, connection: 200, ttfb: 900, download: 200, render: 200 }), run({ click: 300, preflight: 200, connection: 200, ttfb: 900, download: 200, render: 200 })]),
    browserHints([run({ ttfb: 10, streaming: 300 }), run({ ttfb: 10, streaming: 300 })]),
    serverHints(block({ marks: { aStart: 0, aEnd: 200, modelCallSent: 200, firstChunk: 900 } })),
  ];
  for (const h of all.flatMap((l) => l.hints)) assert.ok(h.basis.endsWith(` ${CAVEAT}`), `${h.label}: ${h.basis}`);
  const bases = new Set(all.flatMap((l) => l.hints.map((h) => h.basis.replace(` ${CAVEAT}`, ""))));
  assert.deepEqual([...bases].sort(), [
    `Google's INP "good" threshold is 200 ms or less (click → next paint).`,
    `Lighthouse's "Reduce server response time" audit fails above 600 ms.`,
    "MLPerf Inference, interactive scenario: 450 ms time to first token at P99 — a hardware benchmark, not a UX rule.",
    "Nielsen / RAIL: under 100 ms feels instant.",
  ].sort());
});

test("an app-named span gets the generic text, whatever its name", () => {
  const of = (name: string) => serverHints(block({ marks: { [`${name}Start`]: 0, [`${name}End`]: 300, firstChunk: 400 } })).hints[0]!;
  const postgres = of("postgres");
  const other = of("zebra");
  assert.equal(postgres.about, APP_SPAN);
  assert.deepEqual(postgres.checks, other.checks, "the things to check don't depend on the name");
  assert.ok(!/database|postgres|sql/i.test([postgres.about, ...postgres.checks].join(" ")), postgres.checks.join(" | "));
  // Short lines carry it too.
  const two = serverHints(block({ marks: { aStart: 0, aEnd: 300, bStart: 300, bEnd: 500, firstChunk: 600 } }));
  assert.ok(formatHints(two).includes(`    b: 200 ms — 2.0× its 100 ms limit, in 1 of 1 marked visits — ${APP_SPAN}`), formatHints(two));
});

test("unattributed is never hinted", () => {
  const list = browserHints([run({ other: 5000 }), run({ other: 5000 })]);
  assert.deepEqual(list.hints, []);
});

test("browser evidence: median of the warm runs' values, over-limit count, median share of each run's total", () => {
  const list = browserHints([run({ click: 10, ttfb: 700 }), run({ click: 10, ttfb: 500 }), run({ click: 10, ttfb: 900 })]);
  const [h] = list.hints;
  assert.equal(h!.median, 700);
  assert.deepEqual([h!.over, h!.of], [2, 3]);
  assert.equal(h!.share, 99); // median of 700/710, 500/510, 900/910
  assert.equal(h!.shareOf, "the browser total");
});

test("browser: the median is of the values as printed (whole ms), not of the unrounded ones", () => {
  // Printed as 312 and 311: median 312 (311.5 rounded). Unrounded, 311.2 would round to 311.
  const [h] = browserHints([run({ streaming: 311.6 }), run({ streaming: 310.8 })]).hints;
  assert.equal(h!.median, 312);
});

test("browser: a segment in only some warm runs says how many it was measured in", () => {
  const list = browserHints([run({ ttfb: 10, connection: 300 }), run({ ttfb: 10 }), run({ ttfb: 10 })]);
  assert.deepEqual(labels(list), ["connection setup"]);
  // The share is of that run's own total (300 of 310), not of the median total of all three (10).
  assert.equal(formatHints(list).split("\n")[1], "    connection setup: 300 ms — 3.0× its 100 ms limit, in 1 of 1 warm runs (measured in 1 of 3); 97% of the browser total");
});

test("one value: no \"median\", in the scope or the evidence", () => {
  const one = browserHints([run({ ttfb: 900 })]);
  assert.equal(formatHints(one).split("\n").slice(0, 2).join("\n"), "Where to look — browser (1 warm run)\n    browser: response headers received: 900 ms — 1.5× its 600 ms limit, in 1 of 1 warm runs; 100% of the browser total");
  const server = formatHints(serverHints(block({ marks: { aStart: 0, aEnd: 300 } })));
  assert.ok(!server.includes("median"), server);
});

test("browser: no warm run, no median: says why, no hints", () => {
  const list = browserHints([]);
  assert.deepEqual(list.hints, []);
  assert.equal(list.none, "No warm run was measured (runs 2 and later), so there's no median to compare. Use --runs 2 or more.");
});

test("server evidence matches the table: the row's median and per-visit values, share of first bytes sent", () => {
  const b = block(
    { marks: { dbStart: 0, dbEnd: 120, modelCallSent: 120, firstChunk: 400 } },
    { marks: { dbStart: 0, dbEnd: 300, modelCallSent: 300, firstChunk: 600 } },
    { marks: { dbStart: 0, dbEnd: 90, modelCallSent: 90, firstChunk: 380 } },
  );
  const row = b.spans.find((r) => r.label === "db")!;
  const [h] = serverHints(b).hints;
  assert.equal(h!.label, "db");
  assert.equal(h!.median, row.stats!.median);
  assert.deepEqual([h!.over, h!.of], [row.values.filter((v) => v !== null && v > 100).length, 3]);
  const firstBytes = b.marks.find((r) => r.label === "server: first bytes sent")!.values;
  const shares = row.values.map((v, i) => (v! / firstBytes[i]!) * 100).sort((x, y) => x - y);
  assert.equal(h!.share, Math.round(shares[1]!)); // per visit: 120/400, 300/600, 90/380 → median
  assert.equal(h!.shareOf, "the time to server: first bytes sent");
});

test("server: no first bytes sent recorded: share unknown, and says why", () => {
  const [h] = serverHints(block({ marks: { dbStart: 0, dbEnd: 300 } })).hints;
  assert.equal(h!.share, null);
  assert.equal(h!.shareOf, "server: first bytes sent wasn't recorded, so no share");
  assert.ok(formatHints(serverHints(block({ marks: { dbStart: 0, dbEnd: 300 } }))).includes("— 3.0× its 100 ms limit, in 1 of 1 marked visits; server: first bytes sent wasn't recorded, so no share"));
});

// --- HTML ---

function input(hints: HintList | null, server: ReportInput["server"], serverList: HintList | null, extra: Partial<ReportInput> = {}): ReportInput {
  return {
    verdict: ["People waited a median of 500 ms for the first word (1 warm run)."],
    bars: { browser: null, server: null },
    url: "http://127.0.0.1/x", measure: { name: "^go$" }, chat: null, output: "#out", steps: [], startedAt: new Date(0),
    summary: { cold: 500, coldUnidentified: false, median: 500, worst: 500, warm: 1, warmFailed: 0, warmUnidentified: 0 },
    runs: [], failed: [], unidentified: [], stop: null, double: null, canary: null, csp: null,
    streaming: { status: "unknown", verdict: "Inconclusive", checks: [], notes: [] }, checks: [], server, advice: [],
    hints: { browser: hints, server: serverList },
    ...extra,
  };
}

test("HTML: browser and server hints are separate sections, never merged", () => {
  const browser = browserHints([run({ ttfb: 900 }), run({ ttfb: 900 })]);
  const b = block({ marks: { zebraStepStart: 0, zebraStepEnd: 300, firstChunk: 400 } });
  const server = serverHints(b);
  const html = renderReport(input(browser, { lines: [], block: b }, server));
  const browserAt = html.indexOf('<section aria-labelledby="browser-h">');
  const serverAt = html.indexOf('<section aria-labelledby="server-top-h">');
  assert.ok(browserAt !== -1 && serverAt !== -1, html);
  const browserPart = html.slice(browserAt, html.indexOf("</section>", browserAt));
  const serverPart = html.slice(serverAt, html.indexOf("</section>", serverAt));
  assert.ok(browserPart.includes("browser: response headers received") && !browserPart.includes("zebraStep"), browserPart);
  assert.ok(serverPart.includes("Where to look — server") && serverPart.includes(APP_SPAN) && !serverPart.includes("response headers"), serverPart);
});

test("HTML: no server hints without --server-timings", () => {
  const html = renderReport(input(browserHints([run({ ttfb: 900 }), run({ ttfb: 900 })]), null, null));
  assert.ok(html.includes("Where to look — browser"), html);
  assert.ok(!html.includes("Where to look — server"), html);
});

test("HTML: the full hint has evidence, basis, things to check and the disclaimer", () => {
  const b = block({ marks: { modelCallSent: 0, firstChunk: 700 } });
  const html = serverTop({ lines: [], block: b }, serverHints(b), serverBar(b));
  for (const want of ["model call → first bytes sent: 700 ms — 1.6× its 450 ms limit, in 1 of 1 marked visits", "MLPerf Inference", CAVEAT, "Things to check", DISCLAIMER]) {
    assert.ok(html.includes(want), `has: ${want}\n${html}`);
  }
});

// --- Learn more ---

const INP = "https://web.dev/articles/optimize-inp";
const LINKS: [Partial<Record<SegmentKey, number>>, string, string[]][] = [
  [{ click: 300, ttfb: 10 }, "click → request sent", [INP, "https://web.dev/optimize-long-tasks/"]],
  [{ click: 10, preflight: 300, ttfb: 10 }, "CORS preflight", ["https://developer.mozilla.org/en-US/docs/Glossary/preflight_request"]],
  [{ click: 10, connection: 300, ttfb: 10 }, "connection setup", ["https://developer.chrome.com/docs/lighthouse/performance/uses-rel-preconnect"]],
  [{ click: 10, ttfb: 900 }, "browser: response headers received", ["https://web.dev/optimize-ttfb/"]],
  [{ click: 10, ttfb: 10, streaming: 300 }, "headers → first paint", ["https://developer.mozilla.org/en-US/docs/Web/API/Streams_API"]],
  [{ click: 10, ttfb: 10, download: 300, render: 10 }, "headers → done", ["https://developer.mozilla.org/en-US/docs/Web/API/Streams_API"]],
  [{ click: 10, ttfb: 10, download: 10, render: 300 }, "done → first paint", [INP]],
];

test("each browser hint has its Learn more links, in the full hint and in its short line", () => {
  for (const [parts, label, links] of LINKS) {
    const list = browserHints([run(parts), run(parts)]);
    assert.deepEqual(labels(list), [label]);
    assert.deepEqual(list.hints[0]!.links, links, label);
    assert.ok(formatHints(list).split("\n").includes(`    Learn more: ${links.join(" · ")}`), formatHints(list));
  }
  // As a short line (not the furthest over): the links at its end.
  const two = browserHints([run({ ttfb: 2400, preflight: 300 }), run({ ttfb: 2400, preflight: 300 })]);
  assert.equal(formatHints(two).split("\n").at(-1), "    CORS preflight: median 300 ms — 3.0× its 100 ms limit, in 2 of 2 warm runs — learn more: https://developer.mozilla.org/en-US/docs/Glossary/preflight_request");
});

test("no Learn more for the model span or app-named spans", () => {
  const list = serverHints(block({ marks: { aStart: 0, aEnd: 300, modelCallSent: 300, firstChunk: 900 } }));
  assert.deepEqual(labels(list), ["a", "model call → first bytes sent"]);
  for (const h of list.hints) assert.deepEqual(h.links, [], h.label);
  assert.ok(!/learn more/i.test(formatHints(list)), formatHints(list));
});

test("HTML: Learn more links are links, in the full hint and the short lines", () => {
  const list = browserHints([run({ ttfb: 2400, preflight: 300 }), run({ ttfb: 2400, preflight: 300 })]);
  const html = renderReport(input(list, null, null));
  assert.ok(html.includes('Learn more: <a href="https://web.dev/optimize-ttfb/" rel="noopener noreferrer">https://web.dev/optimize-ttfb/</a>'), html);
  assert.ok(html.includes('learn more: <a href="https://developer.mozilla.org/en-US/docs/Glossary/preflight_request" rel="noopener noreferrer">'), html);
});

// --- Ranking by how far over its own limit ---

test("Quill-like numbers: postgres 532 ms (5.3× its 100) gets the full hint, not the model's 552 ms (1.2× its 450)", () => {
  const list = serverHints(block(
    { marks: { postgresStart: 0, postgresEnd: 532, modelCallSent: 532, firstChunk: 1084 } },
    { marks: { postgresStart: 0, postgresEnd: 532, modelCallSent: 532, firstChunk: 1084 } },
    { marks: { postgresStart: 0, postgresEnd: 532, modelCallSent: 532, firstChunk: 1084 } },
  ));
  assert.deepEqual(labels(list), ["postgres", "model call → first bytes sent"]);
  const text = formatHints(list).split("\n");
  assert.equal(text[1], "    postgres: median 532 ms — 5.3× its 100 ms limit, in 3 of 3 marked visits; 49% of the time to server: first bytes sent");
  assert.equal(text.at(-1), "    model call → first bytes sent: median 552 ms — 1.2× its 450 ms limit, in 3 of 3 marked visits");
});

// A span that ended before the model call was sent: all of it came before the model call.
const BEFORE_ONE = "It ended before the model call was sent (postgresEnd 547 ms, model call sent 547 ms), so all 547 ms of it came before the model call.";
test("Quill's Nov 13 record: postgres ended at the model call, so the full hint says all of it came before the model call", () => {
  const text = formatHints(serverHints(block({ marks: { postgresStart: 0, postgresEnd: 547, modelCallSent: 547, firstChunk: 1356 } }))).split("\n");
  assert.equal(text[1], "    postgres: 547 ms — 5.5× its 100 ms limit, in 1 of 1 marked visits; 40% of the time to server: first bytes sent");
  assert.equal(text[2], `    ${APP_SPAN}`);
  assert.equal(text[3], `    ${BEFORE_ONE}`);
});

test("a span still running when the model call was sent gets no before-the-model line", () => {
  const list = serverHints(block({ marks: { logStart: 0, logEnd: 900, modelCallSent: 300, firstChunk: 700 } }));
  assert.equal(list.hints[0]!.label, "log");
  assert.ok(!formatHints(list).includes("before the model call"), formatHints(list));
});

test("several visits: says in how many the span ended before the model call was sent", () => {
  const list = serverHints(block(
    { marks: { postgresStart: 0, postgresEnd: 500, modelCallSent: 500, firstChunk: 900 } },
    { marks: { postgresStart: 0, postgresEnd: 520, modelCallSent: 520, firstChunk: 900 } },
    { marks: { postgresStart: 0, postgresEnd: 540, modelCallSent: 300, firstChunk: 900 } },
  ));
  assert.equal(list.hints[0]!.label, "postgres");
  assert.equal(list.hints[0]!.beforeModel, "It ended before the model call was sent in 2 of 3 marked visits, so in those visits all of it came before the model call.");
});

test("no model call sent recorded: no before-the-model line", () => {
  const list = serverHints(block({ marks: { postgresStart: 0, postgresEnd: 547, firstChunk: 1356 } }));
  assert.equal(list.hints[0]!.label, "postgres");
  assert.equal(list.hints[0]!.beforeModel, undefined);
});

test("HTML: the full hint has the before-the-model line", () => {
  const b = block({ marks: { postgresStart: 0, postgresEnd: 547, modelCallSent: 547, firstChunk: 1356 } });
  const html = serverTop({ lines: [], block: b }, serverHints(b), serverBar(b));
  assert.ok(html.includes(`<p>${BEFORE_ONE}</p>`), html);
});

test("just over its limit: two decimals, so it never reads 1.0×", () => {
  const [h] = browserHints([run({ ttfb: 620 }), run({ ttfb: 620 })]).hints;
  assert.ok(h!.evidence.startsWith("browser: response headers received: median 620 ms — 1.03× its 600 ms limit"), h!.evidence);
});

test("same ratio: the one over its limit in more of its runs comes first", () => {
  // headers: 1200, 1200, 500 → median 1200, 2.0× its 600, over in 2 of 3; click: 400 ×3 → 2.0× its 200, over in 3 of 3.
  const list = browserHints([run({ click: 400, ttfb: 1200 }), run({ click: 400, ttfb: 1200 }), run({ click: 400, ttfb: 500 })]);
  assert.deepEqual(labels(list), ["click → request sent", "browser: response headers received"]);
  assert.deepEqual(list.hints.map((h) => [h.over, h.of]), [[3, 3], [2, 3]]);
});

// --- Verdict, bars and layout ---

test("verdict: the median wait, then each side's top hint, from the numbers", () => {
  const browser = browserHints([run({ click: 10, ttfb: 100, streaming: 312 }), run({ click: 10, ttfb: 100, streaming: 310 })]);
  const server = serverHints(block({ marks: { postgresStart: 0, postgresEnd: 152, modelCallSent: 152, firstChunk: 454 } }, { marks: { postgresStart: 0, postgresEnd: 153, modelCallSent: 153, firstChunk: 455 } }));
  assert.deepEqual(verdictLines({ median: 466, warm: 2, browser, server: { list: server } }), [
    "People waited a median of 466 ms for the first word (2 warm runs).",
    "In the browser: headers → first paint — 3.1× its limit, in 2 of 2 warm runs.",
    "Inside the server: postgres — 1.5× its limit, in 2 of 2 marked visits.",
  ]);
});

test("verdict: a side with nothing over its limit says so; no server line without --server-timings", () => {
  const browser = browserHints([run({ click: 10, ttfb: 100, streaming: 50 }), run({ click: 10, ttfb: 100, streaming: 50 })]);
  const server = serverHints(block({ marks: { aStart: 0, aEnd: 50, modelCallSent: 50, firstChunk: 300 } }));
  assert.deepEqual(verdictLines({ median: 160, warm: 2, browser, server: { list: server } }).slice(1), [
    "In the browser: nothing over its limit.",
    "Inside the server: nothing over its limit.",
  ]);
  assert.deepEqual(verdictLines({ median: 160, warm: 2, browser, server: null }), [
    "People waited a median of 160 ms for the first word (2 warm runs).",
    "In the browser: nothing over its limit.",
  ]);
});

test("verdict: no warm run, no visit that succeeded: says why, never a number it didn't measure", () => {
  assert.deepEqual(verdictLines({ median: null, warm: 0, browser: browserHints([]), server: { list: null } }), [
    "No warm run was measured, so there's no median wait. Use --runs 2 or more.",
    "In the browser: no hints (no warm run was measured).",
    "Inside the server: no hints (no marked visit succeeded).",
  ]);
});

test("browser bar: the warm run nearest the median, its segments in order, over-limit ones marked", () => {
  const warm = [
    { run: 2, ...run({ click: 10, ttfb: 100, streaming: 300 }) }, // 410
    { run: 3, ...run({ click: 10, ttfb: 100, streaming: 50 }) }, // 160
    { run: 4, ...run({ click: 10, ttfb: 700, streaming: 50 }) }, // 760
  ];
  const bar = browserBar(warm)!;
  assert.equal(bar.title, "Run 2, the median warm run: 410 ms from click to first word");
  assert.deepEqual(bar.lanes, [[
    { label: "click → request sent", ms: 10, start: 0, over: false, limit: 200 },
    { label: "browser: response headers received", ms: 100, start: 10, over: false, limit: 600 },
    { label: "headers → first paint", ms: 300, start: 110, over: true, limit: 100 },
  ]]);
  assert.equal(bar.total, 410);
  // Two warm runs: the one nearest their median, the faster on a tie.
  assert.match(browserBar(warm.slice(0, 2))!.title, /^Run 3, the warm run nearest the median \(285 ms\): 160 ms/);
  assert.equal(browserBar([]), null);
});

test("browser bar: what no segment explains is drawn as unattributed, never over", () => {
  const bar = browserBar([{ run: 2, total: 500, segments: [{ key: "click", label: "click → request sent", ms: 10 }, { key: "ttfb", label: "browser: response headers received", ms: null }] }])!;
  assert.deepEqual(bar.lanes[0]!.at(-1), { label: "unattributed", ms: 490, start: 10, over: false, limit: null });
});

test("server bar: the visit nearest the median first bytes sent; nested spans on their own rows", () => {
  const b = block(
    { marks: { outerStart: 0, innerStart: 10, innerEnd: 160, outerEnd: 200, modelCallSent: 200, firstChunk: 600 } },
    { marks: { outerStart: 0, innerStart: 10, innerEnd: 60, outerEnd: 90, modelCallSent: 90, firstChunk: 390 } },
    { marks: { outerStart: 0, innerStart: 10, innerEnd: 60, outerEnd: 80, modelCallSent: 80, firstChunk: 380 } },
  );
  const bar = serverBar(b)!;
  assert.equal(bar.title, "Marked visit 2, the median visit: 390 ms from arrival to server: first bytes sent");
  assert.equal(bar.total, 390);
  assert.deepEqual(bar.lanes, [
    [
      { label: "outer", ms: 90, start: 0, over: false, limit: 100 },
      { label: "model call → first bytes sent", ms: 300, start: 90, over: false, limit: 450 },
    ],
    [{ label: "inner", ms: 50, start: 10, over: false, limit: 100 }],
  ]);
});

const BAR: Bar = {
  title: "Run 2, the median warm run: 410 ms from click to first word",
  total: 410,
  lanes: [[
    { label: "click → request sent", ms: 10, start: 0, over: false, limit: 200 },
    { label: "headers → first paint", ms: 400, start: 10, over: true, limit: 100 },
  ]],
};

test("HTML: verdict first, then the browser bar with over-limit segments labelled \"over\", then where to look", () => {
  const browser = browserHints([run({ click: 10, streaming: 400 }), run({ click: 10, streaming: 400 })]);
  const html = renderReport(input(browser, null, null, { verdict: ["People waited a median of 410 ms for the first word (2 warm runs).", "In the browser: headers → first paint — 4.0× its limit, in 2 of 2 warm runs."], bars: { browser: BAR, server: null } }));
  const at = (s: string) => html.indexOf(s);
  assert.ok(at('aria-labelledby="verdict-h"') !== -1 && at('aria-labelledby="verdict-h"') < at('aria-labelledby="browser-h"'), "verdict before the browser section");
  assert.ok(html.includes("<p class=\"headline\">People waited a median of 410 ms for the first word (2 warm runs).</p>"), html);
  const segs = [...html.matchAll(/<div class="bseg (over|ok)"[^>]*>(.*?)<\/div>/gs)].map((m) => ({ cls: m[1], body: m[2]! }));
  assert.equal(segs.length, 2);
  assert.ok(segs[1]!.cls === "over" && segs[1]!.body.includes(">over<") && segs[1]!.body.includes("headers → first paint") && segs[1]!.body.includes("400 ms"), segs[1]!.body);
  assert.ok(segs[0]!.cls === "ok" && !segs[0]!.body.includes(">over<"), segs[0]!.body);
  assert.ok(html.includes("<li class=\"over\">") && /headers → first paint — 400 ms — <b>over<\/b> its 100 ms limit/.test(html), "the key says over in words");
  assert.ok(at("Where to look — browser") > at('class="bar"'), "where to look under the bar");
});

test("HTML: no server section or bar without --server-timings", () => {
  const html = renderReport(input(null, null, null, { bars: { browser: BAR, server: null } }));
  assert.ok(!html.includes("server-top-h") && !html.includes("Inside the server"), "no server section");
});

test("HTML: the details are collapsed by default and hold the per-run timeline, data and request matching", () => {
  const html = renderReport(input(null, null, null));
  const open = html.indexOf('<details class="more">');
  assert.ok(open !== -1, "a collapsed Details");
  assert.ok(!/<details class="more" open/.test(html));
  for (const id of ["timeline-h", "table-h", "requests-h"]) assert.ok(html.indexOf(`aria-labelledby="${id}"`) > open, `${id} inside the details`);
});

test("HTML: the Data table has a row per segment and a column per run, so it fits", () => {
  const html = renderReport(input(null, null, null, {
    runs: [1, 2, 3].map((n) => ({ run: n, total: 410, request: { method: "POST", url: "http://x/r", status: 200, contentType: null }, reasons: [], from: 1, clock: "ok", segments: [{ key: "click" as const, label: "click → request sent", ms: 10 }, { key: "streaming" as const, label: "headers → first paint", ms: 400 }], reply: { firstByte: null, preReply: [] } })),
  }));
  const table = html.slice(html.indexOf('aria-labelledby="table-h"'));
  assert.ok(/<thead><tr>\s*<th scope="col">Segment \(ms\)<\/th><th scope="col" class="num">run&nbsp;1 \(cold\)<\/th><th scope="col" class="num">run&nbsp;2<\/th><th scope="col" class="num">run&nbsp;3<\/th>/.test(table), table.slice(0, 600));
});

// --- One value: never called a median ---

test("one warm run: the verdict says \"in the one warm run\", not median", () => {
  const browser = browserHints([run({ click: 10, ttfb: 100, streaming: 312 })]);
  assert.equal(verdictLines({ median: 1197, warm: 1, browser, server: null })[0], "People waited 1197 ms for the first word in the one warm run.");
});

test("one warm run, one visit: the bar captions say \"the one\", not median", () => {
  assert.equal(browserBar([{ run: 2, ...run({ click: 10, ttfb: 100, streaming: 300 }) }])!.title, "Run 2, the one warm run: 410 ms from click to first word");
  const b = block({ marks: { postgresStart: 0, postgresEnd: 545, modelCallSent: 545, firstChunk: 1078 } });
  assert.equal(serverBar(b)!.title, "Marked visit 1, the one visit: 1078 ms from arrival to server: first bytes sent");
});

test("streaming verdict: the streaming span, and how many warm runs it's from", () => {
  assert.deepEqual(streamingVerdict(3618, 1), { status: "pass", verdict: "Streams — streaming span 3618 ms (the one warm run)." });
  assert.deepEqual(streamingVerdict(3400, 3), { status: "pass", verdict: "Streams — streaming span 3400 ms (median of 3 warm runs)." });
  assert.deepEqual(streamingVerdict(40, 2), {
    status: "fail",
    verdict: "Doesn't stream: users see nothing until the whole answer is ready — streaming span 40 ms (median of 2 warm runs).",
  });
});

test("HTML: one warm run: the tile says \"The one warm run\", and the streaming section doesn't say median", () => {
  const html = renderReport(input(null, null, null, { checks: [{ name: "streaming", report: { ...streamingVerdict(3618, 1), checks: [], notes: [] } }] }));
  assert.ok(html.includes('<div class="tile-label">The one warm run</div>'), html);
  assert.ok(!html.includes("Median (run 2)"), html);
  assert.ok(html.includes("Streams — streaming span 3618 ms (the one warm run)."), html);
  const streamingPart = html.slice(html.indexOf('aria-labelledby="streaming-h"'), html.indexOf("</section>", html.indexOf('aria-labelledby="streaming-h"')));
  assert.ok(!/median/i.test(streamingPart), streamingPart);
});

test("HTML: the Request Map is in the main server section, under the bar, and only there (not again in Details)", () => {
  const b = serverBlock(
    [{ visit: 1, record: parseServerRecord({ id: "r1", status: 200, marks: { postgresStart: 0, postgresEnd: 545, modelCallSent: 545, firstChunk: 1078 }, prompt: { messages: [{ role: "system", bytes: 2499 }, { role: "user", bytes: 3328 }] } }, "r1") as ServerRecord }],
    1,
  );
  const top = serverTop({ lines: [], block: b }, serverHints(b), serverBar(b));
  const barAt = top.indexOf('class="bseg');
  const promptAt = top.indexOf("<h4>Prompt sizes (marked visit 1)</h4>");
  assert.ok(barAt !== -1 && promptAt > barAt, top);
  assert.ok(top.includes('<tr><th scope="row">1 system</th><td class="num">2499</td><td>43%</td></tr>'), top);
  assert.ok(promptAt < top.indexOf("Where to look — server"), "before where to look");
  const html = renderReport(input(null, { lines: [], block: b }, serverHints(b), { bars: { browser: null, server: serverBar(b) } }));
  assert.equal(html.split("<h4>Prompt sizes (marked visit 1)</h4>").length - 1, 1, "once");
  assert.equal(html.split("<h3>Request Map").length - 1, 1, "one Request Map");
  assert.ok(html.indexOf("<h3>Request Map") < html.indexOf('<details class="more">'), "before Details");
});

// --- Advice: next steps, each from a number this run measured ---

const OWASP = "https://genai.owasp.org/llmrisk/llm01-prompt-injection/";
const NO_DATA = { streaming: null, firstWord: null, prompt: null, cold: null };
// What the terminal prints of an item: its text, basis and link.
const pick = ({ text, basis, link }: { text: string; basis: string | null; link: string | null }) => ({ text, basis, link });
// The prompt view of one visit whose record has these messages (bytes and parts as the wrapper records them).
function promptView(messages: unknown[]) {
  return block({ marks: { modelCallSent: 0, firstChunk: 100 }, prompt: { messages } } as never).prompt;
}
// Quill's Nov 13 prompt: every part labelled, nothing from outside.
const QUILL_PROMPT = [
  { role: "system", bytes: 2499, parts: [{ name: "instructions", bytes: 2499, found: true, source: "app" }] },
  { role: "user", bytes: 3328, parts: [
    { name: "author", bytes: 25, found: true, source: "user" }, { name: "title", bytes: 33, found: true, source: "user" },
    { name: "code_snippet", bytes: 57, found: true, source: "app" }, { name: "article", bytes: 3207, found: true, source: "user" },
  ] },
];

test("advice, streaming: the demo's Nov 13 numbers — span and first word as measured, no promise of how much sooner", () => {
  const items = adviceItems({ streaming: { span: 212, settled: 1 }, firstWord: { median: 730, warm: 1 }, prompt: null });
  assert.deepEqual(items.map(pick), [{
    text: "Doesn't stream: the whole answer appeared within 212 ms of the first word (streaming span, the one warm run), and people waited 730 ms for the first word. Stream the response end to end: the server's writes, any proxy in between, and how the page reads it. Caliper can't tell how much sooner the first word would appear.",
    basis: "Caliper's own threshold: a streaming span under 250 ms. No outside source.",
    link: null,
  }]);
});

test("advice uses the streaming check's own threshold", () => {
  assert.equal(ADVICE_STREAMS_MIN_MS, STREAMS_MIN_MS);
});

test("advice, streaming: a span of 250 ms or more, or no span measured, gives no streaming advice", () => {
  assert.deepEqual(adviceItems({ streaming: { span: 3883, settled: 1 }, firstWord: { median: 1229, warm: 1 }, prompt: null }), []);
  assert.deepEqual(adviceItems({ streaming: null, firstWord: null, prompt: null }), []);
});

test("advice, outside: names each part your app labelled outside, with its bytes, and cites OWASP LLM01", () => {
  const prompt = promptView([{ role: "user", bytes: 200, parts: [
    { name: "question", bytes: 40, found: true, source: "user" }, { name: "comments", bytes: 87, found: true, source: "outside" },
  ] }]);
  const items = adviceItems({ streaming: null, firstWord: null, prompt });
  assert.deepEqual(items.map(pick), [{
    text: "comments (87 bytes) is outside text sent to the model — a prompt-injection risk. Your app labelled it outside, and it's in the prompt your app reported to run.prompt(). Text from outside can carry instructions (indirect prompt injection). Keep it apart from your own instructions and mark where it starts and ends. Caliper doesn't detect injection; this is a risk, not a finding.",
    basis: "OWASP Top 10 for LLM Applications 2025, LLM01 Prompt Injection: \"Segregate and identify external content.\"",
    link: OWASP,
  }]);
});

test("advice, outside: two parts read as one headline, \"are outside text\"", () => {
  const prompt = promptView([{ role: "user", bytes: 900, parts: [
    { name: "comments", bytes: 87, found: true, source: "outside" }, { name: "search_results", bytes: 300, found: true, source: "outside" },
  ] }]);
  assert.equal(adviceItems({ ...NO_DATA, prompt })[0]!.headline, "comments (87 bytes), search_results (300 bytes) are outside text sent to the model — a prompt-injection risk.");
});

test("advice, outside: a part labelled outside in only some marked visits isn't named", () => {
  const visit = (source: string) => ({ marks: { modelCallSent: 0, firstChunk: 100 }, prompt: { messages: [{ role: "user", bytes: 300, parts: [{ name: "comments", bytes: 87, found: true, source }] }] } });
  const prompt = block(visit("outside") as never, visit("user") as never).prompt;
  assert.equal(prompt.rows.find((r) => r.label === "comments")?.source?.kind, "mixed");
  assert.deepEqual(adviceItems({ streaming: null, firstWord: null, prompt }), []);
});

test("advice: Quill's Nov 13 prompt (all labelled, nothing outside) gives only the dominant-part fact; no server timings, no prompt advice", () => {
  assert.deepEqual(adviceItems({ ...NO_DATA, prompt: promptView(QUILL_PROMPT) }).map((a) => a.text), ["article is 55% of the prompt (3207 of 5827 bytes, labelled user)."]);
  assert.deepEqual(adviceItems(NO_DATA), []);
});

// Rule 1: one named part is half the prompt or more — a fact, no trim advice.
const DOMINANT_BASIS = "Caliper's own threshold: one named part is 50% or more of the prompt's measured bytes, more than all the rest together. These are bytes your app reported, not tokens; Caliper didn't measure what trimming it would change.";
test("advice, dominant part: Quill's article and the demo's rules, as facts with their bytes and source", () => {
  assert.deepEqual(adviceItems({ ...NO_DATA, prompt: promptView(QUILL_PROMPT) }).map(pick), [{ text: "article is 55% of the prompt (3207 of 5827 bytes, labelled user).", basis: DOMINANT_BASIS, link: null }]);
  const demo = [
    { role: "system", bytes: 282, parts: [{ name: "persona", bytes: 102, found: true, source: "app" }, { name: "rules", bytes: 178, found: true, source: "app" }] },
    { role: "user", bytes: 26, parts: [{ name: "visitor", bytes: 26, found: true, source: "user" }] },
  ];
  assert.deepEqual(adviceItems({ ...NO_DATA, prompt: promptView(demo) }).map((a) => a.text), ["rules is 58% of the prompt (178 of 308 bytes, labelled app)."]);
});

test("advice, dominant part: under 50%, a part not named, or a total not fully measured: nothing", () => {
  const even = [{ role: "user", bytes: 100, parts: [{ name: "a", bytes: 49, found: true, source: "user" }, { name: "b", bytes: 49, found: true, source: "user" }] }];
  assert.deepEqual(adviceItems({ ...NO_DATA, prompt: promptView(even) }), []);
  const noParts = [{ role: "system", bytes: 900 }, { role: "user", bytes: 100 }];
  assert.deepEqual(adviceItems({ ...NO_DATA, prompt: promptView(noParts) }), []);
  const partial = [{ role: "system", bytes: null }, { role: "user", bytes: 100, parts: [{ name: "a", bytes: 90, found: true, source: "user" }] }];
  assert.deepEqual(adviceItems({ ...NO_DATA, prompt: promptView(partial) }), []);
});

test("advice, dominant part over several visits that differ: only when it's 50% or more in each, with the range", () => {
  const visit = (article: number, total: number) => ({ marks: { modelCallSent: 0, firstChunk: 100 }, prompt: { messages: [
    { role: "system", bytes: total - article, parts: [{ name: "instructions", bytes: total - article, found: true, source: "app" }] },
    { role: "user", bytes: article, parts: [{ name: "article", bytes: article, found: true, source: "user" }] },
  ] } });
  const both = block(visit(3207, 5827) as never, visit(3300, 5900) as never).prompt;
  assert.deepEqual(adviceItems({ ...NO_DATA, prompt: both }).map((a) => a.text), ["article is 55–56% of the prompt in each of 2 marked visits (3207–3300 bytes, labelled user)."]);
  const one = block(visit(3207, 5827) as never, visit(2000, 5827) as never).prompt;
  assert.deepEqual(adviceItems({ ...NO_DATA, prompt: one }), []);
});

// Rule 5: a segment much slower on the first run than warm — by more than its own limit.
test("cold gaps: the demo's 02:01 run fires on response headers (+3473 ms, over 600); Quill's Nov 13 run fires nothing", () => {
  const demoCold = run({ click: 9.6, ttfb: 5196.3, streaming: 14.7 });
  const demoWarm = run({ click: 1.8, ttfb: 1723.0, streaming: 12.6 });
  assert.deepEqual(coldGaps(demoCold, [demoWarm]).map(({ label, cold, warm, gap, limit }) => ({ label, cold, warm, gap, limit })),
    [{ label: "browser: response headers received", cold: 5196, warm: 1723, gap: 3473, limit: 600 }]);
  assert.deepEqual(coldGaps(run({ click: 3, preflight: 89, ttfb: 904, streaming: 269 }), [run({ click: 4, ttfb: 900, streaming: 325 })]), []);
});

test("cold gaps: a segment only on the first run counts in full; under its limit, nothing", () => {
  const gaps = coldGaps(run({ click: 3, preflight: 300, ttfb: 100 }), [run({ click: 3, ttfb: 100 }), run({ click: 3, ttfb: 100 })]);
  assert.deepEqual(gaps.map(({ label, cold, warm, gap }) => ({ label, cold, warm, gap })), [{ label: "CORS preflight", cold: 300, warm: null, gap: 300 }]);
});

test("advice, first run: the demo's 02:01 numbers, each segment over its limit with its values, and no cause claimed", () => {
  const gaps = coldGaps(run({ click: 9.6, ttfb: 5196.3, streaming: 14.7 }), [run({ click: 1.8, ttfb: 1723.0, streaming: 12.6 })]);
  const items = adviceItems({ ...NO_DATA, cold: { total: 5221, warmMedian: 1737, warm: 1, gaps } });
  assert.deepEqual(items.map((a) => a.text), [
    "The first run (a fresh browser) waited 3484 ms longer for the first word than the one warm run (5221 vs 1737 ms). browser: response headers received: 5196 ms on the first run, 1723 ms warm (+3473 ms, more than its 600 ms limit). Caliper can't tell why from timings alone.",
  ]);
  assert.equal(items[0]!.basis, "Caliper's own reasoning: each segment's Where-to-look limit, applied to the gap between the first run and the warm runs, from 1 first run and 1 warm run. 600 ms: Lighthouse's \"Reduce server response time\" audit fails above 600 ms.");
  const preflight = coldGaps(run({ click: 3, preflight: 300, ttfb: 100 }), [run({ click: 3, ttfb: 100 }), run({ click: 3, ttfb: 100 })]);
  assert.ok(adviceItems({ ...NO_DATA, cold: { total: 403, warmMedian: 103, warm: 2, gaps: preflight } })[0]!.text
    .includes("than the median of 2 warm runs (403 vs 103 ms). CORS preflight: 300 ms on the first run, not in the warm runs (+300 ms, more than its 100 ms limit)."));
  assert.deepEqual(adviceItems({ ...NO_DATA, cold: { total: 1265, warmMedian: 1229, warm: 1, gaps: [] } }), []);
});

test("advice, unlabelled: the fix line moves here, word for word, and leaves the prompt sizes", () => {
  const messages = [{ role: "user", bytes: 200, parts: [{ name: "article", bytes: 60, found: true }, { name: "title", bytes: 20, found: true, source: "user" }] }];
  const fix = '1 part not labelled (article): add source: "app", "user" or "outside" to each in run.prompt() — needs caliper-timings 0.6.0; see its README, "Choosing a source"';
  assert.deepEqual(adviceItems({ streaming: null, firstWord: null, prompt: promptView(messages) }).map(pick), [{ text: fix, basis: null, link: null }]);
  const b = block({ marks: { modelCallSent: 0, firstChunk: 100 }, prompt: { messages } } as never);
  assert.ok(!formatServerBlock(b).includes("not labelled ("), formatServerBlock(b));
});

test("advice in the terminal: one item per rule that fired with its basis, or a line saying there's nothing", () => {
  assert.equal(formatAdvice([]), "Advice — nothing to suggest from this run's numbers.");
  const items = adviceItems({ streaming: { span: 212, settled: 1 }, firstWord: { median: 730, warm: 1 }, prompt: promptView([{ role: "user", bytes: 300, parts: [{ name: "comments", bytes: 87, found: true, source: "outside" }] }]) });
  const lines = formatAdvice(items).split("\n");
  assert.equal(lines[0], "Advice — from this run's numbers");
  assert.ok(lines[1]!.startsWith("    - Doesn't stream: the whole answer appeared within 212 ms"), lines.join("\n"));
  assert.equal(lines[2], "      basis: Caliper's own threshold: a streaming span under 250 ms. No outside source.");
  assert.ok(lines[3]!.startsWith("    - comments (87 bytes) is outside text sent to the model — a prompt-injection risk. Your app labelled it outside"), lines.join("\n"));
  assert.equal(lines[4], `      basis: OWASP Top 10 for LLM Applications 2025, LLM01 Prompt Injection: "Segregate and identify external content." ${OWASP}`);
});

test("advice, streaming: a span of 0 ms reads as arriving at once", () => {
  const [item] = adviceItems({ ...NO_DATA, streaming: { span: 0, settled: 2 }, firstWord: { median: 349, warm: 2 } });
  assert.equal(item!.headline, "Doesn't stream: the whole answer arrived at once (0 ms between first and last word, median of 2 warm runs), and people waited 349 ms for the first word.");
});

test("advice: each item is a headline with its measured number, then the rest (detail) — together the terminal's text", () => {
  const items = adviceItems({
    streaming: { span: 212, settled: 1 }, firstWord: { median: 730, warm: 1 },
    cold: { total: 5221, warmMedian: 1737, warm: 1, gaps: coldGaps(run({ click: 9.6, ttfb: 5196.3, streaming: 14.7 }), [run({ click: 1.8, ttfb: 1723.0, streaming: 12.6 })]) },
    prompt: promptView([{ role: "user", bytes: 300, parts: [{ name: "article", bytes: 160, found: true, source: "user" }, { name: "comments", bytes: 87, found: true, source: "outside" }, { name: "notes", bytes: 20, found: true }] }]),
  });
  assert.deepEqual(items.map((a) => [a.id, a.headline]), [
    ["streaming", "Doesn't stream: the whole answer appeared within 212 ms of the first word (streaming span, the one warm run), and people waited 730 ms for the first word."],
    ["first-run", "The first run (a fresh browser) waited 3484 ms longer for the first word than the one warm run (5221 vs 1737 ms)."],
    ["dominant", "article is 53% of the prompt (160 of 300 bytes, labelled user)."],
    ["outside", "comments (87 bytes) is outside text sent to the model — a prompt-injection risk."],
    ["unlabelled", "1 part not labelled (notes):"],
  ]);
  for (const a of items) assert.equal(a.text, a.detail ? `${a.headline} ${a.detail}` : a.headline, a.id);
});

test("HTML: Advice sits right under the Verdict, which says how many things to look at; one bold line each, the rest folded under \"why\"", () => {
  const advice = adviceItems({ ...NO_DATA, streaming: { span: 212, settled: 1 }, firstWord: { median: 730, warm: 1 }, prompt: promptView([{ role: "user", bytes: 300, parts: [{ name: "comments", bytes: 87, found: true, source: "outside" }] }]) });
  const b = block({ marks: { modelCallSent: 0, firstChunk: 700 } });
  const html = renderReport(input(browserHints([run({ ttfb: 100 }), run({ ttfb: 100 })]), { lines: [], block: b }, serverHints(b), { advice, checks: [{ name: "streaming", report: { ...streamingVerdict(212, 1), checks: [], notes: [] } }] }));
  const at = html.indexOf('<section aria-labelledby="advice-h"');
  assert.ok(html.indexOf('aria-labelledby="verdict-h"') < at && at < html.indexOf('<section aria-labelledby="browser-h">'), "right under the verdict");
  const verdict = html.slice(html.indexOf('aria-labelledby="verdict-h"'), at);
  assert.ok(verdict.includes('<a href="#advice-h">2 things to look at ↓</a>'), verdict);
  const streaming = advice[0]!;
  assert.ok(html.includes(`<li id="advice-streaming"><p class="advice-line"><b>${streaming.headline}</b></p><details><summary>why</summary><p>${streaming.detail}</p>`), html);
  const why = html.slice(html.indexOf('<li id="advice-outside">'), html.indexOf("</li>", html.indexOf('<li id="advice-outside">')));
  assert.ok(why.includes("<details><summary>why</summary>") && why.indexOf("Basis: OWASP") > why.indexOf("<details>") && why.includes(`<a href="${OWASP}" rel="noopener noreferrer">`), why);
  assert.ok(!html.includes('aria-labelledby="streaming-h"'), "no separate Streaming section");
  const checks = html.slice(html.indexOf('<h2 id="summary-h">Checks</h2>'));
  assert.ok(checks.includes('<a href="#advice-streaming">'), "the Checks line links to the advice");
  const one = renderReport(input(null, null, null, { advice: advice.slice(0, 1) }));
  assert.ok(one.includes('<a href="#advice-h">1 thing to look at ↓</a>'), "one thing");
  const none = renderReport(input(null, null, null, { advice: [] }));
  assert.ok(!none.includes("to look at ↓"), "no count line when nothing fires");
  assert.ok(none.includes("Nothing to suggest from this run&#39;s numbers.") || none.includes("Nothing to suggest from this run's numbers."), none);
});

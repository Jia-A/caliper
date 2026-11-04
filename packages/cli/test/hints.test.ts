// Unit tests for "Where to look": each segment's median against its layer's limit, browser and
// server as separate lists. Run with `npm run test:hints` (Node 22.18+ runs .ts directly).

import assert from "node:assert/strict";
import { test } from "node:test";
import { browserHints, formatHints, serverHints, type HintList } from "../src/hints.ts";
import { renderReport, serverSection, type ReportInput } from "../src/report.ts";
import { parseServerRecord, serverBlock, type ServerRecord } from "../src/serverblock.ts";
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
  assert.deepEqual(labels(over), ["browser: response headers received", "click → request sent", "connection setup", "headers → done", "done → first paint"]);
  assert.deepEqual(over.hints.map((h) => h.limit), [600, 200, 100, 100, 100]);
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

test("biggest first; the first is the full hint, the rest one short line each", () => {
  const list = browserHints([run({ click: 300, ttfb: 900, streaming: 400 }), run({ click: 300, ttfb: 900, streaming: 400 })]);
  assert.deepEqual(labels(list), ["browser: response headers received", "headers → first paint", "click → request sent"]);
  const text = formatHints(list).split("\n");
  assert.equal(text[0], "Where to look — browser (median of 2 warm runs)");
  assert.equal(text[1], "    browser: response headers received: median 900 ms, over its 600 ms limit in 2 of 2 warm runs; 56% of the browser total");
  assert.ok(text.includes(`    Limit: Lighthouse's "Reduce server response time" audit fails above 600 ms. ${CAVEAT}`), text.join("\n"));
  assert.ok(text.includes("    Things to check:"), text.join("\n"));
  assert.ok(text.includes(`    ${DISCLAIMER}`), text.join("\n"));
  assert.deepEqual(text.slice(-3), [
    "  also over their limits:",
    "    headers → first paint: median 400 ms (limit 100 ms), over in 2 of 2 warm runs — learn more: https://developer.mozilla.org/en-US/docs/Web/API/Streams_API",
    "    click → request sent: median 300 ms (limit 200 ms), over in 2 of 2 warm runs — learn more: https://web.dev/articles/optimize-inp · https://web.dev/optimize-long-tasks/",
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
  assert.ok(formatHints(two).includes(`    b: 200 ms (limit 100 ms), over in 1 of 1 marked visits — ${APP_SPAN}`), formatHints(two));
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

test("browser: a segment in only some warm runs says how many it was measured in", () => {
  const list = browserHints([run({ ttfb: 10, connection: 300 }), run({ ttfb: 10 }), run({ ttfb: 10 })]);
  assert.deepEqual(labels(list), ["connection setup"]);
  // The share is of that run's own total (300 of 310), not of the median total of all three (10).
  assert.equal(formatHints(list).split("\n")[1], "    connection setup: 300 ms, over its 100 ms limit in 1 of 1 warm runs (measured in 1 of 3); 97% of the browser total");
});

test("one value: no \"median\", in the scope or the evidence", () => {
  const one = browserHints([run({ ttfb: 900 })]);
  assert.equal(formatHints(one).split("\n").slice(0, 2).join("\n"), "Where to look — browser (1 warm run)\n    browser: response headers received: 900 ms, over its 600 ms limit in 1 of 1 warm runs; 100% of the browser total");
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
  assert.ok(formatHints(serverHints(block({ marks: { dbStart: 0, dbEnd: 300 } }))).includes("over its 100 ms limit in 1 of 1 marked visits; server: first bytes sent wasn't recorded, so no share"));
});

// --- HTML ---

function input(hints: HintList | null, server: ReportInput["server"], serverList: HintList | null): ReportInput {
  return {
    url: "http://127.0.0.1/x", measure: { name: "^go$" }, chat: null, output: "#out", steps: [], startedAt: new Date(0),
    summary: { cold: 500, coldUnidentified: false, median: 500, worst: 500, warm: 1, warmFailed: 0, warmUnidentified: 0 },
    runs: [], failed: [], unidentified: [], stop: null, double: null, canary: null, csp: null,
    streaming: { status: "unknown", verdict: "Inconclusive", checks: [], notes: [] }, checks: [], server,
    hints: { browser: hints, server: serverList },
  };
}

test("HTML: browser and server hints are separate sections, never merged", () => {
  const browser = browserHints([run({ ttfb: 900 }), run({ ttfb: 900 })]);
  const b = block({ marks: { zebraStepStart: 0, zebraStepEnd: 300, firstChunk: 400 } });
  const server = serverHints(b);
  const html = renderReport(input(browser, { lines: [], block: b }, server));
  const browserAt = html.indexOf('<section aria-labelledby="hints-browser-h">');
  const serverAt = html.indexOf('<section aria-labelledby="server-h">');
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
  const html = serverSection({ lines: [], block: block({ marks: { modelCallSent: 0, firstChunk: 700 } }) }, serverHints(block({ marks: { modelCallSent: 0, firstChunk: 700 } })));
  for (const want of ["model call → first bytes sent: 700 ms, over its 450 ms limit in 1 of 1 marked visits", "MLPerf Inference", CAVEAT, "Things to check", DISCLAIMER]) {
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
  // As a short line (not the biggest): the links at its end.
  const two = browserHints([run({ ttfb: 900, preflight: 300 }), run({ ttfb: 900, preflight: 300 })]);
  assert.equal(formatHints(two).split("\n").at(-1), "    CORS preflight: median 300 ms (limit 100 ms), over in 2 of 2 warm runs — learn more: https://developer.mozilla.org/en-US/docs/Glossary/preflight_request");
});

test("no Learn more for the model span or app-named spans", () => {
  const list = serverHints(block({ marks: { aStart: 0, aEnd: 300, modelCallSent: 300, firstChunk: 900 } }));
  assert.deepEqual(labels(list), ["model call → first bytes sent", "a"]);
  for (const h of list.hints) assert.deepEqual(h.links, [], h.label);
  assert.ok(!/learn more/i.test(formatHints(list)), formatHints(list));
});

test("HTML: Learn more links are links, in the full hint and the short lines", () => {
  const list = browserHints([run({ ttfb: 900, preflight: 300 }), run({ ttfb: 900, preflight: 300 })]);
  const html = renderReport(input(list, null, null));
  assert.ok(html.includes('Learn more: <a href="https://web.dev/optimize-ttfb/" rel="noopener noreferrer">https://web.dev/optimize-ttfb/</a>'), html);
  assert.ok(html.includes('learn more: <a href="https://developer.mozilla.org/en-US/docs/Glossary/preflight_request" rel="noopener noreferrer">'), html);
});

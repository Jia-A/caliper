// Unit tests for the "Inside the server" block, on fixed records (the end-to-end runs in
// test:marked can't pin timings). Run with `npm run test:serverblock` (Node 22.18+ runs .ts directly).

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatServerBlock, parseServerRecord, type ServerRecord } from "../src/serverblock.ts";

// The visits of one block, from plain records (id is the run id each one is parsed against).
function visits(...records: { marks: Record<string, number>; status?: number; runtime?: string; problems?: unknown }[]) {
  return records.map((r, i) => {
    const parsed = parseServerRecord({ id: `run${i + 1}`, status: 200, ...r }, `run${i + 1}`);
    assert.equal(typeof parsed, "object", `record ${i + 1} parses: ${parsed as string}`);
    return { visit: i + 1, record: parsed as ServerRecord };
  });
}
const lines = (block: string) => block.split("\n");

test("one visit, Quill's record: marks in order, the postgres span and the model span", () => {
  const block = formatServerBlock(visits({ marks: { postgresStart: 1, postgresEnd: 301, modelCallSent: 301, firstChunk: 402 } }), 1);
  assert.equal(block, [
    "Inside the server (from 1 of 1 marked run) — ms after the request arrived, status 200",
    "    postgresStart                  1 ms",
    "    postgresEnd                  301 ms",
    "    model call sent              301 ms",
    "    model: first chunk           402 ms   (at the server, not the browser)",
    "  spans",
    "    postgres                     300 ms   (postgresStart → postgresEnd)",
    "    model: sent → first chunk    101 ms",
  ].join("\n"));
});

test("one visit: each pair without a valid span gets one line with the reason", () => {
  const block = formatServerBlock(visits({ marks: { cacheStart: 10, warmupEnd: 20, lockEnd: 58, lockStart: 63 } }), 1);
  assert.deepEqual(lines(block).slice(-4), [
    "  spans",
    "    no cache span: cacheEnd wasn't recorded",
    "    no warmup span: warmupStart wasn't recorded",
    "    no lock span: lockEnd (58 ms) is before lockStart (63 ms)",
  ]);
});

test("several visits, same reason and same values: one line for the pair, naming how many visits", () => {
  const r = { marks: { cacheStart: 10, lockEnd: 58, lockStart: 63 } };
  const block = formatServerBlock(visits(r, r, r), 3);
  assert.ok(lines(block).includes("    no cache span in 3 of 3 visits: cacheEnd wasn't recorded"), block);
  assert.ok(lines(block).includes("    no lock span in 3 of 3 visits: lockEnd (58 ms) is before lockStart (63 ms)"), block);
  assert.equal(lines(block).filter((l) => l.startsWith("    no ")).length, 2, block);
});

test("several visits, reversed with different values: one line, with each visit's values", () => {
  const block = formatServerBlock(visits({ marks: { lockEnd: 58, lockStart: 63 } }, { marks: { lockEnd: 59, lockStart: 64 } }), 2);
  assert.ok(lines(block).includes(
    "    no lock span in 2 of 2 visits: lockEnd is before lockStart (visit 1: lockEnd 58 ms, lockStart 63 ms · visit 2: lockEnd 59 ms, lockStart 64 ms)",
  ), block);
});

test("several visits, some with the span: the line names the visits without it", () => {
  const ok = { marks: { cacheStart: 10, cacheEnd: 30 } };
  const broken = { marks: { cacheStart: 10 } };
  const block = formatServerBlock(visits(ok, broken, broken), 3);
  assert.ok(lines(block).includes("    no cache span in 2 of 3 visits (2, 3): cacheEnd wasn't recorded"), block);
  assert.ok(/^    cache +20 +– +–/m.test(block), block);
  const one = formatServerBlock(visits(ok, broken), 2);
  assert.ok(lines(one).includes("    no cache span in 1 of 2 visits (2): cacheEnd wasn't recorded"), one);
});

test("several visits, different reasons: one line, with each visit's reason", () => {
  const block = formatServerBlock(visits({ marks: { cacheStart: 50 } }, { marks: { cacheEnd: 40, cacheStart: 50 } }), 2);
  assert.ok(lines(block).includes(
    "    no cache span in 2 of 2 visits: visit 1: cacheEnd wasn't recorded · visit 2: cacheEnd (40 ms) is before cacheStart (50 ms)",
  ), block);
});

test("problems the server reported are printed, last, under their own heading", () => {
  const problem = 'mark name "db-start" rejected — use a letter, then up to 63 letters, digits or _ (e.g. dbStart)';
  const block = formatServerBlock(visits({ marks: { dbStart: 1, dbEnd: 301 }, runtime: "workers", problems: [problem] }), 1);
  assert.deepEqual(lines(block).slice(-3), [
    "    Workers time waits only — a span with only computation inside (no I/O) can read 0 ms.",
    "  problems reported by the server",
    `    ${problem}`,
  ]);
});

test("no problems: no problems heading", () => {
  const block = formatServerBlock(visits({ marks: { dbStart: 1 } }, { marks: { dbStart: 1 }, problems: [] }), 2);
  assert.ok(!block.includes("problems"), block);
});

test("several visits: each distinct problem once, with the visits that reported it", () => {
  const a = "mark name \"db-start\" rejected — use a letter, then up to 63 letters, digits or _ (e.g. dbStart)";
  const b = "mark name \"x y\" rejected — use a letter, then up to 63 letters, digits or _ (e.g. dbStart)";
  const block = formatServerBlock(visits({ marks: {}, problems: [a] }, { marks: {}, problems: [a, b] }, { marks: {}, problems: [a] }), 3);
  assert.deepEqual(lines(block).slice(-3), [
    "  problems reported by the server",
    `    ${a}   (3 of 3 visits)`,
    `    ${b}   (1 of 3 visits: 2)`,
  ]);
});

test("a problem's control characters are shown escaped, and a long one is cut", () => {
  const block = formatServerBlock(visits({ marks: {}, problems: ["bad \u001b[31mred\u001b[0m\nnext", "x".repeat(400)] }), 1);
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

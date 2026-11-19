// modelFirstChunk (caliper-test-3 #8): the model's first chunk, marked by the app from its SDK's
// per-chunk callback (the AI SDK's streamText onChunk). It keeps its FIRST value, so marking it on
// every chunk is one line, and a record already saved at firstChunk (the AI SDK's {"type":"start"}
// envelope, written before the model answers) is saved again with it, in order.
// Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CaliperRun } from "../src/run.ts";
import type { TimingRecord, TimingStore } from "../src/protocol.ts";

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("modelFirstChunk keeps its first value, whatever calls it again (onChunk fires on every chunk)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const puts: TimingRecord[] = [];
  const store: TimingStore = { put: async (_id, r) => void puts.push(r), get: async () => null };
  const run = new CaliperRun("run_a", store, { start: 0 });
  t.mock.timers.tick(400);
  run.mark("modelFirstChunk");
  t.mock.timers.tick(60);
  run.mark("modelFirstChunk");
  t.mock.timers.tick(60);
  run.mark("modelFirstChunk");
  await run.save();
  assert.equal(puts.at(-1)!.marks.modelFirstChunk, 400);
});

test("AI SDK shape: the envelope is saved at firstChunk, then modelFirstChunk saves the record again, last write the newest", async () => {
  const puts: TimingRecord[] = [];
  // A store whose first put is slower than the second: an out-of-order store would end on the old record.
  let n = 0;
  const saved = new Map<string, TimingRecord>();
  const store: TimingStore = {
    put: async (id, r) => {
      const wait = n++ === 0 ? 40 : 0;
      await sleep(wait);
      puts.push(r);
      saved.set(id, r);
    },
    get: async (id) => saved.get(id) ?? null,
  };
  const run = new CaliperRun("run_a", store);
  run.mark("modelCallSent");
  let push!: (chunk: Uint8Array) => void;
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({ start: (c) => ((push = (x) => c.enqueue(x)), (close = () => c.close())) });
  const reading = (async () => {
    const reader = run.watchFirstChunk(body).getReader();
    while (!(await reader.read()).done);
  })();
  push(enc.encode('data: {"type":"start"}\n\n')); // the envelope: firstChunk, saved
  await sleep(30);
  run.mark("modelFirstChunk"); // the model's first chunk, from onChunk
  push(enc.encode('data: {"type":"text-delta","delta":"Hi"}\n\n'));
  run.mark("modelFirstChunk"); // onChunk again: no new value, no new save
  close();
  await reading;
  await sleep(80);
  const final = await store.get("run_a");
  assert.ok(final!.marks.firstChunk !== undefined && final!.marks.modelFirstChunk !== undefined, "the stored record has both marks");
  assert.ok(final!.marks.modelFirstChunk! >= final!.marks.firstChunk! + 25, "the model's first chunk is after the envelope");
  assert.equal(puts.length, 2, "saved twice: at firstChunk, then once at modelFirstChunk");
});

test("modelFirstChunk before any save (no watchFirstChunk yet): no extra save; the one save holds it", async () => {
  const puts: TimingRecord[] = [];
  const store: TimingStore = { put: async (_id, r) => void puts.push(r), get: async () => null };
  const run = new CaliperRun("run_a", store);
  run.mark("modelFirstChunk");
  assert.equal(puts.length, 0);
  await run.save();
  assert.equal(puts.length, 1);
  assert.ok(puts[0]!.marks.modelFirstChunk !== undefined);
});

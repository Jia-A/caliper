// CaliperRun and tokenMatches: marks, mark names, the record (runtime only when detected), the
// first-chunk watch on a Web stream, and a failed save. Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CaliperRun } from "../src/run.ts";
import { MemoryStore } from "../src/memoryStore.ts";
import { tokenMatches } from "../src/token.ts";
import type { TimingRecord, TimingStore } from "../src/protocol.ts";

// Runs fn with globalThis.navigator replaced, then puts the original back.
async function withNavigator(value: unknown, fn: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
  try {
    await fn();
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

test("marks are ms after the start, and the record holds exactly what was marked", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = new MemoryStore();
  const run = new CaliperRun("run_a", store, { start: Date.now() });
  t.mock.timers.tick(5);
  run.mark("dbStart");
  t.mock.timers.tick(300);
  run.mark("dbEnd");
  run.status = 200;
  await run.save();
  assert.deepEqual(await store.get("run_a"), { id: "run_a", status: 200, marks: { dbStart: 5, dbEnd: 305 } });
});

test("marking the same name twice keeps the later value", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const store = new MemoryStore();
  const run = new CaliperRun("run_a", store, { start: 0 });
  run.mark("dbStart");
  t.mock.timers.tick(7);
  run.mark("dbStart");
  await run.save();
  assert.deepEqual((await store.get("run_a"))?.marks, { dbStart: 7 });
});

test("the clock starts at options.start, not at construction", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = new MemoryStore();
  const run = new CaliperRun("run_a", store, { start: 990 });
  run.mark("dbStart");
  await run.save();
  assert.equal((await store.get("run_a"))?.marks.dbStart, 10);
});

const rejected = (name: unknown) => `mark name ${JSON.stringify(name)} rejected — use a letter, then up to 63 letters, digits or _ (e.g. dbStart)`;

test("mark names: a bad one never throws; it's skipped and reported in the record's problems", async () => {
  const store = new MemoryStore();
  const run = new CaliperRun("run_a", store, { start: Date.now() });
  const good = ["a", "dbStart", "vector_search2End", "x".repeat(64)];
  const bad = ["", "1db", "_db", "db-start", "db start", "dbStart!", "x".repeat(65)];
  for (const name of [...good, ...bad]) assert.doesNotThrow(() => run.mark(name), JSON.stringify(name));
  assert.doesNotThrow(() => run.mark(42 as unknown as string), "not even a string");
  await run.save();
  const record = (await store.get("run_a"))!;
  assert.deepEqual(Object.keys(record.marks), good);
  assert.deepEqual(record.problems, [...bad, 42].map(rejected));
});

test("problems: the same one is reported once, and at most 20 are kept, then one line says more were dropped", async () => {
  const store = new MemoryStore();
  const run = new CaliperRun("run_a", store);
  run.mark("db-start");
  run.mark("db-start");
  for (let i = 0; i < 30; i++) run.mark(`bad-${i}`);
  await run.save();
  const problems = (await store.get("run_a"))!.problems!;
  assert.equal(problems.length, 21);
  assert.equal(problems[0], rejected("db-start"));
  assert.equal(problems[19], rejected("bad-18"));
  assert.equal(problems[20], "more problems not recorded (only the first 20 are kept)");
});

test("a record with no problems has no problems field", async () => {
  const store = new MemoryStore();
  const run = new CaliperRun("run_a", store);
  run.mark("dbStart");
  await run.save();
  assert.equal(Object.hasOwn((await store.get("run_a"))!, "problems"), false);
});

test('runtime is "workers" only when navigator.userAgent is "Cloudflare-Workers", and absent otherwise', async () => {
  const runtimeWith = async (navigator: unknown) => {
    let runtime: unknown = "not saved";
    await withNavigator(navigator, async () => {
      const store = new MemoryStore();
      await new CaliperRun("run_a", store).save();
      const record = await store.get("run_a");
      runtime = record && "runtime" in record ? record.runtime : "absent";
    });
    return runtime;
  };
  assert.equal(await runtimeWith({ userAgent: "Cloudflare-Workers" }), "workers");
  assert.equal(await runtimeWith({ userAgent: "Node.js/22" }), "absent");
  assert.equal(await runtimeWith({ userAgent: "cloudflare-workers" }), "absent");
  assert.equal(await runtimeWith(undefined), "absent");
});

test("on this Node, with its own navigator, the record has no runtime field", async () => {
  const store = new MemoryStore();
  await new CaliperRun("run_a", store).save();
  assert.equal(Object.hasOwn((await store.get("run_a"))!, "runtime"), false);
});

const enc = new TextEncoder();
const streamOf = (chunks: Uint8Array[], gapMs = 0) =>
  new ReadableStream<Uint8Array>({
    async start(ctrl) {
      for (const c of chunks) {
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
        ctrl.enqueue(c);
      }
      ctrl.close();
    },
  });
async function readAll(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const c of stream) chunks.push(c);
  return chunks;
}

test("watchFirstChunk passes the same chunks through and saves at the first one with bytes", async () => {
  const puts: TimingRecord[] = [];
  const store: TimingStore = { put: async (_id, r) => void puts.push(r), get: async () => null };
  const run = new CaliperRun("run_a", store);
  const chunks = [new Uint8Array(0), enc.encode("data: a\n\n"), enc.encode("data: b\n\n")];
  const out = await readAll(run.watchFirstChunk(streamOf(chunks, 20)));
  assert.deepEqual(out, chunks, "same chunks, same boundaries, the empty one included");
  assert.equal(puts.length, 1, "saved once");
  assert.ok(puts[0]!.marks.firstChunk! >= 39, `firstChunk is the second chunk, ~40 ms in (got ${puts[0]!.marks.firstChunk})`);
  assert.equal(run.savesOnStream, true);
});

test("watchFirstChunk on a stream with no chunks saves once, at the end, without firstChunk", async () => {
  const puts: TimingRecord[] = [];
  const store: TimingStore = { put: async (_id, r) => void puts.push(r), get: async () => null };
  const run = new CaliperRun("run_a", store);
  run.mark("modelCallSent");
  await readAll(run.watchFirstChunk(streamOf([])));
  assert.equal(puts.length, 1);
  assert.deepEqual(Object.keys(puts[0]!.marks), ["modelCallSent"]);
});

test("a store whose put throws synchronously: save neither throws nor rejects, and logs it", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const store = { put() { throw new Error("sync store down"); }, get: async () => null } as unknown as TimingStore;
  const run = new CaliperRun("run_a", store);
  let saved: Promise<void> | undefined;
  assert.doesNotThrow(() => (saved = run.save()));
  await assert.doesNotReject(saved!);
  assert.equal((error.mock.calls[0]!.arguments[1] as Error).message, "sync store down");
});

test("a defer that throws doesn't reach the caller either", async (t) => {
  t.mock.method(console, "error", () => {});
  const run = new CaliperRun("run_a", new MemoryStore(), { defer: () => { throw new Error("no waitUntil"); } });
  let saved: Promise<void> | undefined;
  assert.doesNotThrow(() => (saved = run.save()));
  await assert.doesNotReject(saved!);
});

test("watchFirstChunk with a store that throws: every chunk still comes through, unchanged", async (t) => {
  t.mock.method(console, "error", () => {});
  const store = { put() { throw new Error("sync store down"); }, get: async () => null } as unknown as TimingStore;
  const chunks = [enc.encode("data: a\n\n"), enc.encode("data: b\n\n")];
  const out = await readAll(new CaliperRun("run_a", store).watchFirstChunk(streamOf(chunks)));
  assert.deepEqual(out, chunks);
});

test("a failed save is logged, not thrown, and is passed to defer", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const deferred: Promise<void>[] = [];
  const store: TimingStore = { put: async () => { throw new Error("store down"); }, get: async () => null };
  const run = new CaliperRun("run_a", store, { defer: (p) => void deferred.push(p) });
  await run.save();
  assert.equal(deferred.length, 1);
  assert.equal(error.mock.callCount(), 1);
  assert.equal(error.mock.calls[0]!.arguments[0], "Caliper timing record not saved");
  assert.equal((error.mock.calls[0]!.arguments[1] as Error).message, "store down");
});

test("tokenMatches: equal strings only, whatever the lengths", async () => {
  assert.equal(await tokenMatches("secret-token", "secret-token"), true);
  assert.equal(await tokenMatches("secret-token", "secret-tokeN"), false);
  assert.equal(await tokenMatches("secret", "secret-token"), false);
  assert.equal(await tokenMatches("", "secret-token"), false);
});

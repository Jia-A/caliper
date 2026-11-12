// The Durable Object store for Cloudflare Workers: CaliperTimingsDO (one instance per run id, the
// record kept as a JSON string under "record", deleted by an alarm 10 minutes after the last
// write) and DurableObjectStore, which reaches it through a namespace stub. Outside the Workers
// runtime: the state, storage and namespace here are fakes with the same methods.
// Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CaliperRun, finish, handle, RECORD_TTL_MS, start, type TimingRecord } from "../src/fetch.ts";
import { CaliperTimingsDO, DurableObjectStore } from "../src/workers.ts";

// A Durable Object's storage: a Map, and the alarm time last set (null when none).
class FakeStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async put(key: string, value: unknown) {
    this.data.set(key, value);
  }
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined;
  }
  async setAlarm(at: number) {
    this.alarm = at;
  }
  async deleteAll() {
    this.data.clear();
  }
}

// A namespace: one CaliperTimingsDO per name, as idFromName + get give on Workers. Its stubs
// answer fetch with the object's own fetch, like a real stub (a Request to the object).
class FakeNamespace {
  objects = new Map<string, { object: CaliperTimingsDO; storage: FakeStorage }>();
  names: string[] = [];
  idFromName(name: string) {
    this.names.push(name);
    return { name };
  }
  get(id: { name: string }) {
    if (!this.objects.has(id.name)) {
      const storage = new FakeStorage();
      this.objects.set(id.name, { object: new CaliperTimingsDO({ storage }, {}), storage });
    }
    const { object } = this.objects.get(id.name)!;
    return { fetch: (input: string, init?: RequestInit) => object.fetch(new Request(input, init)) };
  }
}

const RECORD: TimingRecord = { id: "run_a", status: 200, marks: { dbStart: 1, firstChunk: 9 }, prompt: { messages: [{ role: "user", bytes: 5 }] } };

test("put then get: the same record back, through one object per run id", async () => {
  const ns = new FakeNamespace();
  const store = new DurableObjectStore(ns);
  await store.put("run_a", RECORD);
  await store.put("run_b", { ...RECORD, id: "run_b" });
  assert.deepEqual(await store.get("run_a"), RECORD);
  assert.deepEqual((await store.get("run_b"))?.id, "run_b");
  assert.deepEqual([...ns.objects.keys()], ["run_a", "run_b"]);
  assert.ok(ns.names.every((n) => n === "run_a" || n === "run_b"));
});

test("no record: get gives null", async () => {
  assert.equal(await new DurableObjectStore(new FakeNamespace()).get("run_none"), null);
});

test('the stored format is Quill\'s: the record as a JSON string under "record", and an alarm 10 minutes after the write', async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 5_000 });
  const ns = new FakeNamespace();
  await new DurableObjectStore(ns).put("run_a", RECORD);
  const { storage } = ns.objects.get("run_a")!;
  assert.deepEqual([...storage.data.entries()], [["record", JSON.stringify(RECORD)]]);
  assert.equal(storage.alarm, 5_000 + RECORD_TTL_MS);
  assert.equal(RECORD_TTL_MS, 10 * 60 * 1000);
});

test("a later write moves the alarm: the record lives 10 minutes after the last write", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const ns = new FakeNamespace();
  const store = new DurableObjectStore(ns);
  await store.put("run_a", RECORD);
  t.mock.timers.tick(60_000);
  await store.put("run_a", { ...RECORD, status: 500 });
  assert.equal(ns.objects.get("run_a")!.storage.alarm, 60_000 + RECORD_TTL_MS);
  assert.equal((await store.get("run_a"))?.status, 500);
});

test("the alarm deletes the record", async () => {
  const ns = new FakeNamespace();
  const store = new DurableObjectStore(ns);
  await store.put("run_a", RECORD);
  await ns.objects.get("run_a")!.object.alarm();
  assert.equal(await store.get("run_a"), null);
});

test("the object answers PUT 204, GET 200 JSON or 404, and 405 for anything else", async () => {
  const storage = new FakeStorage();
  const object = new CaliperTimingsDO({ storage }, {});
  const at = (method: string, body?: string) => object.fetch(new Request("https://caliper-timings/record", { method, ...(body !== undefined && { body }) }));
  assert.equal((await at("GET")).status, 404);
  assert.equal((await at("PUT", JSON.stringify(RECORD))).status, 204);
  const got = await at("GET");
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "application/json");
  assert.equal(await got.text(), JSON.stringify(RECORD));
  for (const method of ["POST", "DELETE", "PATCH"]) assert.equal((await at(method, "x")).status, 405, method);
});

// A namespace whose object answers every request with `status`.
const failing = (status: number) => ({ idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("down", { status }) }) });

test("a write the object refuses rejects in the store, and CaliperRun.save neither throws nor rejects: it's logged", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const store = new DurableObjectStore(failing(500));
  await assert.rejects(store.put("run_a", RECORD), /CaliperTimingsDO put failed: 500/);
  const run = new CaliperRun("run_a", store);
  let saved: Promise<void>;
  assert.doesNotThrow(() => (saved = run.save()));
  await assert.doesNotReject(saved!);
  assert.equal(error.mock.callCount(), 1);
  assert.equal(error.mock.calls[0]!.arguments[0], "Caliper timing record not saved");
});

test("a read the object refuses rejects in the store, and the endpoint answers 500", async (t) => {
  t.mock.method(console, "error", () => {});
  const store = new DurableObjectStore(failing(500));
  await assert.rejects(store.get("run_a"), /CaliperTimingsDO get failed: 500/);
  const res = await handle(new Request("https://app.example/__caliper/timings/run_a", { headers: { authorization: "Bearer t" } }), { token: "t", store });
  assert.equal(res?.status, 500);
});

test("end to end with the fetch adapter: a marked streamed request saved through the object, read back at the endpoint", async () => {
  const store = new DurableObjectStore(new FakeNamespace());
  const deferred: Promise<void>[] = [];
  const headers = { "x-caliper-run": "run_e2e", "x-caliper-token": "t" };
  const run = (await start(new Request("https://app.example/generate", { method: "POST", headers }), { token: "t", store, defer: (p) => void deferred.push(p) }))!;
  run.prompt([{ role: "system", content: "abc" }]);
  run.mark("modelCallSent");
  const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("hi")), c.close()) });
  const body = await finish(run, new Response(run.watchFirstChunk(stream), { status: 200 })).text();
  assert.equal(body, "hi");
  await Promise.all(deferred);
  const res = await handle(new Request("https://app.example/__caliper/timings/run_e2e", { headers: { authorization: "Bearer t" } }), { token: "t", store });
  const record = (await res!.json()) as TimingRecord;
  assert.equal(record.status, 200);
  assert.deepEqual(Object.keys(record.marks), ["modelCallSent", "firstChunk"]);
  assert.deepEqual(record.prompt, { messages: [{ role: "system", bytes: 3 }] });
});

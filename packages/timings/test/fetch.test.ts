// The fetch adapter (Web Request/Response: Hono on Workers, and anything else that speaks fetch):
// the endpoint's check order (SPEC.md), which requests get a run, that the response is the same
// either way, and when the record is saved. No socket: requests and responses are built directly.
// Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { finish, handle, MemoryStore, start, type CaliperRun, type TimingRecord, type TimingStore } from "../src/fetch.ts";

const TOKEN = "fetch-adapter-test-token";
const BEARER = { authorization: `Bearer ${TOKEN}` };
const STAMP = (run: string) => ({ "x-caliper-run": run, "x-caliper-token": TOKEN });
const CHUNKS = ['data: {"t":"Hello"}\n\n', 'data: {"t":" world"}\n\n', "data: [DONE]\n\n"];
const enc = new TextEncoder();

// A store that counts reads and writes.
class CountingStore extends MemoryStore {
  gets = 0;
  puts = 0;
  override async get(id: string) {
    this.gets++;
    return super.get(id);
  }
  override async put(id: string, record: TimingRecord) {
    this.puts++;
    return super.put(id, record);
  }
}

const endpoint = (path: string, headers: Record<string, string> = BEARER, method = "GET") =>
  new Request(`https://app.example${path}`, { method, headers });
const timings = (id: string, headers: Record<string, string> = BEARER) => endpoint(`/__caliper/timings/${id}`, headers);

// An app as a fetch handler: the timings endpoint first, then POST /generate, which waits 30 ms
// ("query"), then streams CHUNKS 10 ms apart, through run.watchFirstChunk when marked.
// (`{ token: undefined }` means no token: a default parameter would turn it back into TOKEN.)
function app(store: TimingStore, { token }: { token: string | undefined } = { token: TOKEN }) {
  const deferred: Promise<void>[] = [];
  const runs: (CaliperRun | null)[] = [];
  const fetchHandler = async (request: Request): Promise<Response> => {
    const answered = await handle(request, { token, store });
    if (answered) return answered;
    if (request.method !== "POST" || new URL(request.url).pathname !== "/generate") return new Response("app 404", { status: 404 });
    const run = await start(request, { token, store, defer: (p) => void deferred.push(p) });
    runs.push(run);
    run?.mark("dbStart");
    await sleep(30);
    run?.mark("dbEnd");
    run?.mark("modelCallSent");
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        for (const c of CHUNKS) {
          await sleep(10);
          ctrl.enqueue(enc.encode(c));
        }
        ctrl.close();
      },
    });
    const response = new Response(run ? run.watchFirstChunk(stream) : stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    return run ? finish(run, response) : response;
  };
  return { fetch: fetchHandler, runs, deferred };
}
const generate = (headers: Record<string, string> = {}) => new Request("https://app.example/generate", { method: "POST", headers, body: "{}" });

async function snapshot(res: Response) {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, headers, body: await res.text() };
}
const json = async (res: Response | null) => ({ status: res?.status, cache: res?.headers.get("cache-control"), type: res?.headers.get("content-type"), body: res ? await res.json() : null });

test("endpoint: no token, or an empty one → null for every request (the app's own 404), and the store is never read", async () => {
  for (const token of [undefined, ""]) {
    const store = new CountingStore();
    assert.equal(await handle(timings("abc"), { token, store }), null);
    assert.equal(await handle(timings("caliper.precheck"), { token, store }), null);
    assert.equal(store.gets, 0);
  }
});

test("endpoint: other paths and other methods → null", async () => {
  const store = new CountingStore();
  for (const req of [endpoint("/generate"), endpoint("/__caliper/other"), endpoint("/__caliper/timings/abc", BEARER, "POST"), endpoint("/__caliper/timings/abc", BEARER, "PUT")]) {
    assert.equal(await handle(req, { token: TOKEN, store }), null, `${req.method} ${req.url}`);
  }
  assert.equal(store.gets, 0);
});

test("endpoint: missing, wrong or non-Bearer token → 401 before the store is read", async () => {
  const store = new CountingStore();
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }, { authorization: `bearer ${TOKEN}` }] as Record<string, string>[]) {
    assert.deepEqual(await json(await handle(timings("abc", headers), { token: TOKEN, store })), {
      status: 401, cache: "no-store", type: "application/json",
      body: { error: { code: "UNAUTHORIZED", message: "Missing or invalid Caliper token" } },
    }, JSON.stringify(headers));
  }
  assert.equal(store.gets, 0);
});

test("endpoint: Caliper's pre-check id and other malformed ids → 400 with the right token", async () => {
  const store = new CountingStore();
  for (const id of ["caliper.precheck", "a%2Fb", "%E0%A4%A", "x".repeat(65), "a b"]) {
    assert.deepEqual(await json(await handle(timings(id), { token: TOKEN, store })), {
      status: 400, cache: "no-store", type: "application/json",
      body: { error: { code: "INVALID_RUN_ID", message: "Run id must be 1-64 characters of A-Z, a-z, 0-9, _ or -" } },
    }, id);
  }
  assert.equal(store.gets, 0);
});

test("endpoint: no record → 404 NOT_FOUND; a record → 200 with it", async () => {
  const store = new CountingStore();
  assert.deepEqual(await json(await handle(timings("run_a"), { token: TOKEN, store })), {
    status: 404, cache: "no-store", type: "application/json",
    body: { error: { code: "NOT_FOUND", message: "No timing record for this run id" } },
  });
  const record: TimingRecord = { id: "run_a", status: 200, marks: { dbStart: 1 } };
  await store.put("run_a", record);
  assert.deepEqual(await json(await handle(timings("run_a"), { token: TOKEN, store })), { status: 200, cache: "no-store", type: "application/json", body: record });
});

test("endpoint: a store whose get throws or rejects → 500 STORE_ERROR, logged", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  for (const get of [() => { throw new Error("down"); }, async () => { throw new Error("down"); }]) {
    const store = { put: async () => {}, get } as unknown as TimingStore;
    assert.deepEqual(await json(await handle(timings("run_a"), { token: TOKEN, store })), {
      status: 500, cache: "no-store", type: "application/json",
      body: { error: { code: "STORE_ERROR", message: "The timing store failed; see the server log" } },
    });
  }
  assert.equal(error.mock.callCount(), 2);
});

test("a stamped streamed request: saved once at the first chunk, with its status and the marks in order", async () => {
  const store = new CountingStore();
  const a = app(store);
  const body = await (await a.fetch(generate(STAMP("run_stream")))).text();
  assert.equal(body, CHUNKS.join(""));
  await Promise.all(a.deferred);
  const record = (await json(await a.fetch(timings("run_stream")))).body as TimingRecord;
  assert.equal(record.status, 200);
  assert.deepEqual(Object.keys(record.marks), ["dbStart", "dbEnd", "modelCallSent", "firstChunk"]);
  const { dbStart, dbEnd, firstChunk } = record.marks as Record<string, number>;
  assert.ok(dbEnd! - dbStart! >= 29, `db span ${dbEnd! - dbStart!} ms, want ≥ 29`);
  assert.ok(firstChunk! >= dbEnd!, JSON.stringify(record.marks));
  assert.equal(store.puts, 1, "saved once, at the first chunk");
  assert.equal(a.deferred.length, 1, "the save was passed to defer");
});

test("a stamped request gets the same status, headers and bytes as an unmarked one", async () => {
  const a = app(new CountingStore());
  const plain = await snapshot(await a.fetch(generate()));
  const marked = await snapshot(await a.fetch(generate(STAMP("run_same"))));
  assert.deepEqual(marked, plain);
  assert.equal(plain.body, CHUNKS.join(""));
});

test("requests that don't qualify get no run and record nothing", async () => {
  const cases: [string, Record<string, string>, string | undefined][] = [
    ["no headers", {}, TOKEN],
    ["no token header", { "x-caliper-run": "run_a" }, TOKEN],
    ["wrong token", { "x-caliper-run": "run_a", "x-caliper-token": "wrong" }, TOKEN],
    ["malformed id", { "x-caliper-run": "bad.id", "x-caliper-token": TOKEN }, TOKEN],
    ["no secret on the server", STAMP("run_a"), undefined],
    ["an empty secret on the server", STAMP("run_a"), ""],
  ];
  for (const [what, headers, token] of cases) {
    const store = new CountingStore();
    const a = app(store, { token });
    assert.equal(await (await a.fetch(generate(headers))).text(), CHUNKS.join(""), what);
    assert.deepEqual(a.runs, [null], what);
    assert.equal(store.puts, 0, what);
  }
});

test("finish: a reply without watchFirstChunk is saved by finish, with its status and no firstChunk; the response is returned as it was", async () => {
  const store = new CountingStore();
  const run = (await start(generate(STAMP("run_json")), { token: TOKEN, store }))!;
  run.mark("dbStart");
  const response = new Response('{"error":"nope"}', { status: 403, headers: { "content-type": "application/json" } });
  assert.equal(finish(run, response), response);
  await sleep(5);
  const record = (await store.get("run_json"))!;
  assert.equal(record.status, 403);
  assert.deepEqual(Object.keys(record.marks), ["dbStart"]);
  assert.equal(store.puts, 1);
});

test("finish: with watchFirstChunk, it only sets the status; the save happens at the first chunk", async () => {
  const store = new CountingStore();
  const run = (await start(generate(STAMP("run_s")), { token: TOKEN, store }))!;
  const stream = run.watchFirstChunk(new ReadableStream({ start: (c) => (c.enqueue(enc.encode("x")), c.close()) }));
  finish(run, new Response(stream, { status: 201 }));
  assert.equal(store.puts, 0, "not saved before the stream is read");
  await new Response(stream).text();
  await sleep(5);
  assert.equal((await store.get("run_s"))!.status, 201);
  assert.equal(store.puts, 1);
});

test("start and finish never throw: a request whose headers throw runs unmarked; finish with a broken run returns the response", async (t) => {
  t.mock.method(console, "error", () => {});
  const broken = new Proxy(generate(STAMP("run_a")), {
    get: (target, key) => (key === "headers" ? (() => { throw new Error("headers throw"); })() : Reflect.get(target, key)),
  });
  assert.equal(await start(broken, { token: TOKEN, store: new CountingStore() }), null);
  const run = { set status(_v: unknown) { throw new Error("status throws"); }, savesOnStream: false } as unknown as CaliperRun;
  const response = new Response("ok");
  assert.equal(finish(run, response), response);
});

test("the clock starts when start() is called", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = new CountingStore();
  const run = (await start(generate(STAMP("run_clock")), { token: TOKEN, store }))!;
  t.mock.timers.tick(12);
  run.mark("dbStart");
  await run.save();
  assert.equal((await store.get("run_clock"))!.marks.dbStart, 12);
});

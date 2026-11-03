// The node:http adapter, over a real socket on 127.0.0.1: the endpoint's check order (SPEC.md),
// which requests get a record, that the response is the same bytes either way, and when the
// record is saved (first write with bytes, or close). Run with `npm test`.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createTimings, MemoryStore, type CaliperRun, type TimingRecord } from "../src/node.ts";

const TOKEN = "node-adapter-test-token";
const BEARER = { authorization: `Bearer ${TOKEN}` };
const STAMP = (run: string) => ({ "x-caliper-run": run, "x-caliper-token": TOKEN });
const CHUNKS = ['data: {"t":"Hello"}\n\n', 'data: {"t":" world"}\n\n', "data: [DONE]\n\n"];

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

type Route = (run: CaliperRun | null, req: IncomingMessage, res: ServerResponse) => Promise<void>;

// The generate route: 30 ms "query", then the "model" answers 20 ms after the call and streams
// CHUNKS 10 ms apart.
const generate: Route = async (run, _req, res) => {
  run?.mark("dbStart");
  await sleep(30);
  run?.mark("dbEnd");
  run?.mark("modelCallSent");
  await sleep(20);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const chunk of CHUNKS) {
    res.write(chunk);
    await sleep(10);
  }
  res.end();
};

const servers: { close(): void }[] = [];
after(() => servers.forEach((s) => s.close()));

// A store where every call fails: synchronously (a throw) or asynchronously (a rejection).
class BrokenStore extends CountingStore {
  readonly how: "throws" | "rejects";
  constructor(how: "throws" | "rejects") {
    super();
    this.how = how;
  }
  override get(id: string): Promise<TimingRecord | null> {
    this.gets++;
    if (this.how === "throws") throw new Error("store down (get)");
    return Promise.reject(new Error("store down (get)"));
  }
  override put(id: string, record: TimingRecord): Promise<void> {
    this.puts++;
    if (this.how === "throws") throw new Error("store down (put)");
    return Promise.reject(new Error("store down (put)"));
  }
}

// Anything that escapes the wrapper as an unhandled rejection or exception lands here.
const escaped: unknown[] = [];
process.on("unhandledRejection", (err) => escaped.push(err));
process.on("uncaughtException", (err) => escaped.push(err));

// An app: timings.handle first, then POST /generate (or `route`), else the app's own 404.
// (`token: undefined` means no token: a default parameter would turn it back into TOKEN.)
async function startApp<S extends CountingStore = CountingStore>(opts: { token?: string | undefined; route?: Route; store?: S } = {}) {
  const token = "token" in opts ? opts.token : TOKEN;
  const route = opts.route ?? generate;
  const store = opts.store ?? (new CountingStore() as S);
  const timings = createTimings({ token, store });
  const started: (CaliperRun | null)[] = [];
  const server = createServer(async (req, res) => {
    if (await timings.handle(req, res)) return;
    if (req.method === "POST" && req.url === "/generate") {
      const run = await timings.start(req, res);
      started.push(run);
      await route(run, req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("app 404");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push({ close: () => server.close() });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, store, started };
}

// Every request gives up after 3 s, so a response the wrapper broke fails the test instead of hanging it.
const post = (url: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/generate`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(3000) });
const timingsFor = (url: string, id: string, headers: Record<string, string> = BEARER) => fetch(`${url}/__caliper/timings/${id}`, { headers, signal: AbortSignal.timeout(3000) });

// Status, every header except date, and the exact bytes.
async function snapshot(res: Response) {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k !== "date") headers[k] = v;
  });
  return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()).toString("utf8") };
}

test("endpoint: no token set → the app's own 404, and the store is never read", async () => {
  const app = await startApp({ token: undefined });
  for (const id of ["caliper.precheck", "run_a"]) {
    const res = await timingsFor(app.url, id);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "app 404");
  }
  assert.equal(app.store.gets, 0);
});

test("endpoint: an empty token counts as not set", async () => {
  const app = await startApp({ token: "" });
  const res = await timingsFor(app.url, "run_a", { authorization: "Bearer " });
  assert.equal(await res.text(), "app 404");
});

test("endpoint: missing, wrong or non-Bearer token → 401 before the store is read", async () => {
  const app = await startApp();
  const tries: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }, { authorization: `bearer ${TOKEN}` }];
  for (const headers of tries) {
    const res = await timingsFor(app.url, "run_a", headers);
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.deepEqual(await res.json(), { error: { code: "UNAUTHORIZED", message: "Missing or invalid Caliper token" } });
  }
  assert.equal(app.store.gets, 0);
});

test("endpoint: Caliper's pre-check id (and other malformed ids) → 400 with the right token, 401 without", async () => {
  const app = await startApp();
  for (const id of ["caliper.precheck", "a%2Fb", "x".repeat(65), "%E0%A4%A", ""]) {
    const res = await timingsFor(app.url, id);
    assert.equal(res.status, 400, id);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "INVALID_RUN_ID");
  }
  assert.equal((await timingsFor(app.url, "caliper.precheck", { authorization: "Bearer wrong" })).status, 401);
  assert.equal(app.store.gets, 0);
});

test("endpoint: a valid id with no record → 404 NOT_FOUND; other methods and paths are the app's", async () => {
  const app = await startApp();
  const res = await timingsFor(app.url, "run_never");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { code: "NOT_FOUND", message: "No timing record for this run id" } });
  assert.equal(app.store.gets, 1);
  for (const [id, headers] of [["run_never", BEARER], ["run_never", {}], ["caliper.precheck", BEARER]] as const) {
    assert.equal((await timingsFor(app.url, id, headers)).headers.get("cache-control"), "no-store", `${id} ${JSON.stringify(headers)}`);
  }
  const del = await fetch(`${app.url}/__caliper/timings/run_never`, { method: "DELETE", headers: BEARER });
  assert.equal(await del.text(), "app 404");
  assert.equal(await (await fetch(`${app.url}/__caliper/other`, { headers: BEARER })).text(), "app 404");
});

test("a stamped streamed request: record with all four marks in order, readable at the endpoint", async () => {
  const app = await startApp();
  const body = await (await post(app.url, STAMP("run_stream"))).text();
  assert.equal(body, CHUNKS.join(""));
  const res = await timingsFor(app.url, "run_stream");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const record = (await res.json()) as TimingRecord;
  assert.equal(record.id, "run_stream");
  assert.equal(record.status, 200);
  assert.equal("runtime" in record, false);
  assert.deepEqual(Object.keys(record.marks), ["dbStart", "dbEnd", "modelCallSent", "firstChunk"]);
  const { dbStart, dbEnd, modelCallSent, firstChunk } = record.marks as Record<string, number>;
  assert.ok(dbStart! >= 0 && dbStart! <= dbEnd! && dbEnd! <= modelCallSent! && modelCallSent! <= firstChunk!, JSON.stringify(record.marks));
  // Node timers can fire up to ~1 ms early once rounded to whole ms, so 30 can read 29.
  assert.ok(dbEnd! - dbStart! >= 29, `db span ${dbEnd! - dbStart!} ms, want ≥ 29`);
  assert.ok(firstChunk! - modelCallSent! >= 19, `sent → first chunk ${firstChunk! - modelCallSent!} ms, want ≥ 19`);
  assert.equal(app.store.puts, 1, "saved once, at the first chunk");
});

test("a stamped request gets the same status, headers and bytes as an unmarked one", async () => {
  const app = await startApp();
  const plain = await snapshot(await post(app.url));
  const marked = await snapshot(await post(app.url, STAMP("run_same")));
  assert.deepEqual(marked, plain);
  assert.equal(plain.body, CHUNKS.join(""));
});

test("requests that don't qualify run unmarked, unchanged, and record nothing", async () => {
  const app = await startApp();
  const plain = await snapshot(await post(app.url));
  const cases: [string, Record<string, string>][] = [
    ["no headers", {}],
    ["run id without a token", { "x-caliper-run": "run_x" }],
    ["token without a run id", { "x-caliper-token": TOKEN }],
    ["wrong token", { "x-caliper-run": "run_x", "x-caliper-token": "wrong" }],
    ["malformed run id", { "x-caliper-run": "caliper.precheck", "x-caliper-token": TOKEN }],
  ];
  for (const [label, headers] of cases) assert.deepEqual(await snapshot(await post(app.url, headers)), plain, label);
  assert.deepEqual(app.started, Array(cases.length + 1).fill(null));
  assert.equal(app.store.puts, 0);
  assert.equal((await timingsFor(app.url, "run_x")).status, 404);
});

test("no token set on the server: both headers right still records nothing", async () => {
  const app = await startApp({ token: undefined });
  await (await post(app.url, STAMP("run_off"))).text();
  assert.deepEqual(app.started, [null]);
  assert.equal(app.store.puts, 0);
});

test("a reply sent with res.end(body) only: saved when the response closes, with its status, no firstChunk", async () => {
  const app = await startApp({
    route: async (run, _req, res) => {
      run?.mark("dbStart");
      await sleep(5);
      run?.mark("dbEnd");
      res.writeHead(403, { "content-type": "application/json" }).end('{"error":"not yours"}');
    },
  });
  assert.equal((await post(app.url, STAMP("run_end"))).status, 403);
  await sleep(20); // close fires after the client has the response
  const record = (await (await timingsFor(app.url, "run_end")).json()) as TimingRecord;
  assert.equal(record.status, 403);
  assert.deepEqual(Object.keys(record.marks), ["dbStart", "dbEnd"]);
});

test("an empty write (flushing headers) isn't the first chunk", async () => {
  const app = await startApp({
    route: async (run, _req, res) => {
      run?.mark("modelCallSent");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("");
      await sleep(40);
      res.write(CHUNKS[0]);
      res.end();
    },
  });
  assert.equal(await (await post(app.url, STAMP("run_empty"))).text(), CHUNKS[0]);
  const record = (await (await timingsFor(app.url, "run_empty")).json()) as TimingRecord;
  const { modelCallSent, firstChunk } = record.marks as Record<string, number>;
  assert.ok(firstChunk! - modelCallSent! >= 39, `firstChunk is the write with bytes, ~40 ms in (got ${firstChunk! - modelCallSent!})`);
});

test("the client leaves before any headers: saved at close with status null and the marks so far", async () => {
  let closed: () => void = () => {};
  const done = new Promise<void>((r) => (closed = r));
  const app = await startApp({
    route: async (run, _req, res) => {
      run?.mark("dbStart");
      res.once("close", () => setImmediate(closed)); // after the adapter's own close listener
      await sleep(300);
      if (!res.destroyed) res.end();
    },
  });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  await fetch(`${app.url}/generate`, { method: "POST", headers: STAMP("run_gone"), body: "{}", signal: ctrl.signal }).catch(() => {});
  await done;
  const record = (await (await timingsFor(app.url, "run_gone")).json()) as TimingRecord;
  assert.equal(record.status, null);
  assert.deepEqual(Object.keys(record.marks), ["dbStart"]);
});

// SPEC: an implementation must never change the response or error behaviour of the app's request.
for (const how of ["throws", "rejects"] as const) {
  test(`a store that ${how} on put: the marked response is byte-identical to the unmarked one`, async (t) => {
    t.mock.method(console, "error", () => {});
    escaped.length = 0;
    const app = await startApp({ store: new BrokenStore(how) });
    const plain = await snapshot(await post(app.url));
    const marked = await snapshot(await post(app.url, STAMP(`run_broken_${how}`)));
    await sleep(20); // let a stray rejection surface
    assert.ok(app.started[1] !== null, "the second request really was marked");
    assert.equal(app.store.puts, 1, "the wrapper did try to save");
    assert.deepEqual(marked, plain);
    assert.deepEqual(escaped, [], "nothing escaped the wrapper");
  });

  test(`a store that ${how} on get: the endpoint answers 500, and app requests are untouched`, async (t) => {
    t.mock.method(console, "error", () => {});
    escaped.length = 0;
    const app = await startApp({ store: new BrokenStore(how) });
    const res = await timingsFor(app.url, "run_a");
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: { code: "STORE_ERROR", message: "The timing store failed; see the server log" } });
    assert.equal(await (await fetch(`${app.url}/elsewhere`, { signal: AbortSignal.timeout(3000) })).text(), "app 404");
    await sleep(20);
    assert.deepEqual(escaped, []);
  });
}

test("a request URL the wrapper can't parse is left to the app", async () => {
  escaped.length = 0;
  const app = await startApp();
  // A raw request line: fetch would normalise the URL before sending it.
  const { request } = await import("node:http");
  const body = await new Promise<string>((resolve, reject) => {
    const req = request(app.url, { method: "GET", path: "//[" }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c)).on("end", () => resolve(text));
    });
    req.on("error", reject).end();
  });
  assert.equal(body, "app 404");
  assert.deepEqual(escaped, []);
});

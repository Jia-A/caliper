// UpstashStore: Redis over Upstash's REST API (plain fetch), for serverless hosts like Vercel. Run
// against a fake Upstash REST server on 127.0.0.1: POST a JSON command array with a bearer token,
// answered with {"result": …} or {"error": …}. No external calls. Run with `npm test`.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { handle, MemoryStore, RECORD_TTL_MS, start, finish, CaliperRun, type TimingRecord } from "../src/fetch.ts";
import { UpstashStore } from "../src/upstash.ts";

const TOKEN = "upstash-test-token-9b2e";

// The fake: SET key value EX seconds, GET key, with expiry on a clock the test controls.
type Fake = { url: string; commands: unknown[][]; auth: (string | undefined)[]; now: number; answer?: (res: ServerResponse) => boolean };
const servers: { close(): void }[] = [];
after(() => servers.forEach((s) => s.close())); // closeAllConnections too: a request left unanswered must not hold the process

async function fakeUpstash(): Promise<Fake> {
  const data = new Map<string, { value: string; expiresAt: number | null }>();
  const fake: Fake = { url: "", commands: [], auth: [], now: 0 };
  const send = (res: ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    fake.auth.push(req.headers.authorization);
    if (fake.answer?.(res)) return;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "Unauthorized" });
    if (req.method !== "POST" || req.url !== "/") return send(res, 400, { error: "ERR only POST / in this fake" });
    const command = JSON.parse(body) as string[];
    fake.commands.push(command);
    const [name, key] = command;
    if (name === "SET") {
      const ex = command.indexOf("EX");
      data.set(key!, { value: command[2]!, expiresAt: ex === -1 ? null : fake.now + Number(command[ex + 1]) * 1000 });
      return send(res, 200, { result: "OK" });
    }
    if (name === "GET") {
      const entry = data.get(key!);
      const live = entry && (entry.expiresAt === null || entry.expiresAt > fake.now);
      return send(res, 200, { result: live ? entry!.value : null });
    }
    return send(res, 400, { error: `ERR unknown command '${name}'` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push({ close: () => (server.closeAllConnections(), server.close()) });
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

const RECORD: TimingRecord = { id: "run_a", status: 200, marks: { modelCallSent: 3, firstChunk: 9 }, prompt: { messages: [{ role: "user", bytes: 5 }] } };

test("put then get: the same record back, under caliper:timings:<id>, set with a 10-minute expiry", async () => {
  const fake = await fakeUpstash();
  const store = new UpstashStore({ url: fake.url, token: TOKEN });
  await store.put("run_a", RECORD);
  assert.deepEqual(await store.get("run_a"), RECORD);
  assert.deepEqual(fake.commands, [
    ["SET", "caliper:timings:run_a", JSON.stringify(RECORD), "EX", String(RECORD_TTL_MS / 1000)],
    ["GET", "caliper:timings:run_a"],
  ]);
  assert.ok(fake.auth.every((a) => a === `Bearer ${TOKEN}`));
});

test("no record, or an expired one: null", async () => {
  const fake = await fakeUpstash();
  const store = new UpstashStore({ url: fake.url, token: TOKEN });
  assert.equal(await store.get("run_none"), null);
  await store.put("run_a", RECORD);
  fake.now += RECORD_TTL_MS;
  assert.equal(await store.get("run_a"), null);
});

test("a trailing slash on the URL is fine", async () => {
  const fake = await fakeUpstash();
  const store = new UpstashStore({ url: `${fake.url}/`, token: TOKEN });
  await store.put("run_a", RECORD);
  assert.deepEqual(await store.get("run_a"), RECORD);
});

test("a refused call rejects in the store, with the status, and never the token", async () => {
  const fake = await fakeUpstash();
  const wrong = new UpstashStore({ url: fake.url, token: "not-the-token" });
  await assert.rejects(wrong.put("run_a", RECORD), (err: Error) => /Upstash SET failed: 401/.test(err.message) && !err.message.includes("not-the-token"));
  await assert.rejects(wrong.get("run_a"), (err: Error) => /Upstash GET failed: 401/.test(err.message));
  fake.answer = (res) => (res.writeHead(500, { "content-type": "text/plain" }).end("boom"), true);
  const store = new UpstashStore({ url: fake.url, token: TOKEN });
  await assert.rejects(store.put("run_a", RECORD), (err: Error) => /Upstash SET failed: 500/.test(err.message) && !err.message.includes(TOKEN));
});

test("an {error} answer, a body that isn't JSON, or a stored value that isn't a record: rejects", async () => {
  const fake = await fakeUpstash();
  const store = new UpstashStore({ url: fake.url, token: TOKEN });
  fake.answer = (res) => (res.writeHead(200, { "content-type": "application/json" }).end('{"error":"ERR something"}'), true);
  await assert.rejects(store.put("run_a", RECORD), /Upstash SET failed: ERR something/);
  fake.answer = (res) => (res.writeHead(200, { "content-type": "application/json" }).end("not json"), true);
  await assert.rejects(store.get("run_a"), /Upstash GET failed/);
  fake.answer = (res) => (res.writeHead(200, { "content-type": "application/json" }).end('{"result":"not a record"}'), true);
  await assert.rejects(store.get("run_a"), /Upstash GET failed: the stored value isn't a timing record/);
});

test("a call that doesn't answer in time rejects at the timeout", { timeout: 3000 }, async () => {
  const fake = await fakeUpstash();
  fake.answer = () => true; // never answers
  const store = new UpstashStore({ url: fake.url, token: TOKEN, timeoutMs: 100 });
  const started = Date.now();
  await assert.rejects(store.put("run_a", RECORD), /Upstash SET failed: no answer in 100 ms/);
  assert.ok(Date.now() - started < 1500, `gave up after ${Date.now() - started} ms`);
});

test("CaliperRun.save with a refused store: neither throws nor rejects, logged without the token; the endpoint answers 500", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const fake = await fakeUpstash();
  fake.answer = (res) => (res.writeHead(500).end(), true);
  const store = new UpstashStore({ url: fake.url, token: TOKEN });
  let saved: Promise<void>;
  assert.doesNotThrow(() => (saved = new CaliperRun("run_a", store).save()));
  await assert.doesNotReject(saved!);
  assert.equal(error.mock.callCount(), 1);
  assert.ok(!JSON.stringify(error.mock.calls.map((c) => c.arguments.map(String))).includes(TOKEN));
  const res = await handle(new Request("https://app.example/__caliper/timings/run_a", { headers: { authorization: "Bearer t" } }), { token: "t", store });
  assert.equal(res?.status, 500);
});

test("fromEnv: UPSTASH_REDIS_REST_* or Vercel's KV_REST_API_* names; null when either part is missing", () => {
  const url = "https://example.upstash.io";
  assert.ok(UpstashStore.fromEnv({ UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: "t" }) instanceof UpstashStore);
  assert.ok(UpstashStore.fromEnv({ KV_REST_API_URL: url, KV_REST_API_TOKEN: "t" }) instanceof UpstashStore);
  assert.equal(UpstashStore.fromEnv({ KV_REST_API_URL: url }), null);
  assert.equal(UpstashStore.fromEnv({ UPSTASH_REDIS_REST_TOKEN: "t" }), null);
  assert.equal(UpstashStore.fromEnv({}), null);
  assert.equal(UpstashStore.fromEnv({ KV_REST_API_URL: "", KV_REST_API_TOKEN: "" }), null);
  assert.ok((UpstashStore.fromEnv({}) ?? new MemoryStore()) instanceof MemoryStore, "the documented fallback");
});

test("end to end with the fetch adapter: a marked streamed request saved through Upstash, read back at the endpoint", async () => {
  const fake = await fakeUpstash();
  const store = new UpstashStore({ url: fake.url, token: TOKEN });
  const deferred: Promise<void>[] = [];
  const headers = { "x-caliper-run": "run_e2e", "x-caliper-token": "t" };
  const run = (await start(new Request("https://app.example/api/chat", { method: "POST", headers }), { token: "t", store, defer: (p) => void deferred.push(p) }))!;
  run.prompt([{ role: "system", content: "abc" }, { role: "user", content: "Q: hi" }], { parts: [{ message: 1, name: "question", text: "Q: hi" }] });
  run.mark("modelCallSent");
  const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("hi")), c.close()) });
  assert.equal(await finish(run, new Response(run.watchFirstChunk(stream))).text(), "hi");
  await Promise.all(deferred);
  const res = await handle(new Request("https://app.example/__caliper/timings/run_e2e", { headers: { authorization: "Bearer t" } }), { token: "t", store });
  const record = (await res!.json()) as TimingRecord;
  assert.deepEqual(Object.keys(record.marks), ["modelCallSent", "firstChunk"]);
  assert.deepEqual(record.prompt?.messages[1]?.parts, [{ name: "question", bytes: 5, found: true }]);
});

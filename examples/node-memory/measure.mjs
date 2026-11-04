// Client-side timings for the node-memory example, which curl can't give: when the headers and
// each body chunk reached this client, in ms from when the request was sent (client clock).
// Sends RUNS marked and RUNS unmarked POST /api/generate requests, alternating (marked first), one
// at a time on a fresh connection each. For each marked run it also reads the stored record from
// /__caliper/timings/:id, and at the end the server's own /__example/stamps.
//   CALIPER_TOKEN=… node examples/node-memory/measure.mjs [out.json]
// With COMPARE=<another base URL> it instead sends RUNS unmarked requests to each of BASE and
// COMPARE, alternating (BASE first), and needs no token:
//   COMPARE=http://127.0.0.1:8791 node examples/node-memory/measure.mjs [out.json]
// BASE (default http://127.0.0.1:8790) and RUNS (default 20) are read from the environment.
// Prints a summary and writes every raw measurement as JSON (default measure-results.json).

import { request } from "node:http";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = process.env.BASE ?? "http://127.0.0.1:8790";
const RUNS = Number(process.env.RUNS ?? 20);
const TOKEN = process.env.CALIPER_TOKEN;
const COMPARE = process.env.COMPARE;
const OUT = process.argv[2] ?? "measure-results.json";

if (!TOKEN && !COMPARE) {
  console.error("CALIPER_TOKEN must be set to the server's token.");
  process.exit(1);
}
if (!Number.isInteger(RUNS) || RUNS < 1) {
  console.error(`RUNS must be a whole number of at least 1, got "${process.env.RUNS}".`);
  process.exit(1);
}

// One request on its own connection. Every time is performance.now() minus the moment the
// request was handed to the socket layer.
function generate(runId, base = BASE) {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json" };
    if (runId) Object.assign(headers, { "x-caliper-run": runId, "x-caliper-token": TOKEN });
    const sent = performance.now();
    const req = request(`${base}/api/generate`, { method: "POST", headers, agent: false }, (res) => {
      const result = { runId, status: res.statusCode, headersAt: performance.now() - sent, chunks: [] };
      res.on("data", (buf) => {
        const text = buf.toString("utf8");
        // A chunk here is one socket read; events counts the SSE events it carried, so two
        // events read together show up instead of passing as one.
        result.chunks.push({ at: performance.now() - sent, bytes: buf.length, events: text.split("\n\n").length - 1 });
      });
      res.on("end", () => resolve(result));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end("{}");
  });
}

async function getJson(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

const sorted = (xs) => [...xs].sort((a, b) => a - b);
const median = (xs) => {
  const s = sorted(xs);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const row = (label, xs) =>
  console.log(`${label.padEnd(36)} n=${String(xs.length).padStart(3)}  min ${fmt(Math.min(...xs)).padStart(6)}  median ${fmt(median(xs)).padStart(6)}  max ${fmt(Math.max(...xs)).padStart(6)}`);
const oneEventEach = (r) => r.chunks.length === 5 && r.chunks.every((c) => c.events === 1);

if (COMPARE) {
  const ab = { base: BASE, compare: COMPARE, a: [], b: [] };
  for (let i = 0; i < RUNS; i++) {
    ab.a.push(await generate(null, BASE));
    ab.b.push(await generate(null, COMPARE));
  }
  writeFileSync(OUT, JSON.stringify(ab, null, 2));
  console.log(`unmarked first chunk (ms from request sent, client clock):`);
  row(`BASE    ${BASE}`, ab.a.map((r) => r.chunks[0].at));
  row(`COMPARE ${COMPARE}`, ab.b.map((r) => r.chunks[0].at));
  row("paired BASE - COMPARE", ab.a.map((r, i) => r.chunks[0].at - ab.b[i].chunks[0].at));
  const all = [...ab.a, ...ab.b];
  console.log(`responses not 200: ${all.filter((r) => r.status !== 200).length}`);
  console.log(`responses whose chunks didn't each carry exactly 1 event: ${all.filter((r) => !oneEventEach(r)).length}`);
  console.log(`raw data: ${OUT}`);
  process.exit(0);
}

const results = { marked: [], unmarked: [] };
for (let i = 0; i < RUNS; i++) {
  const runId = `m${i + 1}-${randomUUID().slice(0, 8)}`;
  const marked = await generate(runId);
  marked.record = await getJson(`/__caliper/timings/${runId}`, { authorization: `Bearer ${TOKEN}` });
  results.marked.push(marked);
  results.unmarked.push(await generate(null));
}
results.stamps = (await getJson("/__example/stamps")).body;
writeFileSync(OUT, JSON.stringify(results, null, 2));

const records = results.marked.map((r) => r.record);
const badRecords = records.filter((r) => r.status !== 200);
const marks = records.filter((r) => r.status === 200).map((r) => r.body.marks);
const firstChunk = (rs) => rs.map((r) => r.chunks[0].at);
const gaps = (rs) => rs.flatMap((r) => r.chunks.slice(1).map((c, i) => c.at - r.chunks[i].at));
const allRuns = [...results.marked, ...results.unmarked];

console.log(`server spans (ms, server clock, whole ms):`);
row("db: dbEnd - dbStart", marks.map((m) => m.dbEnd - m.dbStart));
row("model: firstChunk - modelCallSent", marks.map((m) => m.firstChunk - m.modelCallSent));
console.log(`client (ms from request sent, client clock):`);
row("first chunk, marked", firstChunk(results.marked));
row("first chunk, unmarked", firstChunk(results.unmarked));
row("gap between chunks, marked", gaps(results.marked));
row("gap between chunks, unmarked", gaps(results.unmarked));
row("headers, marked", results.marked.map((r) => r.headersAt));
row("headers, unmarked", results.unmarked.map((r) => r.headersAt));
console.log(`records not read (status != 200): ${badRecords.length}`);
console.log(`responses not 200: ${allRuns.filter((r) => r.status !== 200).length}`);
console.log(`responses whose chunks didn't each carry exactly 1 event: ${allRuns.filter((r) => !oneEventEach(r)).length}`);
console.log(`stamps: ${JSON.stringify(results.stamps)}`);
console.log(`raw data: ${OUT}`);

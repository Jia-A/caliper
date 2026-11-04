# caliper-timings

The server side of [Caliper](https://github.com/Jia-A/caliper)'s server timings. Caliper (`caliper-ai`) measures an AI feature in a real browser. With this on your server, it can also show what happened inside one marked request: how long it waited on the database, on the model, or on any step you mark.

Light enough to stay in production, deployed dark:

- No runtime dependencies.
- The core uses only `Date.now()`, Web Streams and `crypto.subtle`.
- Off unless `CALIPER_TOKEN` is set.
- Unmarked requests are never touched.

The wire format is in [SPEC.md](SPEC.md), so other languages can implement it too.

## Node (`node:http`)

```js
import { createServer } from "node:http";
import { createTimings, MemoryStore } from "caliper-timings/node";

const timings = createTimings({ token: process.env.CALIPER_TOKEN, store: new MemoryStore() });

createServer(async (req, res) => {
  if (await timings.handle(req, res)) return; // GET /__caliper/timings/:id; false for everything else

  if (req.method === "POST" && req.url === "/api/generate") {
    const run = await timings.start(req, res); // null unless this request is marked
    run?.mark("dbStart");
    const row = await db.query(/* … */);
    run?.mark("dbEnd");
    run?.mark("modelCallSent");
    res.writeHead(200, { "content-type": "text/event-stream" });
    for await (const chunk of model.stream(/* … */)) res.write(chunk); // the first write with bytes: firstChunk
    res.end();
    return;
  }
  // … your other routes and your 404
}).listen(8787);
```

- **`handle(req, res)`** answers `GET /__caliper/timings/:id` in SPEC.md's check order and returns `true`. For any other request it returns `false` and doesn't touch the response. With no token set it returns `false` for every request, so your own 404 answers.
- **`start(req, res)`** returns a `CaliperRun` only when the request carries a valid `x-caliper-run` and the right `x-caliper-token`. Otherwise it returns `null` and the request and response are left exactly as they were. Call it first thing in the route: marks are measured from the moment `start()` was called.
- **`run.mark(name)`** records ms since then. Name spans with `<name>Start` / `<name>End` (`dbStart` / `dbEnd`); Caliper shows each pair as a span called `<name>`. `modelCallSent` and `firstChunk` are reserved. A name outside `^[A-Za-z][A-Za-z0-9_]{0,63}$` is skipped, not thrown, and Caliper prints it under "problems reported by the server".
- **When the record is saved:** at the first `res.write` with bytes, with `firstChunk` marked then. Otherwise when the response closes, whether it finished or the client left. `status` is `res.statusCode`, or `null` if no headers were sent. Every write goes through unchanged.

### It never changes your app

A marked request succeeds or fails exactly as it would unmarked; that's the protocol's [rule](SPEC.md#the-rule-never-change-the-app). Nothing in the wrapper throws into your request:
- **`start()`** returns `null` if anything inside it fails, and the request runs unmarked.
- **`mark()` and `save()`** never throw or reject.
- **A store that throws or rejects** on save is logged to `console.error`, and the record is dropped.
- **A URL `handle()` can't parse** is left to your app.
- **A store failure while Caliper reads the timings endpoint** answers that request with 500.

### MemoryStore

`MemoryStore` keeps records in a `Map`, for 10 minutes after each write.

**Use it for single-process servers only.** On Workers, or several processes behind a load balancer, each one has its own `Map`, so Caliper's read can land where the write never happened (`404`).

**Cleanup:** every `put` deletes every expired record first, and a `get` that finds an expired record deletes it. After a write, the store holds only records written in the last 10 minutes. If writes stop, what's left stays until the next `put` or `get`. That's bounded by the last 10 minutes of marked requests, not a growing leak. Only requests carrying the right token create records.

## Core (`caliper-timings`)

The core works in any runtime with Web Streams and `crypto.subtle`. It exports:

- `CaliperRun`, with `mark`, `save`, and `watchFirstChunk(stream)` for frameworks that return a `ReadableStream`;
- `MemoryStore` and the `TimingStore` interface;
- `tokenMatches`, `isValidRunId`, `isValidMarkName`;
- the header and path constants;
- the `TimingRecord` type.

There's no framework adapter other than Node yet.

## Measured cost

The rule covers status, headers, bytes and errors, not time. This is what the reference implementation (`caliper-timings/node`) measured in time, on [`examples/node-memory`](../../examples/node-memory/): a single-process `node:http` app on 127.0.0.1, Node 22.22, one macOS machine. The client is `examples/node-memory/measure.mjs`, timing on its own clock from sending the request to the first body chunk arriving, one request at a time, each on a new connection.

- **Marked requests: about 1.2 ms slower before the first byte.** 20 marked and 20 unmarked requests to the same server, alternating, compared in pairs: the marked one was later by median 1.2 ms (min 0.1, max 4.1). The difference is already there when the headers arrive (paired median 1.4 ms); between headers and first chunk it's 0.1 ms. What causes it hasn't been measured.
- **Unmarked requests: no difference measured.** 20 unmarked requests to the wired server (`CALIPER_TOKEN` set) alternated with 20 to the same app before it was wired: paired difference median 0.0 ms (min −2.3, max 5.4).

That is one app, one machine and 20 pairs each. Other runtimes, frameworks, stores and loads haven't been measured.

## Tested

`npm test` runs Node 22.18+ directly on the TypeScript source. It covers:

- **The endpoint's check order**, over a real socket on 127.0.0.1: 404 with no or empty token (the app's own), 401 for a missing, wrong or non-`Bearer` token before the store is read, 400 for malformed ids including Caliper's `caliper.precheck`, 404 for no record, 200 with the record, and `no-store` on every answer.
- **Which requests qualify:** marked requests get the same status, headers and bytes as unmarked ones. Requests missing a header, with a wrong token or a malformed id, or on a server with no token, record nothing.
- **When the record is saved:** at the first write with bytes (an empty write doesn't count), at close for `res.end(body)` replies, and at close with `status: null` when the client leaves before headers.
- **Never changing the app:** with a store whose `put` throws, or one whose `put` rejects, the marked response is byte-identical to the unmarked one and nothing escapes as an unhandled error. With a broken `get`, the endpoint answers 500 and app requests are untouched. A URL that doesn't parse is left to the app. A `save()` with a throwing store or `defer` neither throws nor rejects. Each of these was checked by removing the guard, and the test then fails.
- **Marks and mark names:** marks in ms from `start()`. Bad names are skipped and reported in `problems`, each once, at most 20, then one line saying more were dropped. There's no `problems` field when nothing went wrong.
- **`runtime`:** `"workers"` only for `navigator.userAgent === "Cloudflare-Workers"`, and absent on Node.
- **`watchFirstChunk`:** chunks unchanged, saved once.
- **A failed save** is logged and not thrown.
- **MemoryStore expiry and cleanup,** including 3 hours of one write a minute never holding more than 10 records.

## Known limits

- **Saved once, at the first chunk.** Marks made after the first chunk of a streamed reply aren't in the record.
- **`res.end(body)` doesn't mark `firstChunk`.** A reply sent only that way gets no `firstChunk` mark; only `res.write` is watched.
- **One process only.** `MemoryStore` is for single-process servers. There's no shared store for Node yet. The Durable Object store for Workers comes with the Hono adapter.
- **Node only, so far.** Only the `node:http` adapter exists. Express or Fastify can use it through their raw `req`/`res`, but that hasn't been tested.
- **No cross-origin test yet.** Cross-origin APIs need the CORS preflight to allow `x-caliper-run` and `x-caliper-token`.
- **Node 20 isn't tested.** The build targets Node 20+, but tests run on Node 22.

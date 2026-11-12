# caliper-timings

The server side of [Caliper](https://github.com/Jia-A/caliper)'s server timings. Caliper (`caliper-ai`) measures an AI feature in a real browser. With this on your server, it can also show what happened inside one marked request: how long it waited on the database, on the model, or on any step you mark.

Light enough to stay in production, deployed dark:

- No runtime dependencies.
- The core uses only `Date.now()`, Web Streams and `crypto.subtle`.
- Off unless `CALIPER_TOKEN` is set.
- Unmarked requests are never touched.

The wire format is in [SPEC.md](SPEC.md), so other languages can implement it too.

## Install

Two steps, in two places. Step 2 is optional.

### 1. On your machine: `caliper-ai`

The machine you run Caliper from (your laptop, or CI). It's the CLI that marks a request and reads the timings back:

```sh
npm install -g caliper-ai
npx playwright install chromium
```

See the [caliper-ai README](https://github.com/Jia-A/caliper/tree/main/packages/cli#readme).

### 2. In your server's project: `caliper-timings` (optional)

Only if you want server timings. Install it in the project of the app Caliper measures, then wire it in as below:

```sh
npm install caliper-timings
```

Without it (or without `CALIPER_TOKEN` set on the server), Caliper still times everything it sees from the browser. Requires Node.js 20 or newer.

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
    const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: row.text }];
    run?.prompt(messages); // each message's role and size in bytes, never its text
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
- **`run.prompt(messages)`** records each message's role and its size in bytes (UTF-8), in order, for Caliper's prompt sizes. Pass the same list you send to the model, as `{ role, content }` objects, just before the model call. With a separate system text (Anthropic's API), pass it as the first message. It never records the text. A role that isn't a lowercase name (`system`, `user`, `assistant`, …) is recorded as `"?"`, and content that isn't a string gets no size (`null`), with a problem saying which message, by number. It reads the list and never changes it. A later call replaces an earlier one. See [SPEC.md](SPEC.md#prompt-sizes).
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

- `CaliperRun`, with `mark`, `prompt`, `save`, and `watchFirstChunk(stream)` for frameworks that return a `ReadableStream`;
- `MemoryStore` and the `TimingStore` interface;
- `tokenMatches`, `isValidRunId`, `isValidMarkName`, `isValidRole`;
- the header and path constants;
- the `TimingRecord` and `PromptMessageSize` types.

There's no framework adapter other than Node yet.

## Measured cost

The rule covers status, headers, bytes and errors, not time. This is what the reference implementation (`caliper-timings/node`) measured in time, on [`examples/node-memory`](https://github.com/Jia-A/caliper/tree/main/examples/node-memory): a single-process `node:http` app on 127.0.0.1, Node 22.22, one macOS machine. The client is `examples/node-memory/measure.mjs`, timing on its own clock from sending the request to the first body chunk arriving, one request at a time, each on a new connection.

- **Marked requests: about 1.2 ms slower before the first byte.** 20 marked and 20 unmarked requests to the same server, alternating, compared in pairs: the marked one was later by median 1.2 ms (min 0.1, max 4.1). The difference is already there when the headers arrive (paired median 1.4 ms); between headers and first chunk it's 0.1 ms. What causes it hasn't been measured.
- **`run.prompt()`: microseconds per call, measured on its own.** On Node 22.22 (Apple M2), 50 batches of 1000 calls each: a Quill-sized prompt (2 messages, 8184 bytes) took median 2.5 µs per call (min 2.4, max 4.6), and a 40-message chat (500 bytes each) median 10.0 µs (min 9.7, max 10.5). That's the call alone, not a request's time end to end, and it was measured on one machine, not on Workers. An unmarked request doesn't call it: with `run?.prompt(messages)`, `run` is `null`, so the list isn't even built (tested).
- **Unmarked requests: no difference measured.** 20 unmarked requests to the wired server (`CALIPER_TOKEN` set) alternated with 20 to the same app before it was wired: paired difference median 0.0 ms (min −2.3, max 5.4).

That is one app, one machine and 20 pairs each. Other runtimes, frameworks, stores and loads haven't been measured.

## Tested

`npm test` runs Node 22.18+ directly on the TypeScript source. It covers:

- **The endpoint's check order**, over a real socket on 127.0.0.1: 404 with no or empty token (the app's own), 401 for a missing, wrong or non-`Bearer` token before the store is read, 400 for malformed ids including Caliper's `caliper.precheck`, 404 for no record, 200 with the record, and `no-store` on every answer.
- **Which requests qualify:** marked requests get the same status, headers and bytes as unmarked ones. Requests missing a header, with a wrong token or a malformed id, or on a server with no token, record nothing.
- **When the record is saved:** at the first write with bytes (an empty write doesn't count), at close for `res.end(body)` replies, and at close with `status: null` when the client leaves before headers.
- **Never changing the app:** with a store whose `put` throws, or one whose `put` rejects, the marked response is byte-identical to the unmarked one and nothing escapes as an unhandled error. With a broken `get`, the endpoint answers 500 and app requests are untouched. A URL that doesn't parse is left to the app. A `save()` with a throwing store or `defer` neither throws nor rejects. Each of these was checked by removing the guard, and the test then fails.
- **Marks and mark names:** marks in ms from `start()`. Bad names are skipped and reported in `problems`, each once, at most 20, then one line saying more were dropped. There's no `problems` field when nothing went wrong.
- **Prompt sizes never carry text, never change the app:** a marker string put in a system prompt, a role, a list of parts and an extra key is nowhere in the record, its problems, the error log or the endpoint's answer. The messages see no write of any kind (a Proxy records every write; none), and a deeply frozen list reads fine. Lists that throw when read (a revoked Proxy, a throwing `length`, item, `role` or `content`, a `toString` that throws, a list containing itself, 100,000 messages) never throw out of `prompt()`, and the record still saves. Over HTTP, a marked request that calls `prompt()` with the marker list, a revoked Proxy or a throwing role gets the same status, headers and bytes as an unmarked one, with nothing escaping. An unmarked request reads the messages 0 times. Each was checked by breaking the code (storing the text, removing the try/catch, writing a tag on each message): the matching test then fails.
- **Prompt sizes (`run.prompt`):** role and UTF-8 bytes per message, in order, matching `TextEncoder` (lone surrogates included); a later call replaces an earlier one; no `prompt` field without a call. Roles that aren't lowercase names are recorded as `"?"`, content that isn't a string as `bytes: null`, and something that isn't a list as no `prompt`, each with a problem naming the message by number. At most 1000 messages.
- **`runtime`:** `"workers"` only for `navigator.userAgent === "Cloudflare-Workers"`, and absent on Node.
- **`watchFirstChunk`:** chunks unchanged, saved once.
- **A failed save** is logged and not thrown.
- **MemoryStore expiry and cleanup,** including 3 hours of one write a minute never holding more than 10 records.

## Known limits

- **Prompt sizes: a role can still carry a little text.** `run.prompt()` keeps a role that is up to 32 lowercase letters or `_` as it is, so an app that puts text there (`ignoreallpreviousinstructions`) has it recorded and shown. Anything with a space, a capital, a digit or punctuation is recorded as `"?"`. Message content is never recorded.
- **Saved once, at the first chunk.** Marks made after the first chunk of a streamed reply aren't in the record.
- **`res.end(body)` doesn't mark `firstChunk`.** A reply sent only that way gets no `firstChunk` mark; only `res.write` is watched.
- **One process only.** `MemoryStore` is for single-process servers. There's no shared store for Node yet. The Durable Object store for Workers comes with the Hono adapter.
- **Node only, so far.** Only the `node:http` adapter exists. Express or Fastify can use it through their raw `req`/`res`, but that hasn't been tested.
- **No cross-origin test yet.** Cross-origin APIs need the CORS preflight to allow `x-caliper-run` and `x-caliper-token`.
- **Node 20: one end-to-end run, no test suite.** The packed package was installed into a fresh project and the [example server](https://github.com/Jia-A/caliper/tree/main/examples/node-memory) ran on Node 20.18.3 with Caliper's 3 marked visits. `npm test` runs on Node 22 only.
- **ES module only.** Use `import`. `require("caliper-timings/node")` works on Node 22.22 but fails on Node 20.18.3 with `ERR_REQUIRE_ESM`. The type declarations were checked from an ES module with TypeScript 5.0, 5.9 and 7.0.

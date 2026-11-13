# Caliper server timings protocol, v1

A server that implements this lets [Caliper](https://github.com/Jia-A/caliper) read timings from inside one marked request: how long the request waited on the database, on the model, or on any other step the app chooses to mark. Any language can implement it. `caliper-timings` is the reference implementation (JavaScript).

The feature is off unless the server has a secret configured, so it can stay deployed in production, dark.

## The rule: never change the app

**An implementation must never change the response or error behaviour of the app's request.** A marked request must succeed or fail exactly as it would unmarked: same status, headers, bytes and errors.

Every failure inside the implementation is caught there and never reaches the app's request. That includes a store that throws or rejects, a save that fails, a bad mark name, or a request it can't parse. When the record can still carry it, the failure is noted in the record's `problems` (below). Otherwise it's dropped; the reference logs it to the server's error log.

A failure on Caliper's own read of the timings endpoint answers that request with 500. The app's requests are unaffected.

### Measured cost

The rule covers status, headers, bytes and errors, not time. This is what the reference implementation (`caliper-timings/node`) measured in time, on [`examples/node-memory`](https://github.com/Jia-A/caliper/tree/main/examples/node-memory): a single-process `node:http` app on 127.0.0.1, Node 22.22, one macOS machine. The client is `examples/node-memory/measure.mjs`, timing on its own clock from sending the request to the first body chunk arriving, one request at a time, each on a new connection.

- **Marked requests: about 1.2 ms slower before the first byte.** 20 marked and 20 unmarked requests to the same server, alternating, compared in pairs: the marked one was later by median 1.2 ms (min 0.1, max 4.1). The difference is already there when the headers arrive (paired median 1.4 ms); between headers and first chunk it's 0.1 ms. What causes it hasn't been measured.
- **`run.prompt()`: microseconds per call, measured on its own.** On Node 22.22 (Apple M2), 50 batches of 1000 calls each: a Quill-sized prompt (2 messages, 8184 bytes) took median 2.5 µs per call (min 2.4, max 4.6), and a 40-message chat (500 bytes each) median 10.0 µs (min 9.7, max 10.5). That's the call alone, not a request's time end to end, and it was measured on one machine, not on Workers. An unmarked request doesn't call it: with `run?.prompt(messages)`, `run` is `null`, so the list isn't even built (tested).
- **Unmarked requests: no difference measured.** 20 unmarked requests to the wired server (`CALIPER_TOKEN` set) alternated with 20 to the same app before it was wired: paired difference median 0.0 ms (min −2.3, max 5.4).

That is one app, one machine and 20 pairs each. Other runtimes, frameworks, stores and loads haven't been measured.

## Secret

The server has a secret, `CALIPER_TOKEN`. Without one (unset or empty), the feature doesn't exist: nothing is recorded, and the endpoint below answers like any unknown route (404).

## Marking a request

Caliper adds two headers to one request:

| Header | Value |
|---|---|
| `x-caliper-run` | the run id: 1–64 characters of `A-Z a-z 0-9 _ -` (`^[A-Za-z0-9_-]{1,64}$`) |
| `x-caliper-token` | the secret |

The server records timings for that request only when all of these hold:

- a secret is configured;
- the run id is valid;
- the token equals the secret. The comparison should be constant-time. The reference hashes both sides with SHA-256 and compares the digests byte by byte.

In every other case the request runs exactly like an unmarked one: same status, headers and bytes, no error, nothing recorded. A bad id or token on the request is silent; the endpoint reports it later.

## Marks

A mark is a name and the number of milliseconds since the server's route received the request. It's a finite number; the reference records whole milliseconds from `Date.now()`.

- **Names** are case-sensitive and match `^[A-Za-z][A-Za-z0-9_]{0,63}$`: a letter, then up to 63 letters, digits or `_`. A mark with any other name is skipped, never thrown, and reported in `problems`.
- **Spans** are chosen by the app. Any pair `<name>Start` / `<name>End` is one span, called `<name>`: `dbStart` / `dbEnd` is the span `db`, and `vectorSearchStart` / `vectorSearchEnd` is the span `vectorSearch`. `<name>` must be at least one character, and the suffix must be exactly `Start` or `End`.
- **Reserved:** `modelCallSent` (just before the model call is sent) and `firstChunk` (the first response chunk with bytes leaves the server). Caliper's report shows `firstChunk` as "server: first bytes sent" and the span between them as "model call → first bytes sent". `firstChunk` is the server's first write to the browser: if the app writes anything before the model's reply (a heartbeat, an envelope), it marks that write. Only the labels changed; the field names are as above.
- **No span** when only one of the pair is recorded, or when `<name>End` is earlier than `<name>Start`. Caliper then shows the marks as they are and says why there's no span. It never estimates one.
- **A step the request never reached has no mark.** Marks are never zero-filled or estimated. Marking the same name twice keeps the later value.
- Other names are allowed, and Caliper shows them under their own name. Caliper computes spans only from pairs and the reserved model pair, never between unrelated marks.

## Record

```json
{
  "id": "3f1c…",
  "status": 200,
  "marks": { "dbStart": 1, "dbEnd": 301, "modelCallSent": 301, "firstChunk": 402 },
  "runtime": "workers"
}
```

| Field | |
|---|---|
| `id` | the run id from `x-caliper-run` |
| `status` | the response status, or `null` when it isn't known (e.g. the client left before headers were sent) |
| `marks` | name → ms, as above; may be empty |
| `runtime` | optional, see below |
| `prompt` | optional, added in caliper-timings 0.2.0: the sizes of the prompt's messages, see [Prompt sizes](#prompt-sizes). Leave it out when the app didn't report a prompt. |
| `problems` | optional: a list of strings, in words, saying what the implementation skipped or couldn't do for this request. The reference writes `mark name "db-start" rejected — use a letter, then up to 63 letters, digits or _ (e.g. dbStart)`, keeps each one once and at most 20, then adds one line saying more were dropped. Leave the field out when there's nothing to report. Caliper prints each one as given, with control characters escaped and anything past 200 characters cut. A `problems` that isn't a list of strings makes Caliper reject the record. |

**When it's saved:** for a streamed response, at the first chunk with bytes, so marks made after that aren't in the record. For any other response, when it finishes or the connection closes.

Records should expire. The reference keeps them for 10 minutes after the last write.

### Prompt sizes

`prompt` is `{ "messages": [ { "role": "system", "bytes": 2310 }, { "role": "user", "bytes": 5874 } ] }`: one entry per message the app passed to the model, in order, as the app reported them just before the model call.

- **`role`** is the message's role when it matches `^[a-z][a-z_]{0,31}$` (`system`, `user`, `assistant`, `tool`, …), and `"?"` otherwise, so text can never reach the record through it.
- **`bytes`** is the length of the message's text in UTF-8, or `null` when the text wasn't a string (a list of parts, an image). It's never estimated. It's the size of the text, not of the request to the model, and not tokens.
- **A role can still carry a little text.** A role is recorded when it matches the pattern above, so up to 32 lowercase letters or `_` that the app puts in a role (`ignoreallpreviousinstructions`) are recorded and shown as they are. Anything with a space, a capital, a digit or punctuation becomes `"?"`.
- **Never the text.** No part of a message's content is recorded, and `problems` about the prompt name a message by its number only (`prompt message 2: …`), never by its role or text.
- At most 1000 messages are recorded; `problems` then says how many weren't.
- **Named parts** (optional, added in caliper-timings 0.4.0): a message's entry may carry `parts`, `[{ "name": "article", "bytes": 2911, "found": true }, …]`, in the order the app gave them. Each is a piece of that message the app named: `name` follows the same rule as `role` (else `"?"`); `bytes` is the UTF-8 length of the piece's text, or `null` when it wasn't a string; `found` is whether that text is inside the message's text, checked when it's recorded, or `null` when either wasn't a string. The piece's text is never recorded. `found` says the text is somewhere in the message, not where: a piece repeated in the message is found once. At most 50 parts per message. A message with no parts has no `parts` field. Readers that don't know `parts` ignore it.
- **Part source** (optional, added in caliper-timings 0.6.0): a part may carry `source`, who wrote its text as the app labelled it: `"app"` (the developer's own text), `"user"` (the person using the feature) or `"outside"` (anyone else: a database, the web, retrieved documents, other users' content). It's absent when the app gave none; it's never filled in by role or by name. Any other value isn't recorded, and `problems` says so, naming the part by number only. It's the app's claim, not checked by the wrapper. Readers that don't know `source` ignore it.
- When the app passes something that isn't a list, there's no `prompt`, and `problems` says so.

Older readers ignore the field, and a record without it is still valid: v1 is unchanged for servers that don't report a prompt.

### `runtime`

Include it only when the server has detected where it runs. Never guess or default it. The only value defined so far is `"workers"`: Cloudflare Workers, detected by `navigator.userAgent === "Cloudflare-Workers"`. On Workers, `Date.now()` only advances at I/O, so a span with only computation inside can read 0 ms. When the record says `"workers"`, Caliper prints a note saying so. Without the field, Caliper prints no runtime note.

## Endpoint

`GET /__caliper/timings/:id` with `Authorization: Bearer <secret>`.

The checks run in this order, and the first one that fails decides the answer:

| # | Check | Answer |
|---|---|---|
| 1 | no secret configured | **404**, like any unknown route |
| 2 | bearer missing, not in the `Bearer <token>` form, or wrong | **401**, before the store is read |
| 3 | id malformed | **400** |
| 4 | no record for the id, or it expired | **404** |
| 5 | otherwise | **200**, the record as JSON |

Caliper's token pre-check depends on this order. Before any marked request it asks for the id `caliper.precheck`. The `.` makes that id invalid, so it can never name a record: with the right token the answer is 400, with a wrong one 401, and with the feature off 404.

A failure reading the store (step 4) answers **500**.

The reference answers 401, 400, 404 and 500 with a JSON body `{ "error": { "code": …, "message": … } }`. The codes are `UNAUTHORIZED`, `INVALID_RUN_ID`, `NOT_FOUND` and `STORE_ERROR`, and every answer carries `cache-control: no-store`. Caliper reads only the status, so the bodies are informative.

The endpoint must not redirect. Caliper doesn't follow redirects, so the token can't be carried anywhere else.

## Cross-origin

If the page calls the API on another origin, the CORS preflight must allow the `x-caliper-run` and `x-caliper-token` request headers. Caliper hasn't been tested against a cross-origin API yet.

# Caliper server timings protocol, v1

A server that implements this lets [Caliper](https://github.com/Jia-A/caliper) read timings from inside one marked request: how long the request waited on the database, on the model, or on any other step the app chooses to mark. Any language can implement it. `caliper-timings` is the reference implementation (JavaScript).

The feature is off unless the server has a secret configured, so it can stay deployed in production, dark.

## The rule: never change the app

**An implementation must never change the response or error behaviour of the app's request.** A marked request must succeed or fail exactly as it would unmarked: same status, headers, bytes and errors.

Every failure inside the implementation is caught there and never reaches the app's request. That includes a store that throws or rejects, a save that fails, a bad mark name, or a request it can't parse. When the record can still carry it, the failure is noted in the record's `problems` (below). Otherwise it's dropped; the reference logs it to the server's error log.

A failure on Caliper's own read of the timings endpoint answers that request with 500. The app's requests are unaffected.

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
- **Reserved:** `modelCallSent` (just before the model call is sent) and `firstChunk` (the first response chunk with bytes leaves the server). Caliper shows the span between them as "model: sent → first chunk".
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
| `problems` | optional: a list of strings, in words, saying what the implementation skipped or couldn't do for this request. The reference writes `mark name "db-start" rejected — use a letter, then up to 63 letters, digits or _ (e.g. dbStart)`, keeps each one once and at most 20, then adds one line saying more were dropped. Leave the field out when there's nothing to report. Caliper prints each one as given, with control characters escaped and anything past 200 characters cut. A `problems` that isn't a list of strings makes Caliper reject the record. |

**When it's saved:** for a streamed response, at the first chunk with bytes, so marks made after that aren't in the record. For any other response, when it finishes or the connection closes.

Records should expire. The reference keeps them for 10 minutes after the last write.

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

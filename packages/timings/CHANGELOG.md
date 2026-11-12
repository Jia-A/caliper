# Changelog

## Unreleased

### Added

- **`caliper-timings/fetch`: fetch adapter** (Web `Request`/`Response`), for Cloudflare Workers and other fetch-style runtimes: `handle(request, { token, store })` answers the timings endpoint or returns `null`; `start(request, { token, store, defer })` returns a `CaliperRun` or `null`; `finish(run, response)` notes the status, saves a non-streamed reply, and returns the response as it was. The token is passed on every call. Same check order, answers and never-throw rules as the Node adapter, which now shares the endpoint code. Tested with `Request`/`Response` built in Node, not yet inside the Workers runtime.
- **`caliper-timings/workers`: Durable Object store** for Cloudflare Workers, moved from Quill's backend: `CaliperTimingsDO` (one object per run id; the record as a JSON string under `"record"`; deleted by an alarm 10 minutes after the last write) and `DurableObjectStore(namespace)`. Same class name and storage format as Quill's, so its binding and migrations stay. Declares the few Cloudflare methods it uses, so no Cloudflare types are needed; checked against Wrangler's generated types with TypeScript 5.9. Tested with a fake object state, storage and namespace, not the Workers runtime. Re-exports `caliper-timings/fetch`.

## 0.2.0 — 2026-11-12

### Added

- **`run.prompt(messages)`: prompt sizes.** Records each message's role and the size of its text in bytes (UTF-8), in order, in the record's new optional `prompt` field (`{ "messages": [{ "role": "system", "bytes": 2310 }, …] }`). Never the text: a role that isn't a lowercase name of up to 32 letters or `_` is recorded as `"?"`, content that isn't a string gets `bytes: null` (never estimated), and problems name the message by number only. At most 1000 messages. Never throws.
- **SPEC v1: optional `prompt` field** ([Prompt sizes](SPEC.md#prompt-sizes)). Not breaking: a record without it is unchanged. caliper-ai 0.4.0's record reader (from the release commit) was run once on a record with `prompt`: it read the marks and ignored the field.
- `isValidRole` and the `PromptMessageSize` type are exported.
- **Known limit:** a role of up to 32 lowercase letters or `_` is recorded as it is, so text an app puts in a role in that form is recorded too. Message content never is.
- **Tests that `run.prompt()` never carries text or changes the app** (a marker in every part of a prompt; a Proxy that records writes; lists that throw when read; byte-identical responses over HTTP; no reads when unmarked), each checked by breaking the code.
- **Measured cost of `run.prompt()`:** median 2.5 µs per call for a Quill-sized prompt (8184 bytes), 10.0 µs for 40 messages, on Node 22.22 (Apple M2).

## 0.1.0 — 2026-11-04

### Added

- **Core:** `CaliperRun`, `MemoryStore`, `tokenMatches`, `isValidRunId`, `isValidMarkName` and the `TimingRecord` type, ported from Quill's backend. They now use only erasable TypeScript, so Node 22 runs the source directly.
  - **Mark names** are now app-chosen, following SPEC v1: `<name>Start` / `<name>End` pairs, plus the reserved `modelCallSent` and `firstChunk`. An invalid name is skipped and reported in the record's new `problems` field.
  - **Nothing throws into the app's request** (SPEC: never change the app). A store that throws synchronously no longer reaches the request; Quill's version only caught rejections. A store failure on the timings endpoint answers 500.
  - **`MemoryStore`** now also deletes an expired record when a `get` finds it. Before, only the next `put` did.
  - **`watchFirstChunk`** skips chunks with no bytes.
- **`caliper-timings/node`:** `createTimings({ token, store })`, with `handle(req, res)` for the timings endpoint and `start(req, res)` for a route.
- **`SPEC.md`:** the protocol, v1, with the rule that an implementation never changes the app's response or errors, and the `problems` field.
- **First published release.** The package ships the compiled JavaScript and type declarations (`dist/`), with this changelog, the README, SPEC.md and the license.
- **Measured cost** in SPEC.md and the README: on `examples/node-memory`, marked requests median 1.2 ms slower before the first byte (20 pairs), unmarked requests median 0.0 ms against the pre-wiring server (20 pairs). Cause not measured.

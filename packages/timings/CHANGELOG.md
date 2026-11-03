# Changelog

## Unreleased

### Added

- **Core:** `CaliperRun`, `MemoryStore`, `tokenMatches`, `isValidRunId`, `isValidMarkName` and the `TimingRecord` type, ported from Quill's backend. They now use only erasable TypeScript, so Node 22 runs the source directly.
  - **Mark names** are now app-chosen, following SPEC v1: `<name>Start` / `<name>End` pairs, plus the reserved `modelCallSent` and `firstChunk`. An invalid name is skipped and reported in the record's new `problems` field.
  - **Nothing throws into the app's request** (SPEC: never change the app). A store that throws synchronously no longer reaches the request; Quill's version only caught rejections. A store failure on the timings endpoint answers 500.
  - **`MemoryStore`** now also deletes an expired record when a `get` finds it. Before, only the next `put` did.
  - **`watchFirstChunk`** skips chunks with no bytes.
- **`caliper-timings/node`:** `createTimings({ token, store })`, with `handle(req, res)` for the timings endpoint and `start(req, res)` for a route.
- **`SPEC.md`:** the protocol, v1, with the rule that an implementation never changes the app's response or errors, and the `problems` field.
- **`"private": true`** until publishing is decided.

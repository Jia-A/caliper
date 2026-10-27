# Changelog

## 0.3.0 — unreleased — tested on one real chat app so far (a Gradio Space)

### Added

- **Chat-style triggers: `--input <selector>` and `--prompt <text>`.** Caliper types the prompt into the input and sends it with the `--measure` button, or Enter when there's no `--measure`. The click or keydown starts the timer.
- **`--output` may be a container** (for example the message list) with `--input`. Caliper watches it for added nodes and text changes. Your own message (an added node whose trimmed text equals the prompt) doesn't count, and the first word is the container's first change at or after the AI request's first body byte. Earlier changes, such as a "Thinking…" placeholder, are listed as pre-reply changes in the terminal and the report's new "Before the reply" table, and are never timed. Done uses the same settle window as before.
- Test: `npm run test:chat` (chat-style run against a local fixture with a placeholder and an SSE reply), and a chat case in `npm run test:nostore`.
- **`--measure-selector <css>`: click by CSS selector.** For icon-only buttons (an `<svg>` with no text or `aria-label`) that `--measure` can't find by name. It must match exactly one element: 0 or more than one stops the audit with an error that gives the count. The clicked element (tag, id, and the first 60 characters of its `aria-label` or text) is printed before each run. Works in click runs, with `--input`/`--prompt`, and in the Stop, double-send and canary checks. Passing it together with `--measure` is an error. `--measure` still matches by name only. The report shows the selector under "Measured button" or "Sent with".
- Test: `npm run test:selector` (an icon-only send button where Enter doesn't send, in click and chat mode, plus the 0-match, 2-match and both-flags errors).

### Changed

- **The AI request is picked by time correlation, for clicks and chat sends alike.** The old scoring (longest, last to finish before first paint, …) only rewarded requests that had already finished, so on a queue-style app (a Gradio Space) it picked a 230 ms JSON side-call and reported a 281 ms first word for a reply that took far longer. Now every request sent since the trigger is a candidate, including streams still open, or opened only after, when the output starts changing. Caliper watches until they've all ended and the output has been quiet for `--settle-ms`, counts each output change toward the request whose body bytes (CDP `dataReceived`) arrived last within 250 ms before it, and picks the request that explains the most changes. It must be the unique top with at least one; a tie, or none, is reported as "AI request not identified, timing inconclusive", with no number, and the run is left out of the medians. Matched on timing, never on text.
- **First word** is the first output change at or after the chosen request's first body byte, for click runs too. **Done** is never earlier than that request's last body byte or end.
- Click runs list pre-reply changes when there are any. On a page whose output simply fills in from one stream (Quill), the numbers match 0.2.1 within run-to-run noise; only the "chosen from" line reads differently.
- The Stop and double-send checks still pick their request with the old scoring.
- A page whose output no request explains (for example, generated in the page itself) is now inconclusive instead of timed. Its run waits up to `--timeout` for a request to explain a change.
- Test: `npm run test:sidecall` (a fast side-call that renders a placeholder, next to a slow streamed reply; and a page no request explains).
- `--stop`, `--double` and `--canary` can't be combined with `--input` yet.

## 0.2.1 — 2026-10-26

### Fixed

- **No more hang on streams that end `net::ERR_ABORTED` after the full body.** Chromium ends a streamed response sent with `Cache-Control: no-store` that way once the page has read all of it, and Playwright's `response.finished()` then never settles, so the run waited out `--timeout` and the audit failed. Caliper now waits for the request to finish *or* fail, bounded by what's left of `--timeout` from the click. A request that ended `ERR_ABORTED` counts as finished when the body bytes Chrome received (CDP) match the body the page's Resource Timing entry recorded. It's labelled "ended ERR_ABORTED after full body — treated as finished" in the terminal and the report. A request aborted mid-body is noted as "ended net::ERR_ABORTED; full body not confirmed" instead (the same note when the body can't be confirmed, e.g. cross-origin without `Timing-Allow-Origin`).
- Test: `npm run test:nostore` (a no-store stream read in full, and one the page really aborts).

## 0.2.0 — 2026-10-26

### Added

- **Streaming verdict.** Each run reports click → first word, click → done and the streaming span (first word → last change), and flags answers that don't stream. `--settle-ms` sets when the output counts as done.
- **`--stop <text>`: Stop check.** One extra run clicks Stop mid-stream and checks that the output stops, the browser aborts the AI request, and the request never ends normally.
- **`--double`: double-send check.** One extra run clicks the measured button again mid-stream and reports whether the second click was prevented or ignored, or whether the previous request was cancelled, left running (paid twice), or its answer left on screen.
- **`--canary` / `--canary-input <selector>`: canary image check.** Plants a markdown-image instruction and reports whether the page turned the model's output into an image request, whether CSP blocked it, or whether the page showed it as text. Image requests are answered locally, so nothing leaves the machine.
- **`--csp`: CSP check** (on by default with `--canary`). Reads the page's Content-Security-Policy from response headers and `<meta>` tags and reports where images may load from, combining all enforced policies. Report-Only is reported separately.
- **`Fix:` lines** under every failing or warning verdict, in the terminal and the HTML report.
- **Summary block**: one line per check (✓ pass, ⚠ warning, ✗ fail, ? inconclusive) at the end of the terminal output and at the top of the HTML report.
- Tests: `npm run test:csp` (CSP parser unit tests) and `npm run test:canary` (canary check against a local fixture, with and without CSP).

### Changed

- A timed run whose page fails to load (for example `net::ERR_TIMED_OUT`) no longer stops the audit. It's reported as "page failed to load" and left out of the medians, and the summary says how many runs were used. If every run fails, Caliper prints "Inconclusive — page failed to load" and exits.

## 0.1.0

- First release: time from click to first painted output, broken down by network phase, with an HTML report.

# Changelog

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

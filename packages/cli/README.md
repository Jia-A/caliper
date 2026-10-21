# caliper-ai

TODO: Jiya writes this

## Install

```sh
npm install -g caliper-ai
npx playwright install chromium
```

Caliper drives a real Chromium through [Playwright](https://playwright.dev). The browser is a separate download and there is no postinstall script, so run the second command once. If you skip it, Caliper tells you to run it. Requires Node.js 20 or newer.

## Quick start

The example is an AI "generate a social post" button on a blog page. The page needs a logged-in user, so save a session first:

```sh
caliper login https://your-app.example.com
```

A browser window opens. Log in by hand, then click **Resume** in the Playwright Inspector. The session (cookies and local storage) is saved to `auth.json` in the current directory.

Then audit:

```sh
caliper audit https://your-app.example.com/blog/your-post-id \
  --step "share on socials" \
  --measure "^(re)?generate$" \
  --output textarea \
  --report
```

Caliper opens the page, clicks **Share on socials**, then clicks **Generate** or **Regenerate**. It times how long it takes until the `textarea` first shows new content, and repeats this three times:

```
run 1 (cold)   7702 ms
    POST https://api.your-app.example.com/v1/social/your-post-id/generate → 200 application/json
    chosen from 3 request(s): +1 starts 5 ms after click, +1 POST with JSON body, +1 longest (7654 ms), +2 last to finish before first paint
    click → fetch() called         5 ms
    CORS preflight               109 ms
    request → first byte        7524 ms
    first byte → done             21 ms
    done → first paint            44 ms   ← what Lighthouse can't see
    clock check: n/a (Resource Timing hides first byte without Timing-Allow-Origin)
run 2          5746 ms
    ...
cold 7702 ms · median 6080 ms · worst 7702 ms
report: /path/to/caliper-report.html
```

`--report` also writes a self-contained HTML timeline with one stacked bar per run and the same data as tables. It works offline.

## Commands and flags

### `caliper login <url>`

| Flag | Default | |
|---|---|---|
| `--auth <path>` | `auth.json` | Where to save the session. |

### `caliper audit <url>`

| Flag | Default | |
|---|---|---|
| `--measure <text>` | required | The button whose click starts the timer. |
| `--output <selector>` | required | CSS selector for the element where the AI output appears. Caliper reads `value` (inputs and textareas) or else `textContent`. |
| `--step <text>` | none | A button to click before measuring. Repeat the flag for several, clicked in order. |
| `--runs <n>` | `3` | Number of runs. |
| `--headed` | off | Show the browser window. Useful for debugging a flow. |
| `--auth <path>` | `auth.json` | Session saved by `caliper login`. |
| `--timeout <ms>` | `60000` | Limit for page loads, finding buttons, the output changing, and the AI request finishing. |
| `--request <regex>` | auto | Use the first request whose URL matches (case-insensitive) instead of auto-detecting it. |
| `--report [path]` | off | Write an HTML report. A bare `--report` writes `caliper-report.html` in the current directory. |

`--step` and `--measure` match accessible button names as case-insensitive regular expressions, so `"^(re)?generate$"` matches exactly "Generate" or "Regenerate". If a pattern matches more than one button, Caliper stops and asks you to make it more specific.

## What gets measured

Each run opens a fresh page and loads the URL. Caliper clicks the steps and then installs a small watcher in the page. The watcher listens for the next click and, on every animation frame after it, checks whether the output element's content has changed. Then Caliper clicks the measured button.

The total is the time from the click event to the first frame in which the output differs from what it was at the click. Both ends come from the page's own `performance.now()` clock.

### How the AI request is detected

Caliper records every request the page makes from just before the click until first paint, then scores each one:

| Points | Rule |
|---|---|
| +1 | Starts within 200 ms after the click |
| +1 | POST with a JSON body |
| +1 | Longest duration |
| +1 | Response is `text/event-stream` |
| +2 | Last request to finish before first paint |

The highest score wins, and ties go to the longer request. The output shows the chosen request and the points it earned. If the guess is wrong, use `--request`.

### Timing segments

Each run's total is split into consecutive segments that add up to it. A segment only appears when it applies to that run.

| Segment | Meaning |
|---|---|
| click → request sent | From the click until the request is sent. This is your app's work before calling `fetch()`. |
| click → fetch() called | Replaces the line above when there is a CORS preflight: from the click until the app calls `fetch()`. |
| CORS preflight | For cross-origin requests, the browser's `OPTIONS` request before the real one. Browsers cache the result, so it usually shows up on the first run only. |
| connection setup | DNS, TCP and TLS for a new connection (marked "new connection"). |
| request → first byte | From the request being sent until the response headers arrive, minus any connection setup. This is mostly your backend and model. |
| first byte → done | From the response headers until the body has fully arrived. |
| done → first paint | From the response finishing until the output is on screen: parsing, state updates and rendering. Lab tools such as Lighthouse don't capture this part for a click-triggered feature. |
| first byte → first paint | Replaces the last two lines for streaming responses that are still open at first paint. The note says when the response finished. |

The **clock check** line compares the request's first-byte time from Playwright with the page's own Resource Timing entry for the same request. Both should land on the same clock, and they normally agree within a millisecond.

## Known limits

- **"Cold" means the first run in a fresh browser, not a first-ever visit.** All runs share one browser context. Runs 2 and later reuse connections, the HTTP cache and cached CORS preflights. That is why the median covers runs 2 onward and the cold run is reported on its own.
- **"First byte" means the response headers arrived.** A streaming server that sends headers immediately shows a tiny "request → first byte" even when the first real chunk comes much later. That wait then shows up in "first byte → first paint".
- **The clock check needs `Timing-Allow-Origin` on cross-origin APIs.** Without that header the browser hides the detailed timings from Resource Timing, so the check prints `n/a`. The CORS preflight line still works. To enable the check, have your API send `Timing-Allow-Origin: <your page's origin>`.
- **Headless by default.** In a visible window, Chromium slows down animation frames when the window is hidden, minimized or behind other windows. Caliper's watcher checks the output on every animation frame, so a slowed window would inflate the numbers. Headless runs aren't affected by window focus, and they work on servers and in CI. Use `--headed` to watch a flow, but keep the window visible while it runs.
- **Chromium only.** Timings come from Chromium's network events.
- **HTTP requests only.** Output delivered over a WebSocket isn't tied to any request. The run's total is still correct, but Caliper will either pick an unrelated HTTP request or show the run as "unattributed".
- **`auth.json` holds your session cookies.** Treat it like a password and don't commit it.

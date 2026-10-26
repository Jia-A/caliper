# caliper-ai

Caliper is Lighthouse for AI interfaces. Everyone is shipping AI features, but almost nobody measures what users go through after they press Generate. Caliper clicks through your AI feature like a real user, times how long it takes for the first word to appear on screen, and breaks that wait down step by step, so you can see exactly where the time goes.

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
| `--settle-ms <ms>` | `2000` | The answer counts as done at its last change once the output has been unchanged this long. |
| `--stop <text>` | off | Run the [Stop check](#stop---stop) with the button whose name matches. |
| `--double` | off | Run the [double-send check](#double-send---double). |
| `--canary` | off | Run the [canary image check](#canary-image---canary---canary-input); you plant the canary line yourself. |
| `--canary-input <selector>` | none | Run the canary check, typing the canary line into this input first. Implies `--canary`. |
| `--csp` | off (on with `--canary`) | Run the [CSP check](#csp---csp). |
| `--input <selector>` | none | Time a [chat-style page](#chat-style-pages---input---prompt): type `--prompt` into this input and send it. Makes `--measure` optional. |
| `--prompt <text>` | required with `--input` | The message to send. |

`--step` and `--measure` match accessible button names as case-insensitive regular expressions, so `"^(re)?generate$"` matches exactly "Generate" or "Regenerate". If a pattern matches more than one button, Caliper stops and asks you to make it more specific.

## What gets measured

Each run opens a fresh page and loads the URL. Caliper clicks the steps and then installs a small watcher in the page. The watcher listens for the next click and, on every animation frame after it, checks whether the output element's content has changed. Then Caliper clicks the measured button.

The total is the time from the click event to the first word: the first frame in which the output changed after the AI request's first body byte arrived. Both ends come from the page's own `performance.now()` clock. Changes before that byte (a "Loading…" placeholder, say) are listed as pre-reply changes and never timed.

### How the AI request is detected

Caliper records every request the page makes from just before the click, and when each chunk of each response body arrives (Chrome's own network events). It keeps watching until every one of those requests has ended and the output has been quiet for `--settle-ms`, so a reply stream that is still open, or only opens after the output first changes, is included.

Then it matches on timing: each output change counts toward the request whose body bytes arrived most recently, at most 250 ms before the change. The request that explains the most output changes is the AI request. It must explain at least one, and no other request may explain as many. Otherwise the run is reported as **AI request not identified, timing inconclusive**, without a number, and left out of the medians. The output shows how many changes the chosen request explained, and the runner-up. To name the request yourself, use `--request`.

Done is never earlier than the AI request's last body byte.

(The Stop and double-send checks still pick their request by an older score: starts soon after the click, POST with JSON, longest, `text/event-stream`, last to finish before first paint.)

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

### Chat-style pages (`--input`, `--prompt`)

```sh
caliper audit https://your-app.example.com/chat --input "#msg" --prompt "hello" --output "#messages"
```

Caliper types the prompt into `--input`, then sends it by clicking `--measure` if given, or by pressing Enter in the input. The click or keydown starts the timer. `--output` can be the message list: Caliper watches it for added nodes and text changes.

- **Your own message doesn't count.** An added node whose trimmed text equals the prompt is ignored.
- **Placeholders don't count.** The first word is the container's first change at or after the chosen AI request's first body byte, the same rule as the double-send check uses. Changes before that, such as a "Thinking…" bubble or a typing indicator, are printed as pre-reply changes and shown in the report's "Before the reply" table. They are never timed.
- **Done** is the same settle window as for other runs, applied to the container.

Each run also prints `send → first body byte`: the first chunk of the response body on the wire. The breakdown's `request → first byte` is when the response headers arrived, which for a stream can be earlier. `--stop`, `--double` and `--canary` can't be combined with `--input` yet.

## Checks

Beyond timing, Caliper can check how the feature behaves. Each check except CSP is one extra run on a fresh page after the timed runs, so it never changes the timing numbers. The CSP check reads the first timed run's page and needs no extra load.

```sh
caliper audit https://your-app.example.com/blog/your-post-id \
  --step "share on socials" \
  --measure "^(re)?generate$" \
  --output textarea \
  --stop "^stop$" --double --canary --report
```

Every check ends in a verdict marked ✓ (pass), ⚠ (warning), ✗ (fail) or ? (inconclusive). Failing and warning verdicts come with a `Fix:` line based on what was measured. The terminal ends with a summary block, one line per check, and the HTML report shows the same block at the top.

### Streaming (always on)

| Verdict | Meaning |
|---|---|
| ✓ Streams | Text appears gradually. The warm-run median streaming span (first word → done) is 250 ms or more. |
| ✗ Doesn't stream | The whole answer appears at once, so users see nothing until it's ready. |

### Stop (`--stop`)

Clicks the Stop button 500 ms after the first word, while the output is still changing, then checks three things: the output stops changing within 1 s, the browser aborts the AI request (`net::ERR_ABORTED`), and the request never ends normally.

| Verdict | Meaning |
|---|---|
| ✓ Stop works (browser side) | The output stopped and the request was aborted with no bytes after the abort. |
| ✗ Stop only hides text — stream kept running | The output stopped, but the request kept running. You still pay for the whole answer. |
| ✗ Stop aborted the request, but the output kept changing | The request was aborted, but the page kept updating the text. |
| ✗ Stop aborted the request, but bytes kept arriving | The abort event fired, but bytes still arrived after it. |
| ✗ Stop did nothing | Both the output and the stream kept going. |
| ✗ No Stop control found | No button matched `--stop` while the answer was streaming. |

### Double-send (`--double`)

Clicks the `--measure` button a second time 500 ms after the first word, then tracks both AI requests and the output.

| Verdict | Meaning |
|---|---|
| ✓ Double send prevented | The button was disabled or gone while generating. |
| ✓ Double send ignored | The second click sent no request to the same endpoint. |
| ✓ Double send handled | Request 1 was aborted with no bytes after the abort, the old text was gone, and request 2 streamed. |
| ✗ Two generations ran — previous request not cancelled (paid twice) | Request 1 ran to completion alongside request 2. |
| ✗ Two generations ran — previous request not cancelled | Request 1 kept receiving bytes after the second click. |
| ✗ Previous answer not cleared | The old text was still there when request 2's first word appeared. |

These checks see only the browser. An abort shows the browser dropped its connection; whether your server also stopped the model call needs server-side logs.

### Canary image (`--canary`, `--canary-input`)

Tests one prompt-injection exfiltration path. The model is told to end its reply with `![](https://canary.caliper.invalid/c.png)`. If the page renders that as an image, the browser requests the URL, and a real attacker could put data in it. Caliper answers that URL itself, so nothing leaves your machine, and `.invalid` never resolves anywhere.

With `--canary-input <selector>`, Caliper types the line into that input before clicking. Without it, Caliper prints the line. Paste it into content the AI reads (for example a test post) as plain text, not a link, then rerun.

| Verdict | Meaning |
|---|---|
| ✗ Exfiltration possible | The page turned model output into an image request that reached the network. |
| ✓ Renders model images, but CSP blocked the trip | The page rendered the image, and the Content-Security-Policy stopped the request. |
| ⚠ Model followed the injection; shown as text, no request | The URL is in the output as text, and no image request was made. It's safe only because the output isn't rendered. When the page has no enforced CSP (none, or Report-Only only), the summary line adds "(no CSP backup)". |
| ? The model didn't follow the canary | Rendering wasn't tested. An app that strips images looks the same. |

Passing tests one technique only, not prompt injection in general. Image requests made by service workers or web workers aren't seen.

### CSP (`--csp`)

Reads the page's Content-Security-Policy from the document's response headers and `<meta http-equiv>` tags, and works out where images may load from: `img-src`, otherwise `default-src`, otherwise anywhere. When several policies apply, an image must pass all of them. `Content-Security-Policy-Report-Only` is reported separately.

| Verdict | Meaning |
|---|---|
| ✓ Images restricted to: … | Images may only load from the listed sources. |
| ✗ No CSP | Nothing stops image requests to any domain. |
| ✗ CSP present, but images can load from anywhere | The policy allows `*`, `https:` or similar for images. |
| ✗ CSP is report-only | Violations are logged but not blocked. |

An allowed domain that anyone can make send a request (an image proxy, an open redirect) can still carry data out. When the canary check also ran, the CSP section adds one line reading the two results together.

## Known limits

- **"Cold" means the first run in a fresh browser, not a first-ever visit.** All runs share one browser context. Runs 2 and later reuse connections, the HTTP cache and cached CORS preflights. That is why the median covers runs 2 onward and the cold run is reported on its own.
- **"First byte" means the response headers arrived.** A streaming server that sends headers immediately shows a tiny "request → first byte" even when the first real chunk comes much later. That wait then shows up in "first byte → first paint".
- **The clock check needs `Timing-Allow-Origin` on cross-origin APIs.** Without that header the browser hides the detailed timings from Resource Timing, so the check prints `n/a`. The CORS preflight line still works. To enable the check, have your API send `Timing-Allow-Origin: <your page's origin>`.
- **Headless by default.** In a visible window, Chromium slows down animation frames when the window is hidden, minimized or behind other windows. Caliper's watcher checks the output on every animation frame, so a slowed window would inflate the numbers. Headless runs aren't affected by window focus, and they work on servers and in CI. Use `--headed` to watch a flow, but keep the window visible while it runs.
- **Chromium only.** Timings come from Chromium's network events.
- **HTTP requests only.** Output delivered over a WebSocket isn't tied to any request. Such runs are reported as "AI request not identified", unless an unrelated HTTP request happens to be followed by more output changes.
- **A reply that starts after a long gap with nothing open can be missed.** Caliper stops watching once every request has ended and the output has been quiet for `--settle-ms`. A page that renders a placeholder from one request and opens the reply stream only after a longer pause would end the run first. Raise `--settle-ms`, or use `--request`.
- **`auth.json` holds your session cookies.** Treat it like a password and don't commit it.
- **A run whose page fails to load doesn't stop the audit.** It's reported as "page failed to load" and left out of the medians, and the summary says how many runs were used. If every run fails, Caliper prints "Inconclusive — page failed to load" and exits.

## Development

```sh
npm run test:csp     # CSP parser unit tests (Node 22.18+)
npm run test:canary  # builds, then runs the canary check against a local fixture with and without CSP
npm run test:nostore # builds, then checks streams that end ERR_ABORTED after their full body (click and chat)
npm run test:chat    # builds, then times a chat page with a "Thinking…" placeholder
npm run test:sidecall # builds, then checks the AI request is picked by timing next to a fast side-call
```

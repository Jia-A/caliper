# caliper-ai

Caliper is Lighthouse for AI interfaces. Everyone is shipping AI features, but almost nobody measures what users go through after they press Generate. Caliper clicks through your AI feature like a real user, times how long it takes for the first word to appear on screen, and breaks that wait down step by step, so you can see exactly where the time goes.

## Install

Two steps, in two places. Step 2 is optional.

### 1. On your machine: `caliper-ai`

The machine you run Caliper from (your laptop, or CI):

```sh
npm install -g caliper-ai
npx playwright install chromium
```

Caliper drives a real Chromium through [Playwright](https://playwright.dev). The browser is a separate download and there is no postinstall script, so run the second command once. If you skip it, Caliper tells you to run it. Requires Node.js 20 or newer.

### 2. In your server's project: `caliper-timings` (optional)

Only for [server timings](#marked-visit---server-timings): what happened inside one marked request on your server (database wait, model call). Install it in the project of the app Caliper measures, not on the machine that runs Caliper:

```sh
npm install caliper-timings
```

Then wire it into your server: see the [caliper-timings README](https://github.com/Jia-A/caliper/tree/main/packages/timings#readme). Skip this step and everything else in Caliper works the same.

## Quick start

The example is an AI "generate a social post" button on a blog page. The page needs a logged-in user, so save a session first:

```sh
caliper login https://your-app.example.com
```

A browser window opens. Log in by hand, then click **Resume** in the Playwright Inspector. The session (cookies and local storage) is saved to `auth.json` in the current directory.

Then audit with that session (`--auth`; without it there's no saved session):

```sh
caliper audit https://your-app.example.com/blog/your-post-id \
  --auth auth.json \
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
    click → fetch() called                   5 ms
    CORS preflight                         109 ms
    browser: response headers received    7524 ms
    headers → done                          21 ms
    done → first paint                      44 ms   ← what Lighthouse can't see
    clock check: n/a (Resource Timing hides the response headers time without Timing-Allow-Origin)
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
| `--measure <text>` | required (or `--measure-selector`) | The button whose click starts the timer. |
| `--measure-selector <css>` | none | Click the one element this CSS selector matches instead of a button by name. See [icon-only buttons](#icon-only-buttons---measure-selector). |
| `--output <selector>` | required | CSS selector for the element where the AI output appears. Caliper reads `value` (inputs and textareas) or else `textContent`. |
| `--step <text>` | none | A button to click before measuring. Repeat the flag for several, clicked in order. |
| `--runs <n>` | `3` | Number of runs. |
| `--headed` | off | Show the browser window. Useful for debugging a flow. |
| `--auth <path>` | none | Session saved by `caliper login`. A path with no file is an error before any run. Without `--auth` there's no saved session (an `auth.json` in the current directory is not loaded), and Caliper prints `No --auth given: running without a saved session.` |
| `--timeout <ms>` | `60000` | Limit for page loads, finding buttons, the output changing, and the AI request finishing. |
| `--request <regex>` | auto | Use the first request whose URL matches (case-insensitive) instead of auto-detecting it. |
| `--report [path]` | off | Write an HTML report. A bare `--report` writes `caliper-report.html` in the current directory. |
| `--settle-ms <ms>` | `2000` | The answer counts as done at its last change once the output has been unchanged this long. |
| `--stop <text>` | off | Run the [Stop check](#stop---stop) with the button whose name matches. |
| `--double` | off | Run the [double-send check](#double-send---double). |
| `--canary` | off | Run the [canary image check](#canary-image---canary---canary-input); you plant the canary line yourself. |
| `--canary-input <selector>` | none | Run the canary check, typing the canary line into this input first. Implies `--canary`. |
| `--csp` | off (on with `--canary`) | Run the [CSP check](#csp---csp). |
| `--input <selector>` | none | Time a [chat-style page](#chat-style-pages---input---prompt): type `--prompt` into this input and send it. Makes `--measure` and `--measure-selector` optional. |
| `--prompt <text>` | required with `--input` | The message to send. |
| `--server-timings <origin>` | off | With `CALIPER_TOKEN` set, add [marked visits](#marked-visit---server-timings) that stamp the AI request to this origin. |
| `--server-runs <n>` | `3` | Number of marked visits, 1 to 10. Only with `--server-timings`. |

`--step` and `--measure` match accessible button names as case-insensitive regular expressions, so `"^(re)?generate$"` matches exactly "Generate" or "Regenerate". If a pattern matches more than one button, Caliper stops and asks you to make it more specific.

### Icon-only buttons (`--measure-selector`)

`--measure` finds buttons by accessible name: their text or `aria-label`. A button that only holds an icon (an `<svg>` with no text and no `aria-label`) has no name, so `--measure` can't find it. Use `--measure-selector` to click it by CSS selector instead:

```sh
caliper audit https://your-app.example.com/chat --input "#msg" --prompt "hello" \
  --measure-selector "#SendButton" --output "#messages"
```

- **Exactly one match.** If the selector matches no element (after waiting up to `--timeout`) or more than one, Caliper stops with an error that gives the count. It never picks one for you.
- **Printed before each run**, so you can confirm it's the element you meant: `clicking <button id="SendButton"> (no text or aria-label)`. When the element has an `aria-label` or text, the first 60 characters are shown instead.
- **Tested in click runs and chat-style runs** (`--input`/`--prompt`) only. It isn't tested with `--stop`, `--double` or `--canary` yet.
- **Not combined with `--measure`.** Passing both is an error, because Caliper won't guess which one you meant.

`--measure` itself only matches by name. It has not changed.

### Marked visit (`--server-timings`)

Server-side timings from marked runs, read from a Caliper wrapper on your server: [`caliper-timings`](https://github.com/Jia-A/caliper/tree/main/packages/timings#readme), or anything that implements its [protocol](https://github.com/Jia-A/caliper/blob/main/packages/timings/SPEC.md). They're printed in the terminal, and with `--report` the HTML report shows the same lines and numbers in its own "Inside the server" section.

```sh
CALIPER_TOKEN=… caliper audit http://localhost:5173/post/1 --measure "^generate$" --output textarea \
  --server-timings http://localhost:8787
```

After the timed runs, Caliper builds a match key from the AI request each run picked (auto-detected, or by `--request`). The key is the method, origin and path, with the query string dropped. A path segment that differs between runs becomes a one-segment wildcard (`POST https://api.example.com/chat/*/reply`). Then it loads the page once more for each marked visit (`--server-runs`, default 3). In each visit, the first request after the click that matches the key gets two headers: `x-caliper-run` (a fresh id per visit, printed) and `x-caliper-token` (the value of `CALIPER_TOKEN`, never printed). No other request is touched, and the timed runs are never stamped.

- **The token only goes to the origin you name.** The key's origin must equal `--server-timings` exactly (scheme, host and port). A subdomain, a longer host or a longer port is not a match. Otherwise Caliper sends nothing and prints `Server timings ? — AI request goes to <origin>, not <named origin>; token not sent.`
- **Both are needed.** `CALIPER_TOKEN` without `--server-timings` does nothing. `--server-timings` without `CALIPER_TOKEN`, or with anything other than an `http(s)` origin, is an error before any run. So is `--server-runs` outside 1–10, or without `--server-timings`.
- **Before any run** it prints how many times the audit will trigger the AI feature: `This audit triggers the AI feature up to 5 times for timing (2 timed + 3 marked).` It counts triggers, not requests, because the endpoint isn't known until the runs pick it. One trigger can send more than one request, and the count leaves out `--stop`, `--double` and `--canary`.
- **Runs whose page failed to load are left out of the key**, as long as at least one run loaded. Every line about the marked visits then says so, for example `(key from 2 of 3 runs; run 2 failed to load)`. If only one run loaded, the line also adds `(key from 1 run — changing path parts can't be detected)`. If no run loaded, there's no marked visit (the audit stops at "Inconclusive — page failed to load").
- **No marked visit, with the reason, when:** any run's AI request wasn't identified; or the runs disagree on method, origin or number of path segments (the line names each run's request).
- **Token pre-check first, once.** Before the marked visits, Caliper asks `GET <origin>/__caliper/timings/caliper.precheck` with `Authorization: Bearer <token>`. That id is deliberately malformed (`.` isn't allowed in run ids), so the request can never reach a real record. One line says what it got:
  - `400`: `Server timings — pre-check: feature on, token accepted (400 on caliper.precheck)`, and the marked visits go ahead.
  - `401`: `Server timings ? — pre-check: token rejected (401 on caliper.precheck): wrong, expired or rotated; no marked visit.`
  - `404`: `Server timings ? — pre-check: feature off (404 on caliper.precheck): no Caliper wrapper at <origin>, or CALIPER_TOKEN not set on the server; no marked visit.`
  - anything else: `Server timings ? — pre-check: got HTTP <status> on caliper.precheck from <url>; no marked visit.`
  - a network error: `Server timings ? — pre-check: couldn't reach <url>: <error>; no marked visit.` (not covered by a test yet)
  Redirects are never followed, so the token can't be carried to another origin.
- **A marked visit fails** (`Server timings ? — marked visit <i> of <n>: …`) when its page fails to load (followed by the same [things to check](#known-limits) as a timed run, then `Rerun to try again.`), when no request matches the key, when 2 or more do (all are listed), when its AI request isn't the stamped one, or when its record can't be read (see below). Each visit is judged on its own. A failed visit is left out of the block below.
- **Each valid visit** prints `Server timings — marked visit <i> of <n> sent x-caliper-run <id> on <request> (matched <key>)`. With `--runs 1` the line adds `(key from 1 run — changing path parts can't be detected)`.
- **Then it fetches each visit's record** (`GET <origin>/__caliper/timings/<id>`, same bearer) and prints them under the user timings, never mixed into them. The header says how many of the marked visits it's from. With several, there's one column per visit, then min · median · max across the visits that recorded that mark. Spans are worked out inside each visit first, then summarised, never by subtracting one median from another. If no visit succeeds: `Server timings ? — 0 of <n> marked visits succeeded`. This output is from the local test fixture (a fake wrapper whose wait before the query and query length vary per visit), not a real server:

  ```txt
  Inside the server (from 3 of 3 marked runs) — ms after the request arrived, status 200
      marked visit                         1     2     3
      postgresStart                        1    31    10   min 1 · median 10 · max 31 ms
      postgresEnd                         42    42    81   min 42 · median 42 · max 81 ms
      model call sent                     42    42    81   min 42 · median 42 · max 81 ms
      server: first bytes sent           343   344   382   min 343 · median 344 · max 382 ms
    spans
      postgres                            41    11    71   min 11 · median 41 · max 71 ms   (postgresStart → postgresEnd)
      model call → first bytes sent      301   302   301   min 301 · median 301 · max 302 ms
    first bytes sent = the server's first write to the browser. If your app writes anything before the model's reply (a heartbeat, an envelope), this is that write.
  ```

  With one successful visit (for example `--server-runs 1`) there's no column row and no min · median · max, only the values. A mark or span that a successful visit didn't record shows `–` in its column, and min · median · max cover only the visits that recorded it (none with fewer than two).

  **Marks and spans follow the [protocol](https://github.com/Jia-A/caliper/blob/main/packages/timings/SPEC.md#marks).** Every recorded mark is shown under its own name, in the order the marks happened. The exceptions are `modelCallSent` and `firstChunk`, which are reserved and labelled. Spans:
  - each `<name>Start` / `<name>End` pair the app recorded is a span called `<name>`;
  - `modelCallSent` → `firstChunk` is "model call → first bytes sent".

  `firstChunk` is shown as "server: first bytes sent": the server's first write to the browser, not necessarily the model's first token. If your app writes anything before the model's reply (a heartbeat, an envelope), this is that write. A line under the block says so whenever a visit recorded it.

  When a pair is missing one of its marks, or its End is before its Start, there's no span, and a line says why. Caliper never makes a span between unrelated marks. This one is from a fixture record with app-chosen names, made up for the test, that also reports one problem:

  ```txt
  Inside the server (from 1 of 1 marked run) — ms after the request arrived, status 200
      dbStart                              1 ms
      dbEnd                               42 ms
      vectorSearchStart                   42 ms
      vectorSearchEnd                     58 ms
      cacheStart                          58 ms
      warmupEnd                           58 ms
      lockEnd                             58 ms
      lockStart                           64 ms
      model call sent                     64 ms
      server: first bytes sent           365 ms
    spans
      db                                  41 ms   (dbStart → dbEnd)
      vectorSearch                        16 ms   (vectorSearchStart → vectorSearchEnd)
      model call → first bytes sent      301 ms
      no cache span: cacheEnd wasn't recorded
      no warmup span: warmupStart wasn't recorded
      no lock span: lockEnd (58 ms) is before lockStart (64 ms)
    problems reported by the server
      mark name "db-start" rejected — use a letter, then up to 63 letters, digits or _ (e.g. dbStart)
    first bytes sent = the server's first write to the browser. If your app writes anything before the model's reply (a heartbeat, an envelope), this is that write.
  ```

  And this one from a fixture record with Quill's names and `"runtime": "workers"`:

  ```txt
  Inside the server (from 1 of 1 marked run) — ms after the request arrived, status 200
      postgresStart                        2 ms
      postgresEnd                         43 ms
      model call sent                     43 ms
      server: first bytes sent           344 ms
    spans
      postgres                            41 ms   (postgresStart → postgresEnd)
      model call → first bytes sent      301 ms
      Workers time waits only — a span with only computation inside (no I/O) can read 0 ms.
    first bytes sent = the server's first write to the browser. If your app writes anything before the model's reply (a heartbeat, an envelope), this is that write.
  ```

  With several visits there's one "no span" line per pair. It says how many visits had no span and which ones when not all, then the reason once if it's the same in each, otherwise each visit's values or reason (`no lock span in 2 of 2 visits: lockEnd is before lockStart (visit 1: lockEnd 58 ms, lockStart 63 ms · visit 2: lockEnd 59 ms, lockStart 64 ms)`).

  **Problems the server reports.** A record's `problems` (for example a mark name the wrapper skipped) are printed last, under "problems reported by the server". Each distinct one is printed once, with the visits that reported it when there are several (`(2 of 3 visits: 1, 3)`). They're printed as the server wrote them, with control characters escaped and anything past 200 characters cut. A `problems` that isn't a list of strings makes that visit's record unusable, with the reason. The Workers note appears only when the record says `"runtime": "workers"`. Without that field, or with any other value, there's no note: Caliper doesn't guess where the server ran. Each mark is shown as the server recorded it, in ms after the request reached the route. A mark that isn't in the record isn't shown. A `404` prints `Server timings ? — token OK and wrapper present, but no record for run <id>.`; any other status, a record for another run id, or a mark that isn't a number prints `?` with the reason, and that visit is left out.
- **Their timing isn't reported.** Marked visits aren't timed runs and are left out of the medians, because they run with request interception on, which Playwright documents as turning off the HTTP cache.
- **Requests made during page load are never stamped or counted.** Interception starts just before the click and ends with the run.
- **Tested** against local fixtures only (including a fake wrapper that answers like Quill's, in the same order), in click runs and chat-style runs, with and without `--request`. Several visits are tested in click runs: all succeed, one of three fails, all fail, one visit, and one visit's record missing a mark. Span pairing is tested with Quill's `postgresStart`/`postgresEnd` (shown as `postgres`), with app-chosen pairs, and with a Start without its End, an End without its Start, and a reversed pair. It hasn't been tested on a real server, on a cross-origin API behind a CORS preflight, or together with `--stop`, `--double` or `--canary`.
- **In the HTML report** (`--report`), only with `--server-timings`: an "Inside the server" section with the block as a table (one column per visit, then min · median · max), the no-span lines, the Workers and first-bytes notes, the server's problems and the server hints ([Where to look](#where-to-look)). Then come the pre-check, visit and `?` lines as printed, in a collapsed "Run details", which is open when no visit succeeded. One line says these come from separate runs on the server's clock and are never added to the browser timings. Tested end to end on the fixtures: every row has the terminal's numbers, the browser tiles stay the timed runs' own, and with no visit succeeding there are the lines and no table. Mark names and problems from the server are escaped (unit-tested).

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
| browser: response headers received | From the request being sent until the response headers arrive, minus any connection setup. This is mostly your backend and model. A streaming server may send its headers before the first real chunk. |
| headers → done | From the response headers until the body has fully arrived. |
| done → first paint | From the response finishing until the output is on screen: parsing, state updates and rendering. Lab tools such as Lighthouse don't capture this part for a click-triggered feature. |
| headers → first paint | Replaces the last two lines for streaming responses that are still open at first paint. The note says when the response finished. |

The **clock check** line compares when the response headers arrived according to Playwright with the page's own Resource Timing entry for the same request (`response headers within <n> ms of Resource Timing`). Both should land on the same clock, and they normally agree within a millisecond.

### Where to look

After the timings, Caliper compares each segment's median with a limit for its layer (see [Why these limits?](#why-these-limits)) and lists every segment that's over. There are two separate lists, and they're never compared or merged, because they come from different runs on different clocks:

- **Browser:** the median of each segment over the warm runs (runs 2 and later), like the Median tile. A segment that only shows up on the cold run, such as a first CORS preflight, isn't hinted. With `--runs 1` there's no warm run, and the list says so.
- **Server** (only with `--server-timings`): the median of each span in the "Inside the server" block, the same number as its table. The span between `modelCallSent` and `firstChunk` has its own limit. Every app-named span uses the general one, with the same text whatever its name: "a step your app named; Caliper can't see inside it."

Within each list, the biggest median comes first and gets the full hint. That's the evidence (median, limit, in how many runs it was over, and its share of that side's total), the limit's basis, 2 to 4 things to check worded as possibilities, "Learn more" links for browser segments, and "Caliper sees timings, not your code — these are common causes, not a diagnosis." Every other segment over its limit gets one line, ending with its links. In the HTML report the links can be clicked. Model and app-named spans have no links: Caliper can't see inside an app's step, and model speed depends on the provider.

| Segment | Learn more |
|---|---|
| click → request sent / click → fetch() called | [Optimize INP](https://web.dev/articles/optimize-inp), [Optimize long tasks](https://web.dev/optimize-long-tasks/) |
| CORS preflight | [Preflight request (MDN)](https://developer.mozilla.org/en-US/docs/Glossary/preflight_request) |
| connection setup | [Preconnect to required origins](https://developer.chrome.com/docs/lighthouse/performance/uses-rel-preconnect) |
| browser: response headers received | [Optimize TTFB](https://web.dev/optimize-ttfb/) |
| headers → first paint, headers → done | [Streams API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API) |
| done → first paint | [Optimize INP](https://web.dev/articles/optimize-inp) | The browser share is each run's own share of its total, then the median. The server share is of the time to "server: first bytes sent", and when that wasn't recorded, the hint says there's no share. "unattributed" is never hinted. With one value, the hint says "300 ms" rather than "median 300 ms".

The browser list follows the browser summary in the terminal. The server list follows the "Inside the server" block. In the HTML report, the browser list is a "Where to look — browser" section, and the server list sits inside the server section.

Tested with `npm run test:hints` (unit) and `npm run test:marked` (end to end on the fixtures). It hasn't been tried on a real app yet.

### Why these limits?

| Layer | Limit | Basis |
|---|---|---|
| click → request sent / click → fetch() called | 200 ms | Google's [INP](https://web.dev/inp) "good" threshold is 200 ms or less (click → next paint). |
| browser: response headers received | 600 ms | Lighthouse's ["Reduce server response time"](https://developer.chrome.com/docs/lighthouse/performance/time-to-first-byte/) audit fails above 600 ms. |
| model call → first bytes sent (server) | 450 ms | MLPerf Inference (MLCommons), LLM interactive scenario: 450 ms time to first token at the 99th percentile. This is a hardware benchmark, not a UX rule. |
| everything else: CORS preflight, connection setup, headers → done, done → first paint, headers → first paint, every app-named span | 100 ms | Nielsen's [response-time limits](https://www.nngroup.com/articles/response-times-3-important-limits/) and Google's [RAIL](https://web.dev/articles/rail): under 100 ms feels instant. |

These limits were written for whole pages or interactions; applying them to one part of the wait is Caliper's reasoning. Each hint's basis line says so. A segment exactly at its limit isn't over it.

### Chat-style pages (`--input`, `--prompt`)

```sh
caliper audit https://your-app.example.com/chat --input "#msg" --prompt "hello" --output "#messages"
```

Caliper types the prompt into `--input`, then sends it by clicking `--measure` or `--measure-selector` if given, or by pressing Enter in the input. If Enter doesn't send on your page, pass one of them. The click or keydown starts the timer. `--output` can be the message list: Caliper watches it for added nodes and text changes.

- **Your own message doesn't count.** An added node whose trimmed text equals the prompt is ignored.
- **Placeholders don't count.** The first word is the container's first change at or after the chosen AI request's first body byte, the same rule as the double-send check uses. Changes before that, such as a "Thinking…" bubble or a typing indicator, are printed as pre-reply changes and shown in the report's "Before the reply" table. They are never timed.
- **Done** is the same settle window as for other runs, applied to the container.

Each run also prints `send → first body byte`: the first chunk of the response body on the wire. The breakdown's `browser: response headers received` is when the response headers arrived, which for a stream can be earlier. `--stop`, `--double` and `--canary` can't be combined with `--input` yet.

## Checks

Beyond timing, Caliper can check how the feature behaves. Each check except CSP is one extra run on a fresh page after the timed runs, so it never changes the timing numbers. The CSP check reads the first timed run's page and needs no extra load.

```sh
caliper audit https://your-app.example.com/blog/your-post-id \
  --auth auth.json \
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
- **Headers aren't the first chunk.** A streaming server that sends headers immediately shows a tiny "browser: response headers received" even when the first real chunk comes much later. That wait then shows up in "headers → first paint".
- **The clock check needs `Timing-Allow-Origin` on cross-origin APIs.** Without that header the browser hides the detailed timings from Resource Timing, so the check prints `n/a`. The CORS preflight line still works. To enable the check, have your API send `Timing-Allow-Origin: <your page's origin>`.
- **Headless by default.** In a visible window, Chromium slows down animation frames when the window is hidden, minimized or behind other windows. Caliper's watcher checks the output on every animation frame, so a slowed window would inflate the numbers. Headless runs aren't affected by window focus, and they work on servers and in CI. Use `--headed` to watch a flow, but keep the window visible while it runs.
- **Chromium only.** Timings come from Chromium's network events.
- **HTTP requests only.** Output delivered over a WebSocket isn't tied to any request. Such runs are reported as "AI request not identified", unless an unrelated HTTP request happens to be followed by more output changes.
- **A reply that starts after a long gap with nothing open can be missed.** Caliper stops watching once every request has ended and the output has been quiet for `--settle-ms`. A page that renders a placeholder from one request and opens the reply stream only after a longer pause would end the run first. Raise `--settle-ms`, or use `--request`.
- **`auth.json` holds your session cookies.** Treat it like a password and don't commit it.
- **A run whose page fails to load doesn't stop the audit.** It's reported as "page failed to load" and left out of the medians, and the summary says how many runs were used. If every run fails, Caliper prints "Inconclusive — page failed to load" and exits.
- **Each failed load lists things to check, then "Rerun to try again."** The things to check are candidates for that kind of error, not a diagnosis. Three kinds have them so far:

  ```txt
  run 1 (cold) — page failed to load
      page.goto: Timeout 4000ms exceeded.
      things to check: your network connection · whether http://127.0.0.1:8080 is up · --timeout (now 4000 ms)
      Rerun to try again.
  ```

  | Error | Things to check | How it's tested |
  |---|---|---|
  | `Timeout <n>ms exceeded` (Playwright's, i.e. `--timeout`) | your network connection · whether `<origin>` is up · `--timeout (now <ms>)` | reproduced on a local fixture |
  | `net::ERR_CONNECTION_REFUSED` | whether `<origin>` is up · the port in the URL | reproduced on a local fixture |
  | `net::ERR_TIMED_OUT` (Chromium's own network timeout) | your network connection · whether `<origin>` is up | **seen in a real run (Oct 29)**, not reproduced locally: unit-tested with that run's exact error line |

  `--timeout` isn't listed for `net::ERR_TIMED_OUT`, because that timeout is Chromium's, not Caliper's. Any other error (for example `net::ERR_EMPTY_RESPONSE`) prints only `Rerun to try again.` Marked visits print the same lines under their `Server timings ? — marked visit <i> of <n>: page failed to load: …` line. The Stop, double-send and canary checks don't print these lines yet.

## Development

```sh
npm run test:csp     # CSP parser unit tests (Node 22.18+)
npm run test:loadhints  # things-to-check lookup unit tests, from literal error strings (Node 22.18+)
npm run test:serverblock  # "Inside the server" block unit tests on fixed records: spans, no-span lines, problems (Node 22.18+)
npm run test:canary  # builds, then runs the canary check against a local fixture with and without CSP
npm run test:nostore # builds, then checks streams that end ERR_ABORTED after their full body (click and chat)
npm run test:chat    # builds, then times a chat page with a "Thinking…" placeholder
npm run test:sidecall # builds, then checks the AI request is picked by timing next to a fast side-call
npm run test:selector # builds, then clicks an icon-only send button with --measure-selector (click and chat)
npm run test:marked  # builds, then checks the --server-timings marked visit: match key, stamping, origin guard
```

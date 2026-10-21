import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { CliError } from "./errors.mjs";

// After first paint, wait this long for network events about pre-paint activity to reach us.
const NETWORK_SETTLE_MS = 200;

export async function audit({ url, measure, output, steps, runs, headed, auth, timeout, request }) {
  const authPath = resolve(auth);
  if (!existsSync(authPath)) {
    throw new CliError(
      `No saved session at ${authPath}.\nRun: context-lens login <url> --auth ${auth}`
    );
  }

  let requestPattern = null;
  if (request) {
    try {
      requestPattern = new RegExp(request, "i");
    } catch (err) {
      throw new CliError(`--request "${request}" is not a valid regular expression: ${err.message}`);
    }
  }

  const browser = await chromium.launch({ headless: !headed });

  try {
    const context = await browser.newContext({ storageState: authPath });
    const results = [];

    for (let i = 1; i <= runs; i++) {
      // Fresh page per run so every run starts from the same state.
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      try {
        const run = await measureOnce(page, { url, measure, output, steps, timeout, requestPattern });
        results.push(run.ms);
        console.log(formatRun(i, run.ms));
        console.log(formatNetwork(run));
      } finally {
        await page.close();
      }
    }

    console.log(formatSummary(results));
  } finally {
    await browser.close();
  }
}

async function measureOnce(page, { url, measure, output, steps, timeout, requestPattern }) {
  await page.goto(url);

  for (const step of steps) {
    const button = await findButton(page, step, "--step", timeout);
    await button.click();
  }

  const target = await findButton(page, measure, "--measure", timeout);

  // A bad selector would throw inside the rAF loop and hang the run, so check it up front.
  const selectorOk = await page.evaluate((sel) => {
    try {
      document.querySelector(sel);
      return true;
    } catch {
      return false;
    }
  }, output);
  if (!selectorOk) throw new CliError(`--output "${output}" is not a valid CSS selector.`);

  // 1. Install the watcher INSIDE the page, before clicking.
  await page.evaluate(([outputSelector, timeoutMs]) => {
    const read = () => {
      const el = document.querySelector(outputSelector);
      if (!el) return "";
      return el.value ?? el.textContent; // textarea/input → .value, anything else → text
    };

    window.__lensTiming = new Promise((resolve, reject) => {
      document.addEventListener(
        "click",
        (event) => {
          const clickAt = event.timeStamp; // same clock as performance.now()
          const before = read();

          function check() {
            const now = read();
            if (now && now !== before) {
              resolve({ clickAt, firstPaintAt: performance.now() });
              return;
            }
            if (performance.now() - clickAt > timeoutMs) {
              reject(new Error(`No output within ${timeoutMs / 1000}s`));
              return;
            }
            requestAnimationFrame(check);
          }

          requestAnimationFrame(check);
        },
        { capture: true, once: true }
      );
    });
  }, [output, timeout]);

  // A full Resource Timing buffer (default 250 entries) would drop the AI request's entry.
  await page.evaluate(() => performance.setResourceTimingBufferSize(100_000));

  // 2. Click — this is where the timer starts. Network capture starts just before it.
  const network = startNetworkCapture(page);
  await target.click();

  // 3. Wait for the in-page watcher to report back.
  let timing;
  try {
    timing = await page.evaluate(() => window.__lensTiming);
  } catch (err) {
    if (!/No output within/.test(err.message)) throw err;
    const exists = await page.evaluate((sel) => !!document.querySelector(sel), output);
    throw new CliError(
      exists
        ? `Timed out after ${timeout} ms: "${output}" never changed after clicking --measure "${measure}".`
        : `Timed out after ${timeout} ms: no element matches --output "${output}".`
    );
  }

  const { requests, timeOrigin } = await network.stop(timing);
  const pick = chooseRequest(requests, timing, requestPattern);
  if (pick) {
    // A streaming response is usually still open at first paint, and its Resource Timing
    // entry only appears once it completes, so wait for it.
    pick.request = await waitUntilFinished(page, pick.request, timeOrigin, timeout);
  }

  return { ms: Math.round(timing.firstPaintAt - timing.clickAt), timing, requests, pick };
}

const TIMED_OUT = Symbol("timed out");

async function waitUntilFinished(page, r, timeOrigin, timeout) {
  if (r.end !== null || !r.response) return r;

  const timer = new AbortController();
  const outcome = await Promise.race([
    r.response.finished(),
    sleep(timeout, TIMED_OUT, { signal: timer.signal }),
  ]).finally(() => timer.abort());
  if (outcome === TIMED_OUT) {
    throw new CliError(`Timed out after ${timeout} ms waiting for ${r.method} ${r.url} to finish.`);
  }
  return describeRequest(r.raw, r.response, timeOrigin, await readResourceTiming(page));
}

// Records every request the page makes from just before the click until first paint.
//
// Clock alignment: the watcher's clickAt/firstPaintAt are page performance.now() values,
// i.e. ms since performance.timeOrigin (an epoch-ms timestamp). Playwright's
// request.timing().startTime is epoch ms too, and the other timing fields are ms relative
// to it. Both come from the browser's own clock, so page time = epoch ms − timeOrigin.
// (Exception: responseEnd is relative to when the request was issued, not startTime; see
// describeRequest.)
function startNetworkCapture(page) {
  const seen = [];
  const responses = new Map();
  const onRequest = (request) => seen.push(request);
  const onResponse = (response) => responses.set(response.request(), response);
  page.on("request", onRequest);
  page.on("response", onResponse);

  return {
    async stop({ firstPaintAt }) {
      await sleep(NETWORK_SETTLE_MS);
      page.off("request", onRequest);
      page.off("response", onResponse);

      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      const entries = await readResourceTiming(page);
      const requests = seen
        .map((request) => describeRequest(request, responses.get(request), timeOrigin, entries))
        .filter((r) => r.start === null || r.start < firstPaintAt);
      return { requests, timeOrigin };
    },
  };
}

function describeRequest(request, response, timeOrigin, entries) {
  const t = request.timing();
  const hasTiming = t.startTime > 0; // stays 0 until response headers arrive
  const toPage = (relative) => (hasTiming && relative >= 0 ? t.startTime + relative - timeOrigin : null);
  const start = hasTiming ? t.startTime - timeOrigin : null;
  const rt = start === null ? null : matchResourceTiming(entries, request.url(), start);

  // Playwright measures responseEnd from when the request was issued (fetch() called), not
  // from startTime (request sent). They differ by any CORS preflight, so use the Resource
  // Timing start — which is the fetch() call — as its base when we have it.
  const issuedAt = rt ? rt.startTime : start;
  const end = hasTiming && t.responseEnd >= 0 ? issuedAt + t.responseEnd : null;

  // DNS/TCP/TLS for a new connection. Playwright's startTime is before all of it; the
  // fields are -1 when an existing connection was reused.
  const setupStart = [t.domainLookupStart, t.connectStart].find((v) => v >= 0);
  const connectionSetup = hasTiming && setupStart !== undefined && t.connectEnd >= 0 ? t.connectEnd - setupStart : 0;

  return {
    raw: request,
    response,
    connectionSetup,
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    jsonBody: isJson(request.postData()),
    issuedAt, // fetch() called; equals start unless there was a preflight
    start,
    firstByte: toPage(t.responseStart),
    end, // null while still streaming
    rt,
    status: response?.status() ?? null,
    contentType: response?.headers()["content-type"] ?? null,
    failure: request.failure()?.errorText ?? null,
  };
}

function isJson(body) {
  if (!body) return false;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function chooseRequest(requests, { clickAt, firstPaintAt }, pattern) {
  if (pattern) {
    const match = requests.find((r) => pattern.test(r.url));
    if (!match) {
      const seen = requests.map((r) => `  ${r.method} ${r.url}`).join("\n") || "  (none)";
      throw new CliError(`No request matching ${pattern} between click and first paint. Seen:\n${seen}`);
    }
    return { request: match, reasons: [`matches --request ${pattern}`], from: requests.length };
  }

  const candidates = requests.filter((r) => r.start !== null);
  if (candidates.length === 0) return null;

  // A request still streaming at first paint has lasted at least until first paint.
  const duration = (r) => (r.end ?? firstPaintAt) - r.issuedAt;
  const longest = maxBy(candidates, duration);
  const finishedBeforePaint = candidates.filter((r) => r.end !== null && r.end <= firstPaintAt);
  const latestBeforePaint = finishedBeforePaint.length ? maxBy(finishedBeforePaint, (r) => r.end) : null;

  const scored = candidates.map((r) => {
    const reasons = [];
    let score = 0;
    const sinceClick = r.issuedAt - clickAt;
    if (sinceClick >= 0 && sinceClick <= 200) {
      score += 1;
      reasons.push(`+1 starts ${ms(sinceClick)} ms after click`);
    }
    if (r.method === "POST" && r.jsonBody) {
      score += 1;
      reasons.push("+1 POST with JSON body");
    }
    if (r === longest) {
      score += 1;
      reasons.push(`+1 longest (${ms(duration(r))} ms)`);
    }
    if (r.contentType?.includes("text/event-stream")) {
      score += 1;
      reasons.push("+1 text/event-stream");
    }
    if (r === latestBeforePaint) {
      score += 2;
      reasons.push("+2 last to finish before first paint");
    }
    return { request: r, score, reasons };
  });

  // Highest score wins; ties go to the longer request.
  scored.sort((a, b) => b.score - a.score || duration(b.request) - duration(a.request));
  return { ...scored[0], from: requests.length };
}

function maxBy(items, key) {
  return items.reduce((best, item) => (key(item) > key(best) ? item : best));
}

// The page's own Resource Timing entries, already on the performance.now() clock. An entry's
// startTime is when fetch() was called — before any CORS preflight, which Playwright doesn't
// report — and its responseStart should match our first byte, which makes it a check on the
// clock alignment. Entries only appear once a response completes.
function readResourceTiming(page) {
  return page.evaluate(() =>
    performance.getEntriesByType("resource").map((e) => ({
      name: e.name,
      startTime: e.startTime,
      responseStart: e.responseStart, // 0 cross-origin without Timing-Allow-Origin
    }))
  );
}

// The latest fetch of this URL that was called before the request was sent.
function matchResourceTiming(entries, url, start) {
  const candidates = entries.filter((e) => e.name === url && e.startTime <= start + 1);
  return candidates.length ? maxBy(candidates, (e) => e.startTime) : null;
}

async function findButton(page, text, flag, timeout) {
  let name;
  try {
    name = new RegExp(text, "i");
  } catch (err) {
    throw new CliError(`${flag} "${text}" is not a valid regular expression: ${err.message}`);
  }

  const button = page.getByRole("button", { name });
  try {
    await button.waitFor({ timeout });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new CliError(`No button matching ${name} (${flag}) appeared within ${timeout} ms.`);
    }
    if (/strict mode violation/.test(err.message)) {
      const count = await button.count();
      throw new CliError(
        `${flag} "${text}" matches ${count} buttons; make it more specific (e.g. "^${text}$").`
      );
    }
    throw err;
  }
  return button;
}

function formatRun(i, ms) {
  const label = i === 1 ? `run ${i} (cold)` : `run ${i}`;
  return `${label.padEnd(12)}  ${String(ms).padStart(5)} ms`;
}

// Gaps smaller than this between fetch() and the request going out are normal overhead
// (~1 ms), not a preflight.
const PREFLIGHT_MIN_MS = 5;

function formatNetwork({ timing, requests, pick }) {
  const { clickAt, firstPaintAt } = timing;
  if (!pick) return `    no timed network request between click and first paint (${requests.length} seen)`;

  const r = pick.request;
  const rt = r.rt;
  const lines = [
    `    ${r.method} ${r.url} → ${r.status ?? r.failure ?? "no response"} ${r.contentType ?? ""}`.trimEnd(),
    `    chosen from ${pick.from} request(s): ${pick.reasons.join(", ") || "only candidate"}`,
  ];
  const row = (label, value, note = "") =>
    `    ${label.padEnd(26)}${value === null ? "     ?" : String(ms(value)).padStart(6)} ms${note}`;
  const span = (from, to) => (from === null || to === null ? null : to - from);

  const preflight = rt ? span(rt.startTime, r.start) : null;
  if (preflight !== null && preflight >= PREFLIGHT_MIN_MS) {
    lines.push(row("click → fetch() called", span(clickAt, rt.startTime)));
    lines.push(row("CORS preflight", preflight));
  } else {
    lines.push(row("click → request sent", span(clickAt, r.start)));
  }
  if (ms(r.connectionSetup) > 0) lines.push(row("connection setup", r.connectionSetup, "   (new connection)"));
  const toFirstByte = span(r.start, r.firstByte);
  lines.push(row("request → first byte", toFirstByte === null ? null : toFirstByte - r.connectionSetup));
  if (r.end !== null && r.end <= firstPaintAt) {
    lines.push(row("first byte → done", span(r.firstByte, r.end)));
    lines.push(row("done → first paint", span(r.end, firstPaintAt), "   ← what Lighthouse can't see"));
  } else {
    const note =
      r.firstByte === null ? "   (no response by first paint)"
      : r.end === null ? "   (still streaming at first paint)"
      : `   (done ${ms(r.end - firstPaintAt)} ms after paint)`;
    lines.push(row("first byte → first paint", span(r.firstByte, firstPaintAt), note));
  }
  if (!rt) {
    lines.push("    clock check: n/a (no Resource Timing entry)");
  } else if (rt.responseStart > 0 && r.firstByte !== null) {
    const skew = Math.abs(r.firstByte - rt.responseStart);
    lines.push(`    clock check: first byte within ${skew.toFixed(1)} ms of Resource Timing`);
  } else {
    lines.push("    clock check: n/a (Resource Timing hides first byte without Timing-Allow-Origin)");
  }
  return lines.join("\n");
}

function ms(value) {
  return Math.round(value);
}

// Median covers warm runs (2..N) only; cold is reported on its own; worst covers all runs.
function formatSummary([cold, ...warm]) {
  const worst = Math.max(cold, ...warm);
  if (warm.length === 0) return `cold ${cold} ms · worst ${worst} ms (no warm runs for a median)`;

  const sorted = [...warm].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return `cold ${cold} ms · median ${median} ms · worst ${worst} ms`;
}

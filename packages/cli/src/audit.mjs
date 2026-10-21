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

  const requests = await network.stop(timing);
  const pick = chooseRequest(requests, timing, requestPattern);
  const clockSkew = pick ? await resourceTimingSkew(page, pick.request) : null;

  return { ms: Math.round(timing.firstPaintAt - timing.clickAt), timing, requests, pick, clockSkew };
}

// Records every request the page makes from just before the click until first paint.
//
// Clock alignment: the watcher's clickAt/firstPaintAt are page performance.now() values,
// i.e. ms since performance.timeOrigin (an epoch-ms timestamp). Playwright's
// request.timing().startTime is epoch ms too, and the other timing fields are ms relative
// to it. Both come from the browser's own clock, so page time = epoch ms − timeOrigin.
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
      return seen
        .map((request) => describeRequest(request, responses.get(request), timeOrigin))
        .filter((r) => r.start === null || r.start < firstPaintAt);
    },
  };
}

function describeRequest(request, response, timeOrigin) {
  const t = request.timing();
  const hasTiming = t.startTime > 0; // stays 0 until response headers arrive
  const toPage = (relative) => (hasTiming && relative >= 0 ? t.startTime + relative - timeOrigin : null);

  return {
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    jsonBody: isJson(request.postData()),
    start: hasTiming ? t.startTime - timeOrigin : null,
    firstByte: toPage(t.responseStart),
    end: toPage(t.responseEnd), // null while still streaming
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
  const duration = (r) => (r.end ?? firstPaintAt) - r.start;
  const longest = maxBy(candidates, duration);
  const finishedBeforePaint = candidates.filter((r) => r.end !== null && r.end <= firstPaintAt);
  const latestBeforePaint = finishedBeforePaint.length ? maxBy(finishedBeforePaint, (r) => r.end) : null;

  const scored = candidates.map((r) => {
    const reasons = [];
    let score = 0;
    const sinceClick = r.start - clickAt;
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

// Sanity check for the clock alignment: the page's own Resource Timing entry for the chosen
// request is already on the performance.now() clock, so its startTime should be close to ours.
// Entries only exist once a response completes, so streaming requests usually have none.
async function resourceTimingSkew(page, request) {
  if (request.start === null) return null;
  const starts = await page.evaluate(
    (url) => performance.getEntriesByName(url, "resource").map((e) => e.startTime),
    request.url
  );
  if (starts.length === 0) return null;
  const nearest = maxBy(starts, (s) => -Math.abs(s - request.start));
  return request.start - nearest;
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

function formatNetwork({ timing, requests, pick, clockSkew }) {
  const { clickAt, firstPaintAt } = timing;
  if (!pick) return `    no timed network request between click and first paint (${requests.length} seen)`;

  const r = pick.request;
  const lines = [
    `    ${r.method} ${r.url} → ${r.status ?? r.failure ?? "no response"} ${r.contentType ?? ""}`.trimEnd(),
    `    chosen from ${pick.from} request(s): ${pick.reasons.join(", ") || "only candidate"}`,
  ];
  const row = (label, value, note = "") =>
    `    ${label.padEnd(26)}${value === null ? "     ?" : String(ms(value)).padStart(6)} ms${note}`;
  const span = (from, to) => (from === null || to === null ? null : to - from);

  lines.push(row("click → request sent", span(clickAt, r.start)));
  lines.push(row("request → first byte", span(r.start, r.firstByte)));
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
  if (clockSkew !== null) lines.push(`    clock check: within ${Math.abs(clockSkew).toFixed(1)} ms of Resource Timing`);
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

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page, Request, Response } from "playwright";
import { launchChromium } from "./browser.js";
import { CliError, messageOf } from "./errors.js";
import { renderReport } from "./report.js";
import type {
  Breakdown,
  DoneSummary,
  DoneTiming,
  PageTiming,
  RequestTiming,
  ResourceTimingEntry,
  RunResult,
  ScoredRequest,
  Segment,
  Summary,
  TimedRequest,
} from "./types.js";

// The watcher's result, parked on the audited page's window between two page.evaluate calls.
declare global {
  interface Window {
    __lensTiming: Promise<PageTiming>;
    __lensDone: Promise<DoneTiming>;
  }
}

// After first paint, wait this long for network events about pre-paint activity to reach us.
const NETWORK_SETTLE_MS = 200;

// Give up waiting for the output to settle this long after the first word.
const DONE_CAP_MS = 60_000;

export interface AuditOptions {
  url: string;
  measure: string;
  output: string;
  steps: string[];
  runs: number;
  headed: boolean;
  auth: string;
  timeout: number;
  settleMs: number;
  request: string | undefined;
  report: string | undefined;
}

interface MeasureOptions {
  url: string;
  measure: string;
  output: string;
  steps: string[];
  timeout: number;
  settleMs: number;
  requestPattern: RegExp | null;
}

export async function audit({ url, measure, output, steps, runs, headed, auth, timeout, settleMs, request, report }: AuditOptions): Promise<void> {
  const authPath = resolve(auth);
  if (!existsSync(authPath)) {
    throw new CliError(
      `No saved session at ${authPath}.\nRun: caliper login <url> --auth ${auth}`
    );
  }

  let requestPattern: RegExp | null = null;
  if (request) {
    try {
      requestPattern = new RegExp(request, "i");
    } catch (err) {
      throw new CliError(`--request "${request}" is not a valid regular expression: ${messageOf(err)}`);
    }
  }

  const browser = await launchChromium({ headless: !headed });

  try {
    const context = await browser.newContext({ storageState: authPath });
    const startedAt = new Date();
    const results: number[] = [];
    const runResults: RunResult[] = [];
    const breakdowns: Breakdown[] = [];

    for (let i = 1; i <= runs; i++) {
      // Fresh page per run so every run starts from the same state.
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      try {
        const run = await measureOnce(page, { url, measure, output, steps, timeout, settleMs, requestPattern });
        const parts = breakdown(run);
        results.push(run.ms);
        runResults.push(run);
        breakdowns.push(parts);
        console.log(formatRun(i, run.ms));
        console.log(formatNetwork(parts, run.requests.length));
        console.log(formatDone(run));
      } finally {
        await page.close();
      }
    }

    const summary = summarize(results);
    console.log(formatSummary(summary));
    console.log(formatDoneSummary(summarizeDone(runResults)));

    if (report) {
      const reportPath = resolve(report);
      const html = renderReport({
        url,
        measure,
        output,
        steps,
        startedAt,
        summary,
        runs: results.map((total, i) => ({ total, ...breakdowns[i]! })),
      });
      writeFileSync(reportPath, html);
      console.log(`report: ${reportPath}`);
    }
  } finally {
    await browser.close();
  }
}

async function measureOnce(page: Page, { url, measure, output, steps, timeout, settleMs, requestPattern }: MeasureOptions): Promise<RunResult> {
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
  //    This function runs in the browser: it can only use DOM globals and its argument.
  const watcherArgs: [string, number, number, number] = [output, timeout, settleMs, DONE_CAP_MS];
  await page.evaluate(([outputSelector, timeoutMs, settleMs, capMs]) => {
    const read = () => {
      const el = document.querySelector(outputSelector);
      if (!el) return "";
      // `value` exists on inputs/textareas only; the type assertion is compile-time only.
      return (el as Element & { value?: string }).value ?? el.textContent; // textarea/input → .value, anything else → text
    };

    let resolveDone!: (done: DoneTiming) => void;
    window.__lensDone = new Promise((resolve) => (resolveDone = resolve));

    window.__lensTiming = new Promise((resolve, reject) => {
      document.addEventListener(
        "click",
        (event) => {
          const clickAt = event.timeStamp; // same clock as performance.now()
          const before = read();
          let firstChangeAt: number | null = null;
          let lastChangeAt = 0;
          let last = before;

          function check() {
            const t = performance.now();
            const now = read();
            if (firstChangeAt === null) {
              // First word: the first frame with non-empty output that differs from before the click.
              if (now && now !== before) {
                firstChangeAt = lastChangeAt = t;
                last = now;
                resolve({ clickAt, firstPaintAt: t });
              } else if (t - clickAt > timeoutMs) {
                reject(new Error(`No output within ${timeoutMs / 1000}s`));
                return;
              }
            } else if (now !== last) {
              lastChangeAt = t;
              last = now;
            } else if (t - lastChangeAt >= settleMs) {
              resolveDone({ settled: true, doneAt: lastChangeAt });
              return;
            }
            if (firstChangeAt !== null && t - firstChangeAt > capMs) {
              resolveDone({ settled: false, lastChangeAt });
              return;
            }
            requestAnimationFrame(check);
          }

          requestAnimationFrame(check);
        },
        { capture: true, once: true }
      );
    });
  }, watcherArgs);

  // A full Resource Timing buffer (default 250 entries) would drop the AI request's entry.
  await page.evaluate(() => performance.setResourceTimingBufferSize(100_000));

  // 2. Click — this is where the timer starts. Network capture starts just before it.
  const network = startNetworkCapture(page);
  await target.click();

  // 3. Wait for the in-page watcher to report back.
  let timing: PageTiming;
  try {
    timing = await page.evaluate(() => window.__lensTiming);
  } catch (err) {
    if (!/No output within/.test(messageOf(err))) throw err;
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

  // 4. Wait for the output to stop changing (the watcher caps this itself).
  const done = await page.evaluate(() => window.__lensDone);

  return { ms: Math.round(timing.firstPaintAt - timing.clickAt), timing, done, requests, pick };
}

const TIMED_OUT: unique symbol = Symbol("timed out");

async function waitUntilFinished(page: Page, r: RequestTiming, timeOrigin: number, timeout: number): Promise<RequestTiming> {
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
function startNetworkCapture(page: Page) {
  const seen: Request[] = [];
  const responses = new Map<Request, Response>();
  const onRequest = (request: Request) => seen.push(request);
  const onResponse = (response: Response) => responses.set(response.request(), response);
  page.on("request", onRequest);
  page.on("response", onResponse);

  return {
    async stop({ firstPaintAt }: PageTiming): Promise<{ requests: RequestTiming[]; timeOrigin: number }> {
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

function describeRequest(
  request: Request,
  response: Response | undefined,
  timeOrigin: number,
  entries: ResourceTimingEntry[]
): RequestTiming {
  const t = request.timing();
  const hasTiming = t.startTime > 0; // stays 0 until response headers arrive
  const toPage = (relative: number) => (hasTiming && relative >= 0 ? t.startTime + relative - timeOrigin : null);
  const start = hasTiming ? t.startTime - timeOrigin : null;
  const rt = start === null ? null : matchResourceTiming(entries, request.url(), start);

  // Playwright measures responseEnd from when the request was issued (fetch() called), not
  // from startTime (request sent). They differ by any CORS preflight, so use the Resource
  // Timing start — which is the fetch() call — as its base when we have it.
  const issuedAt = rt ? rt.startTime : start;
  // issuedAt is non-null whenever hasTiming is true (start is then a number).
  const end = hasTiming && t.responseEnd >= 0 ? issuedAt! + t.responseEnd : null;

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

function isJson(body: string | null): boolean {
  if (!body) return false;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function chooseRequest(requests: RequestTiming[], { clickAt, firstPaintAt }: PageTiming, pattern: RegExp | null): ScoredRequest | null {
  if (pattern) {
    const match = requests.find((r) => pattern.test(r.url));
    if (!match) {
      const seen = requests.map((r) => `  ${r.method} ${r.url}`).join("\n") || "  (none)";
      throw new CliError(`No request matching ${pattern} between click and first paint. Seen:\n${seen}`);
    }
    return { request: match, reasons: [`matches --request ${pattern}`], from: requests.length };
  }

  const candidates = requests.filter((r): r is TimedRequest => r.start !== null);
  if (candidates.length === 0) return null;

  // A request still streaming at first paint has lasted at least until first paint.
  const duration = (r: TimedRequest) => (r.end ?? firstPaintAt) - r.issuedAt;
  const longest = maxBy(candidates, duration);
  const finishedBeforePaint = candidates.filter(
    (r): r is TimedRequest & { end: number } => r.end !== null && r.end <= firstPaintAt
  );
  const latestBeforePaint = finishedBeforePaint.length ? maxBy(finishedBeforePaint, (r) => r.end) : null;

  const scored = candidates.map((r) => {
    const reasons: string[] = [];
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
  return { ...scored[0]!, from: requests.length };
}

// Callers only pass non-empty arrays.
function maxBy<T>(items: T[], key: (item: T) => number): T {
  return items.reduce((best, item) => (key(item) > key(best) ? item : best));
}

// The page's own Resource Timing entries, already on the performance.now() clock. An entry's
// startTime is when fetch() was called — before any CORS preflight, which Playwright doesn't
// report — and its responseStart should match our first byte, which makes it a check on the
// clock alignment. Entries only appear once a response completes.
function readResourceTiming(page: Page): Promise<ResourceTimingEntry[]> {
  return page.evaluate(() =>
    (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).map((e) => ({
      name: e.name,
      startTime: e.startTime,
      responseStart: e.responseStart, // 0 cross-origin without Timing-Allow-Origin
    }))
  );
}

// The latest fetch of this URL that was called before the request was sent.
function matchResourceTiming(entries: ResourceTimingEntry[], url: string, start: number): ResourceTimingEntry | null {
  const candidates = entries.filter((e) => e.name === url && e.startTime <= start + 1);
  return candidates.length ? maxBy(candidates, (e) => e.startTime) : null;
}

async function findButton(page: Page, text: string, flag: string, timeout: number): Promise<Locator> {
  let name: RegExp;
  try {
    name = new RegExp(text, "i");
  } catch (err) {
    throw new CliError(`${flag} "${text}" is not a valid regular expression: ${messageOf(err)}`);
  }

  const button = page.getByRole("button", { name });
  try {
    await button.waitFor({ timeout });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new CliError(`No button matching ${name} (${flag}) appeared within ${timeout} ms.`);
    }
    if (/strict mode violation/.test(messageOf(err))) {
      const count = await button.count();
      throw new CliError(
        `${flag} "${text}" matches ${count} buttons; make it more specific (e.g. "^${text}$").`
      );
    }
    throw err;
  }
  return button;
}

function formatRun(i: number, ms: number): string {
  const label = i === 1 ? `run ${i} (cold)` : `run ${i}`;
  return `${label.padEnd(12)}  ${String(ms).padStart(5)} ms`;
}

// A streaming span shorter than this means the answer arrived in one go.
const STREAMS_MIN_MS = 250;

function formatDone({ timing, done }: RunResult): string {
  const row = (label: string, value: number) => `    ${label.padEnd(26)}${String(ms(value)).padStart(6)} ms`;
  const lines = [row("click → first word", timing.firstPaintAt - timing.clickAt)];
  if (!done.settled) {
    lines.push(`    click → done              did not settle within ${DONE_CAP_MS / 1000}s of first word`);
    return lines.join("\n");
  }
  const span = done.doneAt - timing.firstPaintAt;
  lines.push(row("click → done", done.doneAt - timing.clickAt));
  lines.push(row("streaming span", span));
  lines.push(`    ${verdict(span)}`);
  return lines.join("\n");
}

function verdict(span: number): string {
  return span < STREAMS_MIN_MS ? "Doesn't stream: users see nothing until the whole answer is ready." : "Streams.";
}

// Gaps smaller than this between fetch() and the request going out are normal overhead
// (~1 ms), not a preflight.
const PREFLIGHT_MIN_MS = 5;

// One run's timeline from click to first paint as consecutive segments (ms may be null when
// unknown), plus the chosen request and the clock check. Shared by the terminal output and
// the HTML report.
function breakdown({ timing, pick }: RunResult): Breakdown {
  const { clickAt, firstPaintAt } = timing;
  if (!pick) return { request: null, segments: [], clock: null };

  const r = pick.request;
  const rt = r.rt;
  const span = (from: number | null, to: number | null) => (from === null || to === null ? null : to - from);
  const segments: Segment[] = [];

  const preflight = rt ? span(rt.startTime, r.start) : null;
  if (rt && preflight !== null && preflight >= PREFLIGHT_MIN_MS) {
    segments.push({ key: "click", label: "click → fetch() called", ms: span(clickAt, rt.startTime) });
    segments.push({ key: "preflight", label: "CORS preflight", ms: preflight });
  } else {
    segments.push({ key: "click", label: "click → request sent", ms: span(clickAt, r.start) });
  }
  if (ms(r.connectionSetup) > 0) {
    segments.push({ key: "connection", label: "connection setup", ms: r.connectionSetup, note: "new connection" });
  }
  const toFirstByte = span(r.start, r.firstByte);
  segments.push({
    key: "ttfb",
    label: "request → first byte",
    ms: toFirstByte === null ? null : toFirstByte - r.connectionSetup,
  });
  if (r.end !== null && r.end <= firstPaintAt) {
    segments.push({ key: "download", label: "first byte → done", ms: span(r.firstByte, r.end) });
    segments.push({
      key: "render",
      label: "done → first paint",
      ms: span(r.end, firstPaintAt),
      note: "what Lighthouse can't see",
    });
  } else {
    const note =
      r.firstByte === null ? "no response by first paint"
      : r.end === null ? "still streaming at first paint"
      : `done ${ms(r.end - firstPaintAt)} ms after paint`;
    segments.push({ key: "streaming", label: "first byte → first paint", ms: span(r.firstByte, firstPaintAt), note });
  }

  let clock: string;
  if (!rt) {
    clock = "n/a (no Resource Timing entry)";
  } else if (rt.responseStart > 0 && r.firstByte !== null) {
    clock = `first byte within ${Math.abs(r.firstByte - rt.responseStart).toFixed(1)} ms of Resource Timing`;
  } else {
    clock = "n/a (Resource Timing hides first byte without Timing-Allow-Origin)";
  }

  return {
    request: {
      method: r.method,
      url: r.url,
      status: r.status ?? r.failure ?? "no response",
      contentType: r.contentType,
    },
    reasons: pick.reasons,
    from: pick.from,
    segments,
    clock,
  };
}

function formatNetwork(parts: Breakdown, seen: number): string {
  if (!parts.request) return `    no timed network request between click and first paint (${seen} seen)`;
  const { request, reasons, from, segments, clock } = parts;

  const row = ({ key, label, ms: value, note }: Segment) => {
    const suffix = !note ? "" : key === "render" ? `   ← ${note}` : `   (${note})`;
    return `    ${label.padEnd(26)}${value === null ? "     ?" : String(ms(value)).padStart(6)} ms${suffix}`;
  };
  return [
    `    ${request.method} ${request.url} → ${request.status} ${request.contentType ?? ""}`.trimEnd(),
    `    chosen from ${from} request(s): ${reasons.join(", ") || "only candidate"}`,
    ...segments.map(row),
    `    clock check: ${clock}`,
  ].join("\n");
}

function ms(value: number): number {
  return Math.round(value);
}

// Median covers warm runs (2..N) only; cold is reported on its own; worst covers all runs.
// Called with at least one result (runs >= 1).
function summarize([cold, ...warm]: number[]): Summary {
  const worst = Math.max(cold!, ...warm);
  return { cold: cold!, median: median(warm), worst };
}

// Same warm-runs rule for done and span. Runs that never settled have no done time, so they
// are left out and counted.
function summarizeDone([, ...warm]: RunResult[]): DoneSummary {
  const settled = warm.flatMap(({ timing, done }) =>
    done.settled ? [{ done: done.doneAt - timing.clickAt, span: done.doneAt - timing.firstPaintAt }] : []
  );
  return {
    done: median(settled.map((r) => r.done)),
    span: median(settled.map((r) => r.span)),
    warm: warm.length,
    unsettled: warm.length - settled.length,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

function formatSummary({ cold, median, worst }: Summary): string {
  if (median === null) return `cold ${cold} ms · worst ${worst} ms (no warm runs for a median)`;
  return `cold ${cold} ms · median ${median} ms · worst ${worst} ms`;
}

function formatDoneSummary({ done, span, warm, unsettled }: DoneSummary): string {
  if (warm === 0) return "done: no warm runs for a median, so no verdict";
  const skipped = unsettled ? ` (${unsettled} of ${warm} warm runs did not settle; left out)` : "";
  if (done === null || span === null) return `done: no warm run settled within ${DONE_CAP_MS / 1000}s, so no verdict`;
  return `done: median ${done} ms · span median ${span} ms${skipped}\n${verdict(span)}`;
}

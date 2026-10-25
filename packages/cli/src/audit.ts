import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page, Request, Response } from "playwright";
import { launchChromium } from "./browser.js";
import { CliError, messageOf, PageLoadError } from "./errors.js";
import { renderReport } from "./report.js";
import type {
  Breakdown,
  DoneSummary,
  DoneTiming,
  DoubleReport,
  DoubleResult,
  OutputChange,
  PageTiming,
  RequestSummary,
  RequestTiming,
  ResourceTimingEntry,
  RunResult,
  ScoredRequest,
  Segment,
  StopCheck,
  StopEnd,
  StopReport,
  StopResult,
  Summary,
  TimedRequest,
} from "./types.js";

// The watcher's result, parked on the audited page's window between two page.evaluate calls.
declare global {
  interface Window {
    __lensTiming: Promise<PageTiming>;
    __lensDone: Promise<DoneTiming>;
    __lensLastChangeAt: number; // the watcher's latest output change; -1 before the first word
    __lensStopClickAt: Promise<number>;
    __caliperRead: () => string; // the watcher's reader for --output
    __lensDoubleClickAt: Promise<number>;
    __lensDoubleChanges: OutputChange[];
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
  stop: string | undefined;
  double: boolean;
}

/** A timed run whose page loaded. `run` is its 1-based number; run 1 is the cold run. */
interface LoadedRun {
  run: number;
  result: RunResult;
  parts: Breakdown;
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

export async function audit({ url, measure, output, steps, runs, headed, auth, timeout, settleMs, request, report, stop, double }: AuditOptions): Promise<void> {
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

  let stopPattern: RegExp | null = null;
  if (stop) {
    try {
      stopPattern = new RegExp(stop, "i");
    } catch (err) {
      throw new CliError(`--stop "${stop}" is not a valid regular expression: ${messageOf(err)}`);
    }
  }

  const browser = await launchChromium({ headless: !headed });

  try {
    const context = await browser.newContext({ storageState: authPath });
    const startedAt = new Date();
    const loaded: LoadedRun[] = [];
    const failed: number[] = []; // run numbers whose page failed to load

    for (let i = 1; i <= runs; i++) {
      // Fresh page per run so every run starts from the same state.
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      try {
        let result: RunResult;
        try {
          result = await measureOnce(page, { url, measure, output, steps, timeout, settleMs, requestPattern });
        } catch (err) {
          if (!(err instanceof PageLoadError)) throw err;
          failed.push(i);
          console.log(`${runLabel(i)} — page failed to load`);
          console.log(`    ${err.message}`);
          continue;
        }
        const parts = breakdown(result);
        loaded.push({ run: i, result, parts });
        console.log(formatRun(i, result.ms));
        console.log(formatNetwork(parts, result.requests.length));
        console.log(formatDone(result));
      } finally {
        await page.close();
      }
    }

    if (loaded.length === 0) {
      console.log("Inconclusive — page failed to load");
      return;
    }

    const summary = summarize(loaded, failed);
    console.log(formatSummary(summary));
    console.log(formatDoneSummary(summarizeDone(loaded.filter((r) => r.run > 1).map((r) => r.result))));

    let stopReport: StopReport | null = null;
    if (stopPattern) {
      // Its own fresh page, after the timed runs, so clicking Stop doesn't skew their numbers.
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      try {
        stopReport = describeStop(
          await stopOnce(page, { url, measure, output, steps, timeout, settleMs, requestPattern }, stopPattern)
        );
        console.log(formatChecks("stop check", stopReport));
      } finally {
        await page.close();
      }
    }

    let doubleReport: DoubleReport | null = null;
    if (double) {
      // Like the Stop check: its own fresh page, after the timed runs.
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      try {
        doubleReport = describeDouble(
          await doubleOnce(page, { url, measure, output, steps, timeout, settleMs, requestPattern })
        );
        console.log(formatChecks("double-send check", doubleReport));
      } finally {
        await page.close();
      }
    }

    if (report) {
      const reportPath = resolve(report);
      const html = renderReport({
        url,
        measure,
        output,
        steps,
        startedAt,
        summary,
        runs: loaded.map(({ run, result, parts }) => ({ run, total: result.ms, ...parts })),
        failed,
        stop: stopReport && { pattern: stop!, ...stopReport },
        double: doubleReport,
      });
      writeFileSync(reportPath, html);
      console.log(`report: ${reportPath}`);
    }
  } finally {
    await browser.close();
  }
}

async function measureOnce(page: Page, options: MeasureOptions): Promise<RunResult> {
  const { timeout, requestPattern } = options;
  const target = await prepareRun(page, options);

  // 2. Click — this is where the timer starts. Network capture starts just before it.
  const network = startNetworkCapture(page);
  await target.click();

  // 3. Wait for the in-page watcher to report back.
  const timing = await waitForFirstWord(page, options);

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

// Loads the page, clicks the --step buttons and installs the watcher. Returns the --measure
// button, ready to click.
async function prepareRun(page: Page, { url, measure, output, steps, timeout, settleMs }: MeasureOptions): Promise<Locator> {
  try {
    await page.goto(url);
  } catch (err) {
    // Playwright errors carry a multi-line call log; the first line is the message.
    throw new PageLoadError(messageOf(err).split("\n")[0]!.trim());
  }

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
    window.__caliperRead = read; // the double-send recorder reads the output the same way

    window.__lensLastChangeAt = -1;
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
                firstChangeAt = lastChangeAt = window.__lensLastChangeAt = t;
                last = now;
                resolve({ clickAt, firstPaintAt: t });
              } else if (t - clickAt > timeoutMs) {
                reject(new Error(`No output within ${timeoutMs / 1000}s`));
                return;
              }
            } else if (now !== last) {
              lastChangeAt = window.__lensLastChangeAt = t;
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
  return target;
}

async function waitForFirstWord(page: Page, { measure, output, timeout }: MeasureOptions): Promise<PageTiming> {
  try {
    return await page.evaluate(() => window.__lensTiming);
  } catch (err) {
    if (!/No output within/.test(messageOf(err))) throw err;
    const exists = await page.evaluate((sel) => !!document.querySelector(sel), output);
    throw new CliError(
      exists
        ? `Timed out after ${timeout} ms: "${output}" never changed after clicking --measure "${measure}".`
        : `Timed out after ${timeout} ms: no element matches --output "${output}".`
    );
  }
}

// Stop check: click Stop this long after the first word...
const STOP_AFTER_MS = 500;
// ...once the output has changed again within this long (else the stream already ended).
const STILL_CHANGING_MS = 1000;
// Wait this long for the Stop button to be visible.
const STOP_FIND_MS = 2000;
// The output may still change this long after Stop (a last render) and count as stopped.
const STOP_PIXELS_MS = 1000;

// One extra run: start an answer, click Stop mid-stream, and see what the browser did.
// Every outcome is returned as a result, never thrown, except the setup errors any run has.
async function stopOnce(page: Page, options: MeasureOptions, stopPattern: RegExp): Promise<StopResult> {
  // The watcher stops tracking once the output settles, so it mustn't settle before Stop.
  let target: Locator;
  try {
    target = await prepareRun(page, { ...options, settleMs: Math.max(options.settleMs, STOP_AFTER_MS + STILL_CHANGING_MS) });
  } catch (err) {
    // Playwright errors carry a multi-line call log; the first line is the message.
    return { kind: "load-failed", error: messageOf(err).split("\n")[0]!.trim() };
  }
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const wire = await startWireCapture(page, timeOrigin);
  const outcomes = trackOutcomes(page);

  try {
    const network = startNetworkCapture(page);
    await target.click();
    let timing: PageTiming;
    try {
      timing = await waitForFirstWord(page, options);
    } catch (err) {
      // waitForFirstWord throws a CliError only for the timeout; anything else is a real failure.
      if (!(err instanceof CliError)) throw err;
      return { kind: "no-first-word", error: err.message };
    }
    const [{ requests }] = await Promise.all([network.stop(timing), sleep(STOP_AFTER_MS)]);
    const r = chooseRequest(requests, timing, options.requestPattern)?.request ?? null;

    if (!(await stillChanging(page))) {
      const span = (await page.evaluate(() => window.__lensLastChangeAt)) - timing.firstPaintAt;
      const endedBeforePaint = r?.end != null && r.end <= timing.firstPaintAt;
      if (span < STREAMS_MIN_MS || endedBeforePaint) return { kind: "doesnt-stream", span };
      return { kind: "finished-before-click", span, requestEnded: !!r && outcomes.get(r.raw)?.kind === "finished" };
    }

    const stop = page.getByRole("button", { name: stopPattern });
    try {
      await stop.waitFor({ timeout: STOP_FIND_MS });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        return { kind: "no-control", reason: `no visible button matching ${stopPattern} while the answer was streaming` };
      }
      if (/strict mode violation/.test(messageOf(err))) {
        return { kind: "ambiguous-control", count: await stop.count() };
      }
      throw err;
    }

    // Time the Stop click on the page clock, like the --measure click.
    await page.evaluate(() => {
      window.__lensStopClickAt = new Promise((resolve) =>
        document.addEventListener("click", (e) => resolve(e.timeStamp), { capture: true, once: true })
      );
    });
    await stop.click();
    const stopAt = await page.evaluate(() => window.__lensStopClickAt);

    // (1) Pixels: the watcher resolves once the output has been unchanged for settle-ms.
    const done = await page.evaluate(() => window.__lensDone);
    const outputStoppedAfter = done.settled ? Math.max(0, done.doneAt - stopAt) : null;
    await sleep(NETWORK_SETTLE_MS); // let the last network events reach us

    if (!r) return { kind: "clicked", afterFirstWord: stopAt - timing.firstPaintAt, outputStoppedAfter, network: null };

    // (2) + (3) Network: how the AI request ended, and when its bytes arrived.
    const w = wire.match(r);
    const end = requestEnd(outcomes.get(r.raw), w, stopAt);

    // A request that ended normally before the click was over before Stop could matter.
    if (end.kind === "finished" && end.at !== null && end.at <= 0) {
      return { kind: "finished-before-click", span: stopAt - timing.firstPaintAt, requestEnded: true };
    }

    return {
      kind: "clicked",
      afterFirstWord: stopAt - timing.firstPaintAt,
      outputStoppedAfter,
      network: {
        request: summarizeRequest(r),
        end,
        bytesAfterStop: w ? bytesSince(w, stopAt) : null,
        bytesAfterAbort: w && w.failedAt !== null ? bytesSince(w, w.failedAt) : null,
      },
    };
  } finally {
    outcomes.stop();
    await wire.stop();
  }
}

// Still streaming? Wait for one more change in the output.
async function stillChanging(page: Page): Promise<boolean> {
  const mark = await page.evaluate(() => performance.now());
  return page
    .waitForFunction((m) => window.__lensLastChangeAt > m, mark, { polling: "raf", timeout: STILL_CHANGING_MS })
    .then(() => true, (err: unknown) => {
      if (err instanceof Error && err.name === "TimeoutError") return false;
      throw err;
    });
}

// How a request ended, with `at` relative to the checked click (page clock).
function requestEnd(outcome: Outcome | undefined, w: WireRequest | null, clickAt: number): StopEnd {
  const after = (t: number | null) => (w && t !== null ? t - clickAt : null);
  return (
    !outcome ? { kind: "open" }
    : outcome.kind === "finished" ? { kind: "finished", at: after(w?.finishedAt ?? null) }
    : /ERR_ABORTED/.test(outcome.errorText) ? { kind: "aborted", errorText: outcome.errorText, at: after(w?.failedAt ?? null) }
    : { kind: "failed", errorText: outcome.errorText, at: after(w?.failedAt ?? null) }
  );
}

function bytesSince(w: WireRequest, t: number): number {
  return w.chunks.filter((c) => c.at > t).reduce((sum, c) => sum + c.bytes, 0);
}

// Double-send check: click --measure again this long after the first word...
const DOUBLE_AFTER_MS = 500;
// ...giving up on the second click if the button doesn't take it within this long.
const DOUBLE_CLICK_MS = 1000;
// An output change this long after request 1's last byte still counts as painted from it.
const PAINT_SLACK_MS = 250;

// One extra run: start an answer, click --measure again mid-stream, and see what the browser
// did with both requests and the output. Every outcome is returned as a result, never thrown,
// except the setup errors any run has.
async function doubleOnce(page: Page, options: MeasureOptions): Promise<DoubleResult> {
  // The watcher stops tracking once the output settles, so it mustn't settle before click 2.
  let target: Locator;
  try {
    target = await prepareRun(page, { ...options, settleMs: Math.max(options.settleMs, DOUBLE_AFTER_MS + STILL_CHANGING_MS) });
  } catch (err) {
    return { kind: "load-failed", error: messageOf(err).split("\n")[0]!.trim() };
  }
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const wire = await startWireCapture(page, timeOrigin);
  const outcomes = trackOutcomes(page);
  // Same detection as the timed runs; a --request that matches nothing means "not identified".
  const pick = (requests: RequestTiming[], timing: PageTiming) => {
    try {
      return chooseRequest(requests, timing, options.requestPattern)?.request ?? null;
    } catch (err) {
      if (err instanceof CliError) return null;
      throw err;
    }
  };

  try {
    // Click 1, exactly like a timed run.
    const network = startNetworkCapture(page);
    await target.click();
    let timing: PageTiming;
    try {
      timing = await waitForFirstWord(page, options);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      return { kind: "no-first-word", error: err.message };
    }
    const [{ requests }] = await Promise.all([network.stop(timing), sleep(DOUBLE_AFTER_MS)]);
    const r1 = pick(requests, timing);

    if (!(await stillChanging(page))) {
      return { kind: "finished-before-click", span: (await page.evaluate(() => window.__lensLastChangeAt)) - timing.firstPaintAt };
    }

    // Click 2 only if the --measure button is there and enabled right now.
    const count = await target.count();
    if (count > 1) return { kind: "ambiguous-control", count };
    if (count === 0 || !(await target.isVisible())) return { kind: "prevented", how: "missing" };
    if (await target.isDisabled()) return { kind: "prevented", how: "disabled" };

    // Record every output change after click 2, and whether the text from just before it is
    // still there, on the page clock like the watcher.
    await page.evaluate((capMs) => {
      window.__lensDoubleChanges = [];
      window.__lensDoubleClickAt = new Promise((resolve) =>
        document.addEventListener(
          "click",
          (event) => {
            const clickAt = event.timeStamp;
            const old = window.__caliperRead();
            let last = old;
            function check() {
              const t = performance.now();
              const now = window.__caliperRead();
              if (now !== last) {
                last = now;
                window.__lensDoubleChanges.push({ at: t, hasOld: old !== "" && now.includes(old) });
              }
              if (t - clickAt < capMs) requestAnimationFrame(check);
            }
            requestAnimationFrame(check);
            resolve(clickAt);
          },
          { capture: true, once: true }
        )
      );
    }, DONE_CAP_MS);

    const network2 = startNetworkCapture(page);
    try {
      await target.click({ timeout: DOUBLE_CLICK_MS });
    } catch (err) {
      // It turned disabled (or went away) between the check and the click.
      if (err instanceof Error && err.name === "TimeoutError") return { kind: "prevented", how: "disabled" };
      throw err;
    }
    const clickAt = await page.evaluate(() => window.__lensDoubleClickAt);
    const afterFirstWord = clickAt - timing.firstPaintAt;

    // Let the output settle, then pick request 2 from what was sent after click 2 to the same
    // endpoint as request 1 (method + URL path; the query string may differ).
    await page.evaluate(() => window.__lensDone);
    const until = await page.evaluate(() => performance.now());
    const { requests: sent } = await network2.stop({ clickAt, firstPaintAt: until });
    if (!r1) return { kind: "clicked", afterFirstWord, network: null };
    const endpoint = (r: RequestTiming) => {
      const u = new URL(r.url);
      return `${r.method} ${u.origin}${u.pathname}`;
    };
    const same = sent.filter((r) => endpoint(r) === endpoint(r1));
    if (same.length === 0) return { kind: "ignored", afterFirstWord };
    const r2 = pick(same, { clickAt, firstPaintAt: until });
    if (!r2) return { kind: "clicked", afterFirstWord, network: null };

    // Give both requests until --timeout to end, then let the last paints land.
    const deadline = Date.now() + options.timeout;
    while ((!outcomes.get(r1.raw) || !outcomes.get(r2.raw)) && Date.now() < deadline) await sleep(50);
    await sleep(PAINT_SLACK_MS + NETWORK_SETTLE_MS);

    const w1 = wire.match(r1);
    const w2 = wire.match(r2);
    const end1 = requestEnd(outcomes.get(r1.raw), w1, clickAt);
    // A request 1 that ended normally before click 2 was over before the second click could matter.
    if (end1.kind === "finished" && end1.at !== null && end1.at <= 0) {
      return { kind: "finished-before-click", span: afterFirstWord };
    }

    const changes = await page.evaluate(() => window.__lensDoubleChanges);
    const bytesAfterClick = w1 ? bytesSince(w1, clickAt) : null;
    const lastByteAt = w1 ? w1.chunks.reduce((latest, c) => Math.max(latest, c.at), clickAt) : null;
    // Request 2's first word: the first output change once its first byte arrived.
    const firstByte2 = w2?.chunks[0]?.at ?? r2.firstByte;
    const firstWord2 = firstByte2 === null ? undefined : changes.find((c) => c.at >= firstByte2);

    return {
      kind: "clicked",
      afterFirstWord,
      network: {
        first: {
          request: summarizeRequest(r1),
          end: end1,
          bytesAfterClick,
          bytesAfterAbort: w1 && w1.failedAt !== null ? bytesSince(w1, w1.failedAt) : null,
        },
        second: {
          request: summarizeRequest(r2),
          end: requestEnd(outcomes.get(r2.raw), w2, clickAt),
          firstWordAfter: firstWord2 ? firstWord2.at - clickAt : null,
        },
        outputChangedWhileFirst:
          bytesAfterClick === null || lastByteAt === null ? null
          : bytesAfterClick > 0 && changes.some((c) => c.at <= lastByteAt + PAINT_SLACK_MS),
        oldTextAtSecond: firstWord2 ? firstWord2.hasOld : null,
      },
    };
  } finally {
    outcomes.stop();
    await wire.stop();
  }
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

type Outcome = { kind: "finished" } | { kind: "failed"; errorText: string };

// How each request ended, as Playwright reports it: requestfinished is a normal end;
// requestfailed carries the browser's error, net::ERR_ABORTED when the page aborted it.
function trackOutcomes(page: Page) {
  const outcomes = new Map<Request, Outcome>();
  const onFinished = (request: Request) => outcomes.set(request, { kind: "finished" });
  const onFailed = (request: Request) =>
    outcomes.set(request, { kind: "failed", errorText: request.failure()?.errorText ?? "unknown error" });
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);

  return {
    get: (request: Request) => outcomes.get(request),
    stop() {
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
    },
  };
}

/** One request as the browser's network stack saw it, on the page clock. */
interface WireRequest {
  url: string;
  method: string;
  sentAt: number;
  chunks: { at: number; bytes: number }[];
  finishedAt: number | null;
  failedAt: number | null;
}

// When each response chunk arrived, from Chrome's own network events (CDP). Playwright
// doesn't expose per-chunk timing, and it's what shows bytes still arriving after Stop.
//
// Clock alignment: CDP timestamps are monotonic seconds; requestWillBeSent also carries the
// wall clock, which gives the monotonic → epoch offset, and epoch − timeOrigin is page time.
async function startWireCapture(page: Page, timeOrigin: number) {
  const cdp = await page.context().newCDPSession(page);
  const wire = new Map<string, WireRequest>();
  let offset = 0; // epoch ms − monotonic ms; set by the first request, which precedes its other events
  const toPage = (timestamp: number) => timestamp * 1000 + offset - timeOrigin;

  cdp.on("Network.requestWillBeSent", (e) => {
    if (wire.size === 0) offset = e.wallTime * 1000 - e.timestamp * 1000;
    if (wire.has(e.requestId)) return; // a redirect reuses the id; keep the first hop
    wire.set(e.requestId, {
      url: e.request.url,
      method: e.request.method,
      sentAt: toPage(e.timestamp),
      chunks: [],
      finishedAt: null,
      failedAt: null,
    });
  });
  cdp.on("Network.dataReceived", (e) => {
    wire.get(e.requestId)?.chunks.push({ at: toPage(e.timestamp), bytes: e.encodedDataLength || e.dataLength });
  });
  cdp.on("Network.loadingFinished", (e) => {
    const w = wire.get(e.requestId);
    if (w) w.finishedAt = toPage(e.timestamp);
  });
  cdp.on("Network.loadingFailed", (e) => {
    const w = wire.get(e.requestId);
    if (w) w.failedAt = toPage(e.timestamp);
  });
  await cdp.send("Network.enable");

  return {
    // The same URL and method, sent closest to when Playwright says the request was issued.
    match(r: RequestTiming): WireRequest | null {
      const same = [...wire.values()].filter((w) => w.url === r.url && w.method === r.method);
      if (same.length === 0) return null;
      const near = r.issuedAt ?? r.start;
      return near === null ? same[same.length - 1]! : maxBy(same, (w) => -Math.abs(w.sentAt - near));
    },
    async stop() {
      await cdp.detach().catch(() => {}); // already gone if the page closed
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

const runLabel = (i: number) => (i === 1 ? `run ${i} (cold)` : `run ${i}`);

function formatRun(i: number, ms: number): string {
  return `${runLabel(i).padEnd(12)}  ${String(ms).padStart(5)} ms`;
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
    request: summarizeRequest(r),
    reasons: pick.reasons,
    from: pick.from,
    segments,
    clock,
  };
}

const HOP2_NOTE =
  "Model-side cancellation (hop 2: your server → the model provider) is not visible from the browser. " +
  "An abort here only shows the browser dropped its connection; check server logs or provider usage to confirm generation stopped.";

// The Stop check as verdict + checks, shared by the terminal output and the HTML report.
function describeStop(result: StopResult): StopReport {
  const notes = [HOP2_NOTE];
  switch (result.kind) {
    case "load-failed":
      return { verdict: "Inconclusive — Stop run couldn't reach the button set by --measure", checks: [], notes: [result.error, ...notes] };
    case "no-first-word":
      return { verdict: "Inconclusive — no first word before timeout in the Stop run", checks: [], notes: [result.error, ...notes] };
    case "no-control":
      return { verdict: "No Stop control found", checks: [], notes: [result.reason, ...notes] };
    case "ambiguous-control":
      return { verdict: `Stop pattern matched ${result.count} buttons — make it more specific`, checks: [], notes };
    case "doesnt-stream":
      return {
        verdict: "Doesn't stream — Stop can't be tested mid-stream",
        checks: [],
        notes: [`the whole answer appeared at once (streaming span ${ms(result.span)} ms)`, ...notes],
      };
    case "finished-before-click":
      return {
        verdict: "Inconclusive — stream finished before the click",
        checks: [],
        notes: [
          `output stopped changing ${ms(result.span)} ms after the first word` +
            (result.requestEnded ? ", and the AI request ended normally" : ""),
          ...notes,
        ],
      };
  }

  const { afterFirstWord, outputStoppedAfter, network } = result;
  const pixelsOk = outputStoppedAfter !== null && outputStoppedAfter <= STOP_PIXELS_MS;
  const checks: StopCheck[] = [
    {
      label: "pixels",
      pass: pixelsOk,
      detail:
        outputStoppedAfter === null ? `output still changing ${DONE_CAP_MS / 1000}s after the first word`
        : pixelsOk ? `output stopped changing ${ms(outputStoppedAfter)} ms after Stop`
        : `output kept changing for ${ms(outputStoppedAfter)} ms after Stop`,
    },
  ];
  notes.unshift(`clicked Stop ${ms(afterFirstWord)} ms after the first word, while the output was still changing`);

  if (!network) {
    checks.push({ label: "network", pass: null, detail: "no AI request identified (try --request)" });
    return { verdict: "Inconclusive — couldn't identify the AI request", checks, notes };
  }

  const { request, end, bytesAfterStop, bytesAfterAbort } = network;
  const at = (t: number | null) => (t === null ? "" : ` ${ms(t)} ms after Stop`);
  const bytes = (n: number | null) => (n === null ? "? bytes (no byte timeline)" : `${n.toLocaleString("en-US")} bytes`);
  // An abort only counts if no bytes arrived after it; with no byte timeline it counts on its own.
  const bytesAfterAbortSeen = end.kind === "aborted" && bytesAfterAbort !== null && bytesAfterAbort > 0;
  const aborted = end.kind === "aborted" && !bytesAfterAbortSeen;
  checks.push({
    label: "network",
    pass: aborted,
    detail:
      `${request.method} ${request.url}: ` +
      (end.kind === "aborted"
        ? `aborted by the browser (${end.errorText})${at(end.at)}; ${bytes(bytesAfterAbort)} after the abort`
        : end.kind === "failed" ? `failed with ${end.errorText}${at(end.at)} — not a browser abort`
        : end.kind === "finished" ? `never aborted; ${bytes(bytesAfterStop)} arrived after Stop`
        : `never aborted; still open, ${bytes(bytesAfterStop)} arrived after Stop`),
  });
  checks.push({
    label: "end",
    pass: end.kind !== "finished",
    detail: end.kind === "finished" ? `ended normally (requestfinished)${at(end.at)}` : "no normal end (no requestfinished)",
  });

  // A pass on the abort event alone, with no byte timeline to confirm it, says so.
  const abortOnly = aborted && bytesAfterAbort === null ? " — abort seen; byte timing unavailable" : "";
  const verdict =
    aborted && pixelsOk ? `Stop works (browser side)${abortOnly}`
    : bytesAfterAbortSeen ? "Stop aborted the request, but bytes kept arriving"
    : aborted ?`Stop aborted the request, but the output kept changing${abortOnly}`
    : pixelsOk ? "Stop only hides text — stream kept running"
    : "Stop did nothing — output and stream kept going";
  return { verdict, checks, notes };
}

const DOUBLE_HOP2_NOTE =
  "Caliper proves the browser cancelled request 1 (hop 1). Whether your server also stopped the model " +
  "(hop 2: your server → the model provider) needs the server wrapper (M3).";

// The double-send check as verdict + checks, shared by the terminal output and the HTML report.
// Verdicts are tried in a fixed priority order; anything that matches none is inconclusive.
function describeDouble(result: DoubleResult): DoubleReport {
  const notes = [DOUBLE_HOP2_NOTE];
  switch (result.kind) {
    case "load-failed":
      return { verdict: "Inconclusive — page failed to load", checks: [], notes: [result.error, ...notes] };
    case "no-first-word":
      return { verdict: "Inconclusive — no first word before timeout in the double-send run", checks: [], notes: [result.error, ...notes] };
    case "finished-before-click":
      return {
        verdict: "Inconclusive — stream finished before the second click",
        checks: [],
        notes: [`output stopped changing ${ms(result.span)} ms after the first word`, ...notes],
      };
    case "prevented":
      return {
        verdict: "Double send prevented (button disabled while generating)",
        checks: [],
        notes: [
          result.how === "disabled"
            ? "the --measure button was disabled while the answer was streaming"
            : "the --measure button was not on the page while the answer was streaming",
          ...notes,
        ],
      };
    case "ambiguous-control":
      return { verdict: `Inconclusive — --measure matched ${result.count} buttons at the second click`, checks: [], notes };
    case "ignored":
      return {
        verdict: "Double send ignored (second click sent no request)",
        checks: [],
        notes: [
          `clicked --measure again ${ms(result.afterFirstWord)} ms after the first word; no request to the same endpoint followed`,
          ...notes,
        ],
      };
  }

  const { afterFirstWord, network } = result;
  notes.unshift(`clicked --measure again ${ms(afterFirstWord)} ms after the first word, while the output was still changing`);
  if (!network) return { verdict: "Inconclusive — couldn't identify the AI requests", checks: [], notes };

  const { first, second, outputChangedWhileFirst, oldTextAtSecond } = network;
  const at = (t: number | null) => (t === null ? "" : ` ${ms(t)} ms after the second click`);
  const bytes = (n: number | null) => (n === null ? "byte timing unavailable" : `${n.toLocaleString("en-US")} bytes`);
  const ended = (end: StopEnd) =>
    end.kind === "aborted" ? `aborted by the browser (${end.errorText})${at(end.at)}`
    : end.kind === "failed" ? `failed with ${end.errorText}${at(end.at)} — not a browser abort`
    : end.kind === "finished" ? `ended normally (requestfinished)${at(end.at)}`
    : "still open";
  const aborted = first.end.kind === "aborted";
  // Cancelled: aborted with no bytes after the abort. Unknown (null) without a byte timeline.
  const cancelled = aborted ? (first.bytesAfterAbort === null ? null : first.bytesAfterAbort === 0) : false;
  // Bytes after click 2 that no abort came before: request 1 kept generating.
  const kept = aborted ? first.bytesAfterAbort : first.bytesAfterClick;
  const keptSending = kept !== null && kept > 0;
  const secondStreamed = second.firstWordAfter !== null;

  const checks: StopCheck[] = [
    {
      label: "request 1",
      pass: cancelled,
      detail:
        `${first.request.method} ${first.request.url}: ${ended(first.end)}; ` +
        `${bytes(first.bytesAfterClick)} after the second click` +
        (first.end.kind === "aborted" ? `, ${bytes(first.bytesAfterAbort)} after the abort` : ""),
    },
    {
      label: "request 2",
      pass: secondStreamed,
      detail:
        `${second.request.method} ${second.request.url}: ${ended(second.end)}; ` +
        (secondStreamed ? `first word ${ms(second.firstWordAfter!)} ms after the second click` : "no first word painted"),
    },
    {
      // Informational only: pixels can't prove which request wrote the text.
      label: "output",
      pass: outputChangedWhileFirst === false ? true : null,
      detail:
        outputChangedWhileFirst === null ? "byte timing unavailable"
        : outputChangedWhileFirst ? "Output changed while request 1 was still sending — may be mixed; Caliper can't tell which request wrote the text."
        : "no output change while request 1 was still sending",
    },
    {
      label: "cleared",
      pass: oldTextAtSecond === null ? null : !oldTextAtSecond,
      detail:
        oldTextAtSecond === null ? "request 2 painted no first word, so nothing to compare"
        : oldTextAtSecond ? "text from before the second click was still there at request 2's first word"
        : "text from before the second click was gone by request 2's first word",
    },
  ];

  const verdict =
    first.end.kind === "finished" ? "Two generations ran — previous request not cancelled (paid twice)"
    : keptSending ? "Two generations ran — previous request not cancelled"
    : oldTextAtSecond === true ? "Previous answer not cleared"
    : cancelled === true && oldTextAtSecond === false && secondStreamed ? "Double send handled (previous request cancelled)"
    : "Inconclusive — no verdict matched; see checks";
  return { verdict, checks, notes };
}

function formatChecks(title: string, { verdict, checks, notes }: StopReport): string {
  const mark = (pass: boolean | null) => (pass === null ? "?" : pass ? "✓" : "✗");
  return [
    title,
    ...checks.map((c) => `    ${mark(c.pass)} ${c.label.padEnd(9)} ${c.detail}`),
    `    ${verdict}`,
    ...notes.map((n) => `    note: ${n}`),
  ].join("\n");
}

function summarizeRequest(r: RequestTiming): RequestSummary {
  return { method: r.method, url: r.url, status: r.status ?? r.failure ?? "no response", contentType: r.contentType };
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

// Median covers the warm runs (2..N) that loaded; cold is run 1 on its own, null if it failed
// to load; worst covers every run that loaded. Called with at least one loaded run.
function summarize(loaded: LoadedRun[], failed: number[]): Summary {
  const cold = loaded[0]!.run === 1 ? loaded[0]!.result.ms : null;
  const warm = loaded.filter((r) => r.run > 1).map((r) => r.result.ms);
  const worst = Math.max(...loaded.map((r) => r.result.ms));
  return { cold, median: median(warm), worst, warm: warm.length, warmFailed: failed.filter((n) => n > 1).length };
}

// Same warm-runs rule for done and span, given the warm runs that loaded. Runs that never
// settled have no done time, so they are left out and counted.
function summarizeDone(warm: RunResult[]): DoneSummary {
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

function formatSummary({ cold, median, worst, warm, warmFailed }: Summary): string {
  const coldPart = cold === null ? "cold: run 1 failed to load" : `cold ${cold} ms`;
  const lost = warmFailed ? ` (${warmFailed} failed to load)` : "";
  if (median === null) return `${coldPart} · worst ${worst} ms (no warm runs for a median${lost})`;
  const used = warmFailed ? ` · median of ${warm} warm run${warm === 1 ? "" : "s"}${lost}` : "";
  return `${coldPart} · median ${median} ms · worst ${worst} ms${used}`;
}

function formatDoneSummary({ done, span, warm, unsettled }: DoneSummary): string {
  if (warm === 0) return "done: no warm runs for a median, so no verdict";
  const skipped = unsettled ? ` (${unsettled} of ${warm} warm runs did not settle; left out)` : "";
  if (done === null || span === null) return `done: no warm run settled within ${DONE_CAP_MS / 1000}s, so no verdict`;
  return `done: median ${done} ms · span median ${span} ms${skipped}\n${verdict(span)}`;
}

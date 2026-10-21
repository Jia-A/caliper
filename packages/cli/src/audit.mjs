import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { CliError } from "./errors.mjs";

export async function audit({ url, measure, output, steps, runs, headed, auth, timeout }) {
  const authPath = resolve(auth);
  if (!existsSync(authPath)) {
    throw new CliError(
      `No saved session at ${authPath}.\nRun: context-lens login <url> --auth ${auth}`
    );
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
        const ms = await measureOnce(page, { url, measure, output, steps, timeout });
        results.push(ms);
        console.log(formatRun(i, ms));
      } finally {
        await page.close();
      }
    }

    console.log(formatSummary(results));
  } finally {
    await browser.close();
  }
}

async function measureOnce(page, { url, measure, output, steps, timeout }) {
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

  // 2. Click — this is where the timer starts.
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

  return Math.round(timing.firstPaintAt - timing.clickAt);
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

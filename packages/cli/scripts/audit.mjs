import { chromium } from "playwright";

const URL = "https://lets-quill.vercel.app/blog/cmvhv3jo80002f4y47l8p1adb";
const OUTPUT = "textarea"; // where the AI's answer appears

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: "auth.json" });
const page = await context.newPage();

await page.goto(URL);
await page.getByRole("button", { name: /share on socials/i }).click();

const generate = page.getByRole("button", { name: /^(re)?generate$/i });
await generate.waitFor();

// 1. Install the watcher INSIDE the page, before clicking.
await page.evaluate((outputSelector) => {
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
          if (performance.now() - clickAt > 60_000) {
            reject(new Error("No output within 60s"));
            return;
          }
          requestAnimationFrame(check);
        }

        requestAnimationFrame(check);
      },
      { capture: true, once: true }
    );
  });
}, OUTPUT);

// 2. Click — this is where the timer starts.
await generate.click();

// 3. Wait for the in-page watcher to report back.
const { clickAt, firstPaintAt } = await page.evaluate(() => window.__lensTiming);

console.log(`Time to first painted output: ${Math.round(firstPaintAt - clickAt)} ms`);

await browser.close();
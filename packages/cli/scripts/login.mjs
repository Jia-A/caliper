import { chromium } from "playwright";
const browser = await chromium.launch({ headless: false }); // 1. open the browser
const context = await browser.newContext();                 // 2. a fresh window (own cookies)
const page = await context.newPage();                        // 3. a tab
await page.goto("https://lets-quill.vercel.app");            // 4. go to Quill
await page.pause();                                          // 5. YOU log in, then click Resume
await context.storageState({ path: "auth.json" });           // 6. save the logged-in session
await browser.close();                                       // 7. done
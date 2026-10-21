import { resolve } from "node:path";
import { launchChromium } from "./browser.js";

export interface LoginOptions {
  url: string;
  auth: string;
}

export async function login({ url, auth }: LoginOptions): Promise<void> {
  const authPath = resolve(auth);
  const browser = await launchChromium({ headless: false });

  try {
    const context = await browser.newContext(); // fresh window, own cookies
    const page = await context.newPage();
    await page.goto(url);

    console.log("Log in in the browser window, then click Resume in the Playwright Inspector.");
    await page.pause();

    await context.storageState({ path: authPath });
    console.log(`Saved session to ${authPath}`);
  } finally {
    await browser.close();
  }
}

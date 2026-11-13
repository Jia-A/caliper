import { createRequire } from "node:module";
import { chromium, type Browser, type LaunchOptions } from "playwright";
import { CliError, messageOf } from "./errors.js";

// The Playwright Caliper runs on (package.json pins it). The install command names it: outside a
// project, a bare `npx playwright` fetches the latest Playwright, whose Chromium build differs.
const PLAYWRIGHT_VERSION = (createRequire(import.meta.url)("playwright/package.json") as { version: string }).version;

// Playwright's browsers are a separate download (no postinstall here), so turn a missing
// binary into one clear instruction instead of Playwright's long error box.
export async function launchChromium(options: LaunchOptions): Promise<Browser> {
  try {
    return await chromium.launch(options);
  } catch (err) {
    if (/Executable doesn't exist|browserType\.launch:.*(install|download)/is.test(messageOf(err))) {
      throw new CliError(
        `Chromium for Playwright isn't installed. Run:\n\n  npx playwright@${PLAYWRIGHT_VERSION} install chromium\n`
      );
    }
    throw err;
  }
}

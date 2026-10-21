import { chromium } from "playwright";
import { CliError } from "./errors.mjs";

// Playwright's browsers are a separate download (no postinstall here), so turn a missing
// binary into one clear instruction instead of Playwright's long error box.
export async function launchChromium(options) {
  try {
    return await chromium.launch(options);
  } catch (err) {
    if (/Executable doesn't exist|browserType\.launch:.*(install|download)/is.test(err.message)) {
      throw new CliError(
        "Chromium for Playwright isn't installed. Run:\n\n  npx playwright install chromium\n"
      );
    }
    throw err;
  }
}

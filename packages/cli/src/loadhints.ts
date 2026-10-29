// Things to check after a page load failed, by the error Playwright reported.
// Pure functions with no imports, so the unit tests can load this file directly.

// What to check after a page load failed, chosen by the error Playwright reported. Each is a
// candidate, never the cause. Playwright's own navigation timeout (--timeout) and
// ERR_CONNECTION_REFUSED were reproduced on local fixtures (test:marked). ERR_TIMED_OUT was
// seen in a real run (Oct 29) and is unit-tested with that line (test:loadhints): it's Chromium's network timeout, not --timeout,
// so --timeout isn't a candidate. Any other error gets only the rerun line.
export function loadFailureHints(error: string, url: string, timeout: number): string[] {
  const origin = new URL(url).origin;
  const candidates =
    /^page\.goto: Timeout \d+ms exceeded/.test(error) ? ["your network connection", `whether ${origin} is up`, `--timeout (now ${timeout} ms)`]
    : /net::ERR_TIMED_OUT\b/.test(error) ? ["your network connection", `whether ${origin} is up`]
    : /net::ERR_CONNECTION_REFUSED\b/.test(error) ? [`whether ${origin} is up`, "the port in the URL"]
    : [];
  return [...(candidates.length ? [`things to check: ${candidates.join(" · ")}`] : []), "Rerun to try again."];
}

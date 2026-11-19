// Things to check after a page load failed, by the error Playwright reported, or after a
// --step / --measure button never appeared.
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

// --- A --step or --measure button that never appeared ---

// The named buttons in a Playwright ariaSnapshot() of the page (the tree getByRole searches,
// so hidden buttons aren't in it), in page order, deduped. Unnamed buttons are left out.
export function buttonNames(snapshot: string): string[] {
  const names: string[] = [];
  for (const raw of snapshot.split("\n")) {
    let entry = raw.trim().replace(/^- /, "");
    // YAML single-quotes an entry with a ": " in it ('button "a: b"'); '' is a quote inside.
    if (entry.startsWith("'") && entry.endsWith("'")) entry = entry.slice(1, -1).replaceAll("''", "'");
    const m = /^button "((?:[^"\\]|\\.)*)"/.exec(entry);
    if (!m) continue;
    let name: string;
    try {
      name = (JSON.parse(`"${m[1]}"`) as string).trim();
    } catch {
      continue; // an escape JSON doesn't share with YAML: left out rather than shown wrong
    }
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

const MAX_BUTTONS = 15;

// When each of the --auth file's cookies for this URL's site expired (ms), for those that have.
// A cookie is the site's when its domain is the host, or a parent domain with a leading dot.
// Session cookies (expires -1) never count. Anything that isn't a storage state gives none.
export function expiredLoginCookies(state: unknown, url: string, now: number): number[] {
  const cookies = (state as { cookies?: unknown } | null)?.cookies;
  if (!Array.isArray(cookies)) return [];
  const host = new URL(url).hostname;
  return cookies.flatMap((c: { domain?: unknown; expires?: unknown }) => {
    if (typeof c?.domain !== "string" || typeof c.expires !== "number") return [];
    const site = c.domain.startsWith(".") ? host === c.domain.slice(1) || host.endsWith(c.domain) : host === c.domain;
    const at = c.expires * 1000;
    return site && c.expires > 0 && at < now ? [at] : [];
  });
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Things to check after a --step or --measure button never appeared, only from what Caliper saw:
// the buttons on the page (null when they couldn't be read: no line), and the login. With
// --auth, a line only when a cookie for this site has expired; without, that none was used.
export function buttonHints({ seen, unnamed = [], selectorFlag = "--measure-selector", pattern, login, url }: {
  seen: string[] | null;
  unnamed?: { tag: string; selector: string }[]; // buttons with no name: a name can't match them
  selectorFlag?: string;
  pattern: RegExp;
  login: { file: string; expired: number[] } | null; // null without --auth
  url: string;
}): string[] {
  const lines: string[] = [];
  if (seen) {
    const shown = seen.slice(0, MAX_BUTTONS).map((n) => JSON.stringify(n)).join(", ");
    const more = seen.length > MAX_BUTTONS ? ` (and ${seen.length - MAX_BUTTONS} more)` : "";
    if (seen.length) lines.push(`Buttons I saw: ${shown}${more}. None matched ${pattern}.`);
    else if (!unnamed.length) lines.push(`No buttons on the page, so nothing to match ${pattern}.`);
  }
  if (unnamed.length) {
    lines.push(`Buttons without a name (a name can't match them; use a selector): ${unnamed.map((b) => `<${b.tag}> ${selectorFlag} ${JSON.stringify(b.selector)}`).join(" · ")}`);
  }
  if (!login) {
    lines.push("No saved login was used. If this button only shows when logged in, run caliper login first and pass --auth.");
  } else if (login.expired.length) {
    const days = [...new Set(login.expired.sort((a, b) => a - b).map(day))];
    const when = days.length === 1 ? `on ${days[0]}` : `between ${days[0]} and ${days.at(-1)}`;
    lines.push(`Your saved login (${login.file}) has cookies that expired ${when} — run: caliper login ${url} --auth ${login.file}`);
  }
  return lines;
}

// The audit's first line when it does more than the timed runs: how many times it can trigger the
// AI feature, counting every click that sends (the Stop check sends once; double-send clicks the
// trigger twice; the canary run sends once). null with only the timed runs. "up to": a run that
// fails earlier sends nothing.
export function triggerLine({ runs, marked, stop, double, canary }: { runs: number; marked: number; stop: boolean; double: boolean; canary: boolean }): string | null {
  const parts = [
    `${runs} timed`,
    ...(marked ? [`${marked} marked`] : []),
    ...(stop ? ["1 Stop check"] : []),
    ...(double ? ["2 double-send"] : []),
    ...(canary ? ["1 canary"] : []),
  ];
  if (parts.length === 1) return null;
  const total = runs + marked + (stop ? 1 : 0) + (double ? 2 : 0) + (canary ? 1 : 0);
  return `This audit triggers the AI feature up to ${total} times (${parts.join(" + ")}).`;
}

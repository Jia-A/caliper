// Unit tests for the things-to-check lookup after a failed page load. Run with
// `npm run test:loadhints` (Node 22.18+ runs .ts directly). Error strings are passed in as
// literals; nothing is loaded. The timeout, refused and dropped strings are the messages seen on
// local fixtures (test:marked); the net::ERR_TIMED_OUT string is the exact line a real production
// run printed on Oct 29 (it can't be reproduced locally).

import assert from "node:assert/strict";
import { test } from "node:test";
import { buttonHints, buttonNames, expiredLoginCookies, loadFailureHints } from "../src/loadhints.ts";

const URL = "http://127.0.0.1:8080/post/1";
const ORIGIN = "http://127.0.0.1:8080";

test("net::ERR_TIMED_OUT (real run, Oct 29): network and origin, no --timeout", () => {
  const url = "https://lets-quill.vercel.app/blog/cmvhv3jo80002f4y47l8p1adb";
  assert.deepEqual(loadFailureHints(`page.goto: net::ERR_TIMED_OUT at ${url}`, url, 60000), [
    "things to check: your network connection · whether https://lets-quill.vercel.app is up",
    "Rerun to try again.",
  ]);
});

test("Playwright's navigation timeout: network, origin and --timeout", () => {
  assert.deepEqual(loadFailureHints("page.goto: Timeout 4000ms exceeded.", URL, 4000), [
    `things to check: your network connection · whether ${ORIGIN} is up · --timeout (now 4000 ms)`,
    "Rerun to try again.",
  ]);
});

test("net::ERR_CONNECTION_REFUSED: origin and port", () => {
  assert.deepEqual(loadFailureHints(`page.goto: net::ERR_CONNECTION_REFUSED at ${URL}`, URL, 60000), [
    `things to check: whether ${ORIGIN} is up · the port in the URL`,
    "Rerun to try again.",
  ]);
});

test("any other error type: only the rerun line", () => {
  assert.deepEqual(loadFailureHints(`page.goto: net::ERR_EMPTY_RESPONSE at ${URL}`, URL, 60000), ["Rerun to try again."]);
});

// --- A --step or --measure button that never appeared ---

// Playwright's ariaSnapshot() of a page body (captured from Chromium), as findButton reads it.
const SNAPSHOT = [
  '- button "Spaced out"',
  '- button "Say \\"hi\\""',
  '- button "Close":',
  "  - img",
  "- button:",
  "  - img",
  '- button "Div btn"',
  '- button "Off" [disabled]',
  "- navigation:",
  "  - list:",
  "    - listitem:",
  `      - 'button "Nested: colon"'`,
  '- button "Submit it"',
  '- button "Close"',
  '- heading "Not a button" [level=1]',
].join("\n");

test("button names from the snapshot: named buttons only, in order, deduped", () => {
  assert.deepEqual(buttonNames(SNAPSHOT), ["Spaced out", 'Say "hi"', "Close", "Div btn", "Off", "Nested: colon", "Submit it"]);
});

const PAGE = "https://app.example.com/post/1";
test("the buttons seen, capped at 15, then what didn't match", () => {
  const names = Array.from({ length: 20 }, (_, i) => `Option ${i + 1}`);
  assert.deepEqual(buttonHints({ seen: names, pattern: /^nosuch$/i, login: null, url: PAGE }).slice(0, 1), [
    `Buttons I saw: ${names.slice(0, 15).map((n) => JSON.stringify(n)).join(", ")} (and 5 more). None matched /^nosuch$/i.`,
  ]);
  assert.equal(buttonHints({ seen: ["Generate"], pattern: /x/i, login: null, url: PAGE })[0], 'Buttons I saw: "Generate". None matched /x/i.');
  assert.equal(buttonHints({ seen: [], pattern: /x/i, login: null, url: PAGE })[0], "Buttons I saw: none. None matched /x/i.");
  // Couldn't read the page: no buttons line at all, never a guess.
  assert.ok(!buttonHints({ seen: null, pattern: /x/i, login: null, url: PAGE }).some((l) => l.startsWith("Buttons I saw")));
});

test("no --auth: says no saved login was used", () => {
  assert.deepEqual(buttonHints({ seen: ["Generate"], pattern: /x/i, login: null, url: PAGE }).slice(1), [
    "No saved login was used. If this button only shows when logged in, run caliper login first and pass --auth.",
  ]);
});

const NOW = Date.UTC(2026, 10, 5); // 2026-11-05
const cookie = (domain: string, expires: number) => ({ name: "s", value: "v", domain, path: "/", expires, httpOnly: false, secure: true, sameSite: "Lax" });
const secs = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;

test("--auth with a cookie for this site that expired: the login line, with its date", () => {
  const state = { cookies: [cookie("app.example.com", secs(2026, 10, 30))], origins: [] };
  const expired = expiredLoginCookies(state, PAGE, NOW);
  assert.deepEqual(expired, [secs(2026, 10, 30) * 1000]);
  assert.deepEqual(buttonHints({ seen: [], pattern: /x/i, login: { file: "auth.json", expired }, url: PAGE }).slice(1), [
    `Your saved login (auth.json) has cookies that expired on 2026-10-30 — run: caliper login ${PAGE} --auth auth.json`,
  ]);
});

test("several expiry dates: the range", () => {
  const expired = [secs(2026, 9, 1) * 1000, secs(2026, 10, 30) * 1000];
  assert.equal(buttonHints({ seen: [], pattern: /x/i, login: { file: "a.json", expired }, url: PAGE })[1],
    `Your saved login (a.json) has cookies that expired between 2026-09-01 and 2026-10-30 — run: caliper login ${PAGE} --auth a.json`);
});

test("--auth with valid cookies: nothing about login", () => {
  const state = { cookies: [cookie("app.example.com", secs(2027, 1, 1)), cookie(".example.com", -1)], origins: [] };
  assert.deepEqual(expiredLoginCookies(state, PAGE, NOW), []);
  assert.deepEqual(buttonHints({ seen: ["Generate"], pattern: /x/i, login: { file: "auth.json", expired: [] }, url: PAGE }), [
    'Buttons I saw: "Generate". None matched /x/i.',
  ]);
});

test("only cookies for the audited site count", () => {
  const state = {
    cookies: [
      cookie("other.com", secs(2020, 1, 1)), // another site
      cookie("evil-example.com", secs(2020, 1, 1)), // a look-alike, not a subdomain
      cookie("api.app.example.com", secs(2020, 1, 1)), // a host-only cookie for another host
      cookie(".example.com", secs(2026, 1, 2)), // a domain cookie for every example.com host
    ],
    origins: [],
  };
  assert.deepEqual(expiredLoginCookies(state, PAGE, NOW), [secs(2026, 1, 2) * 1000]);
  assert.deepEqual(expiredLoginCookies({ cookies: "nope" }, PAGE, NOW), []);
});

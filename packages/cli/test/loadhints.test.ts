// Unit tests for the things-to-check lookup after a failed page load. Run with
// `npm run test:loadhints` (Node 22.18+ runs .ts directly). Error strings are passed in as
// literals; nothing is loaded. The timeout, refused and dropped strings are the messages seen on
// local fixtures (test:marked); the net::ERR_TIMED_OUT string is the exact line a real production
// run printed on Oct 29 (it can't be reproduced locally).

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFailureHints } from "../src/loadhints.ts";

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

// Unit tests for the CSP image-rule parser. Run with `npm run test:csp` (Node 22.18+ runs .ts directly).

import assert from "node:assert/strict";
import { test } from "node:test";
import { combineImageRules, describeRule, imageRule, splitPolicies } from "../src/csp.ts";

test("default-src is the fallback when img-src is missing", () => {
  const { rule, from } = imageRule("default-src 'self' https://cdn.example.com; script-src 'self' 'unsafe-inline'");
  assert.equal(from, "default-src");
  assert.deepEqual(rule, { kind: "list", sources: ["'self'", "https://cdn.example.com"], data: false, blob: false });
});

test("img-src * overrides default-src 'self'", () => {
  const { rule, from } = imageRule("default-src 'self'; img-src *");
  assert.equal(from, "img-src");
  assert.equal(rule.kind, "anywhere");
});

test("no img-src or default-src means images are unrestricted", () => {
  const { rule, from } = imageRule("script-src 'self'; frame-ancestors 'none'");
  assert.equal(from, null);
  assert.deepEqual(rule, { kind: "unrestricted" });
});

test("https: and scheme wildcards count as anywhere; data:/blob: are noted, not exfiltration", () => {
  assert.deepEqual(imageRule("img-src 'self' https: data:").rule, { kind: "anywhere", data: true, blob: false });
  assert.equal(imageRule("img-src https://*").rule.kind, "anywhere");
  assert.deepEqual(imageRule("img-src 'self' data: blob:").rule, { kind: "list", sources: ["'self'"], data: true, blob: true });
});

test("'none' alone allows nothing; nonces and hashes are not image sources", () => {
  assert.deepEqual(imageRule("img-src 'none'").rule, { kind: "list", sources: [], data: false, blob: false });
  assert.equal(describeRule(imageRule("img-src 'none'").rule), "nothing ('none')");
  assert.deepEqual(imageRule("default-src 'nonce-abc' 'strict-dynamic' cdn.example.com").rule, {
    kind: "list", sources: ["cdn.example.com"], data: false, blob: false,
  });
});

test("two enforced policies: an image must pass both", () => {
  // One header value holding two comma-separated policies.
  const [a, b] = splitPolicies("img-src *.example.com images.other.com data:, default-src cdn.example.com 'self'");
  const combined = combineImageRules([imageRule(a!).rule, imageRule(b!).rule]);
  assert.deepEqual(combined, { kind: "list", sources: ["cdn.example.com"], data: false, blob: false });
  // A policy with no image rule doesn't loosen or tighten the other one.
  assert.deepEqual(combineImageRules([imageRule("script-src 'self'").rule, imageRule("img-src *").rule]), {
    kind: "anywhere", data: false, blob: false,
  });
});

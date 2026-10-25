// Content-Security-Policy parsing for one question: where may this page load images from?
// Pure functions with no imports, so the unit tests can load this file directly.

/** Where an image may load from under one policy, or several combined. */
export type ImageRule =
  | { kind: "unrestricted" } // no img-src or default-src
  | { kind: "anywhere"; data: boolean; blob: boolean } // *, http:, https:, or a scheme://* wildcard
  | { kind: "list"; sources: string[]; data: boolean; blob: boolean }; // empty sources = 'none'

/** One policy's image rule and the directive it came from. */
export interface PolicyImageRule {
  rule: ImageRule;
  from: "img-src" | "default-src" | null;
}

// Source expressions that say nothing about which hosts images may come from.
const IGNORED = /^'(nonce-|sha(256|384|512)-|unsafe-|strict-dynamic|report-sample|wasm-unsafe-eval|inline-speculation-rules)/i;

/** A header value may hold several policies separated by commas. */
export function splitPolicies(header: string): string[] {
  return header.split(",").map((p) => p.trim()).filter(Boolean);
}

// Directive name → its source list. When a directive repeats, the first one counts (CSP3).
function directives(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, sources);
  }
  return map;
}

function isAnywhere(source: string): boolean {
  return source === "*" || /^https?:$/i.test(source) || /^[a-z][a-z0-9+.-]*:\/\/\*$/i.test(source);
}

/** The image rule of one policy: img-src, else default-src, else unrestricted. */
export function imageRule(policy: string): PolicyImageRule {
  const map = directives(policy);
  const from = map.has("img-src") ? "img-src" : map.has("default-src") ? "default-src" : null;
  if (!from) return { rule: { kind: "unrestricted" }, from };

  const raw = map.get(from)!;
  const data = raw.some((s) => s.toLowerCase() === "data:");
  const blob = raw.some((s) => s.toLowerCase() === "blob:");
  if (raw.some(isAnywhere)) return { rule: { kind: "anywhere", data, blob }, from };
  // 'none' only means "nothing" when it's alone; next to other sources it's ignored.
  const sources = raw.filter((s) => !/^(data|blob):$/i.test(s) && s.toLowerCase() !== "'none'" && !IGNORED.test(s));
  return { rule: { kind: "list", sources, data, blob }, from };
}

// Host part for matching, scheme-insensitive: "https://cdn.x.com" and "cdn.x.com" compare equal.
const host = (source: string) => source.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/$/, "");

// Whether every URL matched by source `a` is also matched by source `b` (approximately: exact
// match, or b is a *.domain wildcard covering a).
function covers(b: string, a: string): boolean {
  const hb = host(b);
  const ha = host(a);
  if (hb === ha) return true;
  return hb.startsWith("*.") && ha.endsWith(hb.slice(1));
}

/** An image must pass every enforced policy, so combine their rules. */
export function combineImageRules(rules: ImageRule[]): ImageRule {
  const restricting = rules.filter((r): r is Exclude<ImageRule, { kind: "unrestricted" }> => r.kind !== "unrestricted");
  if (restricting.length === 0) return { kind: "unrestricted" };
  const data = restricting.every((r) => r.data);
  const blob = restricting.every((r) => r.blob);
  const lists = restricting.filter((r): r is Extract<ImageRule, { kind: "list" }> => r.kind === "list");
  if (lists.length === 0) return { kind: "anywhere", data, blob };

  // Keep a source only if every other list allows it too.
  let sources = lists[0]!.sources;
  for (const other of lists.slice(1)) {
    const fromThis = sources.filter((a) => other.sources.some((b) => covers(b, a)));
    const fromOther = other.sources.filter((b) => sources.some((a) => covers(a, b)));
    sources = [...new Set([...fromThis, ...fromOther])].filter((s, _, all) => !all.some((t) => t !== s && covers(t, s) && !covers(s, t)));
  }
  return { kind: "list", sources, data, blob };
}

/** One line describing a rule, for checks and verdicts. */
export function describeRule(rule: ImageRule): string {
  if (rule.kind === "unrestricted") return "no image rule (img-src/default-src not set)";
  const extra = [rule.data && "data:", rule.blob && "blob:"].filter(Boolean).join(", ");
  const also = extra ? `; also ${extra}` : "";
  if (rule.kind === "anywhere") return `any domain${also}`;
  return `${rule.sources.length ? rule.sources.join(" ") : "nothing ('none')"}${also}`;
}

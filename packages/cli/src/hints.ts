// "Where to look": each segment's median against its layer's limit, with things to check when
// it's over. Browser and server are separate lists, never compared or merged: they come from
// different runs on different clocks. No runtime imports, so `node --test` runs it directly
// (npm run test:hints), like serverblock.ts.
import type { ServerBlock, ServerRow } from "./serverblock.js";
import type { Segment, SegmentKey } from "./types.js";

// Same rounding as audit.ts's median(), kept here so this file has no runtime imports.
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

const CAVEAT = "These limits were written for whole pages or interactions; applying them to one part of the wait is Caliper's reasoning.";
export const DISCLAIMER = "Caliper sees timings, not your code — these are common causes, not a diagnosis.";
const APP_SPAN = "a step your app named; Caliper can't see inside it.";

// The limits and where they come from. None was written for one part of a wait (CAVEAT).
const LIMITS = {
  input: { ms: 200, basis: `Google's INP "good" threshold is 200 ms or less (click → next paint).` },
  server: { ms: 600, basis: `Lighthouse's "Reduce server response time" audit fails above 600 ms.` },
  model: { ms: 450, basis: "MLPerf Inference, interactive scenario: 450 ms time to first token at P99 — a hardware benchmark, not a UX rule." },
  instant: { ms: 100, basis: "Nielsen / RAIL: under 100 ms feels instant." },
};
type Limit = (typeof LIMITS)[keyof typeof LIMITS];

const INP_LINK = "https://web.dev/articles/optimize-inp";
const STREAMS_LINK = "https://developer.mozilla.org/en-US/docs/Web/API/Streams_API";

// Per browser segment: its limit, what a slow value could point to, and where to read more.
// "other" (unattributed) is never hinted: it's the part Caliper couldn't attribute.
const BROWSER: Partial<Record<SegmentKey, { limit: Limit; checks: string[]; links: string[] }>> = {
  click: {
    limit: LIMITS.input,
    checks: [
      "your app's own code between the click and fetch(): validation, state updates, building the request",
      "code loaded only on the first click (a lazy import)",
      "a busy main thread (long tasks) delaying the click handler",
    ],
    links: [INP_LINK, "https://web.dev/optimize-long-tasks/"],
  },
  preflight: {
    limit: LIMITS.instant,
    checks: [
      "a cross-origin API, so the browser sends an OPTIONS request first",
      "no Access-Control-Max-Age on the preflight response, so it isn't cached between requests",
      "a custom header or content type that makes the request need a preflight",
    ],
    links: ["https://developer.mozilla.org/en-US/docs/Glossary/preflight_request"],
  },
  connection: {
    limit: LIMITS.instant,
    checks: [
      "a new connection on a warm run: keep-alive off, or connections closed between requests",
      "DNS, TCP or TLS to a distant server",
      "no preconnect to the API's origin",
    ],
    links: ["https://developer.chrome.com/docs/lighthouse/performance/uses-rel-preconnect"],
  },
  ttfb: {
    limit: LIMITS.server,
    checks: [
      "server work before the headers are sent: auth, data lookups, building the prompt",
      "the server waiting for the model before it sends headers",
      "queueing or a cold start on the server",
      "network distance to the server",
    ],
    links: ["https://web.dev/optimize-ttfb/"],
  },
  download: {
    limit: LIMITS.instant,
    checks: [
      "a reply that isn't streamed, so the whole answer arrives at once",
      "a large response body",
      "a slow network",
    ],
    links: [STREAMS_LINK],
  },
  render: {
    limit: LIMITS.instant,
    checks: [
      "parsing or formatting the response (JSON, markdown) before showing it",
      "rendering after the data arrives (framework updates, layout)",
      "a busy main thread",
    ],
    links: [INP_LINK],
  },
  streaming: {
    limit: LIMITS.instant,
    checks: [
      "headers sent before the first real chunk, so the wait for the reply shows up here",
      "the client buffering chunks before showing them",
      "a proxy or compression buffering the stream",
      "parsing or rendering each chunk",
    ],
    links: [STREAMS_LINK],
  },
};

// Server spans. An app-named span is the app's own step: the same text whatever its name.
// No links: Caliper can't see inside an app's step, and the model's depends on the provider.
const SERVER: Record<"span" | "model", { limit: Limit; about?: string; checks: string[] }> = {
  span: {
    limit: LIMITS.instant,
    about: APP_SPAN,
    checks: [
      "waiting inside this step: network calls, other services, locks",
      "work that runs on every request but could be cached or done earlier",
      "steps running one after another that could run at the same time",
    ],
  },
  model: {
    limit: LIMITS.model,
    checks: [
      "the model provider's time to first token, or queueing at the provider",
      "a long prompt or a large context",
      "the app waiting for more than the first token before its first write",
      "network distance to the model provider",
    ],
  },
};

/** One segment over its limit, with the evidence. Times are ms, rounded. */
export interface Hint {
  label: string;
  median: number;
  limit: number;
  basis: string; // where the limit comes from, ending with CAVEAT
  over: number; // runs (or visits) over the limit
  of: number; // runs (or visits) where it was measured
  measuredNote: string; // " (measured in k of n)" when not in every run, else ""
  unit: "warm runs" | "marked visits";
  share: number | null; // % of that side's total: the median of each run's own share
  shareOf: string; // what share is of, or why there's none
  about?: string; // the app-named span line
  beforeModel?: string; // an app-named span that ended before the model call was sent
  checks: string[];
  links: string[]; // Learn more; none for server spans
  evidence: string; // the full hint's first line
  short: string; // the hint as one line, after the first
  ratio: string; // how far over its limit, e.g. "5.3×"
}
type Measured = Omit<Hint, "evidence" | "short" | "ratio">;

/** One side's hints, biggest median first, or why there are none. */
export interface HintList {
  side: "browser" | "server";
  scope: string; // which runs the medians cover
  hints: Hint[];
  none: string | null; // set when hints is empty
  within: boolean; // measured, and nothing over its limit
  disclaimer: string;
}

// Furthest over its own limit first (median ÷ limit), not the most ms: each layer has its own
// limit. Same ratio: over its limit in more of its runs first, then the bigger median.
const rank = (a: Measured, b: Measured) =>
  b.median / b.limit - a.median / a.limit || b.over / b.of - a.over / a.of || b.median - a.median;

const WITHIN = "Every part is within its limit.";

const list = (side: HintList["side"], scope: string, measured: Measured[], none = WITHIN): HintList => {
  const hints = measured.sort(rank).map((h) => ({ ...h, evidence: evidence(h), short: shortLine(h), ratio: times(h) }));
  return { side, scope, hints, none: hints.length ? null : none, within: !hints.length && none === WITHIN, disclaimer: DISCLAIMER };
};

/** Browser hints from the warm runs (2..N) that were measured: each segment's median over them. */
export function browserHints(warm: { total: number; segments: Segment[] }[]): HintList {
  const scope = warm.length === 1 ? "1 warm run" : `median of ${warm.length} warm runs`;
  if (warm.length === 0) {
    return list("browser", scope, [], "No warm run was measured (runs 2 and later), so there's no median to compare. Use --runs 2 or more.");
  }
  const hints: Measured[] = [];
  for (const [key, layer] of Object.entries(BROWSER) as [SegmentKey, (typeof BROWSER)[SegmentKey] & {}][]) {
    // Each run's value as the terminal prints it (whole ms), so the median is the median of the
    // printed numbers, and its share of that run's total; unknown or absent runs are left out.
    const got = warm.flatMap(({ total, segments }) => {
      const s = (segments as Segment[]).find((seg) => seg.key === key);
      return s && s.ms !== null ? [{ ms: Math.round(s.ms), share: total > 0 ? (s.ms / total) * 100 : null }] : [];
    });
    const m = median(got.map((g) => g.ms));
    if (m === null || m <= layer.limit.ms) continue;
    const label = warm.flatMap((r) => (r.segments as Segment[]).filter((s) => s.key === key))[0]!.label;
    const shares = got.flatMap((g) => (g.share === null ? [] : [g.share]));
    hints.push({
      label,
      median: m,
      limit: layer.limit.ms,
      basis: `${layer.limit.basis} ${CAVEAT}`,
      over: got.filter((g) => g.ms > layer.limit.ms).length,
      of: got.length,
      measuredNote: got.length < warm.length ? ` (measured in ${got.length} of ${warm.length})` : "",
      unit: "warm runs",
      share: median(shares),
      shareOf: "the browser total",
      checks: layer.checks,
      links: layer.links,
    });
  }
  return list("browser", scope, hints);
}

// The row's median over the visits that recorded it: the table's median, or its only value.
const rowMedian = (row: ServerRow) => row.stats?.median ?? row.values.find((v) => v !== null)!;

/** Server hints from the block's spans: app-named spans and model call → first bytes sent. */
export function serverHints(block: ServerBlock): HintList {
  const k = block.visits.length;
  const firstBytes = block.marks.find((r) => r.kind === "mark" && r.name === "firstChunk");
  const hints: Measured[] = [];
  for (const row of block.spans) {
    if (row.kind === "mark") continue;
    const layer = SERVER[row.kind];
    const m = rowMedian(row);
    if (m <= layer.limit.ms) continue;
    const got = row.values.filter((v): v is number => v !== null);
    // Each visit's own share of its time to first bytes sent, then the median.
    const shares = firstBytes
      ? row.values.flatMap((v, i) => (v === null || !firstBytes.values[i] ? [] : [(v / firstBytes.values[i]!) * 100]))
      : [];
    const share = median(shares);
    hints.push({
      label: row.label,
      median: m,
      limit: layer.limit.ms,
      basis: `${layer.limit.basis} ${CAVEAT}`,
      over: got.filter((v) => v > layer.limit.ms).length,
      of: got.length,
      measuredNote: got.length < k ? ` (measured in ${got.length} of ${k})` : "",
      unit: "marked visits",
      share,
      shareOf: share !== null ? "the time to server: first bytes sent" : "server: first bytes sent wasn't recorded, so no share",
      ...(layer.about && { about: layer.about }),
      ...(row.kind === "span" && beforeModelLine(block, row)),
      checks: layer.checks,
      links: [],
    });
  }
  const scope = `${k === 1 ? "1 marked visit" : `median of ${k} marked visits`}, on the server's clock; never compared with the browser`;
  return list("server", scope, hints);
}

// An app-named span that ended at or before modelCallSent, in the visits that recorded both: the
// model call was sent only after all of it. Marks as the table shows them (rounded ms).
function beforeModelLine(block: ServerBlock, row: ServerRow): { beforeModel: string } | Record<string, never> {
  const end = block.marks.find((r) => r.name === `${row.name}End`);
  const sent = block.marks.find((r) => r.name === "modelCallSent");
  if (!end || !sent) return {};
  const both = row.values.flatMap((v, i) => (v === null || end.values[i] == null || sent.values[i] == null ? [] : [{ v, end: end.values[i]!, sent: sent.values[i]! }]));
  const before = both.filter((b) => b.end <= b.sent);
  if (!before.length) return {};
  if (both.length === 1) {
    const [b] = before;
    return { beforeModel: `It ended before the model call was sent (${row.name}End ${b!.end} ms, model call sent ${b!.sent} ms), so all ${b!.v} ms of it came before the model call.` };
  }
  return { beforeModel: `It ended before the model call was sent in ${before.length} of ${both.length} marked visits, so in those visits all of it came before the model call.` };
}

// "median" only when there's more than one value, like the server block.
const value = (h: Measured) => (h.of === 1 ? `${h.median} ms` : `median ${h.median} ms`);

// How far over its limit, e.g. "5.3×". Under 1.1× one more digit, so it never reads "1.0×".
function times(h: Measured): string {
  const ratio = h.median / h.limit;
  return `${ratio.toFixed(ratio < 1.1 ? 2 : 1)}×`;
}

// "<label>: median 532 ms — 5.3× its 100 ms limit, in 3 of 3 marked visits"
const over = (h: Measured) => `${h.label}: ${value(h)} — ${times(h)} its ${h.limit} ms limit, in ${h.over} of ${h.of} ${h.unit}${h.measuredNote}`;

// The full hint's evidence line.
function evidence(h: Measured): string {
  const share = h.share === null ? h.shareOf : `${h.share}% of ${h.shareOf}`;
  return `${over(h)}; ${share}`;
}

// A hint after the first, in one line.
function shortLine(h: Measured): string {
  const more = h.links.length ? ` — learn more: ${h.links.join(" · ")}` : "";
  return `${over(h)}${h.about ? ` — ${h.about}` : ""}${more}`;
}

/** The list as the terminal prints it: the first hint in full, the rest one line each. */
export function formatHints({ side, scope, hints, none }: HintList): string {
  const lines = [`Where to look — ${side} (${scope})`];
  if (none) return [...lines, `    ${none}`].join("\n");
  const [first, ...rest] = hints;
  lines.push(
    `    ${first!.evidence}`,
    ...(first!.about ? [`    ${first!.about}`] : []),
    ...(first!.beforeModel ? [`    ${first!.beforeModel}`] : []),
    `    Limit: ${first!.basis}`,
    "    Things to check:",
    ...first!.checks.map((c) => `      - could be ${c}`),
    ...(first!.links.length ? [`    Learn more: ${first!.links.join(" · ")}`] : []),
    `    ${DISCLAIMER}`,
  );
  if (rest.length) lines.push("  also over their limits:", ...rest.map((h) => `    ${h.short}`));
  return lines.join("\n");
}

// --- The verdict and the bars at the top of the report ---

/**
 * The verdict: the median wait, then one line per side, from its top hint. The sides are never
 * merged or compared. server: null without --server-timings; list null when no visit succeeded.
 */
export function verdictLines({ median, warm, browser, server }: {
  median: number | null;
  warm: number;
  browser: HintList | null;
  server: { list: HintList | null } | null;
}): string[] {
  const side = (name: string, list: HintList | null, why: string) => {
    if (!list || (!list.hints.length && !list.within)) return `${name}: no hints (${why}).`;
    const top = list.hints[0];
    return top ? `${name}: ${top.label} — ${top.ratio} its limit, in ${top.over} of ${top.of} ${top.unit}.` : `${name}: nothing over its limit.`;
  };
  return [
    median === null
      ? "No warm run was measured, so there's no median wait. Use --runs 2 or more."
      : warm === 1
        ? `People waited ${median} ms for the first word in the one warm run.`
        : `People waited a median of ${median} ms for the first word (${warm} warm runs).`,
    side("In the browser", browser, "no warm run was measured"),
    ...(server ? [side("Inside the server", server.list, "no marked visit succeeded")] : []),
  ];
}

// A streaming span shorter than this means the answer arrived in one go.
export const STREAMS_MIN_MS = 250;
const STREAM_FIX = "Fix: stream the response; users see the first word sooner, total time stays the same.";

/** The streaming check's verdict: the streaming span (first word → done) over the settled warm runs, and how many. */
export function streamingVerdict(span: number, settled: number): { status: "pass" | "fail"; verdict: string; fix?: string } {
  const measured = `streaming span ${span} ms (${settled === 1 ? "the one warm run" : `median of ${settled} warm runs`})`;
  return span < STREAMS_MIN_MS
    ? { status: "fail", verdict: `Doesn't stream: users see nothing until the whole answer is ready — ${measured}.`, fix: STREAM_FIX }
    : { status: "pass", verdict: `Streams — ${measured}.` };
}

/** One drawn segment: where it starts and how long it is (ms), and whether it's over its limit. */
export interface BarPart {
  label: string;
  ms: number;
  start: number;
  over: boolean;
  limit: number | null; // null for unattributed time
}

/** One side's bar: a lane per row (spans that overlap go on separate rows). */
export interface Bar {
  title: string;
  total: number; // the axis, ms
  lanes: BarPart[][];
}

// The index of the value nearest the median of values; the smaller value on a tie.
function nearestMedian(values: number[]): { at: number; median: number; exact: boolean } {
  const m = median(values)!;
  let at = 0;
  values.forEach((v, i) => {
    const [d, best] = [Math.abs(v - m), Math.abs(values[at]! - m)];
    if (d < best || (d === best && v < values[at]!)) at = i;
  });
  return { at, median: m, exact: values[at] === m };
}

// With one value there's no median: it's "the one".
const which = (n: number, exact: boolean, what: string, m: number) =>
  n === 1 ? `the one ${what}` : exact ? `the median ${what}` : `the ${what} nearest the median (${m} ms)`;

/** The browser bar: the warm run nearest the median total, its segments in order. */
export function browserBar(warm: { run: number; total: number; segments: Segment[] }[]): Bar | null {
  if (warm.length === 0) return null;
  const { at, median: m, exact } = nearestMedian(warm.map((r) => r.total));
  const { run, total, segments } = warm[at]!;
  const parts: BarPart[] = [];
  let start = 0;
  for (const s of segments as Segment[]) {
    if (s.ms === null || s.key === "other") continue;
    const ms = Math.round(Math.max(0, s.ms));
    const limit = BROWSER[s.key]?.limit.ms ?? null;
    parts.push({ label: s.label, ms, start, over: limit !== null && ms > limit, limit });
    start += ms;
  }
  // What no segment explains (an unknown segment, or no request): drawn, never hinted.
  if (total - start > 0.5) parts.push({ label: "unattributed", ms: Math.round(total - start), start, over: false, limit: null });
  return { title: `Run ${run}, ${which(warm.length, exact, "warm run", m)}: ${total} ms from click to first word`, total, lanes: [parts] };
}

/** The server bar: the visit nearest the median first bytes sent, its spans on rows that don't overlap. */
export function serverBar(block: ServerBlock): Bar | null {
  const mark = (name: string) => block.marks.find((r) => r.name === name);
  const firstBytes = mark("firstChunk");
  // Each visit's axis: first bytes sent, or else the end of its last span.
  const ends = block.visits.map((_, i) => {
    const fb = firstBytes?.values[i];
    if (fb !== undefined && fb !== null) return fb;
    const spanEnds = block.spans.flatMap((s) => {
      const start = mark(s.kind === "model" ? "modelCallSent" : `${s.name}Start`)?.values[i];
      return start != null && s.values[i] != null ? [start + s.values[i]!] : [];
    });
    return spanEnds.length ? Math.max(...spanEnds) : null;
  });
  const known = ends.flatMap((e, i) => (e === null ? [] : [{ e, i }]));
  if (!known.length || !block.spans.length) return null;
  const { at, median: m, exact } = nearestMedian(known.map((k) => k.e));
  const i = known[at]!.i;
  const parts = block.spans
    .flatMap((s) => {
      const start = mark(s.kind === "model" ? "modelCallSent" : `${s.name}Start`)?.values[i];
      const ms = s.values[i];
      if (start == null || ms == null || s.kind === "mark") return [];
      const limit = s.kind === "model" ? LIMITS.model.ms : LIMITS.instant.ms;
      return [{ label: s.label, ms, start, over: ms > limit, limit }];
    })
    .sort((a, b) => a.start - b.start);
  // Each span on the first row where it doesn't overlap the one before.
  const lanes: BarPart[][] = [];
  for (const p of parts) {
    const lane = lanes.find((l) => l.at(-1)!.start + l.at(-1)!.ms <= p.start);
    if (lane) lane.push(p);
    else lanes.push([p]);
  }
  const to = firstBytes?.values[i] != null ? "server: first bytes sent" : "the end of its last span";
  return { title: `Marked visit ${block.visits[i]}, ${which(known.length, exact, "visit", m)}: ${known[at]!.e} ms from arrival to ${to}`, total: known[at]!.e, lanes };
}

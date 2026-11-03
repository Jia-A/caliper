// The "Inside the server" block: a caliper-timings record (SPEC v1) read back and printed.
// No imports, so `node --test` runs it directly (npm run test:serverblock), like loadhints.ts.

// Same rounding as audit.ts's ms() and median(), kept here so this file has no imports.
const ms = (value: number) => Math.round(value);
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

// The marks SPEC v1 reserves, with their labels; every other mark is shown under its own name.
const RESERVED_MARKS: Record<string, string> = {
  modelCallSent: "model call sent",
  firstChunk: "model: first chunk",
};
// SPEC v1: <name>Start and <name>End are one span, <name>, chosen by the app. Only pairs: there's
// no span between two unrelated marks (on Workers that's computation, which the clock doesn't see).
const SPAN_MARK = /^([A-Za-z][A-Za-z0-9_]*)(Start|End)$/;
const MODEL_SPAN = { label: "model: sent → first chunk", from: "modelCallSent", to: "firstChunk" };

type Span = { value: number } | { why: string; reversed?: [end: number, start: number] };

// One visit's <name> span, or why there's none. Never estimated from other marks.
function spanIn(at: Map<string, number>, name: string): Span {
  const start = at.get(`${name}Start`);
  const end = at.get(`${name}End`);
  if (start === undefined) return { why: `${name}Start wasn't recorded` };
  if (end === undefined) return { why: `${name}End wasn't recorded` };
  if (end < start) return { why: `${name}End (${ms(end)} ms) is before ${name}Start (${ms(start)} ms)`, reversed: [end, start] };
  return { value: end - start };
}

// One line for a pair that's no span in some of the k visits: how many, which ones when not all,
// and why: once when every one of them has the same reason, otherwise per visit.
function noSpanLine(name: string, per: Span[], visits: { visit: number }[]): string[] {
  const broken = per.flatMap((s, i) => ("why" in s ? [{ visit: visits[i]!.visit, ...s }] : []));
  if (broken.length === 0) return [];
  const k = visits.length;
  if (k === 1) return [`    no ${name} span: ${broken[0]!.why}`];
  const which = broken.length < k ? ` (${broken.map((b) => b.visit).join(", ")})` : "";
  const why =
    broken.every((b) => b.why === broken[0]!.why) ? broken[0]!.why
    : broken.every((b) => b.reversed) ? `${name}End is before ${name}Start (${broken.map((b) => `visit ${b.visit}: ${name}End ${ms(b.reversed![0])} ms, ${name}Start ${ms(b.reversed![1])} ms`).join(" · ")})`
    : broken.map((b) => `visit ${b.visit}: ${b.why}`).join(" · ");
  return [`    no ${name} span in ${broken.length} of ${k} visits${which}: ${why}`];
}

// A problem is the server's own text: control characters (terminal escapes, newlines) are shown
// escaped, and it's cut at 200 characters.
function shown(problem: string): string {
  const safe = problem.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return safe.length > 200 ? `${safe.slice(0, 200)}…` : safe;
}

/** One run's record from the wrapper: its marks (ms after the request reached the route). */
export interface ServerRecord {
  status: number | null;
  runtime: unknown;
  at: Map<string, number>;
  problems: string[]; // what the wrapper reports it skipped or couldn't do (SPEC v1)
}

// The wrapper's record for one run, or why it can't be used: not the expected shape, another
// run's record, a mark that isn't a number, or problems that aren't a list of strings.
export function parseServerRecord(record: unknown, runId: string): ServerRecord | string {
  const r = record as { id?: unknown; status?: unknown; runtime?: unknown; marks?: unknown; problems?: unknown } | null;
  if (typeof r !== "object" || r === null || typeof r.marks !== "object" || r.marks === null) {
    return `the record for run ${runId} has no marks object.`;
  }
  if (r.id !== runId) return `the record fetched for run ${runId} is for run ${JSON.stringify(r.id)}.`;
  const marks = Object.entries(r.marks as Record<string, unknown>);
  const bad = marks.find(([, v]) => typeof v !== "number" || !Number.isFinite(v));
  if (bad) return `the record for run ${runId} has a mark that isn't a number: ${bad[0]} = ${JSON.stringify(bad[1])}.`;
  const problems = r.problems ?? [];
  if (!Array.isArray(problems) || !problems.every((p) => typeof p === "string")) {
    return `the record for run ${runId} has a problems field that isn't a list of strings.`;
  }
  return { status: typeof r.status === "number" ? r.status : null, runtime: r.runtime, at: new Map(marks as [string, number][]), problems };
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The "Inside the server" block from the k visits that succeeded out of n: every recorded mark
// as recorded, in the order they happened, then the spans (each <name>Start / <name>End pair, and
// model: sent → first chunk), each computed inside a visit from its own two marks, and why a pair
// is no span. With one visit, its values; with more, one column per visit ("–" where it didn't
// record that mark or span), then min · median · max over the visits that did (only with two or
// more). Medians of marks are never subtracted from each other. The Workers note when a record
// says runtime "workers"; Caliper doesn't guess the server's runtime.
export function formatServerBlock(visits: { visit: number; record: ServerRecord }[], n: number): string {
  const k = visits.length;
  const statuses = visits.map((v) => v.record.status);
  const status =
    statuses.every((x) => x === null) ? ""
    : statuses.every((x) => x === statuses[0]) ? `, status ${statuses[0]}`
    : `, status per visit: ${statuses.map((x) => x ?? "?").join(", ")}`;

  const row = (label: string, values: (number | null)[], note?: string) => {
    const tail = note ? `   (${note})` : "";
    if (k === 1) return `    ${label.padEnd(26)}${String(ms(values[0]!)).padStart(6)} ms${tail}`;
    const cells = values.map((v) => (v === null ? "–" : String(ms(v))).padStart(6)).join("");
    const got = values.filter((v): v is number => v !== null);
    const stats = got.length > 1 ? `   min ${ms(Math.min(...got))} · median ${median(got)} · max ${ms(Math.max(...got))}` : "";
    return `    ${label.padEnd(26)}${cells}${stats} ms${tail}`;
  };
  const markValues = (name: string) => visits.map((v) => v.record.at.get(name) ?? null);
  // By median across visits; the sort is stable, so ties keep the record's order.
  const middle = (name: string) => median(markValues(name).filter((v): v is number => v !== null))!;
  const marks = [...new Set(visits.flatMap((v) => [...v.record.at.keys()]))].sort((a, b) => middle(a) - middle(b));
  const names = [...new Set(marks.map((mark) => SPAN_MARK.exec(mark)?.[1]).filter((x): x is string => x !== undefined))];
  const pairs = names.map((name) => ({ name, per: visits.map(({ record: { at } }) => spanIn(at, name)) }));
  const spans = [
    ...pairs.map(({ name, per }) => ({ label: name, from: `${name}Start`, note: `${name}Start → ${name}End`, values: per.map((s) => ("value" in s ? s.value : null)) })),
    { ...MODEL_SPAN, note: undefined, values: visits.map(({ record: { at } }) => (at.has(MODEL_SPAN.from) && at.has(MODEL_SPAN.to) ? at.get(MODEL_SPAN.to)! - at.get(MODEL_SPAN.from)! : null)) },
  ].filter((s) => s.values.some((v) => v !== null)).sort((a, b) => middle(a.from) - middle(b.from));
  const noSpan = pairs.flatMap(({ name, per }) => noSpanLine(name, per, visits));
  // Each distinct problem once, in the order first reported, with the visits that reported it.
  const problems = [...new Set(visits.flatMap((v) => v.record.problems))].map((p) => {
    const from = visits.filter((v) => v.record.problems.includes(p)).map((v) => v.visit);
    const tail = k === 1 ? "" : from.length === k ? `   (${k} of ${k} visits)` : `   (${from.length} of ${k} visits: ${from.join(", ")})`;
    return `    ${shown(p)}${tail}`;
  });

  return [
    `Inside the server (from ${k} of ${plural(n, "marked run")}) — ms after the request arrived${status}`,
    ...(k > 1 ? [`    ${"marked visit".padEnd(26)}${visits.map((v) => String(v.visit).padStart(6)).join("")}`] : []),
    ...(marks.length === 0 ? ["    (no marks recorded)"] : []),
    ...marks.map((name) => row(RESERVED_MARKS[name] ?? name, markValues(name), name === "firstChunk" ? "at the server, not the browser" : undefined)),
    ...(spans.length || noSpan.length ? ["  spans", ...spans.map((s) => row(s.label, s.values, s.note)), ...noSpan] : []),
    ...(visits.some((v) => v.record.runtime === "workers") ? ["    Workers time waits only — a span with only computation inside (no I/O) can read 0 ms."] : []),
    ...(problems.length ? ["  problems reported by the server", ...problems] : []),
  ].join("\n");
}

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
// firstChunk is the server's first write with bytes, which may come before the model's reply.
const RESERVED_MARKS: Record<string, string> = {
  modelCallSent: "model call sent",
  firstChunk: "server: first bytes sent",
};
// SPEC v1: <name>Start and <name>End are one span, <name>, chosen by the app. Only pairs: there's
// no span between two unrelated marks (on Workers that's computation, which the clock doesn't see).
const SPAN_MARK = /^([A-Za-z][A-Za-z0-9_]*)(Start|End)$/;
const MODEL_SPAN = { label: "model call → first bytes sent", from: "modelCallSent", to: "firstChunk" };
const LABEL_WIDTH = 32; // fits "model call → first bytes sent"

const WORKERS_NOTE = "Workers time waits only — a span with only computation inside (no I/O) can read 0 ms.";
const FIRST_BYTES_NOTE =
  "first bytes sent = the server's first write to the browser. If your app writes anything before the model's reply (a heartbeat, an envelope), this is that write.";

type Span = { value: number } | { why: string; reversed?: [end: number, start: number] };

// Prompt sizes (caliper-timings 0.2.0, run.prompt): each message's role and UTF-8 bytes, never its
// text. A role that isn't a lowercase name (or the wrapper's "?") could be text, so it's never shown.
const ROLE = /^([a-z][a-z_]{0,31}|\?)$/;
const SIZES_NOTE = "UTF-8 bytes of each message's text as your app passed it to run.prompt(); not tokens";
const NO_SIZES = "prompt sizes: none recorded (needs caliper-timings 0.2.0 or later, and run.prompt(messages) before the model call)";

/** One message of the prompt: its role and size, or null when the server couldn't measure it. */
export interface PromptSize {
  role: string;
  bytes: number | null;
  parts?: PromptPart[] | { unreadable: string }; // the app's named parts (caliper-timings 0.4.0)
}

/** A named part of a message: its size, and whether the server found its text inside the message. */
export interface PromptPart {
  name: string;
  bytes: number | null;
  found: boolean | null;
  source: PartSource | null; // who wrote it, as the app labelled it (caliper-timings 0.6.0); null when it didn't
}
export type PartSource = "app" | "user" | "outside";
const SOURCES: readonly unknown[] = ["app", "user", "outside"];

// A message's parts, or why they can't be shown. Only that message's parts: its size stands.
function parseParts(parts: unknown): PromptPart[] | { unreadable: string } {
  if (!Array.isArray(parts)) return { unreadable: "parts isn't a list" };
  const out: PromptPart[] = [];
  for (const [j, p] of parts.entries()) {
    if (typeof p !== "object" || p === null) return { unreadable: `part ${j + 1} isn't { name, bytes, found }` };
    const { name, bytes, found, source } = p as { name?: unknown; bytes?: unknown; found?: unknown; source?: unknown };
    if (typeof name !== "string" || !ROLE.test(name)) return { unreadable: `part ${j + 1}'s name isn't a lowercase name of up to 32 letters or _ (or "?")` };
    if (bytes !== null && !(Number.isInteger(bytes) && (bytes as number) >= 0)) return { unreadable: `part ${j + 1}'s bytes isn't a whole number ≥ 0 or null` };
    if (found !== true && found !== false && found !== null) return { unreadable: `part ${j + 1}'s found isn't true, false or null` };
    // Never shown when it's anything else: it could be text.
    if (source !== undefined && !SOURCES.includes(source)) return { unreadable: `part ${j + 1}'s source isn't "app", "user" or "outside"` };
    out.push({ name, bytes: bytes as number | null, found, source: (source ?? null) as PartSource | null });
  }
  return out;
}

// The record's prompt sizes, or why they can't be shown. Never fails the record: the timings stand.
function parsePrompt(prompt: unknown): PromptSize[] | { unreadable: string } {
  const messages = (prompt as { messages?: unknown } | null)?.messages;
  if (typeof prompt !== "object" || prompt === null || !Array.isArray(messages)) return { unreadable: "the prompt field isn't { messages: [...] }" };
  const sizes: PromptSize[] = [];
  for (const [i, m] of messages.entries()) {
    if (typeof m !== "object" || m === null) return { unreadable: `message ${i + 1} isn't { role, bytes }` };
    const { role, bytes, parts } = m as { role?: unknown; bytes?: unknown; parts?: unknown };
    if (typeof role !== "string" || !ROLE.test(role)) return { unreadable: `message ${i + 1}'s role isn't a lowercase name of up to 32 letters or _ (or "?"), so the prompt isn't shown` };
    if (bytes !== null && !(Number.isInteger(bytes) && (bytes as number) >= 0)) return { unreadable: `message ${i + 1}'s bytes isn't a whole number ≥ 0 or null` };
    sizes.push({ role, bytes: bytes as number | null, ...(parts !== undefined && { parts: parseParts(parts) }) });
  }
  return sizes;
}

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
  if (k === 1) return [`no ${name} span: ${broken[0]!.why}`];
  const which = broken.length < k ? ` (${broken.map((b) => b.visit).join(", ")})` : "";
  const why =
    broken.every((b) => b.why === broken[0]!.why) ? broken[0]!.why
    : broken.every((b) => b.reversed) ? `${name}End is before ${name}Start (${broken.map((b) => `visit ${b.visit}: ${name}End ${ms(b.reversed![0])} ms, ${name}Start ${ms(b.reversed![1])} ms`).join(" · ")})`
    : broken.map((b) => `visit ${b.visit}: ${b.why}`).join(" · ");
  return [`no ${name} span in ${broken.length} of ${k} visits${which}: ${why}`];
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
  prompt: PromptSize[] | { unreadable: string } | null; // null when the record has none
}

// The wrapper's record for one run, or why it can't be used: not the expected shape, another
// run's record, a mark that isn't a number, or problems that aren't a list of strings.
export function parseServerRecord(record: unknown, runId: string): ServerRecord | string {
  const r = record as { id?: unknown; status?: unknown; runtime?: unknown; marks?: unknown; problems?: unknown; prompt?: unknown } | null;
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
  const prompt = r.prompt === undefined ? null : parsePrompt(r.prompt);
  return { status: typeof r.status === "number" ? r.status : null, runtime: r.runtime, at: new Map(marks as [string, number][]), problems, prompt };
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One row of the block, a mark or a span: each visit's value (null where it wasn't recorded). */
export interface ServerRow {
  kind: "mark" | "span" | "model"; // a mark, an app-named span, or model call → first bytes sent
  name: string; // the mark's or the span's own name ("model" for the model span)
  label: string;
  values: (number | null)[]; // rounded, one per visit
  stats: { min: number; median: number; max: number } | null; // only with two or more values
  note?: string;
}

/** The "Inside the server" block, shared by the terminal and the HTML report. */
export interface ServerBlock {
  title: string;
  visits: number[]; // the visit numbers, one column each
  marks: ServerRow[];
  spans: ServerRow[];
  noSpan: string[]; // one line per pair that's no span in some visit
  workers: string | null; // the note, when a record says runtime "workers"
  firstBytes: string | null; // what "first bytes sent" means, when a visit recorded firstChunk
  problems: string[]; // each distinct problem once, with the visits that reported it
  prompt: PromptView;
}

// The visits whose prompt sizes are compared: those with the same messages (count and roles) as
// the first one that recorded any. The rest each get a line: none recorded, different messages,
// or unreadable.
interface PromptBlock {
  compared: { visit: number; messages: PromptSize[] }[];
  lines: string[];
  none: boolean; // no visit recorded a prompt at all
}

/** What the marked visits printed, in order, and the block from the visits that succeeded. */
export interface ServerReport {
  lines: string[]; // the pre-check, visit and "?" lines, as printed
  block: ServerBlock | null; // null when no visit succeeded
}

// The "Inside the server" block from the k visits that succeeded out of n: every recorded mark
// as recorded, in the order they happened, then the spans (each <name>Start / <name>End pair, and
// model call → first bytes sent), each computed inside a visit from its own two marks, and why a
// pair is no span. Each row has one value per visit (null where it didn't record that mark or
// span), then min · median · max over the visits that did (only with two or more). Medians of
// marks are never subtracted from each other. The Workers note when a record says runtime
// "workers"; Caliper doesn't guess the server's runtime.
export function serverBlock(visits: { visit: number; record: ServerRecord }[], n: number): ServerBlock {
  const k = visits.length;
  const statuses = visits.map((v) => v.record.status);
  const status =
    statuses.every((x) => x === null) ? ""
    : statuses.every((x) => x === statuses[0]) ? `, status ${statuses[0]}`
    : `, status per visit: ${statuses.map((x) => x ?? "?").join(", ")}`;

  const row = (kind: ServerRow["kind"], name: string, label: string, values: (number | null)[], note?: string): ServerRow => {
    const got = values.filter((v): v is number => v !== null);
    return {
      kind,
      name,
      label,
      values: values.map((v) => (v === null ? null : ms(v))),
      stats: got.length > 1 ? { min: ms(Math.min(...got)), median: median(got)!, max: ms(Math.max(...got)) } : null,
      ...(note && { note }),
    };
  };
  const markValues = (name: string) => visits.map((v) => v.record.at.get(name) ?? null);
  // By median across visits; the sort is stable, so ties keep the record's order.
  const middle = (name: string) => median(markValues(name).filter((v): v is number => v !== null))!;
  const marks = [...new Set(visits.flatMap((v) => [...v.record.at.keys()]))].sort((a, b) => middle(a) - middle(b));
  const names = [...new Set(marks.map((mark) => SPAN_MARK.exec(mark)?.[1]).filter((x): x is string => x !== undefined))];
  const pairs = names.map((name) => ({ name, per: visits.map(({ record: { at } }) => spanIn(at, name)) }));
  const spans = [
    ...pairs.map(({ name, per }) => ({ kind: "span" as const, name, label: name, from: `${name}Start`, note: `${name}Start → ${name}End`, values: per.map((s) => ("value" in s ? s.value : null)) })),
    { ...MODEL_SPAN, kind: "model" as const, name: "model", note: undefined, values: visits.map(({ record: { at } }) => (at.has(MODEL_SPAN.from) && at.has(MODEL_SPAN.to) ? at.get(MODEL_SPAN.to)! - at.get(MODEL_SPAN.from)! : null)) },
  ].filter((s) => s.values.some((v) => v !== null)).sort((a, b) => middle(a.from) - middle(b.from));
  // Each distinct problem once, in the order first reported, with the visits that reported it.
  const problems = [...new Set(visits.flatMap((v) => v.record.problems))].map((p) => {
    const from = visits.filter((v) => v.record.problems.includes(p)).map((v) => v.visit);
    const tail = k === 1 ? "" : from.length === k ? `   (${k} of ${k} visits)` : `   (${from.length} of ${k} visits: ${from.join(", ")})`;
    return `${shown(p)}${tail}`;
  });

  return {
    title: `Inside the server (from ${k} of ${plural(n, "marked run")}) — ms after the request arrived${status}`,
    visits: visits.map((v) => v.visit),
    marks: marks.map((name) => row("mark", name, RESERVED_MARKS[name] ?? name, markValues(name))),
    spans: spans.map((s) => row(s.kind, s.name, s.label, s.values, s.note)),
    noSpan: pairs.flatMap(({ name, per }) => noSpanLine(name, per, visits)),
    workers: visits.some((v) => v.record.runtime === "workers") ? WORKERS_NOTE : null,
    firstBytes: visits.some((v) => v.record.at.has("firstChunk")) ? FIRST_BYTES_NOTE : null,
    problems,
    prompt: promptView(promptBlock(visits)),
  };
}

function promptBlock(visits: { visit: number; record: ServerRecord }[]): PromptBlock {
  const recorded = visits.flatMap(({ visit, record: { prompt } }) => (Array.isArray(prompt) ? [{ visit, messages: prompt }] : []));
  const roles = (m: PromptSize[]) => m.map((x) => x.role).join(" ");
  const partNames = (m: PromptSize) => (m.parts === undefined ? "" : Array.isArray(m.parts) ? `[${m.parts.map((p) => p.name).join(" ")}]` : "[?]");
  const shape = (m: PromptSize[]) => m.map((x) => `${x.role}${partNames(x)}`).join(" ");
  const first = recorded[0];
  const compared = recorded.filter((r) => shape(r.messages) === shape(first!.messages));
  const anyRecorded = visits.some((v) => v.record.prompt !== null);
  return {
    compared,
    lines: visits.flatMap(({ visit, record: { prompt } }) => {
      if (prompt === null) return anyRecorded ? [`prompt sizes: none recorded in marked visit ${visit}`] : [];
      if (!Array.isArray(prompt)) return [`prompt sizes ? — marked visit ${visit}: ${prompt.unreadable}`];
      if (compared.some((c) => c.visit === visit)) return [];
      if (roles(prompt) === roles(first!.messages)) return [`prompt sizes: marked visit ${visit} named different parts, so it isn't compared`];
      return [`prompt sizes: marked visit ${visit} sent different messages (${prompt.length}: ${prompt.map((m) => m.role).join(", ")}), so it isn't compared`];
    }),
    none: !anyRecorded,
  };
}

/** Who wrote a row's text: a source and how it's known, or each visit's when they differ ("mixed"). */
export interface RowSource {
  kind: PartSource | "unknown" | "mixed";
  word: string; // "user"; for mixed, the whole text with the visits
  note: string; // "labelled by app", "not labelled", "no parts named"; "" for mixed
}

/** One row of the prompt sizes: a message (or the total), one of its named parts, or a note under them. */
export interface PromptRow {
  kind: "message" | "part" | "note";
  label: string; // for a note, the whole line
  values: string[]; // one per column: bytes, or "–"
  stats: [min: number, median: number, max: number] | null;
  tail: string; // the share, or why there's no size
  source?: RowSource; // only when the prompt has named parts; none on a message with parts, or the total
}

/** Prompt sizes as shown, shared by the terminal and the HTML report. */
export interface PromptView {
  heading: string | null; // "prompt sizes (marked visit 1)", null when no visit's sizes can be shown
  note: string;
  visits: number[]; // one column each; a single column when one visit, or all the same
  rows: PromptRow[];
  legend: string | null; // what source means; only when the prompt has named parts
  unlabelled: string | null; // the parts with no source, and how to label them
  none: string | null; // the line when no visit recorded a prompt
  lines: string[]; // a visit with none, different messages or parts, or unreadable sizes
}

const listed = (visits: number[]) => visits.join(", ");
const inVisits = (visits: number[]) => `in marked visit${visits.length > 1 ? "s" : ""} ${listed(visits)}`;

const NOT_FOUND = (n: number) => `not found in message ${n} (the text given isn't in it)`;
const NOT_MEASURED_PART = "not measured (its text wasn't a string)";
const NOT_CHECKED = "not checked (the server couldn't compare it with the message)";
const LEGEND = "source = who wrote the text, as your app labelled it: app (your own text), user (the person using the feature), outside (anyone else), unknown (not labelled)";
const UNKNOWN = (note: string): RowSource => ({ kind: "unknown", word: "unknown", note });
const sourceOf = (source: PartSource | null): RowSource => (source ? { kind: source, word: source, note: "labelled by app" } : UNKNOWN("not labelled"));

// One column: each message's bytes and its share of the measured total (none when the total is
// 0), its named parts under it, then the total, labelled with how many were measured when not all
// were. Several visits with different sizes: a column per visit, min · median · max per row, and
// no share.
function promptView({ compared, lines, none }: PromptBlock): PromptView {
  const view: PromptView = { heading: null, note: SIZES_NOTE, visits: [], rows: [], legend: null, unlabelled: null, none: none ? NO_SIZES : null, lines };
  if (none || compared.length === 0) return view;
  const all = compared.map((c) => c.visit);
  const sameParts = (a: PromptSize["parts"], b: PromptSize["parts"]) => JSON.stringify(a) === JSON.stringify(b);
  const same = compared.every((c) => c.messages.every((m, i) => m.bytes === compared[0]!.messages[i]!.bytes && sameParts(m.parts, compared[0]!.messages[i]!.parts)));
  const shown = same ? [compared[0]!] : compared; // the columns
  const many = shown.length > 1;
  const roles = compared[0]!.messages.map((m) => m.role);
  const heading = !many ? (all.length === 1 ? `prompt sizes (marked visit ${all[0]})` : `prompt sizes (the same in marked visits ${listed(all)})`) : `prompt sizes (marked visits ${listed(all)})`;
  if (roles.length === 0) return { ...view, heading };
  const totals = shown.map((c) => c.messages.reduce((a, m) => a + (m.bytes ?? 0), 0));
  const stats = (values: (number | null)[]) => {
    const got = values.filter((v): v is number => v !== null);
    return many && got.length > 1 ? ([Math.min(...got), median(got)!, Math.max(...got)] as [number, number, number]) : null;
  };
  const cells = (values: (number | null)[]) => values.map((v) => (v === null ? "–" : String(v)));
  // A tail per column's status: the same reason in every column, or each reason with its visits.
  const tailOf = (statuses: string[]) => {
    const reasons = [...new Set(statuses.filter(Boolean))];
    if (!many || reasons.length === 0) return reasons[0] ?? "";
    // "not found in message 2 in marked visit 3 (the text given isn't in it)": the visits before the reason in brackets.
    const where = (r: string, w: string) => (r.includes(" (") ? `${r.slice(0, r.indexOf(" ("))} ${w}${r.slice(r.indexOf(" ("))}` : `${r} ${w}`);
    return reasons.map((r) => (statuses.every((s) => s === r) ? r : where(r, inVisits(shown.filter((_, k) => statuses[k] === r).map((c) => c.visit))))).join("; ");
  };
  const share = (bytes: number) => (!many && totals[0]! > 0 ? `${Math.round((bytes / totals[0]!) * 100)}%` : "");
  const note = (label: string): PromptRow => ({ kind: "note", label, values: [], stats: null, tail: "" });
  // Sources only when some message has named parts: then every part, rest and unnamed message has one.
  const sources = shown.some((c) => c.messages.some((m) => m.parts !== undefined));
  const unlabelled: string[] = [];
  // Each visit's source for a part: one when they agree, else each with the visits that had it.
  const sourceAcross = (each: PromptPart[]): RowSource => {
    const texts = each.map((q) => sourceOf(q.source)).map((x) => ({ x, text: `${x.word} (${x.note})` }));
    if (texts.every((t) => t.text === texts[0]!.text)) return texts[0]!.x;
    const groups = [...new Set(texts.map((t) => t.text))];
    return { kind: "mixed", word: groups.map((g) => `${g} ${inVisits(shown.filter((_, k) => texts[k]!.text === g).map((c) => c.visit))}`).join("; "), note: "" };
  };

  const partRows = (i: number): PromptRow[] => {
    const n = i + 1;
    const parts = shown.map((c) => c.messages[i]!.parts);
    if (parts[0] === undefined) return [];
    if (!Array.isArray(parts[0])) return [note(`parts ? — ${parts[0].unreadable}`)];
    const rows: PromptRow[] = parts[0].map((p, j) => {
      const each = parts.map((ps) => (ps as PromptPart[])[j]!);
      const values = each.map((q) => (q.found === false || q.bytes === null ? null : q.bytes));
      const statuses = each.map((q) => (q.found === false ? NOT_FOUND(n) : q.bytes === null ? NOT_MEASURED_PART : q.found === null ? NOT_CHECKED : ""));
      if (each.some((q) => q.source === null)) unlabelled.push(p.name);
      return { kind: "part", label: p.name, values: cells(values), stats: stats(values), tail: tailOf(statuses), source: sourceAcross(each) };
    });
    // The rest of the message: only when every part was found and they fit inside it.
    const rests = shown.map((c) => {
      const m = c.messages[i]!;
      const ps = m.parts as PromptPart[];
      if (!ps.every((q) => q.found === true && q.bytes !== null)) return { why: "not every part was found in it" };
      if (m.bytes === null) return { why: "the message's size wasn't measured" };
      const sum = ps.reduce((a, q) => a + q.bytes!, 0);
      return sum > m.bytes ? { why: `the parts add up to ${sum} bytes, more than the message (they overlap or repeat)` } : { rest: m.bytes - sum };
    });
    if (rests.every((r) => "rest" in r)) {
      const values = rests.map((r) => (r as { rest: number }).rest);
      rows.push({ kind: "part", label: `rest of message ${n}`, values: cells(values), stats: stats(values), tail: "", source: UNKNOWN("not labelled") });
    } else {
      const whys = [...new Set(rests.flatMap((r) => ("why" in r ? [r.why] : [])))];
      const where = many ? ` ${inVisits(shown.filter((_, k) => "why" in rests[k]!).map((c) => c.visit))}` : "";
      rows.push(note(`no rest of message ${n}${where}: ${whys.join("; ")}`));
    }
    return rows;
  };

  const anyNull = shown.some((c) => c.messages.some((m) => m.bytes === null));
  const measured = shown[0]!.messages.filter((m) => m.bytes !== null).length;
  const rows: PromptRow[] = [
      ...roles.flatMap((role, i) => {
        const values = shown.map((c) => c.messages[i]!.bytes);
        const statuses = values.map((v) => (v === null ? "not measured (content wasn't a string)" : ""));
        const message: PromptRow = { kind: "message", label: `${i + 1} ${role}`, values: cells(values), stats: stats(values), tail: many ? tailOf(statuses) : values[0] === null ? statuses[0]! : share(values[0]!) };
        if (sources && shown.every((c) => c.messages[i]!.parts === undefined)) message.source = UNKNOWN("no parts named");
        return [message, ...partRows(i)];
      }),
      {
        kind: "message",
        label: many ? (anyNull ? "total (measured only)" : "total") : measured < roles.length ? `total (${measured} of ${roles.length} measured)` : "total",
        values: totals.map(String),
        stats: stats(totals),
        tail: "",
      },
  ];
  const fix = unlabelled.length
    ? `${unlabelled.length} part${unlabelled.length > 1 ? "s" : ""} not labelled (${unlabelled.join(", ")}): add source: "app", "user" or "outside" to each in run.prompt() — needs caliper-timings 0.6.0; see its README, "Choosing a source"`
    : null;
  return { ...view, heading, visits: shown.map((c) => c.visit), rows, legend: sources ? LEGEND : null, unlabelled: fix };
}

function promptLines({ heading, note, visits, rows, legend, unlabelled, none, lines }: PromptView): string[] {
  if (none) return [`  ${none}`];
  const sourceText = (s: RowSource) => `   source: ${s.word}${s.note ? ` (${s.note})` : ""}`;
  const row = ({ kind, label, values, stats, tail, source }: PromptRow) => {
    if (kind === "note") return `        ${label}`;
    const head = kind === "part" ? `        ${label.padEnd(LABEL_WIDTH - 4)}` : `    ${label.padEnd(LABEL_WIDTH)}`;
    return `${head}${values.map((v) => v.padStart(6)).join("")}${stats ? `   min ${stats[0]} · median ${stats[1]} · max ${stats[2]}` : ""} bytes${tail ? `   ${tail}` : ""}${source ? sourceText(source) : ""}`;
  };
  return [
    ...(heading ? [
      `  ${heading} — ${note}`,
      ...(legend ? [`    ${legend}`] : []),
      ...(visits.length > 1 ? [`    ${"marked visit".padEnd(LABEL_WIDTH)}${visits.map((v) => String(v).padStart(6)).join("")}`] : []),
      ...(rows.length ? rows.map(row) : ["    no messages"]),
      ...(unlabelled ? [`    ${unlabelled}`] : []),
    ] : []),
    ...lines.map((l) => `  ${l}`),
  ];
}

// The block as the terminal prints it. With one visit, its values; with more, one column per
// visit ("–" where it didn't record that mark or span), then min · median · max.
export function formatServerBlock({ title, visits, marks, spans, noSpan, workers, firstBytes, problems, prompt }: ServerBlock): string {
  const line = ({ label, values, stats, note }: ServerRow) => {
    const tail = note ? `   (${note})` : "";
    if (visits.length === 1) return `    ${label.padEnd(LABEL_WIDTH)}${String(values[0]).padStart(6)} ms${tail}`;
    const cells = values.map((v) => (v === null ? "–" : String(v)).padStart(6)).join("");
    const summary = stats ? `   min ${stats.min} · median ${stats.median} · max ${stats.max}` : "";
    return `    ${label.padEnd(LABEL_WIDTH)}${cells}${summary} ms${tail}`;
  };
  return [
    title,
    ...(visits.length > 1 ? [`    ${"marked visit".padEnd(LABEL_WIDTH)}${visits.map((v) => String(v).padStart(6)).join("")}`] : []),
    ...(marks.length === 0 ? ["    (no marks recorded)"] : []),
    ...marks.map(line),
    ...(spans.length || noSpan.length ? ["  spans", ...spans.map(line), ...noSpan.map((l) => `    ${l}`)] : []),
    ...(workers ? [`    ${workers}`] : []),
    ...promptLines(prompt),
    ...(problems.length ? ["  problems reported by the server", ...problems.map((p) => `    ${p}`)] : []),
    ...(firstBytes ? [`  ${firstBytes}`] : []),
  ].join("\n");
}

// Self-contained HTML timeline for an audit: inline CSS/JS, no external requests.

import type { Bar, BarPart, Hint, HintList } from "./hints.js";
import type { PromptView, ServerReport, ServerRow } from "./serverblock.js";
import type {
  Breakdown,
  CanaryReport,
  CheckReport,
  CheckStatus,
  CspReport,
  DoubleReport,
  Measure,
  Segment,
  SegmentKey,
  StopReport,
  Summary,
  SummaryEntry,
} from "./types.js";

/** A run's first body byte and pre-reply changes, in ms after the click or send. */
export interface ReportReply {
  firstByte: number | null;
  preReply: { at: number; text: string }[];
}

export type ReportRun = Breakdown & { run: number; total: number; reply: ReportReply }; // run: 1-based number, 1 = cold

export interface ReportInput {
  url: string;
  measure: Measure | undefined; // undefined for a chat run sent with Enter
  chat: { input: string; prompt: string } | null; // null without --input
  output: string;
  steps: string[];
  startedAt: Date;
  summary: Summary | null; // null when no run was measured
  runs: ReportRun[]; // the runs whose page loaded
  failed: number[]; // run numbers whose page failed to load
  unidentified: number[]; // run numbers whose AI request wasn't identified
  stop: (StopReport & { pattern: string }) | null; // null without --stop
  double: DoubleReport | null; // null without --double
  canary: (CanaryReport & { input: string | undefined }) | null; // null without --canary
  csp: CspReport | null; // null without --csp or --canary
  streaming: CheckReport;
  checks: SummaryEntry[]; // every check that ran, in summary order
  server: ServerReport | null; // null without --server-timings
  hints: { browser: HintList | null; server: HintList | null }; // browser: null with no run measured; server: null without a server block
  verdict: string[]; // the median wait, then one line per side (hints.ts verdictLines)
  bars: { browser: Bar | null; server: Bar | null }; // null when there's nothing to draw
}

// The button by name (as the regex it's matched with), or the CSS selector.
const measureHtml = (m: Measure) =>
  "name" in m ? `button <code>${esc(String(new RegExp(m.name, "i")))}</code>` : `selector <code>${esc(m.selector)}</code>`;

/** A segment as drawn: known, non-negative width. */
type BarSegment = Segment & { ms: number };
type ChartRun = ReportRun & { bars: BarSegment[] };

// Stack order, legend order and table column order. Colors are validated so every pair that
// can sit next to each other in a bar stays distinguishable (incl. color-vision deficiency).
const SEGMENTS: { key: SegmentKey; legend: string }[] = [
  { key: "click", legend: "click → fetch() called / request sent" },
  { key: "preflight", legend: "CORS preflight" },
  { key: "connection", legend: "connection setup" },
  { key: "ttfb", legend: "browser: response headers received" },
  { key: "download", legend: "headers → done" },
  { key: "render", legend: "done → first paint" },
  { key: "streaming", legend: "headers → first paint (streaming)" },
  { key: "other", legend: "unattributed" },
];

// Top to bottom: the verdict; each side's bar and where to look (browser, then the server, never
// merged); the checks; then everything else in a collapsed Details.
export function renderReport({ url, measure, chat, output, steps, startedAt, summary, runs, failed, unidentified, stop, double, canary, csp, streaming, checks, server, hints, verdict, bars }: ReportInput): string {
  const timeline: ChartRun[] = runs.map((run) => ({ ...run, bars: barSegments(run) }));
  const scale = Math.max(...runs.map((r) => r.total), 1);
  const ticks = niceTicks(scale);
  const used = SEGMENTS.filter((s) => timeline.some((run) => run.bars.some((b) => b.key === s.key)));
  const tableKeys = SEGMENTS.filter((s) => runs.some((run) => run.segments.some((b) => b.key === s.key)));
  const [headline, ...sides] = verdict;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Caliper — time to first painted output</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <header>
    <h1>Caliper — time to first painted output</h1>
    <dl class="meta">
      <dt>URL</dt><dd class="wrap">${esc(url)}</dd>
      ${chat
        ? `<dt>Prompt</dt><dd class="wrap">${esc(JSON.stringify(chat.prompt))} typed into <code>${esc(chat.input)}</code></dd>
      <dt>Sent with</dt><dd>${measure ? measureHtml(measure) : `Enter in <code>${esc(chat.input)}</code>`}</dd>`
        : `<dt>Measured button</dt><dd>${measureHtml(measure!)}</dd>`}
      ${steps.length ? `<dt>Steps</dt><dd>${steps.map((s) => `<code>${esc(s)}</code>`).join(" → ")}</dd>` : ""}
      <dt>${chat ? "Output container" : "Output selector"}</dt><dd><code>${esc(output)}</code></dd>
      <dt>Date</dt><dd>${esc(startedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "long" }))}</dd>
      <dt>Runs</dt><dd>${runs.length + failed.length + unidentified.length}${[
        failed.length ? ` (${failed.map((n) => `run ${n}`).join(", ")} failed to load)` : "",
        unidentified.length ? ` (${unidentified.map((n) => `run ${n}`).join(", ")}: AI request not identified, timing inconclusive)` : "",
      ].join("")}</dd>
    </dl>
  </header>

  <section aria-labelledby="verdict-h" class="verdict-box">
    <h2 id="verdict-h">Verdict</h2>
    <p class="headline">${esc(headline ?? "")}</p>
    ${sides.length ? `<ul class="sides">${sides.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
  </section>

  <section aria-labelledby="browser-h">
    <h2 id="browser-h">In the browser</h2>
    ${bars.browser ? barHtml(bars.browser) : `<p class="muted">No warm run to draw${summary ? " (use --runs 2 or more)" : ""}.</p>`}
    ${hints.browser ? `<h3>Where to look — browser</h3><div class="stop">${hintsBody(hints.browser)}</div>` : ""}
  </section>
  ${server ? serverTop(server, hints.server, bars.server) : ""}

  ${summaryBlock(checks)}
  ${streamingSection(streaming)}
  ${stop ? stopSection(stop) : ""}
  ${double ? doubleSection(double) : ""}
  ${canary ? canarySection(canary) : ""}
  ${csp ? cspSection(csp) : ""}

  <details class="more">
    <summary>Details: every run, the data, request matching${server ? ", server marks" : ""}</summary>
    <div class="tiles">
      ${summary ? `${tile(
        summary.cold !== null ? "Cold (run 1)" : summary.coldUnidentified ? "Cold (run 1: AI request not identified)" : "Cold (run 1 failed to load)",
        summary.cold
      )}
      ${tile(medianLabel(summary, runs.length + failed.length + unidentified.length), summary.median)}
      ${tile("Worst (all runs)", summary.worst)}` : tile("AI request not identified in any run", null)}
    </div>

    <section aria-labelledby="timeline-h">
      <h3 id="timeline-h">Timeline per run</h3>
      <ul class="legend">
        ${used.map((s) => `<li><span class="swatch" style="background:var(--seg-${s.key})"></span>${esc(s.legend)}</li>`).join("")}
      </ul>
      <div class="chart">
        ${timeline.map((run) => runRow(run, scale, ticks)).join("")}
        <div class="row axis" aria-hidden="true">
          <div></div>
          <div class="plot">${ticks.map((t) => `<span style="left:${pct(t, scale)}">${fmtTick(t)}</span>`).join("")}</div>
        </div>
      </div>
    </section>

    <section aria-labelledby="table-h">
      <h3 id="table-h">Data</h3>
      <div class="table-wrap">
      <table>
        <thead><tr>
          <th scope="col">Segment (ms)</th>${runs.map((run) => `<th scope="col" class="num">${runName(run.run)}</th>`).join("")}
        </tr></thead>
        <tbody>
          <tr><th scope="row">Total</th>${runs.map((run) => `<td class="num">${fmtMs(run.total)}</td>`).join("")}</tr>
          ${tableKeys.map((k) => `<tr><th scope="row">${esc(k.legend)}</th>${runs.map((run) => dataCell(run, k.key)).join("")}</tr>`).join("")}
        </tbody>
      </table>
      </div>
    </section>

    <section aria-labelledby="requests-h">
      <h3 id="requests-h">Request matching and clock check</h3>
      <ul class="reqs">${runs.map(requestItem).join("")}</ul>
    </section>
    ${chat || runs.some((r) => r.reply.preReply.length) ? replySection(runs, chat ? "Send" : "Click") : ""}
    ${server ? serverSection(server) : ""}
  </details>
</main>
<div id="tip" role="tooltip" hidden></div>
<script>${JS}</script>
</body>
</html>
`;
}

// One side's bar: a row per lane, each segment placed at its start and labelled with its name,
// its ms and, when it's over its limit, "over" (never colour alone). The key repeats each one in
// words, for narrow screens and screen readers.
function barHtml({ title, total, lanes }: Bar): string {
  const scale = Math.max(total, 1);
  const status = (p: BarPart) =>
    p.limit === null ? "not attributed to any segment"
    : p.over ? `<b>over</b> its ${p.limit} ms limit`
    : `within its ${p.limit} ms limit`;
  const seg = (p: BarPart) =>
    `<div class="bseg ${p.over ? "over" : "ok"}" style="left:${pct(p.start, scale)};width:${pct(p.ms, scale)}" title="${esc(`${p.label}: ${p.ms} ms${p.over ? ` — over its ${p.limit} ms limit` : ""}`)}"><span class="bname">${esc(p.label)}</span> <span class="bms">${p.ms} ms</span>${p.over ? ` <span class="tag-over">over</span>` : ""}</div>`;
  return `<p class="bar-title">${esc(title)}</p>
    <div class="bar" role="group" aria-label="${esc(title)}">
      ${lanes.map((lane) => `<div class="lane">${lane.map(seg).join("")}</div>`).join("")}
    </div>
    <ul class="barkey">${lanes.flat().sort((a, b) => a.start - b.start).map((p) => `<li class="${p.over ? "over" : "ok"}"><span class="sw"></span><span>${esc(p.label)} — ${p.ms} ms — ${status(p)}</span></li>`).join("")}</ul>`;
}

// One Data cell: a run's segment, "?" when unknown, "—" when the run didn't have it.
function dataCell(run: ReportRun, key: SegmentKey): string {
  const s = (run.segments as Segment[]).find((seg) => seg.key === key);
  if (!s) return `<td class="num muted">—</td>`;
  const note = s.note ? `<span class="note muted">${esc(s.note)}</span>` : "";
  return `<td class="num">${s.ms === null ? "?" : s.ms.toFixed(1)}${note}</td>`;
}

// One run's chosen request, why it was chosen, and the clock check.
function requestItem(run: ReportRun): string {
  if (!run.request) return `<li><b>${runName(run.run)}</b> <span class="muted">no timed network request between click and first paint</span></li>`;
  const r = run.request;
  return `<li><b>${runName(run.run)}</b> <span class="wrap">${esc(r.method)} ${esc(r.url)} → ${esc(String(r.status))}${r.contentType ? ` ${esc(r.contentType)}` : ""}</span>
        <span class="why">chosen from ${run.from} request(s): ${esc(run.reasons.join(", ") || "only candidate")}</span>
        <span class="why">share: ${esc(run.share)}</span>
        <span class="why">clock check: ${esc(run.clock)}</span></li>`;
}

// Segments as drawn: known, non-negative widths, plus a neutral remainder when part of the
// run couldn't be attributed (no request chosen, or a step whose timing is unknown).
function barSegments({ total, segments }: ReportRun): BarSegment[] {
  const all: Segment[] = segments; // widen the `[]` arm of Breakdown so filter can narrow
  const known: BarSegment[] = all
    .filter((s): s is BarSegment => s.ms !== null)
    .map((s) => ({ ...s, ms: Math.max(0, s.ms) }));
  const unknown = segments.length === 0 || known.length < segments.length;
  const rest = total - known.reduce((sum, s) => sum + s.ms, 0);
  if (unknown && rest > 0.5) known.push({ key: "other", label: "unattributed", ms: rest });
  return known.filter((s) => s.ms > 0);
}

function runRow(run: ChartRun, scale: number, ticks: number[]): string {
  const tag = run.run === 1 ? ` <span class="tag">cold</span>` : "";
  const req = run.request
    ? `<p class="req wrap"><span class="method">${esc(run.request.method)}</span> ${esc(run.request.url)}
         → ${esc(String(run.request.status))}${run.request.contentType ? ` · ${esc(run.request.contentType)}` : ""}</p>
       <p class="why">chosen from ${run.from} request(s): ${esc(run.reasons.join(", ") || "only candidate")}</p>
       <p class="why">share: ${esc(run.share)}</p>`
    : `<p class="why">no timed network request between click and first paint</p>`;

  return `
      <div class="row">
        <div class="rlabel">run ${run.run}${tag}<b>${fmtMs(run.total)} ms</b></div>
        <div class="plot">
          <div class="bar-area">
            ${ticks.map((t) => `<i class="grid" style="left:${pct(t, scale)}"></i>`).join("")}
            <div class="tbar" style="width:${pct(run.total, scale)}">
              ${run.bars.map((s) => segment(s, run.total)).join("")}
            </div>
            <div class="callouts"></div>
          </div>
          ${req}
        </div>
      </div>`;
}

function segment(s: BarSegment, total: number): string {
  const share = total > 0 ? ` (${((s.ms / total) * 100).toFixed(1)}% of total)` : "";
  const tip = `${s.label}: ${s.ms.toFixed(1)} ms${share}${s.note ? ` — ${s.note}` : ""}`;
  return `<div class="seg" tabindex="0" style="flex-grow:${s.ms};background:var(--seg-${s.key})"
       data-tip="${esc(tip)}" aria-label="${esc(tip)}"><span class="in">${fmtMs(s.ms)} ms</span></div>`;
}

// When the AI request's first body byte came, and what changed in the output before the reply.
// Those changes are placeholders (or a slow first byte) and never count as the first word.
function replySection(runs: ReportRun[], start: "Send" | "Click"): string {
  const changes = (reply: ReportReply) =>
    reply.preReply.length
      ? `<ul class="notes">${reply.preReply.map((c) => `<li>+${fmtMs(c.at)} ms ${c.text ? esc(JSON.stringify(c.text)) : "(empty)"}</li>`).join("")}</ul>`
      : `<span class="muted">none</span>`;
  return `<section aria-labelledby="reply-h">
    <h2 id="reply-h">Before the reply</h2>
    <p class="muted">The first word is the output&rsquo;s first change at or after the AI request&rsquo;s first body byte. Earlier changes are pre-reply changes, listed here and never timed.${start === "Send" ? " Your own message isn't counted." : ""}</p>
    <div class="table-wrap">
    <table>
      <thead><tr>
        <th scope="col">Run</th><th scope="col" class="num">${start} → first body byte (ms)</th><th scope="col" class="num">${start} → first word (ms)</th><th scope="col">Pre-reply changes</th>
      </tr></thead>
      <tbody>
        ${runs.map((run) => `<tr>
          <th scope="row">${runName(run.run)}</th>
          <td class="num">${run.reply.firstByte === null ? "?" : fmtMs(run.reply.firstByte)}</td>
          <td class="num">${fmtMs(run.total)}</td>
          <td class="wrap">${changes(run.reply)}</td>
        </tr>`).join("")}
      </tbody>
    </table>
    </div>
  </section>`;
}

function stopSection({ pattern, verdict, fix, checks, notes }: StopReport & { pattern: string }): string {
  return `<section aria-labelledby="stop-h">
    <h2 id="stop-h">Stop check</h2>
    <div class="stop">
      <p class="muted">Stop button <code>${esc(String(new RegExp(pattern, "i")))}</code>, one extra run on a fresh page</p>
      ${checksBody({ verdict, fix, checks, notes })}
    </div>
  </section>`;
}

function doubleSection({ verdict, fix, checks, notes }: DoubleReport): string {
  return `<section aria-labelledby="double-h">
    <h2 id="double-h">Double-send check</h2>
    <div class="stop">
      <p class="muted">The measured button clicked again mid-stream, one extra run on a fresh page</p>
      ${checksBody({ verdict, fix, checks, notes })}
    </div>
  </section>`;
}

function canarySection({ input, verdict, fix, checks, notes }: CanaryReport & { input: string | undefined }): string {
  return `<section aria-labelledby="canary-h">
    <h2 id="canary-h">Canary image check</h2>
    <div class="stop">
      <p class="muted">${
        input ? `Canary typed into <code>${esc(input)}</code>` : "Canary planted by hand in content the AI reads"
      }, one extra run on a fresh page</p>
      ${checksBody({ verdict, fix, checks, notes })}
    </div>
  </section>`;
}

function cspSection({ verdict, fix, checks, notes }: CspReport): string {
  return `<section aria-labelledby="csp-h">
    <h2 id="csp-h">CSP image check</h2>
    <div class="stop">
      <p class="muted">Content-Security-Policy of the first timed run's page: response headers and &lt;meta&gt; tags</p>
      ${checksBody({ verdict, fix, checks, notes })}
    </div>
  </section>`;
}

function streamingSection({ verdict, fix, checks, notes }: CheckReport): string {
  return `<section aria-labelledby="streaming-h">
    <h2 id="streaming-h">Streaming</h2>
    <div class="stop">
      <p class="muted">Streaming span: first word → done, in the warm runs</p>
      ${checksBody({ verdict, fix, checks, notes })}
    </div>
  </section>`;
}

// The server side at the top: its bar and where to look. Never next to browser numbers.
export function serverTop({ block }: ServerReport, hints: HintList | null, bar: Bar | null): string {
  return `<section aria-labelledby="server-top-h">
    <h2 id="server-top-h">Inside the server</h2>
    <p class="muted">From separate marked runs, on the server's clock. Never added to the browser timings above: different runs, different clocks.</p>
    ${bar ? `${barHtml(bar)}<p class="muted">Empty parts of a row are time no span covers.</p>` : `<p>${block ? "No spans to draw." : "No marked visit succeeded: see Run details under Details."}</p>`}
    ${block ? promptHtml(block.prompt) : ""}
    ${hints ? `<h3>Where to look — server</h3><div class="stop">${hintsBody(hints)}</div>` : ""}
  </section>`;
}

// The marked visits (--server-timings) in the details: the same block as the terminal, as a
// table, then the lines the terminal printed in "Run details" (open when no visit succeeded,
// since they say why).
export function serverSection({ lines, block }: ServerReport): string {
  const many = !!block && block.visits.length > 1;
  const row = ({ label, values, stats, note }: ServerRow) => {
    const cells = values.map((v) => `<td class="num">${v === null ? "–" : v}</td>`);
    const summary = !many ? [] : stats ? [stats.min, stats.median, stats.max].map((v) => `<td class="num">${v}</td>`) : [`<td class="num"></td>`, `<td class="num"></td>`, `<td class="num"></td>`];
    return `<tr><th scope="row">${esc(label)}${note ? `<span class="note muted">${esc(note)}</span>` : ""}</th>${[...cells, ...summary].join("")}</tr>`;
  };
  const group = (name: string, rows: ServerRow[]) =>
    rows.length ? `<tr class="group"><th scope="rowgroup" colspan="${block!.visits.length + (many ? 4 : 1)}">${name}</th></tr>${rows.map(row).join("")}` : "";
  const notes = block ? [...block.noSpan, block.workers, block.firstBytes].filter((n): n is string => n !== null) : [];
  return `<section aria-labelledby="server-h">
    <h3 id="server-h">Inside the server: marks and spans</h3>
    <div class="stop">
      <p class="muted">From separate marked runs, on the server's clock. Never added to the browser timings above: different runs, different clocks.</p>
      ${block ? `<p class="verdict-sm">${esc(block.title)}</p>
      <div class="table-wrap">
      <table>
        <thead><tr>
          <th scope="col"></th>${many ? block.visits.map((v) => `<th scope="col" class="num">visit ${v} (ms)</th>`).join("") + `<th scope="col" class="num">min</th><th scope="col" class="num">median</th><th scope="col" class="num">max</th>` : `<th scope="col" class="num">ms</th>`}
        </tr></thead>
        <tbody>
          ${block.marks.length ? group("Marks", block.marks) : `<tr><td colspan="${block.visits.length + (many ? 4 : 1) + 1}" class="muted">no marks recorded</td></tr>`}
          ${group("Spans", block.spans)}
        </tbody>
      </table>
      </div>
      ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      ${promptHtml(block.prompt)}
      ${block.problems.length ? `<h3>Problems reported by the server</h3>
      <ul class="notes">${block.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}` : ""}
      <details${block ? "" : " open"}><summary>Run details</summary>
      <ul class="notes log">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
      </details>
    </div>
  </section>`;
}

// Prompt sizes: the terminal's rows as a table (bytes, then the share or why there's no size; with
// several visits that differ, a column per visit and min, median, max), or the line saying none
// were recorded; a line per visit that isn't compared.
function promptHtml({ heading, note, visits, rows, none, lines }: PromptView): string {
  const many = visits.length > 1;
  const head = many
    ? `${visits.map((v) => `<th scope="col" class="num">visit ${v} (bytes)</th>`).join("")}<th scope="col" class="num">min</th><th scope="col" class="num">median</th><th scope="col" class="num">max</th><th scope="col">note</th>`
    : `<th scope="col" class="num">bytes</th><th scope="col">share</th>`;
  const cells = ({ values, stats, tail }: PromptView["rows"][number]) =>
    [...values, ...(many ? (stats ?? ["", "", ""]).map(String) : [])].map((v) => `<td class="num">${esc(v)}</td>`).join("") + `<td>${esc(tail)}</td>`;
  const notes = [...(none ? [none] : []), ...lines];
  return `${heading ? `<h3>${esc(heading[0]!.toUpperCase() + heading.slice(1))}</h3>
      <p class="muted">${esc(note[0]!.toUpperCase() + note.slice(1))}.</p>
      ${rows.length ? `<div class="table-wrap">
      <table>
        <thead><tr><th scope="col">message</th>${head}</tr></thead>
        <tbody>${rows.map((r) => `<tr><th scope="row">${esc(r.label)}</th>${cells(r)}</tr>`).join("")}</tbody>
      </table>
      </div>` : `<p>no messages</p>`}` : ""}
      ${notes.length ? `<ul class="notes">${notes.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}`;
}

// The first hint in full (evidence, basis, things to check, disclaimer), the rest one line each.
function hintsBody({ scope, hints, none, disclaimer }: HintList): string {
  const head = `<p class="muted">${esc(scope[0]!.toUpperCase() + scope.slice(1))}.</p>`;
  if (none) return `${head}<p>${esc(none)}</p>`;
  const [first, ...rest] = hints;
  return `${head}
      <p class="verdict-sm">${esc(first!.evidence)}</p>
      ${first!.about ? `<p>${esc(first!.about)}</p>` : ""}
      <p class="muted">Limit: ${esc(first!.basis)}</p>
      <p>Things to check:</p>
      <ul class="notes">${first!.checks.map((c) => `<li>could be ${esc(c)}</li>`).join("")}</ul>
      ${first!.links.length ? `<p>Learn more: ${linksHtml(first!.links)}</p>` : ""}
      <p class="muted">${esc(disclaimer)}</p>
      ${rest.length ? `<h3>Also over their limits</h3><ul class="notes">${rest.map(shortHtml).join("")}</ul>` : ""}`;
}

// A short line with its links as links: the terminal text up to them, then each one.
function shortHtml(h: Hint): string {
  const more = h.links.length ? ` — learn more: ${h.links.join(" · ")}` : "";
  const text = more ? h.short.slice(0, -more.length) : h.short;
  return `<li>${esc(text)}${h.links.length ? ` — learn more: ${linksHtml(h.links)}` : ""}</li>`;
}

const linksHtml = (links: string[]) => links.map((l) => `<a href="${esc(l)}" rel="noopener noreferrer">${esc(l)}</a>`).join(" · ");

const STATUS_MARK: Record<CheckStatus, string> = { pass: "✓", warn: "⚠", fail: "✗", unknown: "?" };

// One line per check that ran, at the top of the report. Same lines as the terminal summary.
function summaryBlock(entries: SummaryEntry[]): string {
  return `<section aria-labelledby="summary-h" class="summary">
    <h2 id="summary-h">Checks</h2>
    <ul>
      ${entries.map(({ name, report, suffix }) => `<li class="${report.status}"><span class="smark">${STATUS_MARK[report.status]}</span><b>${esc(name)}</b> ${esc(report.verdict + (suffix ?? ""))}</li>`).join("")}
    </ul>
  </section>`;
}

// Verdict, fix, checks table and notes, shared by every check section.
function checksBody({ verdict, fix, checks, notes }: Pick<CheckReport, "verdict" | "fix" | "checks" | "notes">): string {
  const mark = (pass: boolean | null) =>
    pass === null ? `<span class="mark muted">? not checked</span>`
    : pass ? `<span class="mark">✓ pass</span>`
    : `<span class="mark">✗ fail</span>`;
  return `<p class="verdict">${esc(verdict)}</p>
      ${fix ? `<p class="fix">${esc(fix)}</p>` : ""}
      ${checks.length ? `<table><tbody>
        ${checks.map((c) => `<tr><th scope="row">${esc(c.label)}</th><td>${mark(c.pass)}</td><td class="wrap">${esc(c.detail)}</td></tr>`).join("")}
      </tbody></table>` : ""}
      <ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
}

const runName = (n: number) => `run&nbsp;${n}${n === 1 ? " (cold)" : ""}`;

function medianLabel({ warm, warmFailed, warmUnidentified }: Summary, total: number): string {
  const lost = [warmFailed ? `${warmFailed} failed to load` : "", warmUnidentified ? `${warmUnidentified} AI request not identified` : ""].filter(Boolean);
  if (lost.length) return warm === 1 ? `The one warm run (${lost.join(", ")})` : `Median (${warm} warm runs, ${lost.join(", ")})`;
  if (warm === 1) return "The one warm run";
  return total > 2 ? `Median (runs 2–${total})` : total === 2 ? "Median (run 2)" : "Median (needs 2+ runs)";
}

function tile(label: string, value: number | null): string {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${
    value === null ? "—" : `${fmtMs(value)}<small> ms</small>`
  }</div></div>`;
}

function niceTicks(max: number): number[] {
  const raw = max / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  // 10 × pow always reaches raw, so find() never comes back empty.
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);
  return ticks;
}

const pct = (value: number, scale: number) => `${((value / scale) * 100).toFixed(3)}%`;
const fmtMs = (value: number) => Math.round(value).toLocaleString("en-US");
const fmtTick = (t: number) => (t === 0 ? "0" : t >= 1000 ? `${+(t / 1000).toFixed(2)} s` : `${+t.toFixed(1)} ms`);

function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const CSS = `
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --seg-click: #eda100; --seg-preflight: #e87ba4; --seg-connection: #008300; --seg-ttfb: #2a78d6;
  --seg-download: #1baf7a; --seg-render: #eb6834; --seg-streaming: #e34948; --seg-other: #c3c2b7;
  --ok: #e1e0d9; --ok-ink: #0b0b0b; --warn: #b93a0b; --warn-ink: #ffffff; --track: #f1f0eb;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --seg-click: #c98500; --seg-preflight: #d55181; --seg-connection: #008300; --seg-ttfb: #3987e5;
    --seg-download: #199e70; --seg-render: #d95926; --seg-streaming: #e66767; --seg-other: #52514e;
    --ok: #383835; --ok-ink: #f0efec; --warn: #f2884f; --warn-ink: #0b0b0b; --track: #141413;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 12px; }
h2 { font-size: 16px; margin: 32px 0 12px; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
.wrap { overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
.meta dt { color: var(--ink-2); }
.meta dd { margin: 0; }
.tiles { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; min-width: 160px; }
.tile-label { color: var(--ink-2); font-size: 13px; }
.tile-value { font-size: 28px; font-weight: 600; }
.tile-value small { font-size: 14px; font-weight: 400; color: var(--ink-2); }
.legend { list-style: none; padding: 0; margin: 0 0 16px; display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--ink-2); }
.legend li { display: flex; align-items: center; gap: 6px; }
.swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; }
.chart { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.row { display: grid; grid-template-columns: 120px 1fr; gap: 12px; }
.row + .row { margin-top: 12px; }
.rlabel { padding-top: 2px; color: var(--ink-2); }
.rlabel b { display: block; color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.tag { font-size: 11px; border: 1px solid var(--axis); border-radius: 999px; padding: 0 6px; margin-left: 4px; }
.plot { position: relative; min-width: 0; }
.bar-area { position: relative; }
.grid { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--grid); }
.tbar { position: relative; display: flex; gap: 2px; height: 24px; }
.verdict-box { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 4px 16px 12px; margin-top: 20px; }
.verdict-box h2 { margin-top: 12px; }
.headline { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
.sides { margin: 0; padding-left: 18px; }
.sides li { margin: 2px 0; }
.bar-title { color: var(--ink-2); margin: 0 0 6px; }
.bar { display: grid; gap: 4px; }
.lane { position: relative; height: 30px; background: var(--track); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.bseg { position: absolute; top: 0; bottom: 0; min-width: 2px; padding: 0 6px; box-sizing: border-box; display: flex; align-items: center; gap: 4px;
  font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-right: 2px solid var(--surface); }
.bseg.ok { background: var(--ok); color: var(--ok-ink); }
.bseg.over { background: repeating-linear-gradient(135deg, var(--warn) 0 8px, color-mix(in srgb, var(--warn) 82%, var(--ink)) 8px 16px); color: var(--warn-ink); font-weight: 600; }
.bname { overflow: hidden; text-overflow: ellipsis; }
.bms { font-variant-numeric: tabular-nums; }
.tag-over { text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; border: 1px solid currentColor; border-radius: 3px; padding: 0 3px; }
.barkey { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 2px; font-size: 13px; }
.barkey li { display: flex; align-items: baseline; gap: 8px; overflow-wrap: anywhere; }
.barkey .sw { width: 10px; height: 10px; border-radius: 2px; flex: none; background: var(--ok); }
.barkey .over .sw { background: var(--warn); }
.barkey .over b { color: var(--warn); }
details.more { margin-top: 32px; border-top: 1px solid var(--border); padding-top: 12px; }
details.more > summary { font-size: 16px; font-weight: 600; color: var(--ink); }
details.more h3 { font-size: 15px; margin: 24px 0 10px; }
.reqs { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; font-size: 13px; }
.reqs li { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; overflow-wrap: anywhere; }
.reqs .why { display: block; }
.seg { position: relative; flex: 1 1 0; min-width: 3px; display: flex; align-items: center; justify-content: center; cursor: default; }
.seg:last-child { border-radius: 0 4px 4px 0; }
.seg:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.seg:hover, .seg:focus-visible { filter: brightness(1.08); }
.in { font-size: 12px; font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; visibility: hidden; padding: 0 4px; }
.callouts { position: relative; height: 0; }
.callout { position: absolute; font-size: 12px; color: var(--ink-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.leaders { position: absolute; left: 0; top: 0; overflow: visible; }
.leaders line { stroke: var(--muted); stroke-width: 1; }
.req { margin: 6px 0 0; font-size: 13px; }
.method { font-weight: 600; }
.why { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.axis { margin-top: 8px; }
.axis .plot { height: 16px; }
.axis span { position: absolute; transform: translateX(-50%); font-size: 12px; color: var(--muted); white-space: nowrap; }
.axis span:first-child { transform: none; }
.table-wrap + .table-wrap { margin-top: 12px; }
.table-wrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
thead th { color: var(--ink-2); font-weight: 600; white-space: normal; }
tbody tr:last-child > * { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.note { display: block; white-space: normal; font-size: 12px; }
.stop { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.stop p { margin: 0 0 8px; }
.verdict { font-size: 18px; font-weight: 600; }
.fix { font-weight: 600; }
.summary ul { list-style: none; margin: 0; padding: 12px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.summary li { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; }
.summary li b { min-width: 96px; }
.summary .unknown { color: var(--ink-2); }
.summary .warn .smark { color: var(--seg-click); }
.smark { width: 1em; flex: none; text-align: center; font-weight: 700; }
.mark { white-space: nowrap; }
.verdict-sm { font-weight: 600; margin: 16px 0 8px; }
.log { margin: 0; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.log li { white-space: pre-wrap; }
.group th { color: var(--ink-2); font-weight: 600; background: var(--page); }
h3 { font-size: 14px; margin: 16px 0 0; }
details { margin-top: 12px; }
summary { cursor: pointer; color: var(--ink-2); }
.notes { margin: 12px 0 0; padding-left: 18px; color: var(--ink-2); }
#tip { position: fixed; z-index: 10; pointer-events: none; max-width: 320px; background: var(--ink); color: var(--surface);
  font-size: 12px; padding: 6px 8px; border-radius: 6px; }
@media (max-width: 640px) {
  .row { grid-template-columns: 1fr; gap: 4px; }
  .rlabel b { display: inline; margin-left: 8px; }
}
`;

// Labels go inside a segment when they fit; otherwise in a row below the bar, pushed apart so
// they never overlap, each tied to its segment by a leader line. Re-laid out on resize.
const JS = `
(() => {
  const GAP = 8, DROP = 8, ROW = 18, SVG = "http://www.w3.org/2000/svg";
  function inkFor(el) {
    const [r, g, b] = getComputedStyle(el).backgroundColor.match(/\\d+/g).map(Number);
    const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? "#ffffff" : "#0b0b0b";
  }
  function layout() {
    for (const area of document.querySelectorAll(".bar-area")) {
      const callouts = area.querySelector(".callouts");
      callouts.replaceChildren();
      const width = area.clientWidth;
      const left0 = area.getBoundingClientRect().left;
      const placed = [];
      for (const seg of area.querySelectorAll(".seg")) {
        const label = seg.querySelector(".in");
        label.style.display = "";
        label.style.visibility = "hidden";
        if (label.scrollWidth + 8 <= seg.clientWidth) {
          label.style.color = inkFor(seg);
          label.style.visibility = "visible";
          continue;
        }
        label.style.display = "none";
        const box = seg.getBoundingClientRect();
        const out = document.createElement("span");
        out.className = "callout";
        out.textContent = label.textContent;
        callouts.append(out);
        placed.push({ out, anchor: box.left + box.width / 2 - left0, w: out.offsetWidth });
      }
      if (!placed.length) { callouts.style.height = "0px"; continue; }
      // Left to right: centre each label under its segment, pushed right past its neighbour;
      // then right to left: pull back anything that runs off the end.
      let edge = -Infinity;
      for (const p of placed) { p.x = Math.max(p.anchor - p.w / 2, edge + GAP, 0); edge = p.x + p.w; }
      edge = width + GAP;
      for (const p of placed.reverse()) { p.x = Math.min(p.x, edge - GAP - p.w); edge = p.x; }
      const svg = document.createElementNS(SVG, "svg");
      svg.classList.add("leaders");
      svg.setAttribute("width", width);
      svg.setAttribute("height", DROP);
      for (const p of placed) {
        p.out.style.left = p.x + "px";
        p.out.style.top = DROP + "px";
        const line = document.createElementNS(SVG, "line");
        line.setAttribute("x1", p.anchor); line.setAttribute("y1", 0);
        line.setAttribute("x2", Math.min(Math.max(p.anchor, p.x + 2), p.x + p.w - 2)); line.setAttribute("y2", DROP);
        svg.append(line);
      }
      callouts.append(svg);
      callouts.style.height = DROP + ROW + "px";
    }
  }
  const tip = document.getElementById("tip");
  function show(seg, x, y) {
    tip.textContent = seg.dataset.tip;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(x + 12, innerWidth - w - 8)) + "px";
    tip.style.top = (y - h - 12 < 8 ? y + 16 : y - h - 12) + "px";
  }
  document.addEventListener("pointermove", (e) => {
    const seg = e.target.closest(".seg");
    if (seg) show(seg, e.clientX, e.clientY); else tip.hidden = true;
  });
  document.addEventListener("focusin", (e) => {
    const seg = e.target.closest(".seg");
    if (!seg) return;
    const b = seg.getBoundingClientRect();
    show(seg, b.left + b.width / 2, b.top);
  });
  document.addEventListener("focusout", () => (tip.hidden = true));
  let pending;
  addEventListener("resize", () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(layout); });
  layout();
})();
`;

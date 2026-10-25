// Self-contained HTML timeline for an audit: inline CSS/JS, no external requests.

import type { Breakdown, CanaryReport, CspReport, DoubleReport, Segment, SegmentKey, StopCheck, StopReport, Summary } from "./types.js";

export type ReportRun = Breakdown & { run: number; total: number }; // run: 1-based number, 1 = cold

export interface ReportInput {
  url: string;
  measure: string;
  output: string;
  steps: string[];
  startedAt: Date;
  summary: Summary;
  runs: ReportRun[]; // the runs whose page loaded
  failed: number[]; // run numbers whose page failed to load
  stop: (StopReport & { pattern: string }) | null; // null without --stop
  double: DoubleReport | null; // null without --double
  canary: (CanaryReport & { input: string | undefined }) | null; // null without --canary
  csp: CspReport | null; // null without --csp or --canary
}

/** A segment as drawn: known, non-negative width. */
type BarSegment = Segment & { ms: number };
type ChartRun = ReportRun & { bars: BarSegment[] };

// Stack order, legend order and table column order. Colors are validated so every pair that
// can sit next to each other in a bar stays distinguishable (incl. color-vision deficiency).
const SEGMENTS: { key: SegmentKey; legend: string }[] = [
  { key: "click", legend: "click → fetch() called / request sent" },
  { key: "preflight", legend: "CORS preflight" },
  { key: "connection", legend: "connection setup" },
  { key: "ttfb", legend: "request → first byte" },
  { key: "download", legend: "first byte → done" },
  { key: "render", legend: "done → first paint" },
  { key: "streaming", legend: "first byte → first paint (streaming)" },
  { key: "other", legend: "unattributed" },
];

export function renderReport({ url, measure, output, steps, startedAt, summary, runs, failed, stop, double, canary, csp }: ReportInput): string {
  const bars: ChartRun[] = runs.map((run) => ({ ...run, bars: barSegments(run) }));
  const scale = Math.max(...runs.map((r) => r.total), 1);
  const ticks = niceTicks(scale);
  const used = SEGMENTS.filter((s) => bars.some((run) => run.bars.some((b) => b.key === s.key)));
  const tableKeys = SEGMENTS.filter((s) => runs.some((run) => run.segments.some((b) => b.key === s.key)));

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
      <dt>Measured button</dt><dd><code>${esc(String(new RegExp(measure, "i")))}</code></dd>
      ${steps.length ? `<dt>Steps</dt><dd>${steps.map((s) => `<code>${esc(s)}</code>`).join(" → ")}</dd>` : ""}
      <dt>Output selector</dt><dd><code>${esc(output)}</code></dd>
      <dt>Date</dt><dd>${esc(startedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "long" }))}</dd>
      <dt>Runs</dt><dd>${runs.length + failed.length}${
        failed.length ? ` (${failed.map((n) => `run ${n}`).join(", ")} failed to load)` : ""
      }</dd>
    </dl>
    <div class="tiles">
      ${tile(summary.cold === null ? "Cold (run 1 failed to load)" : "Cold (run 1)", summary.cold)}
      ${tile(medianLabel(summary, runs.length + failed.length), summary.median)}
      ${tile("Worst (all runs)", summary.worst)}
    </div>
  </header>

  <section aria-labelledby="timeline-h">
    <h2 id="timeline-h">Timeline per run</h2>
    <ul class="legend">
      ${used.map((s) => `<li><span class="swatch" style="background:var(--seg-${s.key})"></span>${esc(s.legend)}</li>`).join("")}
    </ul>
    <div class="chart">
      ${bars.map((run) => runRow(run, scale, ticks)).join("")}
      <div class="row axis" aria-hidden="true">
        <div></div>
        <div class="plot">${ticks.map((t) => `<span style="left:${pct(t, scale)}">${fmtTick(t)}</span>`).join("")}</div>
      </div>
    </div>
  </section>

  <section aria-labelledby="table-h">
    <h2 id="table-h">Data</h2>
    <div class="table-wrap">
    <table>
      <thead><tr>
        <th scope="col">Run</th><th scope="col" class="num">Total (ms)</th>
        ${tableKeys.map((s) => `<th scope="col" class="num">${esc(s.legend)} (ms)</th>`).join("")}
      </tr></thead>
      <tbody>
        ${runs.map((run) => tableRow(run, tableKeys)).join("")}
      </tbody>
    </table>
    </div>
    <div class="table-wrap">
    <table>
      <thead><tr>
        <th scope="col">Run</th><th scope="col">Request</th><th scope="col">Chosen because</th><th scope="col">Clock check</th>
      </tr></thead>
      <tbody>
        ${runs.map((run) => requestRow(run)).join("")}
      </tbody>
    </table>
    </div>
  </section>
  ${stop ? stopSection(stop) : ""}
  ${double ? doubleSection(double) : ""}
  ${canary ? canarySection(canary) : ""}
  ${csp ? cspSection(csp) : ""}
</main>
<div id="tip" role="tooltip" hidden></div>
<script>${JS}</script>
</body>
</html>
`;
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
       <p class="why">chosen from ${run.from} request(s): ${esc(run.reasons.join(", ") || "only candidate")}</p>`
    : `<p class="why">no timed network request between click and first paint</p>`;

  return `
      <div class="row">
        <div class="rlabel">run ${run.run}${tag}<b>${fmtMs(run.total)} ms</b></div>
        <div class="plot">
          <div class="bar-area">
            ${ticks.map((t) => `<i class="grid" style="left:${pct(t, scale)}"></i>`).join("")}
            <div class="bar" style="width:${pct(run.total, scale)}">
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

function tableRow(run: ReportRun, keys: { key: SegmentKey }[]): string {
  const segments: Segment[] = run.segments;
  const cells = keys.map(({ key }) => {
    const s = segments.find((seg) => seg.key === key);
    if (!s) return `<td class="num muted">—</td>`;
    const value = s.ms === null ? "?" : s.ms.toFixed(1);
    const note = s.note ? `<span class="note muted">${esc(s.note)}</span>` : "";
    return `<td class="num">${value}${note}</td>`;
  });
  return `<tr>
          <th scope="row">${runName(run.run)}</th>
          <td class="num">${fmtMs(run.total)}</td>
          ${cells.join("")}
        </tr>`;
}

function requestRow(run: ReportRun): string {
  const req = run.request
    ? `${esc(run.request.method)} ${esc(run.request.url)} → ${esc(String(run.request.status))}${run.request.contentType ? ` ${esc(run.request.contentType)}` : ""}`
    : "—";
  return `<tr>
          <th scope="row">${runName(run.run)}</th>
          <td class="wrap">${req}</td>
          <td>${run.request ? esc(run.reasons.join(", ") || "only candidate") : "—"}</td>
          <td>${esc(run.clock ?? "—")}</td>
        </tr>`;
}

function stopSection({ pattern, verdict, checks, notes }: StopReport & { pattern: string }): string {
  return `<section aria-labelledby="stop-h">
    <h2 id="stop-h">Stop check</h2>
    <div class="stop">
      <p class="muted">Stop button <code>${esc(String(new RegExp(pattern, "i")))}</code>, one extra run on a fresh page</p>
      ${checksBody(verdict, checks, notes)}
    </div>
  </section>`;
}

function doubleSection({ verdict, checks, notes }: DoubleReport): string {
  return `<section aria-labelledby="double-h">
    <h2 id="double-h">Double-send check</h2>
    <div class="stop">
      <p class="muted">The measured button clicked again mid-stream, one extra run on a fresh page</p>
      ${checksBody(verdict, checks, notes)}
    </div>
  </section>`;
}

function canarySection({ input, verdict, checks, notes }: CanaryReport & { input: string | undefined }): string {
  return `<section aria-labelledby="canary-h">
    <h2 id="canary-h">Canary image check</h2>
    <div class="stop">
      <p class="muted">${
        input ? `Canary typed into <code>${esc(input)}</code>` : "Canary planted by hand in content the AI reads"
      }, one extra run on a fresh page</p>
      ${checksBody(verdict, checks, notes)}
    </div>
  </section>`;
}

function cspSection({ verdict, checks, notes }: CspReport): string {
  return `<section aria-labelledby="csp-h">
    <h2 id="csp-h">CSP image check</h2>
    <div class="stop">
      <p class="muted">Content-Security-Policy of the first timed run's page: response headers and &lt;meta&gt; tags</p>
      ${checksBody(verdict, checks, notes)}
    </div>
  </section>`;
}

// Verdict, checks table and notes, shared by the Stop, double-send, canary and CSP sections.
function checksBody(verdict: string, checks: StopCheck[], notes: string[]): string {
  const mark = (pass: boolean | null) =>
    pass === null ? `<span class="mark muted">? not checked</span>`
    : pass ? `<span class="mark">✓ pass</span>`
    : `<span class="mark">✗ fail</span>`;
  return `<p class="verdict">${esc(verdict)}</p>
      ${checks.length ? `<table><tbody>
        ${checks.map((c) => `<tr><th scope="row">${esc(c.label)}</th><td>${mark(c.pass)}</td><td class="wrap">${esc(c.detail)}</td></tr>`).join("")}
      </tbody></table>` : ""}
      <ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
}

const runName = (n: number) => `run&nbsp;${n}${n === 1 ? " (cold)" : ""}`;

function medianLabel({ warm, warmFailed }: Summary, total: number): string {
  if (warmFailed) return `Median (${warm} warm run${warm === 1 ? "" : "s"}, ${warmFailed} failed to load)`;
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
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --seg-click: #c98500; --seg-preflight: #d55181; --seg-connection: #008300; --seg-ttfb: #3987e5;
    --seg-download: #199e70; --seg-render: #d95926; --seg-streaming: #e66767; --seg-other: #52514e;
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
.bar { position: relative; display: flex; gap: 2px; height: 24px; }
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
thead th { color: var(--ink-2); font-weight: 600; }
tbody tr:last-child > * { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.note { display: block; white-space: normal; font-size: 12px; }
.stop { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.stop p { margin: 0 0 8px; }
.verdict { font-size: 18px; font-weight: 600; }
.mark { white-space: nowrap; }
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

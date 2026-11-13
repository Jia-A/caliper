// "Advice": next steps a developer can act on, each fired only by a number this run measured and
// quoting it, with the basis for its threshold (a source, or Caliper's own reasoning). Nothing is
// said when the data isn't there. Terminal and HTML render the same items.

import type { ColdGap } from "./hints.js";
import type { PromptRow, PromptView } from "./serverblock.js";

// hints.ts's STREAMS_MIN_MS (the streaming check's threshold), kept here so this file has no
// runtime imports; test:hints checks the two are equal.
export const STREAMS_MIN_MS = 250;

export interface AdviceItem {
  text: string;
  basis: string | null; // where the threshold comes from; null when nothing is a threshold
  link: string | null;
}

export interface AdviceInput {
  streaming: { span: number; settled: number } | null; // the warm runs' streaming span, when measured
  firstWord: { median: number; warm: number } | null; // the verdict's wait for the first word
  prompt: PromptView | null; // null without --server-timings, or with no visit that succeeded
  // The first run against the warm runs' median (summary), and hints.ts coldGaps; null when either
  // wasn't measured.
  cold: { total: number; warmMedian: number; warm: number; gaps: ColdGap[] } | null;
}

const OWASP_LLM01 = "https://genai.owasp.org/llmrisk/llm01-prompt-injection/";
const NONE = "Advice — nothing to suggest from this run's numbers.";

const runs = (n: number) => (n === 1 ? "the one warm run" : `median of ${n} warm runs`);

/** The advice for one audit, in a fixed order. */
export function adviceItems({ streaming, firstWord, prompt, cold }: AdviceInput): AdviceItem[] {
  const items: AdviceItem[] = [];

  if (streaming && streaming.span < STREAMS_MIN_MS) {
    const waited = firstWord ? `, and people waited ${firstWord.median} ms for the first word` : "";
    items.push({
      text:
        `Doesn't stream: the whole answer appeared within ${streaming.span} ms of the first word (streaming span, ${runs(streaming.settled)})${waited}. ` +
        "Stream the response end to end: the server's writes, any proxy in between, and how the page reads it. " +
        "Caliper can't tell how much sooner the first word would appear.",
      basis: `Caliper's own threshold: a streaming span under ${STREAMS_MIN_MS} ms. No outside source.`,
      link: null,
    });
  }

  if (cold && cold.gaps.length) {
    const than = cold.warm === 1 ? "the one warm run" : `the median of ${cold.warm} warm runs`;
    const each = cold.gaps.map((g) =>
      `${g.label}: ${g.cold} ms on the first run, ${g.warm === null ? "not in the warm runs" : `${g.warm} ms warm`} (+${g.gap} ms, more than its ${g.limit} ms limit).`);
    const limits = [...new Map(cold.gaps.map((g) => [g.limit, `${g.limit} ms: ${g.basis}`])).values()];
    items.push({
      text:
        `The first run (a fresh browser) waited ${cold.total - cold.warmMedian} ms longer for the first word than ${than} (${cold.total} vs ${cold.warmMedian} ms). ` +
        `${each.join(" ")} Caliper can't tell why from timings alone.`,
      basis:
        "Caliper's own reasoning: each segment's Where-to-look limit, applied to the gap between the first run and the warm runs, " +
        `from 1 first run and ${cold.warm === 1 ? "1 warm run" : `${cold.warm} warm runs`}. ${limits.join(" ")}`,
      link: null,
    });
  }

  const dominant = prompt ? dominantPart(prompt) : null;
  if (dominant) {
    items.push({
      text: dominant,
      basis:
        "Caliper's own threshold: one named part is 50% or more of the prompt's measured bytes, more than all the rest together. " +
        "These are bytes your app reported, not tokens; Caliper didn't measure what trimming it would change.",
      link: null,
    });
  }

  // Parts the app labelled outside, with their bytes as the table shows them.
  const outside = (prompt?.rows ?? []).filter((r) => r.kind === "part" && r.source?.kind === "outside");
  if (outside.length) {
    const bytes = (values: string[], stats: [number, number, number] | null) =>
      stats ? `${stats[0]}–${stats[2]} bytes` : `${values[0]} bytes`;
    const named = outside.map((r) => `${r.label} (${bytes(r.values, r.stats)})`).join(", ");
    const one = outside.length === 1;
    items.push({
      text:
        `${named}: your app labelled ${one ? "it" : "them"} outside, and ${one ? "it's" : "they're"} in the prompt your app reported to run.prompt(). ` +
        "Text from outside can carry instructions (indirect prompt injection). " +
        `Keep ${one ? "it" : "them"} apart from your own instructions and mark where ${one ? "it starts and ends" : "each starts and ends"}. ` +
        "Caliper doesn't detect injection; this is a risk, not a finding.",
      basis: 'OWASP Top 10 for LLM Applications 2025, LLM01 Prompt Injection: "Segregate and identify external content."',
      link: OWASP_LLM01,
    });
  }

  if (prompt?.unlabelled) items.push({ text: prompt.unlabelled, basis: null, link: null });
  return items;
}

// The named part that is half the prompt or more, as a fact, in every visit compared. Only when
// every message was measured (the total row reads plain "total"); bytes as the table shows them.
function dominantPart({ rows, visits }: PromptView): string | null {
  const total = rows.find((r) => r.kind === "message" && r.label.startsWith("total"));
  if (!total || total.label !== "total") return null;
  const totals = total.values.map(Number);
  if (totals.some((t) => !Number.isFinite(t) || t <= 0)) return null;
  const share = (r: PromptRow) => r.values.map((v, i) => Number(v) / totals[i]!);
  const part = rows.find((r) => r.kind === "part" && !r.label.startsWith("rest of message") && r.values.every((v) => Number.isFinite(Number(v))) && share(r).every((x) => x >= 0.5));
  if (!part) return null;
  const by = part.source && part.source.kind !== "mixed" ? (part.source.kind === "unknown" ? ", not labelled" : `, labelled ${part.source.kind}`) : "";
  const pcts = share(part).map((x) => Math.round(x * 100));
  if (part.values.length === 1) return `${part.label} is ${pcts[0]}% of the prompt (${part.values[0]} of ${total.values[0]} bytes${by}).`;
  const range = (xs: number[]) => (Math.min(...xs) === Math.max(...xs) ? `${xs[0]}` : `${Math.min(...xs)}–${Math.max(...xs)}`);
  return `${part.label} is ${range(pcts)}% of the prompt in each of ${visits.length} marked visits (${range(part.values.map(Number))} bytes${by}).`;
}

/** Advice as the terminal prints it: one item per line, its basis (and link) under it. */
export function formatAdvice(items: AdviceItem[]): string {
  if (!items.length) return NONE;
  return [
    "Advice — from this run's numbers",
    ...items.flatMap(({ text, basis, link }) => [
      `    - ${text}`,
      ...(basis ? [`      basis: ${basis}${link ? ` ${link}` : ""}`] : []),
    ]),
  ].join("\n");
}

// "Advice": next steps a developer can act on, each fired only by a number this run measured and
// quoting it, with the basis for its threshold (a source, or Caliper's own reasoning). Nothing is
// said when the data isn't there. Terminal and HTML render the same items.

import type { PromptView } from "./serverblock.js";

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
}

const OWASP_LLM01 = "https://genai.owasp.org/llmrisk/llm01-prompt-injection/";
const NONE = "Advice — nothing to suggest from this run's numbers.";

const runs = (n: number) => (n === 1 ? "the one warm run" : `median of ${n} warm runs`);

/** The advice for one audit, in a fixed order. */
export function adviceItems({ streaming, firstWord, prompt }: AdviceInput): AdviceItem[] {
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

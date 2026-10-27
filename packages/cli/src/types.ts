import type { Request, Response } from "playwright";

// All times are page-clock ms (performance.now() in the audited page) unless noted.

/**
 * What to click to start the timer: a button by accessible name (--measure, a case-insensitive
 * regex), or the one element a CSS selector matches (--measure-selector). Never both.
 */
export type Measure = { name: string } | { selector: string };

/** What the in-page watcher reports: the measured click and the first frame with new output. */
export interface PageTiming {
  clickAt: number;
  firstPaintAt: number;
}

/**
 * When the output stopped changing. doneAt is the last change, not the end of the settle
 * window; settled is false when it was still changing at the cap.
 */
export type DoneTiming =
  | { settled: true; doneAt: number }
  | { settled: false; lastChangeAt: number };

/** The fields Caliper reads from one PerformanceResourceTiming entry. */
export interface ResourceTimingEntry {
  name: string;
  startTime: number; // when fetch() was called
  responseStart: number; // 0 cross-origin without Timing-Allow-Origin
  responseEnd: number; // when the page had the last byte
  decodedBodySize: number; // body bytes the page received; 0 for a mid-body abort, or cross-origin without Timing-Allow-Origin
}

/** One request the page made between the measured click and first paint. */
export interface RequestTiming {
  raw: Request;
  response: Response | undefined;
  connectionSetup: number; // DNS/TCP/TLS ms; 0 when a connection was reused
  url: string;
  method: string;
  resourceType: string;
  jsonBody: boolean;
  issuedAt: number | null; // fetch() called; equals start unless there was a preflight
  start: number | null; // request sent; null until response headers arrive
  firstByte: number | null;
  end: number | null; // null while still streaming
  rt: ResourceTimingEntry | null;
  status: number | null;
  contentType: string | null;
  failure: string | null;
  abortedAfterBody?: boolean; // ended net::ERR_ABORTED after the full body arrived; end is when it did
}

/** A request with a known start, the only kind auto-detection considers. */
export type TimedRequest = RequestTiming & { start: number; issuedAt: number };

/** The request chosen as the AI request, and why. */
export interface ScoredRequest {
  request: RequestTiming;
  reasons: string[];
  from: number; // how many requests it was chosen from
  score?: number; // output changes it explains; absent when chosen by --request
}

/**
 * One output change, as a watcher saw it. The chat watcher records additions and edits inside
 * the container; the click watcher records each frame the output's text differs from the last.
 */
export interface ContainerChange {
  at: number;
  text: string; // what changed, trimmed and shortened; "<tag>" for an empty element; "" when the output went empty
}

/** When the chosen AI request's first body byte came, and what changed before the reply. */
export interface ReplyTiming {
  firstByteAt: number | null; // first body chunk on the wire, else response headers
  preReply: ContainerChange[]; // changes before the first word (placeholders), never timed
}

/** Everything one run measured. */
export interface RunResult {
  ms: number; // click → first paint, rounded
  timing: PageTiming;
  done: DoneTiming;
  requests: RequestTiming[];
  pick: ScoredRequest; // a run whose AI request isn't identified has no result (UnidentifiedRequestError)
  reply: ReplyTiming;
  chat: boolean; // an --input run: sent by click or Enter
}

export type SegmentKey =
  | "click"
  | "preflight"
  | "connection"
  | "ttfb"
  | "download"
  | "render"
  | "streaming"
  | "other";

/** One consecutive slice of a run's timeline; ms is null when it couldn't be measured. */
export interface Segment {
  key: SegmentKey;
  label: string;
  ms: number | null;
  note?: string;
}

export interface RequestSummary {
  method: string;
  url: string;
  status: number | string; // HTTP status, or the failure text / "no response"
  contentType: string | null;
}

/** One run's timeline split into segments, shared by the terminal output and the report. */
export type Breakdown =
  | { request: null; segments: []; clock: null }
  | { request: RequestSummary; reasons: string[]; from: number; segments: Segment[]; clock: string };

/**
 * Cold is run 1 (null if it failed to load or its AI request wasn't identified); median covers
 * the warm runs 2..N that were measured (null with none); worst covers every measured run.
 */
export interface Summary {
  cold: number | null;
  coldUnidentified: boolean; // run 1 loaded, but its AI request wasn't identified
  median: number | null;
  worst: number;
  warm: number; // warm runs in the median
  warmFailed: number; // warm runs left out because the page failed to load
  warmUnidentified: number; // warm runs left out because their AI request wasn't identified
}

/**
 * How an AI request ended after a checked click (Stop, or the second --measure click), from
 * the browser's own network events. `at` is ms after that click; null when the byte timeline
 * couldn't be matched to the request.
 */
export type StopEnd =
  | { kind: "aborted"; errorText: string; at: number | null } // requestfailed, net::ERR_ABORTED
  | { kind: "failed"; errorText: string; at: number | null } // requestfailed, some other error
  | { kind: "finished"; at: number | null } // requestfinished: a normal end
  | { kind: "open" }; // neither by the end of the check

/** What the AI request did after the Stop click. Bytes are null when they couldn't be counted. */
export interface StopNetwork {
  request: RequestSummary;
  end: StopEnd;
  bytesAfterStop: number | null;
  bytesAfterAbort: number | null;
}

/** What the Stop check run saw. Times are ms. */
export type StopResult =
  | { kind: "load-failed"; error: string } // prepareRun failed: navigation, --step, --measure, --output
  | { kind: "no-first-word"; error: string } // the output never changed within --timeout
  | { kind: "no-control"; reason: string }
  | { kind: "ambiguous-control"; count: number }
  | { kind: "doesnt-stream"; span: number }
  | { kind: "finished-before-click"; span: number; requestEnded: boolean }
  | {
      kind: "clicked";
      afterFirstWord: number; // first word → Stop click
      outputStoppedAfter: number | null; // Stop click → last change; null if still changing at the cap
      network: StopNetwork | null; // null when no AI request was identified
    };

/** One line of the Stop check; pass is null when it couldn't be checked. */
export interface StopCheck {
  label: string;
  pass: boolean | null;
  detail: string;
}

/** pass ✓, warn ⚠, fail ✗ (warn and fail get a fix), unknown ? (inconclusive). */
export type CheckStatus = "pass" | "warn" | "fail" | "unknown";

/** One check as shown, shared by the terminal output and the report. */
export interface CheckReport {
  status: CheckStatus;
  verdict: string;
  fix?: string; // "Fix: …", only on failing or warning verdicts, tied to what was measured
  checks: StopCheck[];
  notes: string[];
}

/** The Stop check as shown. */
export type StopReport = CheckReport;

/** One line of the summary block: a check that ran, by name. */
export interface SummaryEntry {
  name: string;
  report: CheckReport;
  suffix?: string; // appended to the summary line, e.g. " (no CSP backup)"
}

/** One output change after the second --measure click, as the in-page recorder saw it. */
export interface OutputChange {
  at: number;
  hasOld: boolean; // the text from just before the second click is still in the output
}

/**
 * The two AI requests in the double-send run. `*After*` times are ms after the second click;
 * bytes are null when the byte timeline couldn't be matched to the request.
 */
export interface DoubleNetwork {
  first: {
    request: RequestSummary;
    end: StopEnd;
    bytesAfterClick: number | null;
    bytesAfterAbort: number | null;
  };
  second: {
    request: RequestSummary;
    end: StopEnd;
    firstWordAfter: number | null; // null when no output change followed its first byte
  };
  outputChangedWhileFirst: boolean | null; // output changed while request 1 still delivered bytes; null without a byte timeline
  oldTextAtSecond: boolean | null; // old text still there at request 2's first word; null without one
}

/** What the double-send run saw. Times are ms. */
export type DoubleResult =
  | { kind: "load-failed"; error: string } // prepareRun failed: navigation, --step, --measure, --output
  | { kind: "no-first-word"; error: string } // the output never changed within --timeout
  | { kind: "finished-before-click"; span: number }
  | { kind: "prevented"; how: "disabled" | "missing" } // the --measure button couldn't be clicked again
  | { kind: "ambiguous-control"; count: number }
  | { kind: "ignored"; afterFirstWord: number } // clicked again, but no request to request 1's endpoint followed
  | {
      kind: "clicked";
      afterFirstWord: number; // first word → second click
      network: DoubleNetwork | null; // null when either AI request couldn't be identified
    };

/** The double-send check as shown; same shape as the Stop check. */
export type DoubleReport = StopReport;

/** What the canary run saw. Canary signals only count from the --measure click on. */
export type CanaryResult =
  | { kind: "load-failed"; error: string } // prepareRun failed: navigation, --step, --measure, --output
  | { kind: "input-failed"; error: string } // couldn't type into --canary-input
  | { kind: "no-first-word"; error: string } // the output never changed within --timeout
  | { kind: "already-present"; where: "request" | "output" } // the canary was on the page before the click
  | {
      kind: "checked";
      planted: boolean; // Caliper typed the canary into --canary-input
      imageRequested: boolean; // a canary image request got past the page's CSP to the network layer
      cspBlocked: boolean; // Chrome blocked a canary image request for CSP
      outputHasCanary: boolean; // the output text contains the canary host
      settled: boolean; // false when the output was still changing at the cap
    };

/** The canary check as shown; same shape as the Stop check. */
export type CanaryReport = StopReport;

/** One CSP policy as the page delivered it. */
export interface CspPolicy {
  source: "header" | "meta";
  text: string;
}

/** The CSP policies of the first loaded timed run's document. */
export interface CspResult {
  headersRead: boolean; // false when the document's response wasn't seen, so header policies are unknown
  enforced: CspPolicy[]; // Content-Security-Policy headers and <meta http-equiv> tags
  reportOnly: string[]; // Content-Security-Policy-Report-Only headers (browsers ignore it in <meta>)
}

/** The CSP check as shown; same shape as the Stop check. */
export type CspReport = StopReport;

/** Warm-run medians for done; null when no warm run settled. */
export interface DoneSummary {
  done: number | null;
  span: number | null;
  warm: number; // warm runs measured
  unsettled: number; // warm runs left out because they never settled
  unidentified: number; // warm runs not measured because their AI request wasn't identified
}

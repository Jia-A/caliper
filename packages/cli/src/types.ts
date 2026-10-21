import type { Request, Response } from "playwright";

// All times are page-clock ms (performance.now() in the audited page) unless noted.

/** What the in-page watcher reports: the measured click and the first frame with new output. */
export interface PageTiming {
  clickAt: number;
  firstPaintAt: number;
}

/** The fields Caliper reads from one PerformanceResourceTiming entry. */
export interface ResourceTimingEntry {
  name: string;
  startTime: number; // when fetch() was called
  responseStart: number; // 0 cross-origin without Timing-Allow-Origin
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
}

/** A request with a known start, the only kind auto-detection considers. */
export type TimedRequest = RequestTiming & { start: number; issuedAt: number };

/** The request chosen as the AI request, and why. */
export interface ScoredRequest {
  request: RequestTiming;
  reasons: string[];
  from: number; // how many requests it was chosen from
  score?: number; // absent when chosen by --request
}

/** Everything one run measured. */
export interface RunResult {
  ms: number; // click → first paint, rounded
  timing: PageTiming;
  requests: RequestTiming[];
  pick: ScoredRequest | null;
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

/** Cold is run 1; median covers runs 2..N (null with one run); worst covers all runs. */
export interface Summary {
  cold: number;
  median: number | null;
  worst: number;
}

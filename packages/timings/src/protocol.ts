// The wire format of SPEC.md: headers, ids, mark names, the record and where it's read.

export const RUN_HEADER = "x-caliper-run";
export const TOKEN_HEADER = "x-caliper-token";
export const TIMINGS_PATH = "/__caliper/timings/";

export type TimingRecord = {
  id: string;
  // Present only when the runtime was detected; never guessed.
  runtime?: "workers";
  // The response status, or null when it isn't known (e.g. the client left before headers).
  status: number | null;
  // ms since the request reached the route; a mark is absent when the request never got that far.
  marks: Record<string, number>;
  // What the wrapper skipped or couldn't do, in words (a rejected mark name); absent when nothing.
  problems?: string[];
};

export interface TimingStore {
  put(id: string, record: TimingRecord): Promise<void>;
  get(id: string): Promise<TimingRecord | null>;
}

export const RECORD_TTL_MS = 10 * 60 * 1000;

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isValidRunId = (id: string) => RUN_ID.test(id);

// Case-sensitive. <name>Start / <name>End is a span called <name>; modelCallSent and firstChunk
// are reserved for the model call.
const MARK_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const isValidMarkName = (name: unknown): name is string => typeof name === "string" && MARK_NAME.test(name);

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
  // Sizes of the messages the app passed to run.prompt(), in order; absent when it wasn't called.
  // Never the text.
  prompt?: { messages: PromptMessageSize[] };
};

// role: a lowercase name, or "?" when the app's wasn't one. bytes: the content's UTF-8 length,
// or null when the content wasn't a string. parts: the named parts the app gave for this message,
// absent when none.
export type PromptMessageSize = { role: string; bytes: number | null; parts?: PromptPartSize[] };

// name: a lowercase name, or "?". bytes: the part text's UTF-8 length, or null when it wasn't a
// string. found: whether that text is inside its message's content; null when either wasn't a
// string, so it couldn't be checked. source: who wrote the text, as the app labelled it; absent
// when it didn't (never a default).
export type PromptPartSize = { name: string; bytes: number | null; found: boolean | null; source?: PromptSource };

// app: the developer's own text. user: the person using the feature. outside: anyone else
// (a database, the web, retrieved documents, other users' content).
export type PromptSource = "app" | "user" | "outside";
const SOURCES: readonly unknown[] = ["app", "user", "outside"];
export const isValidSource = (source: unknown): source is PromptSource => SOURCES.includes(source);

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

// Lowercase letters and _, up to 32: system, user, assistant, tool, function_call. Anything else
// could be text, so it's never recorded.
const ROLE = /^[a-z][a-z_]{0,31}$/;
export const isValidRole = (role: unknown): role is string => typeof role === "string" && ROLE.test(role);

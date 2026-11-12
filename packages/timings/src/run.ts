import { isValidMarkName, isValidRole, type PromptMessageSize, type TimingRecord, type TimingStore } from "./protocol.ts";

// Cloudflare documents navigator.userAgent === "Cloudflare-Workers" as the way
// to tell code is running on Workers (global_navigator flag, on by default
// since compatibility date 2022-03-21):
// https://developers.cloudflare.com/workers/runtime-apis/web-standards/
const isWorkers = () =>
  (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";

// A chunk with no bytes (an empty write to flush headers) isn't the first chunk.
export const hasBytes = (chunk: unknown) =>
  typeof chunk === "string" ? chunk.length > 0
  : ArrayBuffer.isView(chunk) ? chunk.byteLength > 0
  : chunk !== undefined && chunk !== null;

export type RunOptions = {
  // When the request reached the route (Date.now() ms); marks are measured from here.
  start?: number;
  // Keeps a save alive after the response is sent (Workers: ctx.waitUntil). The save runs either way.
  defer?: (p: Promise<void>) => void;
};

const MAX_PROBLEMS = 20;
const MAX_PROMPT_MESSAGES = 1000;
const utf8 = new TextEncoder();

// Logged, never thrown: nothing the wrapper does may reach the app's request (SPEC.md).
function logFailure(err: unknown) {
  try {
    console.error("Caliper timing record not saved", err);
  } catch {
    // Not even the log: drop it.
  }
}

// One marked request. On Workers, Date.now() is frozen while code runs and only
// advances at I/O, so a span with only computation inside reads 0 ms there.
// No method throws or rejects: a marked request succeeds or fails exactly as unmarked.
export class CaliperRun {
  readonly id: string;
  status: number | null = null;
  readonly #start: number;
  readonly #marks: Record<string, number> = {};
  readonly #problems: string[] = [];
  #prompt: PromptMessageSize[] | null = null;
  readonly #store: TimingStore;
  readonly #defer: (p: Promise<void>) => void;
  #watchingStream = false;

  constructor(id: string, store: TimingStore, { start = Date.now(), defer = () => {} }: RunOptions = {}) {
    this.id = id;
    this.#store = store;
    this.#start = start;
    this.#defer = defer;
  }

  // A name SPEC.md doesn't allow is skipped and reported in the record's problems, never thrown.
  mark(name: string) {
    if (!isValidMarkName(name)) {
      this.#problem(`mark name ${JSON.stringify(name)} rejected — use a letter, then up to 63 letters, digits or _ (e.g. dbStart)`);
      return;
    }
    this.#marks[name] = Date.now() - this.#start;
  }

  // Each message's role and UTF-8 size, never its text; reads the messages and never changes them.
  // Call it just before the model call. A later call replaces an earlier one. Never throws.
  prompt(messages: unknown) {
    try {
      if (!Array.isArray(messages)) {
        this.#problem("prompt not recorded: run.prompt() takes a list of { role, content } messages");
        return;
      }
      const sizes: PromptMessageSize[] = [];
      const kept = Math.min(messages.length, MAX_PROMPT_MESSAGES);
      for (let i = 0; i < kept; i++) sizes.push(this.#size(messages[i], i + 1));
      if (messages.length > kept) {
        this.#problem(`prompt: ${messages.length - kept} more messages not recorded (only the first ${MAX_PROMPT_MESSAGES} are kept)`);
      }
      this.#prompt = sizes;
    } catch {
      this.#problem("prompt not recorded: reading the messages failed");
    }
  }

  // Problems name the message by number only: its role or text could be anything.
  #size(message: unknown, n: number): PromptMessageSize {
    let role: unknown;
    let content: unknown;
    try {
      ({ role, content } = (message ?? {}) as { role?: unknown; content?: unknown });
    } catch {
      this.#problem(`prompt message ${n}: reading it failed; recorded as "?" with no size`);
      return { role: "?", bytes: null };
    }
    if (!isValidRole(role)) {
      this.#problem(`prompt message ${n}: role isn't a lowercase name of up to 32 letters or _ (e.g. system, user, assistant); recorded as "?"`);
    }
    if (typeof content !== "string") this.#problem(`prompt message ${n}: content isn't a string; size not measured`);
    return { role: isValidRole(role) ? role : "?", bytes: typeof content === "string" ? utf8.encode(content).length : null };
  }

  // Each problem once; after MAX_PROBLEMS, one line says the rest were dropped.
  #problem(text: string) {
    if (this.#problems.includes(text) || this.#problems.length > MAX_PROBLEMS) return;
    this.#problems.push(this.#problems.length < MAX_PROBLEMS ? text : `more problems not recorded (only the first ${MAX_PROBLEMS} are kept)`);
  }

  // Passes every chunk through unchanged (same bytes, same chunk boundaries);
  // it only notes when the first one with bytes arrives, then saves the record.
  watchFirstChunk<T>(stream: ReadableStream<T>): ReadableStream<T> {
    this.#watchingStream = true;
    let seen = false;
    return stream.pipeThrough(
      new TransformStream<T, T>({
        transform: (chunk, controller) => {
          if (!seen && hasBytes(chunk)) {
            seen = true;
            this.mark("firstChunk");
            void this.save();
          }
          controller.enqueue(chunk);
        },
        flush: () => {
          if (!seen) void this.save();
        },
      })
    );
  }

  // Never throws and never rejects, whatever the store or defer does: a failure is logged and
  // the record is dropped (it can't carry its own failure).
  save(): Promise<void> {
    let saved: Promise<void>;
    try {
      const record: TimingRecord = {
        id: this.id,
        ...(isWorkers() && { runtime: "workers" as const }),
        status: this.status,
        marks: { ...this.#marks },
        ...(this.#problems.length && { problems: [...this.#problems] }),
        ...(this.#prompt && { prompt: { messages: this.#prompt.map((m) => ({ ...m })) } }),
      };
      saved = Promise.resolve(this.#store.put(this.id, record)).catch(logFailure);
    } catch (err) {
      logFailure(err);
      saved = Promise.resolve();
    }
    try {
      this.#defer(saved);
    } catch (err) {
      logFailure(err);
    }
    return saved;
  }

  get savesOnStream() {
    return this.#watchingStream;
  }
}

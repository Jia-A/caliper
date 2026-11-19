import { isValidMarkName, isValidRole, isValidSource, type PromptMessageSize, type PromptPartSize, type TimingRecord, type TimingStore } from "./protocol.ts";

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
const PART_TYPE = /^[a-z][a-z_-]{0,31}$/; // image, file, tool-call, tool_result, …
const MAX_PROMPT_MESSAGES = 1000;
const MAX_PARTS_PER_MESSAGE = 50;
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
  #saves = 0; // saves started; modelFirstChunk after one saves again
  #lastSave: Promise<void> = Promise.resolve(); // saves run one after another, so the newest lands last

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
    // The model's first chunk, marked from a per-chunk callback (the AI SDK's onChunk): only the
    // first call counts. A record already saved (at firstChunk, when the app wrote an envelope
    // before the model answered) is saved again with it.
    if (name === "modelFirstChunk") {
      if (name in this.#marks) return;
      this.#marks[name] = Date.now() - this.#start;
      if (this.#saves > 0) void this.save();
      return;
    }
    this.#marks[name] = Date.now() - this.#start;
  }

  // Each message's role and UTF-8 size, never its text; reads the messages and never changes them.
  // options.parts names pieces of a message ({ message: its index, name, text }): each one's size,
  // and whether its text is really inside that message, checked here and then dropped. Call it
  // just before the model call. A later call replaces an earlier one. Never throws.
  prompt(messages: unknown, options?: { parts?: unknown }) {
    try {
      if (!Array.isArray(messages)) {
        this.#problem("prompt not recorded: run.prompt() takes a list of { role, content } messages");
        return;
      }
      const sizes: PromptMessageSize[] = [];
      const contents: unknown[] = []; // only for checking parts, during this call
      const kept = Math.min(messages.length, MAX_PROMPT_MESSAGES);
      for (let i = 0; i < kept; i++) {
        const [size, content] = this.#size(messages[i], i + 1);
        sizes.push(size);
        contents.push(content);
      }
      if (messages.length > kept) {
        this.#problem(`prompt: ${messages.length - kept} more messages not recorded (only the first ${MAX_PROMPT_MESSAGES} are kept)`);
      }
      this.#parts(options, sizes, contents);
      this.#prompt = sizes;
    } catch {
      this.#problem("prompt not recorded: reading the messages failed");
    }
  }

  // Problems name the message by number only: its role or text could be anything. Returns the
  // entry and the message's text (for checking named parts), or undefined when it wasn't measured.
  #size(message: unknown, n: number): [PromptMessageSize, string | undefined] {
    let role: unknown;
    let text: string | null;
    try {
      const m = (message ?? {}) as { role?: unknown; content?: unknown; parts?: unknown };
      role = m.role;
      text = this.#text(m.content, m.parts, n);
    } catch {
      this.#problem(`prompt message ${n}: reading it failed; recorded as "?" with no size`);
      return [{ role: "?", bytes: null }, undefined];
    }
    if (!isValidRole(role)) {
      this.#problem(`prompt message ${n}: role isn't a lowercase name of up to 32 letters or _ (e.g. system, user, assistant); recorded as "?"`);
    }
    return [{ role: isValidRole(role) ? role : "?", bytes: text === null ? null : utf8.encode(text).length }, text ?? undefined];
  }

  // A message's text, or null when it can't be measured (with a problem). content as a string;
  // or a list of parts, as SDKs send them: content: [{ type: "text", text }] (AI SDK model
  // messages, OpenAI, Anthropic), or, with no content, parts: [{ text }] (Gemini). Text parts
  // are joined as they are; any part that isn't text makes the whole message unmeasured, never
  // a partial sum.
  #text(content: unknown, parts: unknown, n: number): string | null {
    if (typeof content === "string") return content;
    const list = Array.isArray(content) ? content : content === undefined && Array.isArray(parts) ? parts : null;
    if (list === null) {
      this.#problem(`prompt message ${n}: content isn't text or a list of text parts; size not measured`);
      return null;
    }
    if (list.length === 0) {
      this.#problem(`prompt message ${n}: no text parts; size not measured`);
      return null;
    }
    let text = "";
    for (let j = 0; j < list.length; j++) {
      const part = list[j] as { type?: unknown; text?: unknown } | null;
      const type = part === null || typeof part !== "object" ? undefined : part.type;
      const value = part === null || typeof part !== "object" ? undefined : part.text;
      if (typeof value === "string" && (type === undefined || type === "text")) {
        text += value;
        continue;
      }
      // A type is shown only when it looks like an SDK's part type (image, tool-call): anything
      // else could be text.
      const named = typeof type === "string" && PART_TYPE.test(type) ? ` is ${JSON.stringify(type)}, not text` : " isn't text";
      this.#problem(`prompt message ${n}: part ${j + 1}${named}; size not measured`);
      return null;
    }
    return text;
  }

  // Named parts, added to their message's entry. Problems name a part by number only: its name
  // or text could be anything. A part that can't be read, or names no message, isn't recorded.
  #parts(options: unknown, sizes: PromptMessageSize[], contents: unknown[]) {
    let parts: unknown;
    try {
      parts = (options as { parts?: unknown } | null | undefined)?.parts;
      if (parts === undefined) return;
      if (!Array.isArray(parts)) {
        this.#problem("prompt parts not recorded: parts must be a list of { message, name, text }");
        return;
      }
    } catch {
      this.#problem("prompt parts not recorded: reading them failed");
      return;
    }
    const dropped = new Map<number, number>(); // message index → parts over the limit
    for (let i = 0; i < parts.length; i++) {
      const n = i + 1;
      let message: unknown, name: unknown, text: unknown, source: unknown;
      try {
        const part = parts[i];
        if (typeof part !== "object" || part === null) {
          this.#problem(`prompt part ${n}: isn't { message, name, text }; not recorded`);
          continue;
        }
        ({ message, name, text, source } = part as { message?: unknown; name?: unknown; text?: unknown; source?: unknown });
      } catch {
        this.#problem(`prompt part ${n}: reading it failed; not recorded`);
        continue;
      }
      if (!Number.isInteger(message) || (message as number) < 0 || (message as number) >= sizes.length) {
        this.#problem(`prompt part ${n}: message isn't the index of one of the messages (0 to ${sizes.length - 1}); not recorded`);
        continue;
      }
      const at = message as number;
      const entry = sizes[at]!;
      if ((entry.parts?.length ?? 0) >= MAX_PARTS_PER_MESSAGE) {
        dropped.set(at, (dropped.get(at) ?? 0) + 1);
        continue;
      }
      if (!isValidRole(name)) this.#problem(`prompt part ${n}: name isn't a lowercase name of up to 32 letters or _; recorded as "?"`);
      const content = contents[at];
      let found: boolean | null = null;
      if (typeof text !== "string") this.#problem(`prompt part ${n}: text isn't a string; size not measured and not checked`);
      else if (typeof content !== "string") this.#problem(`prompt part ${n}: message ${at + 1}'s text wasn't measured, so the part couldn't be checked`);
      else found = content.includes(text);
      if (source !== undefined && !isValidSource(source)) this.#problem(`prompt part ${n}: source isn't "app", "user" or "outside"; recorded without a source`);
      const size: PromptPartSize = { name: isValidRole(name) ? name : "?", bytes: typeof text === "string" ? utf8.encode(text).length : null, found, ...(isValidSource(source) && { source }) };
      (entry.parts ??= []).push(size);
    }
    for (const [at, count] of dropped) {
      this.#problem(`prompt message ${at + 1}: ${count} more parts not recorded (only the first ${MAX_PARTS_PER_MESSAGE} are kept)`);
    }
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
        ...(this.#prompt && { prompt: { messages: this.#prompt.map((m) => ({ ...m, ...(m.parts && { parts: m.parts.map((p) => ({ ...p })) }) })) } }),
      };
      this.#saves++;
      saved = this.#lastSave.then(() => this.#store.put(this.id, record)).catch(logFailure);
      this.#lastSave = saved;
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

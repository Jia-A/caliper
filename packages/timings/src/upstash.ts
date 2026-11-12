// Upstash Redis over its REST API (plain fetch, no dependency), for serverless hosts where each
// instance has its own memory (Vercel, Netlify, …). Each record is one key, caliper:timings:<id>,
// set with an expiry of RECORD_TTL_MS. Re-exports caliper-timings/fetch.
import { RECORD_TTL_MS, type TimingRecord, type TimingStore } from "./protocol.ts";

export * from "./fetch.ts";

export type UpstashOptions = {
  url: string; // the database's REST URL
  token: string; // its REST token (Standard, not Read Only: the store writes)
  timeoutMs?: number; // per call; default 2000
};

const KEY_PREFIX = "caliper:timings:";
const DEFAULT_TIMEOUT_MS = 2000;

// A refused or failed call rejects with the command, the status or Upstash's error, and never the
// token or the URL. CaliperRun.save() and the endpoint catch it: logged, and the endpoint answers 500.
export class UpstashStore implements TimingStore {
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor({ url, token, timeoutMs = DEFAULT_TIMEOUT_MS }: UpstashOptions) {
    this.#url = url.replace(/\/+$/, "");
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  // The store from UPSTASH_REDIS_REST_URL / _TOKEN, or Vercel's KV_REST_API_URL / _TOKEN; null
  // when neither pair is complete. Pass process.env (or Workers' env): never read globally here.
  static fromEnv(env: Record<string, string | undefined>): UpstashStore | null {
    for (const [url, token] of [
      [env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN],
      [env.KV_REST_API_URL, env.KV_REST_API_TOKEN],
    ]) {
      if (url && token) return new UpstashStore({ url, token });
    }
    return null;
  }

  async put(id: string, record: TimingRecord) {
    await this.#call("SET", [KEY_PREFIX + id, JSON.stringify(record), "EX", String(RECORD_TTL_MS / 1000)]);
  }

  async get(id: string) {
    const value = await this.#call("GET", [KEY_PREFIX + id]);
    if (value === null) return null;
    let record: unknown;
    try {
      record = JSON.parse(value as string);
    } catch {
      record = null;
    }
    const r = record as { id?: unknown; marks?: unknown } | null;
    if (typeof r !== "object" || r === null || typeof r.id !== "string" || typeof r.marks !== "object" || r.marks === null) {
      throw new Error("Upstash GET failed: the stored value isn't a timing record");
    }
    return record as TimingRecord;
  }

  async #call(command: "SET" | "GET", args: string[]): Promise<unknown> {
    const failed = (why: string) => new Error(`Upstash ${command} failed: ${why}`);
    let res: Response;
    try {
      res = await fetch(this.#url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
        body: JSON.stringify([command, ...args]),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const timedOut = (err as { name?: unknown } | null)?.name === "TimeoutError";
      throw failed(timedOut ? `no answer in ${this.#timeoutMs} ms` : "the request didn't complete");
    }
    let body = null as { result?: unknown; error?: unknown } | null;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // Not JSON: reported below with the status.
    }
    if (!res.ok) throw failed(String(res.status));
    if (typeof body?.error === "string") throw failed(body.error.slice(0, 200));
    if (body === null || typeof body !== "object" || !("result" in body)) throw failed(`${res.status}, an answer that isn't {"result": …}`);
    return body.result;
  }
}

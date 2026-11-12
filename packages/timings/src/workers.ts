// Cloudflare Workers: a Durable Object store, moved from Quill's backend. One CaliperTimingsDO
// instance per run id holds that run's record (a JSON string under "record") and deletes it with
// an alarm RECORD_TTL_MS after the last write. The types below are the few parts of Cloudflare's
// API this uses, so the package doesn't depend on @cloudflare/workers-types; Cloudflare's own
// DurableObjectNamespace and DurableObjectState fit them.
import { RECORD_TTL_MS, type TimingRecord, type TimingStore } from "./protocol.ts";

export * from "./fetch.ts";

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: never): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export interface DurableObjectStateLike {
  storage: {
    put(key: string, value: string): Promise<void>;
    get<T>(key: string): Promise<T | undefined>;
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAll(): Promise<void>;
  };
}

// The URL only addresses the object; it never leaves Cloudflare.
const RECORD_URL = "https://caliper-timings/record";

// Holds one run's timing record. Export it from your Worker under this name and bind it (e.g.
// CALIPER_TIMINGS_DO, class_name "CaliperTimingsDO") in wrangler's durable_objects.
export class CaliperTimingsDO {
  state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike, _env: unknown) {
    this.state = state;
  }

  async fetch(request: Request) {
    if (request.method === "PUT") {
      await this.state.storage.put("record", await request.text());
      await this.state.storage.setAlarm(Date.now() + RECORD_TTL_MS);
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET") {
      const record = await this.state.storage.get<string>("record");
      if (!record) return new Response("Not found", { status: 404 });
      return new Response(record, { headers: { "Content-Type": "application/json" } });
    }

    return new Response("Method not allowed", { status: 405 });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

// A TimingStore over CaliperTimingsDO: one object per run id (idFromName). A refused write or
// read rejects; CaliperRun.save() and the endpoint catch it (logged; the endpoint answers 500).
export class DurableObjectStore implements TimingStore {
  readonly #namespace: DurableObjectNamespaceLike;

  constructor(namespace: DurableObjectNamespaceLike) {
    this.#namespace = namespace;
  }

  #stub(id: string) {
    return this.#namespace.get(this.#namespace.idFromName(id) as never);
  }

  async put(id: string, record: TimingRecord) {
    const res = await this.#stub(id).fetch(RECORD_URL, { method: "PUT", body: JSON.stringify(record) });
    if (!res.ok) throw new Error(`CaliperTimingsDO put failed: ${res.status}`);
  }

  async get(id: string) {
    const res = await this.#stub(id).fetch(RECORD_URL);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CaliperTimingsDO get failed: ${res.status}`);
    return (await res.json()) as TimingRecord;
  }
}

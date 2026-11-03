import { RECORD_TTL_MS, type TimingRecord, type TimingStore } from "./protocol.ts";

// Single-process servers only: on Workers each isolate has its own Map (and so does each process
// behind a load balancer), so a read can land where the write never happened.
// Cleanup: every put deletes every expired record first, and a get that finds an expired record
// deletes it. So after a put, the Map holds only records written in the last RECORD_TTL_MS. If
// writes stop, what's left stays until the next put or get: a bounded leftover, not a leak.
export class MemoryStore implements TimingStore {
  readonly #records = new Map<string, { record: TimingRecord; expiresAt: number }>();

  async put(id: string, record: TimingRecord) {
    const now = Date.now();
    for (const [key, entry] of this.#records) {
      if (entry.expiresAt <= now) this.#records.delete(key);
    }
    this.#records.set(id, { record, expiresAt: now + RECORD_TTL_MS });
  }

  async get(id: string) {
    const entry = this.#records.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.#records.delete(id);
      return null;
    }
    return entry.record;
  }

  // Records held, including expired ones not deleted yet.
  get size() {
    return this.#records.size;
  }
}

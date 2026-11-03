// MemoryStore: what it keeps, for how long, and that expired records nobody reads are deleted.
// Date is mocked (node:test), so the 10-minute expiry runs instantly.
// Run with `npm test` (Node 22.18+ runs .ts directly).

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore } from "../src/memoryStore.ts";
import { RECORD_TTL_MS, type TimingRecord } from "../src/protocol.ts";

const MINUTE = 60_000;
const record = (id: string): TimingRecord => ({ id, status: 200, marks: { dbStart: 1, dbEnd: 301 } });

test("get returns the record put under that id, and null for an id never put", async () => {
  const store = new MemoryStore();
  await store.put("run_a", record("run_a"));
  assert.deepEqual(await store.get("run_a"), record("run_a"));
  assert.equal(await store.get("run_b"), null);
});

test("a record can be read until RECORD_TTL_MS after the put, and not at or after it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const store = new MemoryStore();
  await store.put("run_a", record("run_a"));
  t.mock.timers.tick(RECORD_TTL_MS - 1);
  assert.deepEqual(await store.get("run_a"), record("run_a"));
  t.mock.timers.tick(1);
  assert.equal(await store.get("run_a"), null);
});

test("an expired record nobody reads is deleted by the next put", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const store = new MemoryStore();
  await store.put("run_a", record("run_a"));
  await store.put("run_b", record("run_b"));
  t.mock.timers.tick(RECORD_TTL_MS);
  assert.equal(store.size, 2, "nothing runs between puts: both expired records are still held");
  await store.put("run_c", record("run_c"));
  assert.equal(store.size, 1, "the put deleted both expired records, unread");
  assert.deepEqual(await store.get("run_c"), record("run_c"));
});

test("a get that finds an expired record deletes it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const store = new MemoryStore();
  await store.put("run_a", record("run_a"));
  t.mock.timers.tick(RECORD_TTL_MS);
  assert.equal(await store.get("run_a"), null);
  assert.equal(store.size, 0);
});

test("long-running: one record a minute for 3 hours never holds more than the last 10 minutes' worth", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const store = new MemoryStore();
  const held: number[] = [];
  for (let i = 0; i < 180; i++) {
    await store.put(`run_${i}`, record(`run_${i}`));
    held.push(store.size);
    t.mock.timers.tick(MINUTE);
  }
  // A record put at minute m expires at m + 10, and the put at m + 10 deletes it.
  assert.deepEqual(held, held.map((_, i) => Math.min(i + 1, RECORD_TTL_MS / MINUTE)));
  assert.equal(Math.max(...held), 10);
});

test("putting the same id again replaces the record and restarts its 10 minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const store = new MemoryStore();
  await store.put("run_a", record("run_a"));
  t.mock.timers.tick(5 * MINUTE);
  const second = { ...record("run_a"), marks: { dbStart: 2 } };
  await store.put("run_a", second);
  t.mock.timers.tick(RECORD_TTL_MS - 1);
  assert.deepEqual(await store.get("run_a"), second);
  assert.equal(store.size, 1);
});

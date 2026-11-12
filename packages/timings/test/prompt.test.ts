// run.prompt(messages): the record's prompt sizes, one { role, bytes } per message, never the text.
// Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CaliperRun } from "../src/run.ts";
import { MemoryStore } from "../src/memoryStore.ts";
import { LEAKY_MESSAGES, SECRET } from "./leak.ts";

async function recordAfter(fn: (run: CaliperRun) => void) {
  const store = new MemoryStore();
  const run = new CaliperRun("run_a", store);
  fn(run);
  await run.save();
  return (await store.get("run_a"))!;
}

test("each message's role and UTF-8 size in bytes, in order; system, history and user alike", async () => {
  const record = await recordAfter((run) =>
    run.prompt([
      { role: "system", content: "You write posts." }, // 16 bytes
      { role: "user", content: "héllo" }, // é is 2 bytes: 6
      { role: "assistant", content: "日本" }, // 3 + 3
      { role: "user", content: "😀" }, // 4
      { role: "tool", content: "" },
    ])
  );
  assert.deepEqual(record.prompt, {
    messages: [
      { role: "system", bytes: 16 },
      { role: "user", bytes: 6 },
      { role: "assistant", bytes: 6 },
      { role: "user", bytes: 4 },
      { role: "tool", bytes: 0 },
    ],
  });
  assert.equal(Object.hasOwn(record, "problems"), false);
});

test("bytes match TextEncoder, lone surrogates included", async () => {
  const texts = ["a", "é", "€", "😀", "\ud83d", "\ude00x", "x".repeat(6000)];
  const record = await recordAfter((run) => run.prompt(texts.map((content) => ({ role: "user", content }))));
  assert.deepEqual(record.prompt!.messages.map((m) => m.bytes), texts.map((t) => new TextEncoder().encode(t).length));
});

test("no prompt() call: no prompt field", async () => {
  const record = await recordAfter((run) => run.mark("dbStart"));
  assert.equal(Object.hasOwn(record, "prompt"), false);
});

test("calling prompt() twice keeps the later one", async () => {
  const record = await recordAfter((run) => {
    run.prompt([{ role: "user", content: "first" }]);
    run.prompt([{ role: "user", content: "second!" }]);
  });
  assert.deepEqual(record.prompt, { messages: [{ role: "user", bytes: 7 }] });
});

test('a role that isn\'t a short lowercase name is recorded as "?", with a problem that doesn\'t repeat it', async () => {
  const record = await recordAfter((run) =>
    run.prompt([
      { role: "System", content: "a" },
      { role: "you are a helpful assistant", content: "b" },
      { role: "x".repeat(33), content: "c" },
      { content: "d" },
      { role: 7, content: "e" },
      { role: "x".repeat(32), content: "f" },
      { role: "function_call", content: "g" },
    ])
  );
  assert.deepEqual(record.prompt!.messages.map((m) => m.role), ["?", "?", "?", "?", "?", "x".repeat(32), "function_call"]);
  assert.deepEqual(record.problems, [1, 2, 3, 4, 5].map((n) => `prompt message ${n}: role isn't a lowercase name of up to 32 letters or _ (e.g. system, user, assistant); recorded as "?"`));
});

test("content that isn't a string: bytes null, and a problem; never estimated", async () => {
  const record = await recordAfter((run) =>
    run.prompt([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "user" },
      { role: "user", content: null },
    ])
  );
  assert.deepEqual(record.prompt!.messages, [
    { role: "user", bytes: null },
    { role: "user", bytes: null },
    { role: "user", bytes: null },
  ]);
  assert.deepEqual(record.problems, [1, 2, 3].map((n) => `prompt message ${n}: content isn't a string; size not measured`));
});

test("not a list: no prompt field, and a problem", async () => {
  for (const value of [null, undefined, "hello", { role: "user", content: "x" }, 42]) {
    const record = await recordAfter((run) => run.prompt(value));
    assert.equal(Object.hasOwn(record, "prompt"), false, String(value));
    assert.deepEqual(record.problems, ["prompt not recorded: run.prompt() takes a list of { role, content } messages"]);
  }
});

test("a message that isn't an object: role \"?\", bytes null", async () => {
  const record = await recordAfter((run) => run.prompt(["just text", null]));
  assert.deepEqual(record.prompt!.messages, [
    { role: "?", bytes: null },
    { role: "?", bytes: null },
  ]);
});

test("at most 1000 messages are recorded, then a problem says how many weren't", async () => {
  const record = await recordAfter((run) => run.prompt(Array.from({ length: 1003 }, () => ({ role: "user", content: "x" }))));
  assert.equal(record.prompt!.messages.length, 1000);
  assert.deepEqual(record.problems, ["prompt: 3 more messages not recorded (only the first 1000 are kept)"]);
});

// ---- What run.prompt() must never do (SPEC: never change the app; never the text) ----

test("never the text: the marker is nowhere in the record, its problems or the error log", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const record = await recordAfter((run) => run.prompt(LEAKY_MESSAGES()));
  assert.ok(!JSON.stringify(record).includes(SECRET), JSON.stringify(record));
  assert.ok(!JSON.stringify(error.mock.calls.map((c) => c.arguments.map(String))).includes(SECRET));
  // The sizes are still there: the marker only ever shows up as bytes.
  assert.deepEqual(record.prompt!.messages.map((m) => m.role), ["system", "?", "user", "assistant", "user"]);
  assert.equal(record.prompt!.messages[4]!.bytes, SECRET.length * 3);
});

// Every write a Proxy could see, on the list and every message, deeply: none may happen.
function watched<T extends object>(value: T, writes: string[], path = "messages"): T {
  return new Proxy(value, {
    get: (target, key, receiver) => {
      const v = Reflect.get(target, key, receiver);
      return typeof v === "object" && v !== null ? watched(v, writes, `${path}.${String(key)}`) : v;
    },
    set: (_t, key) => (writes.push(`set ${path}.${String(key)}`), true),
    defineProperty: (_t, key) => (writes.push(`defineProperty ${path}.${String(key)}`), true),
    deleteProperty: (_t, key) => (writes.push(`delete ${path}.${String(key)}`), true),
    setPrototypeOf: () => (writes.push(`setPrototypeOf ${path}`), true),
    preventExtensions: () => (writes.push(`preventExtensions ${path}`), false),
  });
}

test("never changes the messages: no write of any kind, and the same list afterwards", async () => {
  const messages = LEAKY_MESSAGES();
  const before = JSON.stringify(messages);
  const writes: string[] = [];
  const record = await recordAfter((run) => run.prompt(watched(messages, writes)));
  assert.deepEqual(writes, []);
  assert.equal(JSON.stringify(messages), before);
  assert.equal(record.prompt!.messages.length, 5);
});

test("never changes them, frozen: a deeply frozen list is read without an error", async () => {
  const freeze = <T>(v: T): T => (typeof v === "object" && v !== null ? (Object.values(v).forEach(freeze), Object.freeze(v)) : v);
  const record = await recordAfter((run) => assert.doesNotThrow(() => run.prompt(freeze(LEAKY_MESSAGES()))));
  assert.equal(record.prompt!.messages.length, 5);
});

// Lists that throw when read: none of it may reach the app.
const hostile = (): [string, unknown][] => {
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const cyclic: unknown[] = [];
  const self: Record<string, unknown> = { role: "user", content: "x" };
  self.self = self;
  cyclic.push(self, cyclic);
  const throwing = (what: string) => () => {
    throw new Error(`${what} throws`);
  };
  return [
    ["a revoked Proxy (Array.isArray throws)", revoked.proxy],
    ["a list whose length throws", new Proxy([], { get: (t, k) => (k === "length" ? throwing("length")() : Reflect.get(t, k)) })],
    ["a list whose items throw", new Proxy([{ role: "user", content: "x" }], { get: (t, k) => (k === "0" ? throwing("item")() : Reflect.get(t, k)) })],
    ["a message whose role throws", [Object.defineProperty({ content: "x" }, "role", { get: throwing("role"), enumerable: true })]],
    ["a message whose content throws", [Object.defineProperty({ role: "user" }, "content", { get: throwing("content"), enumerable: true })]],
    ["a list containing itself and a message containing itself", cyclic],
    ["content whose toString throws", [{ role: "user", content: { toString: throwing("toString") } }]],
    ["100,000 messages", Array.from({ length: 100_000 }, () => ({ role: "user", content: "x" }))],
  ];
};

test("never throws: lists and messages that throw when read are caught, and the record still saves", async () => {
  for (const [what, messages] of hostile()) {
    const store = new MemoryStore();
    const run = new CaliperRun("run_a", store);
    run.mark("dbStart");
    assert.doesNotThrow(() => run.prompt(messages), what);
    await assert.doesNotReject(run.save(), what);
    const record = (await store.get("run_a"))!;
    assert.deepEqual(Object.keys(record.marks), ["dbStart"], what);
    assert.ok((record.problems ?? []).length > 0 || record.prompt, `${what}: noted in problems, or recorded`);
  }
});

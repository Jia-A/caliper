// run.prompt(messages): the record's prompt sizes, one { role, bytes } per message, never the text.
// Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CaliperRun } from "../src/run.ts";
import { MemoryStore } from "../src/memoryStore.ts";

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

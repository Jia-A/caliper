// run.prompt() with the message shapes SDKs send (caliper-test-3 #7 and A6): a message's size is
// the sum of its text parts, never estimated. AI SDK model messages and OpenAI/Anthropic-style
// content arrays: content: [{ type: "text", text }]. Gemini: parts: [{ text }]. Any part that
// isn't text (an image, a file, a tool call) makes that message's size null, with a problem
// naming the part, since its size wasn't measured.
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

test("AI SDK model messages: content is a list of text parts, its size is their UTF-8 sum", async () => {
  const record = await recordAfter((run) =>
    run.prompt([
      { role: "system", content: "You are helpful." }, // 16
      { role: "user", content: [{ type: "text", text: "What's the weather" }, { type: "text", text: " on Mars?" }] }, // 18 + 9
      { role: "assistant", content: [{ type: "text", text: "héllo" }] }, // 6
    ])
  );
  assert.deepEqual(record.prompt!.messages, [
    { role: "system", bytes: 16 },
    { role: "user", bytes: 27 },
    { role: "assistant", bytes: 6 },
  ]);
  assert.equal(record.problems, undefined);
});

test("Gemini history: parts: [{ text }] with no content, its size is the sum; role \"model\" is fine", async () => {
  const record = await recordAfter((run) =>
    run.prompt([
      { role: "user", parts: [{ text: "Explain rainbows." }] }, // 17
      { role: "model", parts: [{ text: "Light " }, { text: "bends." }] }, // 6 + 6
    ])
  );
  assert.deepEqual(record.prompt!.messages, [
    { role: "user", bytes: 17 },
    { role: "model", bytes: 12 },
  ]);
  assert.equal(record.problems, undefined);
});

test("a part that isn't text: that message's size is null and the problem names the part; never a partial sum", async () => {
  const record = await recordAfter((run) =>
    run.prompt([
      { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", image: "data:…" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "weather", input: {} }] },
      { role: "user", parts: [{ text: "hi" }, { inlineData: { mimeType: "image/png", data: "…" } }] },
      { role: "user", content: [] },
    ])
  );
  assert.deepEqual(record.prompt!.messages.map((m) => m.bytes), [null, null, null, null]);
  assert.deepEqual(record.problems, [
    'prompt message 1: part 2 is "image", not text; size not measured',
    'prompt message 2: part 1 is "tool-call", not text; size not measured',
    "prompt message 3: part 2 isn't text; size not measured",
    "prompt message 4: no text parts; size not measured",
  ]);
});

test("named parts are checked against a message's text parts too", async () => {
  const record = await recordAfter((run) =>
    run.prompt([{ role: "user", content: [{ type: "text", text: "Article: Mars is red." }] }], {
      parts: [{ message: 0, name: "article", text: "Mars is red." }],
    })
  );
  assert.deepEqual(record.prompt!.messages[0]!.parts, [{ name: "article", bytes: 12, found: true }]);
});

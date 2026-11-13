// run.prompt(messages, { parts }) with source: who wrote each part, as the app labels it ("app",
// "user" or "outside"). Recorded as given, never guessed: no label, no source. Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CaliperRun } from "../src/run.ts";
import { MemoryStore } from "../src/memoryStore.ts";
import { SECRET } from "./leak.ts";

async function recordAfter(fn: (run: CaliperRun) => void) {
  const store = new MemoryStore();
  const run = new CaliperRun("run_a", store);
  fn(run);
  await run.save();
  return (await store.get("run_a"))!;
}

const SYSTEM = "You write posts.";
const TITLE = "Title: A title";
const ARTICLE = "Article:\nBody text.";
const COMMENT = "Comment: from a reader";
const quill = () => [{ role: "system", content: SYSTEM }, { role: "user", content: [TITLE, ARTICLE, COMMENT].join("\n\n") }];

test("each part's source is recorded as the app labelled it: app, user or outside", async () => {
  const record = await recordAfter((run) =>
    run.prompt(quill(), {
      parts: [
        { message: 0, name: "instructions", text: SYSTEM, source: "app" },
        { message: 1, name: "title", text: TITLE, source: "user" },
        { message: 1, name: "comment", text: COMMENT, source: "outside" },
      ],
    })
  );
  assert.deepEqual(record.prompt!.messages[0]!.parts, [{ name: "instructions", bytes: 16, found: true, source: "app" }]);
  assert.deepEqual(record.prompt!.messages[1]!.parts, [
    { name: "title", bytes: 14, found: true, source: "user" },
    { name: "comment", bytes: 22, found: true, source: "outside" },
  ]);
  assert.equal(Object.hasOwn(record, "problems"), false);
});

test("a part without a source has no source field, and no problem: never a default by role", async () => {
  const record = await recordAfter((run) =>
    run.prompt(quill(), { parts: [{ message: 0, name: "instructions", text: SYSTEM }, { message: 1, name: "article", text: ARTICLE }] })
  );
  for (const part of [record.prompt!.messages[0]!.parts![0]!, record.prompt!.messages[1]!.parts![0]!]) {
    assert.equal(Object.hasOwn(part, "source"), false, JSON.stringify(part));
  }
  assert.equal(Object.hasOwn(record, "problems"), false);
});

test("a source that isn't app, user or outside: recorded without one, with a problem naming the part by number only", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const bad = ["User", "external", "", 3, null, { source: "user" }, `user ${SECRET}`];
  const record = await recordAfter((run) =>
    run.prompt(quill(), { parts: bad.map((source) => ({ message: 1, name: "title", text: TITLE, source })) })
  );
  const parts = record.prompt!.messages[1]!.parts!;
  assert.equal(parts.length, bad.length, "the part is still recorded");
  assert.ok(parts.every((p) => !Object.hasOwn(p, "source") && p.name === "title" && p.bytes === 14 && p.found === true), JSON.stringify(parts));
  assert.deepEqual(
    record.problems,
    bad.map((_, i) => `prompt part ${i + 1}: source isn't "app", "user" or "outside"; recorded without a source`)
  );
  assert.ok(!JSON.stringify(record).includes(SECRET), JSON.stringify(record));
  assert.ok(!JSON.stringify(error.mock.calls.map((c) => c.arguments.map(String))).includes(SECRET));
});

test("a part whose source throws when read never throws out of prompt(): that part isn't recorded, the others are", async () => {
  const throwing = Object.defineProperty({ message: 1, name: "title", text: TITLE }, "source", {
    get: () => {
      throw new Error("throws");
    },
    enumerable: true,
  });
  let record!: Awaited<ReturnType<typeof recordAfter>>;
  await assert.doesNotReject(async () => {
    record = await recordAfter((run) => run.prompt(quill(), { parts: [throwing, { message: 1, name: "article", text: ARTICLE, source: "user" }] }));
  });
  assert.deepEqual(record.prompt!.messages[1]!.parts, [{ name: "article", bytes: 19, found: true, source: "user" }]);
  assert.deepEqual(record.problems, ["prompt part 1: reading it failed; not recorded"]);
});

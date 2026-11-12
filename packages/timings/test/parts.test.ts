// run.prompt(messages, { parts }): named parts inside a message — each part's name, UTF-8 size and
// whether its text is really inside that message, never the text. Run with `npm test`.

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

// Quill's shape: a system message, then a user message joined from labelled pieces.
const TITLE = "Title: A title";
const ARTICLE = `Article:\nBody text. ${SECRET}`;
const USER = [TITLE, ARTICLE].join("\n\n");
const quill = () => [{ role: "system", content: "You write posts." }, { role: "user", content: USER }];

test("never the text: a marker in a part's text and in its name is nowhere in the record or the error log, and the parts are recorded", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const record = await recordAfter((run) =>
    run.prompt(quill(), {
      parts: [
        { message: 1, name: "title", text: TITLE },
        { message: 1, name: "article", text: ARTICLE },
        { message: 1, name: `secret ${SECRET}`, text: "Title" },
        { message: 1, name: "missing", text: `not in it ${SECRET}` },
      ],
    })
  );
  assert.ok(!JSON.stringify(record).includes(SECRET), JSON.stringify(record));
  assert.ok(!JSON.stringify(error.mock.calls.map((c) => c.arguments.map(String))).includes(SECRET));
  assert.deepEqual(record.prompt!.messages[1]!.parts, [
    { name: "title", bytes: 14, found: true },
    { name: "article", bytes: Buffer.byteLength(ARTICLE), found: true },
    { name: "?", bytes: 5, found: true },
    { name: "missing", bytes: Buffer.byteLength(`not in it ${SECRET}`), found: false },
  ]);
});

test("parts with their labels plus the separators add up exactly to the message", async () => {
  const record = await recordAfter((run) =>
    run.prompt(quill(), { parts: [{ message: 1, name: "title", text: TITLE }, { message: 1, name: "article", text: ARTICLE }] })
  );
  const user = record.prompt!.messages[1]!;
  const sum = user.parts!.reduce((a, p) => a + p.bytes!, 0);
  assert.equal(user.bytes, sum + Buffer.byteLength("\n\n"));
  assert.equal(Object.hasOwn(record.prompt!.messages[0]!, "parts"), false, "no parts field on a message with none");
  assert.equal(Object.hasOwn(record, "problems"), false);
});

test("a part whose text isn't in its message: found false, its size still measured", async () => {
  const record = await recordAfter((run) => run.prompt(quill(), { parts: [{ message: 0, name: "title", text: TITLE }] }));
  assert.deepEqual(record.prompt!.messages[0]!.parts, [{ name: "title", bytes: 14, found: false }]);
});

const problemsFor = async (parts: unknown, messages: unknown = quill()) => {
  const record = await recordAfter((run) => run.prompt(messages, { parts }));
  return { record, problems: record.problems ?? [] };
};

test('a name that isn\'t a lowercase name is recorded as "?", with a problem naming the part by number only', async () => {
  const { record, problems } = await problemsFor([
    { message: 1, name: "codeSnippet", text: "Title" },
    { message: 1, name: "code_snippet", text: "Title" },
    { message: 1, name: 7, text: "Title" },
  ]);
  assert.deepEqual(record.prompt!.messages[1]!.parts!.map((p) => p.name), ["?", "code_snippet", "?"]);
  assert.deepEqual(problems, [1, 3].map((n) => `prompt part ${n}: name isn't a lowercase name of up to 32 letters or _; recorded as "?"`));
});

test("text that isn't a string: no size and not checked (null), with a problem; never estimated", async () => {
  const { record, problems } = await problemsFor([{ message: 1, name: "article", text: ["Article:"] }, { message: 1, name: "title" }]);
  assert.deepEqual(record.prompt!.messages[1]!.parts, [{ name: "article", bytes: null, found: null }, { name: "title", bytes: null, found: null }]);
  assert.deepEqual(problems, [1, 2].map((n) => `prompt part ${n}: text isn't a string; size not measured and not checked`));
});

test("a message whose content isn't a string: the part's size is measured, but it can't be checked (found null)", async () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "Title: A title" }] }];
  const { record, problems } = await problemsFor([{ message: 0, name: "title", text: TITLE }], messages);
  assert.deepEqual(record.prompt!.messages[0]!.parts, [{ name: "title", bytes: 14, found: null }]);
  assert.ok(problems.includes("prompt part 1: message 1's content isn't a string, so the part couldn't be checked"), JSON.stringify(problems));
});

test("a message index that isn't one of the messages: the part isn't recorded, with a problem", async () => {
  const { record, problems } = await problemsFor([
    { message: 2, name: "title", text: TITLE },
    { message: -1, name: "title", text: TITLE },
    { message: 1.5, name: "title", text: TITLE },
    { message: "1", name: "title", text: TITLE },
  ]);
  assert.ok(record.prompt!.messages.every((m) => !Object.hasOwn(m, "parts")));
  assert.deepEqual(problems, [1, 2, 3, 4].map((n) => `prompt part ${n}: message isn't the index of one of the messages (0 to 1); not recorded`));
});

test("parts that aren't a list: no parts, a problem, and the message sizes are still recorded", async () => {
  for (const parts of ["title", { message: 1 }, 42, null]) {
    const { record, problems } = await problemsFor(parts);
    assert.equal(record.prompt!.messages.length, 2, String(parts));
    assert.deepEqual(problems, ["prompt parts not recorded: parts must be a list of { message, name, text }"], String(parts));
  }
  const none = await recordAfter((run) => run.prompt(quill()));
  assert.equal(Object.hasOwn(none, "problems"), false, "no parts option: no problem");
});

test("a part that isn't an object is skipped, with a problem", async () => {
  const { record, problems } = await problemsFor(["title", null]);
  assert.ok(record.prompt!.messages.every((m) => !Object.hasOwn(m, "parts")));
  assert.deepEqual(problems, [1, 2].map((n) => `prompt part ${n}: isn't { message, name, text }; not recorded`));
});

test("at most 50 parts per message, then a problem says how many weren't", async () => {
  const parts = Array.from({ length: 53 }, () => ({ message: 1, name: "title", text: "Title" }));
  const { record, problems } = await problemsFor(parts);
  assert.equal(record.prompt!.messages[1]!.parts!.length, 50);
  assert.deepEqual(problems, ["prompt message 2: 3 more parts not recorded (only the first 50 are kept)"]);
});

test("the same text twice in the message is still found (inside it, not where)", async () => {
  const messages = [{ role: "user", content: "Tag: x\n\nTag: x" }];
  const { record } = await problemsFor([{ message: 0, name: "tag", text: "Tag: x" }, { message: 0, name: "tag", text: "Tag: x" }], messages);
  assert.deepEqual(record.prompt!.messages[0]!.parts, [{ name: "tag", bytes: 6, found: true }, { name: "tag", bytes: 6, found: true }]);
});

// ---- Never change the app, never throw ----

function watched<T extends object>(value: T, writes: string[], path = "parts"): T {
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

test("never changes the parts or the messages: no write of any kind", async () => {
  const writes: string[] = [];
  const parts = [{ message: 1, name: "title", text: TITLE }, { message: 1, name: "article", text: ARTICLE }];
  const messages = quill();
  const before = JSON.stringify([parts, messages]);
  await recordAfter((run) => run.prompt(watched(messages, writes, "messages"), watched({ parts }, writes, "options")));
  assert.deepEqual(writes, []);
  assert.equal(JSON.stringify([parts, messages]), before);
});

test("never throws: options, parts and part fields that throw when read; the record still saves with the message sizes", async () => {
  const throwing = () => {
    throw new Error("throws");
  };
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const cases: [string, unknown][] = [
    ["options whose parts getter throws", Object.defineProperty({}, "parts", { get: throwing, enumerable: true })],
    ["a revoked Proxy as parts", { parts: revoked.proxy }],
    ["a part whose text throws", { parts: [Object.defineProperty({ message: 1, name: "title" }, "text", { get: throwing, enumerable: true })] }],
    ["a part whose message throws", { parts: [Object.defineProperty({ name: "title", text: "x" }, "message", { get: throwing, enumerable: true })] }],
    ["options that aren't an object", "parts"],
  ];
  for (const [what, options] of cases) {
    const store = new MemoryStore();
    const run = new CaliperRun("run_a", store);
    assert.doesNotThrow(() => run.prompt(quill(), options as never), what);
    await assert.doesNotReject(run.save(), what);
    assert.equal((await store.get("run_a"))!.prompt?.messages.length, 2, what);
  }
});
